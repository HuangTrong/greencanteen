import { Router } from 'express';
import { User } from '../models/User.js';
import { adminCsrfToken, beginAdminLogin, clearAdminCookie, completeAdminLogin, loadAdminSession, revokeCurrentAdminSession } from '../services/adminSession.js';
import { finishEnrollment, isMfaEnrolled, startEnrollment, verifySecondFactor } from '../services/adminMfa.js';
import { adminOptions, hasPasskey, verifyAdminPasskey } from '../services/passkeys.js';
import { adminIdleTimeoutMs, adminReauthWindowMs } from '../services/adminConfig.js';
import { AdminSession } from '../models/AdminSession.js';
import { adminActor, writeAudit } from '../services/audit.js';
import { isPlausibleEmail, normalizeEmail } from '../services/accounts.js';
import { verifyPassword, verifyPasswordOrDummy } from '../services/password.js';
import { clientIpKey, createRateLimiter, reserveAll, tooManyRequests } from '../services/rateLimit.js';
import { maskEmail } from '../services/privacy.js';
import { hashToken } from '../services/session.js';
import { limitAdminApi, requireAdmin, requireAdminCsrf, sendAdminError } from '../middleware/admin.js';

const router = Router();

const WINDOW_MS = 15 * 60 * 1000;
// Khóa theo cặp email + IP để kẻ khác khó khóa chéo quản trị viên; hai bộ đếm rộng hơn chặn dò rải và dò phân tán
const loginByPair = createRateLimiter({ name: 'admin-login-pair', max: 5, windowMs: WINDOW_MS });
const loginByEmail = createRateLimiter({ name: 'admin-login-email', max: 20, windowMs: WINDOW_MS });
const loginByIp = createRateLimiter({ name: 'admin-login-ip', max: 30, windowMs: WINDOW_MS });
const mfaFailures = createRateLimiter({ name: 'admin-mfa-fail', max: 5, windowMs: WINDOW_MS });
const enrollFailures = createRateLimiter({ name: 'admin-enroll-fail', max: 5, windowMs: WINDOW_MS });
const reauthFailures = createRateLimiter({ name: 'admin-reauth-fail', max: 5, windowMs: WINDOW_MS });

const INVALID_CREDENTIALS = { error: 'Email hoặc mật khẩu không đúng.', code: 'invalid_credentials' };
const INVALID_MFA = { error: 'Mã xác thực không đúng hoặc đã được dùng.', code: 'invalid_mfa_code' };
const MFA_LOCKED = 'Bạn đã nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.';

const serializeAdmin = (user) => ({ id: user._id.toString(), name: user.name, email: maskEmail(user.email) });

function sessionState(session) {
  return {
    stage: session.stage,
    expiresAt: session.expiresAt,
    idleTimeoutMs: adminIdleTimeoutMs(),
    reauthValidUntil: session.reauthAt ? new Date(session.reauthAt.getTime() + adminReauthWindowMs()) : null,
  };
}

/** Phiên đang chờ MFA của request này (đã qua mật khẩu) */
async function requirePendingMfa(req, res, next) {
  try {
    const session = await loadAdminSession(req);
    const user = session?.stage === 'mfa' ? await User.findById(session.userId) : null;
    if (user?.role !== 'admin' || user.status === 'locked') {
      return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Hãy nhập lại mật khẩu.', code: 'admin_auth_required' });
    }
    req.pendingSession = session;
    req.pendingUser = user;
    next();
  } catch (err) {
    sendAdminError(res, err);
  }
}

router.get('/session', async (req, res) => {
  try {
    const session = await loadAdminSession(req);
    const user = session && (await User.findById(session.userId));
    if (user?.role !== 'admin' || user.status === 'locked') return res.json({ stage: 'none' });
    res.json({
      ...sessionState(session),
      csrfToken: adminCsrfToken(req),
      mfaEnrolled: await isMfaEnrolled(user._id),
      passkeyAvailable: session.stage === 'mfa' && Boolean(await hasPasskey(user._id)),
      admin: session.stage === 'active' ? serializeAdmin(user) : null,
    });
  } catch (err) {
    sendAdminError(res, err);
  }
});

