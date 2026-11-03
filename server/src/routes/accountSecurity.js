import { Router } from 'express';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { accountLocked, sendAccountError, serializeUser } from '../services/accounts.js';
import { auditAccount } from '../services/audit.js';
import { changePasswordFailures } from '../services/authLimits.js';
import { verifyPassword } from '../services/password.js';
import { finishLogin, finishRegistration, listPasskeys, loginOptions, registrationOptions, removePasskey } from '../services/passkeys.js';
import { clientIpKey, createRateLimiter, tooManyRequests } from '../services/rateLimit.js';
import { notifyAccount } from '../services/securityNotice.js';
import { currentSessionHash, isRecentlyAuthenticated, revokeUserSessions, startSession } from '../services/session.js';
import {
  clearPendingMfaLogin,
  disableUserMfa,
  findPendingMfaLogin,
  finishUserMfa,
  isUserMfaAvailable,
  isUserMfaEnabled,
  recoveryCodesLeft,
  replaceRecoveryCodes,
  startUserMfa,
  verifyUserSecondFactor,
} from '../services/userMfa.js';

const router = Router();

const WINDOW_MS = 15 * 60 * 1000;
const OBJECT_ID = /^[a-f0-9]{24}$/i;
// Mã 6 chữ số nên giới hạn chặt và theo tài khoản: đổi trình duyệt hay IP không có thêm lượt đoán
const mfaFailures = createRateLimiter({ name: 'user-mfa-fail', max: 5, windowMs: WINDOW_MS });
const passkeyFailures = createRateLimiter({ name: 'passkey-fail-ip', max: 20, windowMs: WINDOW_MS });
const passkeyLogins = createRateLimiter({ name: 'passkey-options-ip', max: 60, windowMs: 10 * 60 * 1000 });

const INVALID_MFA = { error: 'Mã xác thực không đúng hoặc đã được dùng.', code: 'invalid_mfa_code' };
const MFA_EXPIRED = { error: 'Lượt đăng nhập đã hết hạn. Hãy đăng nhập lại.', code: 'mfa_expired' };
const MFA_LOCKED = 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.';
const MFA_NOT_CONFIGURED = { error: 'Máy chủ chưa cấu hình xác thực hai lớp. Vui lòng liên hệ quản trị viên.', code: 'mfa_not_configured' };

/** Giữ cookie phiên chưa đủ để đổi cách đăng nhập: phải vừa nhập lại mật khẩu hoặc vừa đăng nhập từ nhà cung cấp */
async function requireRecentAuth(req, res, next) {
  try {
    if (await isRecentlyAuthenticated(req)) return next();
    res.status(403).json({ error: 'Cần xác thực lại trước khi thay đổi cài đặt bảo mật.', code: 'reauth_required' });
  } catch (e) {
    sendAccountError(res, e, 'Lỗi máy chủ.');
  }
}

/**
 * Tắt 2FA hay đổi mã khôi phục đều phải kèm mã ngay trong yêu cầu, nên mật khẩu đi cùng yêu cầu đó: gọi /reauth trước sẽ tiêu mã của
 * bước TOTP hiện tại và người dùng phải chờ mã kế tiếp. Không gửi mật khẩu thì như requireRecentAuth.
 */
async function requireRecentAuthOrPassword(req, res, next) {
  const { password } = req.body;
  if (password === undefined) return requireRecentAuth(req, res, next);
  try {
    const user = await User.findById(req.user._id).select('+passwordHash');
    const limitKey = user._id.toString();
    if (await changePasswordFailures.hit(limitKey)) return tooManyRequests(res, 'Bạn đã nhập sai mật khẩu quá nhiều lần. Vui lòng thử lại sau 15 phút.');
    if (typeof password !== 'string' || password.length > 256 || !user.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(400).json({ error: 'Mật khẩu không đúng.', code: 'invalid_current_password' });
    }
    await changePasswordFailures.reset(limitKey);
    next();
  } catch (e) {
    sendAccountError(res, e, 'Không thể xác thực lại.');
  }
}

/** Mã 2FA đúng hay không, có giới hạn thử. Đã trả lời thì trả về false */
async function passSecondFactor(req, res) {
  const limitKey = req.user._id.toString();
  if (await mfaFailures.hit(limitKey)) {
    tooManyRequests(res, MFA_LOCKED);
    return false;
  }
  if (!(await verifyUserSecondFactor(req, req.user, req.body.code))) {
    res.status(400).json(INVALID_MFA);
    return false;
  }
  await mfaFailures.reset(limitKey);
  return true;
}

router.get('/security', requireAuth, async (req, res) => {
  try {
    const { _id: userId } = req.user;
    res.json({
      mfa: { available: isUserMfaAvailable(), enabled: await isUserMfaEnabled(userId), recoveryCodesLeft: await recoveryCodesLeft(userId) },
      passkeys: await listPasskeys(userId),
    });
  } catch (e) {
    sendAccountError(res, e, 'Không tải được cài đặt bảo mật.');
  }
});

// ---- Xác thực hai lớp ----

router.post('/mfa/setup', requireAuth, requireRecentAuth, async (req, res) => {
  try {
    if (!isUserMfaAvailable()) return res.status(503).json(MFA_NOT_CONFIGURED);
    if (await isUserMfaEnabled(req.user._id)) {
      return res.status(409).json({ error: 'Tài khoản đã bật xác thực hai lớp.', code: 'mfa_already_enabled' });
    }
    res.json(await startUserMfa(req.user));
  } catch (e) {
    sendAccountError(res, e, 'Không bắt đầu được thiết lập.');
  }
});

