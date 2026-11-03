import crypto from 'crypto';
import { PendingMfaLogin } from '../models/PendingMfaLogin.js';
import { UserMfa } from '../models/UserMfa.js';
import { adminMfaKey } from './adminConfig.js';
import { auditAccount } from './audit.js';
import { secondFactorStore } from './secondFactor.js';
import { notifyAccount } from './securityNotice.js';
import { clearCookie, cookieOptions, hashToken, randomToken, readCookie } from './session.js';
import { generateTotpSecret, totpUri } from './totp.js';

export const MFA_COOKIE = 'gc_mfa';
const PENDING_TTL_MS = 5 * 60 * 1000;

/** Dẫn xuất từ ADMIN_MFA_KEY để không thêm một bí mật phải quản lý, và lộ khóa của bên này không mở được bản mã của bên kia */
function userMfaKey() {
  const master = adminMfaKey();
  return master ? Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'greencanteen-user-mfa', 32)) : null;
}

const store = secondFactorStore(UserMfa, userMfaKey);

export const isUserMfaAvailable = () => userMfaKey() !== null;
export const isUserMfaEnabled = store.isEnabled;
export const finishUserMfa = store.finish;

/** Mã TOTP hoặc mã khôi phục, trả về 'totp', 'recovery' hoặc false. Mã khôi phục dùng ở đâu cũng báo chủ tài khoản: đó là dấu hiệu mất thiết bị hoặc bị lộ */
export async function verifyUserSecondFactor(req, user, code) {
  const method = await store.verify(user._id, code);
  if (method === 'recovery') {
    await auditAccount(req, user, 'account.mfa_recovery_used');
    notifyAccount(user, 'mfa_recovery_used');
  }
  return method;
}

export async function startUserMfa(user) {
  const secret = generateTotpSecret();
  await UserMfa.updateOne({ userId: user._id, enabledAt: null }, { $set: { pendingSecretEnc: store.seal(secret, user._id) } }, { upsert: true });
  return { secret, otpauthUri: totpUri({ secret, account: user.email || user.studentId, issuer: 'GreenCanteen' }) };
}

export async function recoveryCodesLeft(userId) {
  const mfa = await UserMfa.findOne({ userId, enabledAt: { $ne: null } }).select('recoveryCodeHashes').lean();
  return mfa?.recoveryCodeHashes?.length ?? 0;
}

export async function replaceRecoveryCodes(userId) {
  const codes = store.newRecoveryCodes();
  await UserMfa.updateOne({ userId, enabledAt: { $ne: null } }, { $set: { recoveryCodeHashes: codes.map(store.codeHash) } });
  return codes;
}

export async function disableUserMfa(userId) {
  const { deletedCount } = await UserMfa.deleteOne({ userId, enabledAt: { $ne: null } });
  return deletedCount > 0;
}

// ---- Đăng nhập hai bước: bước một xong chỉ có cookie chờ, chưa phải phiên ----

export async function beginMfaLogin(res, user, { reauthenticated = false } = {}) {
  const token = randomToken();
  await PendingMfaLogin.create({ tokenHash: hashToken(token), userId: user._id, reauthenticated, expiresAt: new Date(Date.now() + PENDING_TTL_MS) });
  res.cookie(MFA_COOKIE, token, cookieOptions(PENDING_TTL_MS));
}

export function findPendingMfaLogin(req) {
  const token = readCookie(req, MFA_COOKIE);
  return token ? PendingMfaLogin.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }) : null;
}

export async function clearPendingMfaLogin(req, res) {
  const token = readCookie(req, MFA_COOKIE);
  clearCookie(res, MFA_COOKIE);
  return token ? PendingMfaLogin.findOneAndDelete({ tokenHash: hashToken(token) }) : null;
}