router.post('/login', async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;
    if (!isPlausibleEmail(email) || typeof password !== 'string' || !password || password.length > 256) {
      return res.status(400).json({ error: 'Nhập email và mật khẩu.', code: 'invalid_input' });
    }

    const ip = clientIpKey(req);
    // Khóa bộ đếm là bản băm: ratelimits không giữ email (hay cặp email|IP) người khác gõ vào (SEC-03)
    const emailKey = hashToken(email);
    const pairKey = hashToken(`${email}|${ip}`);
    // Giữ chỗ TRƯỚC khi băm: nhiều yêu cầu đồng thời không cùng lọt qua bước kiểm tra, và yêu cầu đã vượt ngưỡng không tốn CPU scrypt
    if (!(await reserveAll([[loginByIp, ip], [loginByEmail, emailKey], [loginByPair, pairKey]]))) {
      return tooManyRequests(res, MFA_LOCKED);
    }

    // Luôn băm mật khẩu kể cả khi email lạ: không lộ tài khoản nào tồn tại hay có quyền qua nội dung hoặc thời gian phản hồi
    const user = await User.findOne({ email }).select('+passwordHash');
    const passwordOk = await verifyPasswordOrDummy(password, user?.passwordHash);
    if (!passwordOk || user.role !== 'admin' || user.status === 'locked') {
      await writeAudit(req, {
        action: 'admin.login',
        result: 'failure',
        reason: !passwordOk ? 'invalid_credentials' : user.role !== 'admin' ? 'not_admin' : 'account_locked',
        actor: { type: 'anonymous', label: maskEmail(email) },
      });
      return res.status(401).json(INVALID_CREDENTIALS);
    }

    await Promise.all([loginByPair.reset(pairKey), loginByEmail.release(emailKey), loginByIp.release(ip)]);
    const csrfToken = await beginAdminLogin(req, res, user);
    res.json({ stage: 'mfa', mfaEnrolled: await isMfaEnrolled(user._id), passkeyAvailable: Boolean(await hasPasskey(user._id)), csrfToken });
  } catch (err) {
    sendAdminError(res, err);
  }
});

router.post('/mfa/setup', requirePendingMfa, requireAdminCsrf, async (req, res) => {
  const user = req.pendingUser;
  try {
    if (await isMfaEnrolled(user._id)) {
      return res.status(409).json({ error: 'Tài khoản đã đăng ký MFA.', code: 'mfa_already_enrolled' });
    }
    if (await enrollFailures.hit(user._id)) return tooManyRequests(res, MFA_LOCKED);
    const enrollment = await startEnrollment(user, req.body.enrollCode);
    if (!enrollment) {
      await writeAudit(req, { action: 'admin.mfa_enroll', result: 'failure', reason: 'invalid_enroll_code', actor: adminActor(user) });
      return res.status(400).json({ error: 'Mã đăng ký không đúng hoặc đã hết hạn.', code: 'invalid_enroll_code' });
    }
    await enrollFailures.reset(user._id);
    res.json(enrollment);
  } catch (err) {
    sendAdminError(res, err);
  }
});

router.post('/mfa/verify', requirePendingMfa, requireAdminCsrf, async (req, res) => {
  const user = req.pendingUser;
  const actor = adminActor(user);
  try {
    // Giữ chỗ trước khi chấm: TOTP chỉ có 6 chữ số, chấm rồi mới đếm thì một loạt yêu cầu đồng thời thử được nhiều mã hơn giới hạn
    if (await mfaFailures.hit(user._id)) return tooManyRequests(res, MFA_LOCKED);

    const enrolled = await isMfaEnrolled(user._id);
    const recoveryCodes = enrolled ? null : await finishEnrollment(user, req.body.code);
    const passed = enrolled ? await verifySecondFactor(user._id, req.body.code) : Boolean(recoveryCodes);
    if (!passed) {
      await writeAudit(req, { action: 'admin.login', result: 'failure', reason: 'invalid_mfa_code', actor });
      return res.status(401).json(INVALID_MFA);
    }

    await mfaFailures.reset(user._id);
    const login = await completeAdminLogin(res, req.pendingSession);
    if (!login) return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Hãy nhập lại mật khẩu.', code: 'admin_auth_required' });

    if (recoveryCodes) await writeAudit(req, { action: 'admin.mfa_enroll', actor });
    await writeAudit(req, { action: 'admin.login', actor });
    res.json({
      ...sessionState(login.session),
      csrfToken: login.csrfToken,
      mfaEnrolled: true,
      admin: serializeAdmin(user),
      ...(recoveryCodes && { recoveryCodes }),
    });
  } catch (err) {
    sendAdminError(res, err);
  }
});