router.post('/mfa/enable', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const limitKey = user._id.toString();
    if (await mfaFailures.hit(limitKey)) return tooManyRequests(res, MFA_LOCKED);
    const recoveryCodes = await finishUserMfa(user, req.body.code);
    if (!recoveryCodes) return res.status(400).json(INVALID_MFA);
    await mfaFailures.reset(limitKey);
    // Bật 2FA thường vì lo tài khoản bị lộ: phiên đang mở ở nơi khác không được giữ lại
    await revokeUserSessions(user._id, { exceptHash: currentSessionHash(req) });
    await auditAccount(req, user, 'account.mfa_enable');
    notifyAccount(user, 'mfa_enabled');
    res.json({ recoveryCodes });
  } catch (e) {
    sendAccountError(res, e, 'Không bật được xác thực hai lớp.');
  }
});

router.post('/mfa/disable', requireAuth, requireRecentAuthOrPassword, async (req, res) => {
  try {
    if (!(await passSecondFactor(req, res))) return undefined;
    await disableUserMfa(req.user._id);
    await auditAccount(req, req.user, 'account.mfa_disable');
    notifyAccount(req.user, 'mfa_disabled');
    res.json({ ok: true });
  } catch (e) {
    sendAccountError(res, e, 'Không tắt được xác thực hai lớp.');
  }
});

router.post('/mfa/recovery-codes', requireAuth, requireRecentAuthOrPassword, async (req, res) => {
  try {
    if (!(await passSecondFactor(req, res))) return undefined;
    const recoveryCodes = await replaceRecoveryCodes(req.user._id);
    await auditAccount(req, req.user, 'account.mfa_recovery_regenerate');
    res.json({ recoveryCodes });
  } catch (e) {
    sendAccountError(res, e, 'Không tạo được mã khôi phục mới.');
  }
});

/** Bước hai của đăng nhập: chỉ cookie chờ, chưa có phiên. Xem services/userMfa.js */
router.post('/mfa/verify', async (req, res) => {
  try {
    const pending = await findPendingMfaLogin(req);
    if (!pending) return res.status(401).json(MFA_EXPIRED);
    const limitKey = pending.userId.toString();
    if (await mfaFailures.hit(limitKey)) return tooManyRequests(res, MFA_LOCKED);

    const user = await User.findById(pending.userId);
    if (!user) return res.status(401).json(MFA_EXPIRED);
    if (user.status === 'locked') throw accountLocked();
    if (!(await verifyUserSecondFactor(req, user, req.body.code))) return res.status(401).json(INVALID_MFA);

    await mfaFailures.reset(limitKey);
    const consumed = await clearPendingMfaLogin(req, res);
    if (!consumed) return res.status(401).json(MFA_EXPIRED);
    await startSession(req, res, user, { reauthenticated: consumed.reauthenticated });
    res.json({ user: serializeUser(user) });
  } catch (e) {
    sendAccountError(res, e, 'Không xác thực được.');
  }
});

// ---- Passkey ----

router.post('/passkeys/register/options', requireAuth, requireRecentAuth, async (req, res) => {
  try {
    res.json(await registrationOptions(res, req.user));
  } catch (e) {
    sendAccountError(res, e, 'Không bắt đầu được đăng ký passkey.');
  }
});

router.post('/passkeys/register/verify', requireAuth, requireRecentAuth, async (req, res) => {
  try {
    const passkey = await finishRegistration(req, res, req.user, req.body.response, req.body.name);
    await auditAccount(req, req.user, 'account.passkey_add');
    notifyAccount(req.user, 'passkey_added');
    res.status(201).json({ passkey });
  } catch (e) {
    sendAccountError(res, e, 'Không đăng ký được passkey.');
  }
});

router.delete('/passkeys/:id', requireAuth, requireRecentAuth, async (req, res) => {
  try {
    const removed = OBJECT_ID.test(req.params.id) ? await removePasskey(req.user, req.params.id) : null;
    if (!removed) return res.status(404).json({ error: 'Không tìm thấy passkey.', code: 'not_found' });
    await auditAccount(req, req.user, 'account.passkey_remove');
    notifyAccount(req.user, 'passkey_removed');
    res.json({ ok: true });
  } catch (e) {
    sendAccountError(res, e, 'Không xóa được passkey.');
  }
});

router.post('/passkeys/login/options', async (req, res) => {
  try {
    if (await passkeyLogins.hit(clientIpKey(req))) return tooManyRequests(res, 'Mạng của bạn đã thử đăng nhập quá nhiều lần. Vui lòng thử lại sau ít phút.');
    res.json(await loginOptions(res));
  } catch (e) {
    sendAccountError(res, e, 'Không bắt đầu được đăng nhập bằng passkey.');
  }
});

// Chữ ký passkey cần sinh trắc hoặc PIN trên thiết bị nên đã gồm hai yếu tố: không hỏi thêm mã 2FA
router.post('/passkeys/login/verify', async (req, res) => {
  try {
    const ip = clientIpKey(req);
    if (await passkeyFailures.hit(ip)) return tooManyRequests(res, 'Mạng của bạn đã thử quá nhiều lần. Vui lòng thử lại sau 15 phút.');
    const user = await finishLogin(req, res, req.body.response);
    await passkeyFailures.release(ip);
    if (user.status === 'locked') throw accountLocked();
    await startSession(req, res, user, { reauthenticated: true });
    await auditAccount(req, user, 'account.passkey_login');
    res.json({ user: serializeUser(user) });
  } catch (e) {
    sendAccountError(res, e, 'Không đăng nhập được bằng passkey.');
  }
});

export default router;
