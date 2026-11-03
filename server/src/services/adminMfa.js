import { AdminMfa } from '../models/AdminMfa.js';
import { generateClaimCode } from './accounts.js';
import { adminMfaKey } from './adminConfig.js';
import { secondFactorStore } from './secondFactor.js';
import { generateTotpSecret, totpUri } from './totp.js';

const ENROLL_CODE_TTL_MS = 24 * 60 * 60 * 1000;

const store = secondFactorStore(AdminMfa, adminMfaKey);

export const isMfaEnrolled = store.isEnabled;
export const finishEnrollment = store.finish;
export const verifySecondFactor = store.verify;

/** Cấp mã đăng ký MFA dùng một lần và xóa thiết lập MFA cũ. Mã chỉ trả về ở đây, DB giữ HMAC. */
export async function issueEnrollCode(userId) {
  const enrollCode = generateClaimCode();
  const expiresAt = new Date(Date.now() + ENROLL_CODE_TTL_MS);
  await AdminMfa.updateOne(
    { userId },
    {
      $set: { enrollCodeHash: store.codeHash(enrollCode), enrollCodeExpiresAt: expiresAt },
      $unset: { secretEnc: 1, pendingSecretEnc: 1, enabledAt: 1, lastUsedStep: 1, recoveryCodeHashes: 1 },
    },
    { upsert: true }
  );
  return { enrollCode, expiresAt };
}

/** Bước đầu đăng ký: cần mã đăng ký hợp lệ. Secret được giữ ở trạng thái chờ cho tới khi xác nhận bằng một mã TOTP đúng. */
export async function startEnrollment(user, enrollCode) {
  if (typeof enrollCode !== 'string' || !enrollCode) return null;
  const secret = generateTotpSecret();
  const started = await AdminMfa.findOneAndUpdate(
    {
      userId: user._id,
      enabledAt: null,
      enrollCodeHash: store.codeHash(enrollCode),
      enrollCodeExpiresAt: { $gt: new Date() },
    },
    { $set: { pendingSecretEnc: store.seal(secret, user._id) } }
  );
  if (!started) return null;
  return { secret, otpauthUri: totpUri({ secret, account: user.email }) };
}

export async function removeMfa(userId) {
  await AdminMfa.deleteOne({ userId });
}