/** Passkey thay cho mã TOTP ở bước hai. Lần đăng nhập đầu vẫn phải đăng ký MFA bằng mã do người cấp quyền trao */
router.post('/passkey/options', requirePendingMfa, requireAdminCsrf, async (req, res) => {
  try {
    const options = (await isMfaEnrolled(req.pendingUser._id)) ? await adminOptions(res, req.pendingUser) : null;
    if (!options) return res.status(404).json({ error: 'Tài khoản chưa có passkey.', code: 'not_found' });
    res.json(options);
  } catch (err) {
    sendAdminError(res, err);
  }
});

router.post('/passkey/verify', requirePendingMfa, requireAdminCsrf, async (req, res) => {
  const user = req.pendingUser;
  const actor = adminActor(user);
  try {
    if (await mfaFailures.hit(user._id)) return tooManyRequests(res, MFA_LOCKED);
    const enrolled = await isMfaEnrolled(user._id);
    if (!enrolled || !(await verifyAdminPasskey(req, res, user, req.body.response))) {
      await writeAudit(req, { action: 'admin.login', result: 'failure', reason: 'invalid_passkey', actor });
      return res.status(401).json({ error: 'Không xác minh được passkey.', code: 'passkey_invalid' });
    }
    await mfaFailures.reset(user._id);
    const login = await completeAdminLogin(res, req.pendingSession);
    if (!login) return res.status(401).json({ error: 'Phiên đăng nhập đã hết hạn. Hãy nhập lại mật khẩu.', code: 'admin_auth_required' });
    await writeAudit(req, { action: 'admin.login', actor, meta: { method: 'passkey' } });
    res.json({ ...sessionState(login.session), csrfToken: login.csrfToken, mfaEnrolled: true, admin: serializeAdmin(user) });
  } catch (err) {
    sendAdminError(res, err);
  }
});

/** Xác thực lại trước thao tác nhạy cảm: mật khẩu và mã MFA đều phải đúng */
router.post('/reauth', requireAdmin, requireAdminCsrf, limitAdminApi, async (req, res) => {
  const limitKey = req.admin._id;
  try {
    if (await reauthFailures.hit(limitKey)) return tooManyRequests(res, MFA_LOCKED);
    const { password, code } = req.body;
    const user = await User.findById(req.admin._id).select('+passwordHash');
    const passwordOk = typeof password === 'string' && password.length <= 256 && (await verifyPassword(password, user.passwordHash));
    if (!passwordOk || !(await verifySecondFactor(user._id, code))) {
      await writeAudit(req, { action: 'admin.reauth', result: 'failure', reason: passwordOk ? 'invalid_mfa_code' : 'invalid_password' });
      return res.status(401).json({ error: 'Mật khẩu hoặc mã xác thực không đúng.', code: 'reauth_failed' });
    }
    await reauthFailures.reset(limitKey);
    const reauthAt = new Date();
    await AdminSession.updateOne({ _id: req.adminSession._id }, { $set: { reauthAt } });
    await writeAudit(req, { action: 'admin.reauth' });
    res.json({ reauthValidUntil: new Date(reauthAt.getTime() + adminReauthWindowMs()) });
  } catch (err) {
    sendAdminError(res, err);
  }
});

router.post('/logout', async (req, res) => {
  try {
    const session = await loadAdminSession(req);
    const user = session?.stage === 'active' ? await User.findById(session.userId) : null;
    await revokeCurrentAdminSession(req);
    if (user) await writeAudit(req, { action: 'admin.logout', actor: adminActor(user) });
  } catch (err) {
    console.error(err);
  }
  clearAdminCookie(res);
  res.json({ ok: true });
});

export default router;
