import { Router } from 'express';
import { User } from '../models/User.js';
import { PendingSignup } from '../models/PendingSignup.js';
import { PasswordReset } from '../models/PasswordReset.js';
import { requireAuth, requireOwnStudentId } from '../middleware/auth.js';
import { hashPassword, verifyPassword, verifyPasswordOrDummy } from '../services/password.js';
import { clientIpKey, createRateLimiter, tooManyRequests } from '../services/rateLimit.js';
import { authLimits, changePasswordFailures } from '../services/authLimits.js';
import { auditAccount } from '../services/audit.js';
import { issueCaptcha, loginNeedsCaptcha, mailNeedsCaptcha, noteLoginFailure, noteMailRequest, verifyCaptcha } from '../services/captcha.js';
import { emailStatus, escapeHtml, mailFailureCode, sendEmail } from '../services/email.js';
import { hasPasskey } from '../services/passkeys.js';
import { notifyAccount } from '../services/securityNotice.js';
import { beginMfaLogin, isUserMfaEnabled, verifyUserSecondFactor } from '../services/userMfa.js';
import { VERIFY_FAILURE_CODES, completeRegistration, resendVerification, startRegistration } from '../services/emailVerification.js';
import {
  RESET_CODE_LENGTH,
  RESET_CODE_PATTERN,
  claimResetCode,
  consumeResetRecord,
  isResetCodeEnabled,
  issuePasswordReset,
  normalizeResetCode,
  releaseResetCodeAttempt,
} from '../services/passwordReset.js';
import {
  SESSION_COOKIE,
  clearCookie,
  cookieOptions,
  currentSessionHash,
  getSessionUser,
  hashToken,
  isRecentlyAuthenticated,
  markReauthenticated,
  randomToken,
  readCookie,
  revokeSession,
  revokeUserSessions,
  safeEqual,
  startSession,
} from '../services/session.js';
import {
  PROVIDER_FIELDS,
  accountLocked,
  createOrClaimAccount,
  isPlausibleEmail,
  normalizeEmail,
  normalizeName,
  normalizeStudentId,
  sendAccountError,
  serializeUser,
  validateEmail,
  validateName,
  validatePassword,
  validateStudentId,
} from '../services/accounts.js';
import {
  buildAuthorizationUrl,
  clientOrigin,
  fetchProviderProfile,
  isProviderConfigured,
  isQrLoginEnabled,
} from '../services/oauth.js';

const router = Router();

const OAUTH_COOKIE = 'gc_oauth';
const OAUTH_TTL_MS = 10 * 60 * 1000;
const SIGNUP_COOKIE = 'gc_signup';
const SIGNUP_TTL_MS = 15 * 60 * 1000;
const RESET_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const loginFailures = createRateLimiter({ name: 'login-fail', max: 10, windowMs: 15 * 60 * 1000 });
// Theo IP: chặn dò rải một mật khẩu qua nhiều email. Ngưỡng rộng và chỉ đếm lần sai vì cả trường có thể dùng chung một IP NAT
const loginFailuresByIp = createRateLimiter({
  name: 'login-fail-ip',
  max: () => authLimits().loginIp.max,
  windowMs: () => authLimits().loginIp.windowMs,
});
const registrationsByIp = createRateLimiter({
  name: 'register-ip',
  max: () => authLimits().registerIp.max,
  windowMs: () => authLimits().registerIp.windowMs,
});
const verificationMailsByEmail = createRateLimiter({
  name: 'verify-mail-email',
  max: () => authLimits().verifyEmail.max,
  windowMs: () => authLimits().verifyEmail.windowMs,
});
const verifyFailuresByIp = createRateLimiter({
  name: 'verify-fail-ip',
  max: () => authLimits().loginIp.max,
  windowMs: () => authLimits().loginIp.windowMs,
});
const resetRequestsByEmail = createRateLimiter({ name: 'reset-request-email', max: 5, windowMs: 60 * 60 * 1000 });
const resetRequestsByIp = createRateLimiter({ name: 'reset-request-ip', max: 30, windowMs: 60 * 60 * 1000 });
const resetFailuresByIp = createRateLimiter({ name: 'reset-fail-ip', max: 10, windowMs: 15 * 60 * 1000 });
// Theo email người dùng NHẬP: mỗi email đặt lại có 5 lượt nhập mã và 5 email mỗi giờ, trần này chặn dò dần mã 6 số qua nhiều email trong ngày.
// Bị chặn chỉ khóa đường nhập mã; liên kết trong email (token 256 bit) vẫn dùng được
const resetCodeFailuresByEmail = createRateLimiter({ name: 'reset-code-fail-email', max: 10, windowMs: 24 * 60 * 60 * 1000 });

/** Cần CAPTCHA mà lời giải không hợp lệ thì đã trả lời 403 và trả về false: trình duyệt tự giải rồi gửi lại, người dùng không phải làm gì */
async function passCaptcha(req, res, needed) {
  if (!needed || (await verifyCaptcha(req.body.captcha))) return true;
  res.status(403).json({ error: 'Cần xác minh bạn không phải chương trình tự động. Vui lòng thử lại.', code: 'captcha_required' });
  return false;
}

router.post('/captcha', async (req, res) => {
  try {
    const issued = await issueCaptcha(clientIpKey(req));
    if (!issued) return tooManyRequests(res, 'Mạng của bạn đã yêu cầu xác minh quá nhiều lần. Vui lòng thử lại sau ít phút.');
    res.json(issued);
  } catch (e) {
    sendAccountError(res, e, 'Không thể tạo thử thách xác minh.');
  }
});

router.get('/providers', (_req, res) => {
  const email = emailStatus();
  res.json({
    providers: {
      email: { enabled: true },
      google: { enabled: isProviderConfigured('google') },
      facebook: { enabled: isProviderConfigured('facebook') },
      qr: { enabled: isQrLoginEnabled() },
      // "Quên mật khẩu" cần gửi email; devConsole = chế độ phát triển, email chỉ được in ra log server
      // code: thư có thêm mã 6 số để nhập ngay trong popup (cần ADMIN_MFA_KEY làm khóa HMAC)
      passwordReset: { enabled: email.enabled, devConsole: email.enabled && email.mode === 'console', code: email.enabled && isResetCodeEnabled() },
      // Đăng ký bằng email cần gửi được thư xác minh
      emailVerification: { enabled: email.enabled, devConsole: email.enabled && email.mode === 'console' },
    },
  });
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: serializeUser(req.user) });
});

// ---- Đăng ký email + mật khẩu: chỉ tạo tài khoản sau khi xác minh email (services/emailVerification.js) ----

const REGISTRATION_EMAIL_NOT_CONFIGURED = {
  error: 'Máy chủ chưa cấu hình gửi email nên chưa thể đăng ký bằng email. Vui lòng liên hệ quản trị viên, hoặc dùng Google/Facebook nếu đã được bật.',
  code: 'email_not_configured',
};
const REGISTRATION_SENT_MESSAGE =
  'Chúng tôi đã gửi một email tới địa chỉ bạn vừa nhập. Hãy mở email và làm theo hướng dẫn để hoàn tất; liên kết kích hoạt có hiệu lực 24 giờ.';
const RESEND_MESSAGE = 'Nếu email này đang chờ xác minh, một liên kết mới sẽ được gửi trong vài phút và liên kết cũ sẽ mất hiệu lực.';
const MAIL_LIMIT_MESSAGE = 'Bạn đã yêu cầu gửi email xác minh quá nhiều lần. Vui lòng thử lại sau.';
const REGISTER_IP_LIMIT_MESSAGE = 'Mạng của bạn đã gửi quá nhiều yêu cầu đăng ký. Vui lòng thử lại sau.';

/** Giữ chỗ gửi thư theo IP rồi theo email (email người dùng NHẬP, có tài khoản hay không) nên lỗi giới hạn không lộ gì. Trả về thông báo nếu bị chặn */
async function reserveVerificationMail(ip, email) {
  if (await registrationsByIp.hit(ip)) return REGISTER_IP_LIMIT_MESSAGE;
  if (await verificationMailsByEmail.hit(hashToken(email))) {
    await registrationsByIp.release(ip);
    return MAIL_LIMIT_MESSAGE;
  }
  return null;
}

router.post('/register', async (req, res) => {
  try {
    // Kiểm tra cấu hình và dữ liệu trước mọi tra cứu: hai lỗi này giống hệt nhau dù email, mã SV đã có hay chưa
    const delivery = emailStatus();
    if (!delivery.enabled) return res.status(503).json(REGISTRATION_EMAIL_NOT_CONFIGURED);

    // Khoa/Viện và Lớp cố ý không đọc từ body — đăng ký mới không thu thập các trường này
    const name = normalizeName(req.body.name);
    const studentId = normalizeStudentId(req.body.studentId);
    const email = normalizeEmail(req.body.email);
    const { password } = req.body;
    const invalid =
      validateName(name) || validateStudentId(studentId) || validateEmail(email) || validatePassword(password, { name, studentId, email });
    if (invalid) return res.status(400).json({ error: invalid, code: 'invalid_input' });
    if (!(await passCaptcha(req, res, await mailNeedsCaptcha()))) return undefined;

    const ip = clientIpKey(req);
    const limited = await reserveVerificationMail(ip, email);
    if (limited) return tooManyRequests(res, limited);
    await noteMailRequest();

    try {
      await startRegistration({ name, studentId, email, passwordHash: await hashPassword(password) });
    } catch (e) {
      // Thư chưa đi: trả lại lượt để thử lại được ngay khi SMTP hoạt động trở lại
      if (e.code === 'email_send_failed') {
        await Promise.all([registrationsByIp.release(ip), verificationMailsByEmail.release(hashToken(email))]);
      }
      throw e;
    }
    res.status(202).json({ ok: true, message: REGISTRATION_SENT_MESSAGE, devConsole: delivery.mode === 'console' });
  } catch (e) {
    sendAccountError(res, e, 'Không thể tạo tài khoản.');
  }
});

router.post('/email/verify', async (req, res) => {
  try {
    // Giữ chỗ trước khi chấm mật khẩu như ở /login; kích hoạt đúng trả lại lượt nên không tốn ngân sách của cả mạng
    const ip = clientIpKey(req);
    if (await verifyFailuresByIp.hit(ip)) {
      return tooManyRequests(res, 'Mạng của bạn đã thử quá nhiều liên kết hoặc mật khẩu không đúng. Vui lòng thử lại sau.');
    }
    let result;
    try {
      result = await completeRegistration(req.body);
    } catch (e) {
      if (!VERIFY_FAILURE_CODES.has(e.code)) await verifyFailuresByIp.release(ip);
      throw e;
    }
    await verifyFailuresByIp.release(ip);
    await startSession(req, res, result.user);
    res.status(201).json({ user: serializeUser(result.user), claimed: result.claimed });
  } catch (e) {
    sendAccountError(res, e, 'Không thể kích hoạt tài khoản.');
  }
});

router.post('/email/resend', async (req, res) => {
  try {
    const delivery = emailStatus();
    if (!delivery.enabled) return res.status(503).json(REGISTRATION_EMAIL_NOT_CONFIGURED);

    const email = normalizeEmail(req.body.email);
    const invalid = validateEmail(email);
    if (invalid) return res.status(400).json({ error: invalid, code: 'invalid_input' });
    if (!(await passCaptcha(req, res, await mailNeedsCaptcha()))) return undefined;

    const limited = await reserveVerificationMail(clientIpKey(req), email);
    if (limited) return tooManyRequests(res, limited);
    await noteMailRequest();

    // Trả lời ngay, giống hệt nhau cho mọi email; tra cứu và gửi thư chạy sau → thời gian phản hồi không lộ email nào đang chờ
    res.status(202).json({ ok: true, message: RESEND_MESSAGE, devConsole: delivery.mode === 'console' });
    setImmediate(() => resendVerification(email));
  } catch (e) {
    sendAccountError(res, e, 'Không thể xử lý yêu cầu.');
  }
});

router.post('/login', async (req, res) => {
  try {
    const { password } = req.body;
    // Client cũ gửi mã SV + họ tên để "đăng nhập" — luồng này đã gỡ vì ai cũng gõ được mã của người khác
    if (req.body.studentId !== undefined && password === undefined) {
      return res.status(410).json({
        error:
          'Đăng nhập chỉ bằng mã sinh viên đã ngừng hỗ trợ. Vào trang Cá nhân để đăng nhập bằng email, Google, Facebook hoặc mã QR.',
        code: 'legacy_login_removed',
      });
    }

    const email = normalizeEmail(req.body.email);
    if (!isPlausibleEmail(email) || typeof password !== 'string' || !password || password.length > 256) {
      return res.status(400).json({ error: 'Nhập email và mật khẩu.', code: 'invalid_input' });
    }
    const ip = clientIpKey(req);
    if (!(await passCaptcha(req, res, await loginNeedsCaptcha(email, ip)))) return undefined;

    // Giữ chỗ trong bộ đếm TRƯỚC khi băm: hit() nguyên tử nên nhiều yêu cầu đồng thời không cùng lọt qua bước kiểm tra,
    // và yêu cầu đã vượt ngưỡng không tốn CPU scrypt. Đăng nhập đúng trả lại lượt nên không tốn ngân sách của cả mạng.
    if (await loginFailuresByIp.hit(ip)) {
      const minutes = Math.ceil(loginFailuresByIp.windowMs / 60_000);
      return tooManyRequests(res, `Mạng của bạn có quá nhiều lần đăng nhập sai. Vui lòng thử lại sau ${minutes} phút, hoặc đăng nhập bằng Google, Facebook hay mã QR.`);
    }
    // Khóa bộ đếm theo email luôn là bản băm: ratelimits (và bản sao lưu DB) không giữ email người khác gõ vào (SEC-03)
    const emailKey = hashToken(email);
    if (await loginFailures.hit(emailKey)) {
      await loginFailuresByIp.release(ip);
      return tooManyRequests(res, 'Bạn đã đăng nhập sai quá nhiều lần. Vui lòng thử lại sau 15 phút.');
    }

    const user = await User.findOne({ email }).select('+passwordHash');
    if (!(await verifyPasswordOrDummy(password, user?.passwordHash))) {
      await noteLoginFailure(email, ip);
      return res.status(401).json({
        error: 'Email hoặc mật khẩu không đúng. Nếu bạn đã đăng ký bằng Google/Facebook, hãy dùng nút tương ứng. Nếu bạn vừa đăng ký, hãy mở email xác minh trước.',
        code: 'invalid_credentials',
      });
    }
    await Promise.all([loginFailures.reset(emailKey), loginFailuresByIp.release(ip)]);
    // Chỉ báo sau khi mật khẩu đúng: người ngoài không dò được tài khoản nào đang bị khóa
    if (user.status === 'locked') throw accountLocked();
    if (await isUserMfaEnabled(user._id)) {
      await beginMfaLogin(res, user);
      return res.json({ mfaRequired: true });
    }
    await startSession(req, res, user);
    res.json({ user: serializeUser(user) });
  } catch (e) {
    sendAccountError(res, e, 'Không thể đăng nhập.');
  }
});

router.post('/logout', async (req, res) => {
  try {
    await revokeSession(req);
  } catch (e) {
    console.error(e);
  }
  clearCookie(res, SESSION_COOKIE);
  res.json({ ok: true });
});

router.post('/sessions/revoke-others', requireAuth, async (req, res) => {
  try {
    const revokedSessions = await revokeUserSessions(req.user._id, { exceptHash: currentSessionHash(req) });
    await auditAccount(req, req.user, 'account.sessions_revoked', { revokedSessions });
    res.json({ ok: true, revokedSessions });
  } catch (e) {
    sendAccountError(res, e, 'Không thể đăng xuất các thiết bị khác.');
  }
});

// Xác thực lại trước khi đổi cách đăng nhập: dùng chung ngân sách với đổi mật khẩu để phiên bị đánh cắp không có thêm chỗ dò mật khẩu
router.post('/reauth', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!user?.passwordHash) {
      return res.status(400).json({ error: 'Tài khoản chưa có mật khẩu. Hãy đăng xuất rồi đăng nhập lại bằng Google hoặc Facebook.', code: 'no_password' });
    }
    const limitKey = user._id.toString();
    if (await changePasswordFailures.hit(limitKey)) {
      return tooManyRequests(res, 'Bạn đã nhập sai mật khẩu quá nhiều lần. Vui lòng thử lại sau 15 phút.');
    }
    const { password, code } = req.body;
    if (typeof password !== 'string' || password.length > 256 || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(400).json({ error: 'Mật khẩu không đúng.', code: 'invalid_current_password' });
    }
    // Sau bước này thêm được passkey hay liên kết: thiếu mã 2FA thì kẻ có phiên và mật khẩu tự mở được đường vòng qua 2FA
    if ((await isUserMfaEnabled(user._id)) && !(await verifyUserSecondFactor(req, user, code))) {
      return res.status(400).json({ error: 'Cần mã xác thực hai lớp đúng.', code: 'invalid_mfa_code' });
    }
    await changePasswordFailures.reset(limitKey);
    await markReauthenticated(req);
    res.json({ ok: true });
  } catch (e) {
    sendAccountError(res, e, 'Không thể xác thực lại.');
  }
});

// ---- Mật khẩu: quên / đặt lại qua email, đổi khi đang đăng nhập ----

const FORGOT_PASSWORD_MESSAGE =
  'Nếu email này thuộc một tài khoản GreenCanteen, liên kết đặt lại mật khẩu sẽ được gửi tới hộp thư trong vài phút. Liên kết có hiệu lực 30 phút và chỉ dùng được một lần.';
const FORGOT_PASSWORD_CODE_MESSAGE =
  `Nếu email này thuộc một tài khoản GreenCanteen, mã ${RESET_CODE_LENGTH} số và liên kết đặt lại mật khẩu sẽ được gửi tới hộp thư trong vài phút. Mã và liên kết có hiệu lực 30 phút, chỉ dùng được một lần.`;

const RESET_INVALID = {
  error: 'Liên kết đặt lại mật khẩu không hợp lệ, đã hết hạn hoặc đã được sử dụng. Hãy yêu cầu liên kết mới.',
  code: 'reset_token_invalid',
};
// Một thông báo cho mọi trường hợp (sai mã, hết lượt, hết hạn, email không có tài khoản) → không lộ email nào có tài khoản
const RESET_CODE_INVALID = {
  error: 'Mã không đúng hoặc đã hết hạn. Kiểm tra lại mã trong email mới nhất, hoặc mở liên kết trong email đó.',
  code: 'reset_code_invalid',
};
const RESET_FAILURES_IP_MESSAGE = 'Bạn đã thử quá nhiều liên kết hoặc mã không hợp lệ. Vui lòng thử lại sau 15 phút.';

function passwordResetMail(user, link, code) {
  const text = [
    `Xin chào ${user.name},`,
    '',
    'Có yêu cầu đặt lại mật khẩu cho tài khoản GreenCanteen gắn với email này.',
    ...(code
      ? [
          `Mã đặt lại mật khẩu (hiệu lực 30 phút): ${code}`,
          '',
          'Nhập mã này ở màn hình "Quên mật khẩu" trên GreenCanteen, hoặc mở liên kết sau để đặt mật khẩu mới:',
        ]
      : ['Mở liên kết sau trong vòng 30 phút để đặt mật khẩu mới (liên kết chỉ dùng được một lần):']),
    '',
    link,
    '',
    ...(code ? ['Mã và liên kết chỉ dùng được một lần. Không đưa mã cho bất kỳ ai, kể cả người tự nhận là quản trị viên GreenCanteen.'] : []),
    'Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu hiện tại không thay đổi.',
  ].join('\n');
  const codeHtml = code
    ? `<p>Mã đặt lại mật khẩu, nhập ở màn hình "Quên mật khẩu" (hiệu lực 30 phút):</p>
<p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${escapeHtml(code)}</p>
<p>Hoặc mở liên kết:</p>`
    : '<p>Liên kết có hiệu lực trong 30 phút và chỉ dùng được một lần:</p>';
  const html = `<p>Xin chào ${escapeHtml(user.name)},</p>
<p>Có yêu cầu đặt lại mật khẩu cho tài khoản GreenCanteen gắn với email này.</p>
${codeHtml}
<p><a href="${escapeHtml(link)}">Đặt mật khẩu mới</a></p>
${code ? '<p>Mã và liên kết chỉ dùng được một lần. Không đưa mã cho bất kỳ ai, kể cả người tự nhận là quản trị viên GreenCanteen.</p>\n' : ''}<p>Nếu bạn không yêu cầu, hãy bỏ qua email này — mật khẩu hiện tại không thay đổi.</p>`;
  return { text, html };
}

async function deliverPasswordReset(email) {
  try {
    const user = await User.findOne({ email }).select('_id name email');
    if (!user) return; // không có tài khoản: không làm gì — phản hồi đã gửi trước đó giống hệt trường hợp có tài khoản

    // Chỉ email mới nhất còn hiệu lực: yêu cầu mới thay cả liên kết lẫn mã cũ
    const { token, code } = await issuePasswordReset(user._id);
    // Token nằm sau dấu # → trình duyệt không gửi nó lên server trong request hay header Referer
    const link = `${clientOrigin()}/profile#reset=${token}`;
    const { text, html } = passwordResetMail(user, link, code);
    await sendEmail({ to: user.email, subject: 'Đặt lại mật khẩu GreenCanteen', text, html });
  } catch (err) {
    // Không ghi token, mã hay địa chỉ email vào log
    console.error('Gửi email đặt lại mật khẩu thất bại:', mailFailureCode(err));
  }
}

router.post('/password/forgot', async (req, res) => {
  try {
    // Thiếu cấu hình → báo rõ, không bao giờ báo "đã gửi". Kiểm tra trước khi tra email nên không lộ gì về tài khoản.
    const delivery = emailStatus();
    if (!delivery.enabled) {
      return res.status(503).json({
        error: 'Máy chủ chưa cấu hình gửi email nên chưa thể đặt lại mật khẩu qua email. Vui lòng liên hệ quản trị viên.',
        code: 'email_not_configured',
      });
    }

    const email = normalizeEmail(req.body.email);
    const invalid = validateEmail(email);
    if (invalid) return res.status(400).json({ error: invalid, code: 'invalid_input' });
    if (!(await passCaptcha(req, res, await mailNeedsCaptcha()))) return undefined;

    // Đếm theo email người dùng NHẬP (dù có tài khoản hay không) → lỗi giới hạn cũng không lộ email nào tồn tại
    const [emailLimited, ipLimited] = await Promise.all([
      resetRequestsByEmail.hit(hashToken(email)),
      resetRequestsByIp.hit(clientIpKey(req)),
    ]);
    if (emailLimited || ipLimited) {
      return tooManyRequests(res, 'Bạn đã yêu cầu đặt lại mật khẩu quá nhiều lần. Vui lòng thử lại sau.');
    }
    await noteMailRequest();

    // Trả lời ngay, giống hệt nhau cho mọi email; tra cứu và gửi thư chạy sau → thời gian phản hồi cũng không lộ.
    // codeLength chỉ phụ thuộc cấu hình máy chủ, không phụ thuộc email có tài khoản hay không
    const withCode = isResetCodeEnabled();
    res.status(202).json({
      ok: true,
      message: withCode ? FORGOT_PASSWORD_CODE_MESSAGE : FORGOT_PASSWORD_MESSAGE,
      devConsole: delivery.mode === 'console',
      codeLength: withCode ? RESET_CODE_LENGTH : 0,
    });
    setImmediate(() => deliverPasswordReset(email));
  } catch (e) {
    sendAccountError(res, e, 'Không thể xử lý yêu cầu.');
  }
});

/** Bước chung sau khi liên kết hoặc mã đã được tiêu: lưu mật khẩu, đăng xuất mọi thiết bị, rồi mở phiên mới (hoặc bước 2FA) cho trình duyệt này */
async function finishPasswordReset(req, res, user, password, method) {
  user.passwordHash = await hashPassword(password);
  user.passwordChangedAt = new Date();
  await user.save();
  await PasswordReset.deleteMany({ userId: user._id });
  // Có thể mật khẩu cũ đã lộ → đăng xuất mọi thiết bị, rồi mở phiên mới cho trình duyệt này
  await revokeUserSessions(user._id);
  if (user.email) await loginFailures.reset(hashToken(user.email));
  await auditAccount(req, user, 'account.password_reset', { method });
  notifyAccount(user, 'password_reset');
  if (user.status === 'locked') throw accountLocked();
  // Chiếm được hộp thư không được đồng nghĩa với vượt qua 2FA
  if (await isUserMfaEnabled(user._id)) {
    await beginMfaLogin(res, user);
    return res.json({ mfaRequired: true });
  }
  await startSession(req, res, user);
  return res.json({ user: serializeUser(user) });
}

router.post('/password/reset', async (req, res) => {
  try {
    const ip = clientIpKey(req);
    if (await resetFailuresByIp.isLimited(ip)) return tooManyRequests(res, RESET_FAILURES_IP_MESSAGE);
    const { token, password } = req.body;
    const invalidPassword = validatePassword(password);
    if (invalidPassword) return res.status(400).json({ error: invalidPassword, code: 'invalid_input' });
    if (typeof token !== 'string' || !RESET_TOKEN_PATTERN.test(token)) {
      await resetFailuresByIp.hit(ip);
      return res.status(400).json(RESET_INVALID);
    }

    const active = { tokenHash: hashToken(token), expiresAt: { $gt: new Date() } };
    const pending = await PasswordReset.findOne(active);
    const owner = pending && (await User.findById(pending.userId));
    // Chưa tiêu liên kết: chọn mật khẩu khác thì dùng lại được ngay
    const personal = owner && validatePassword(password, owner);
    if (personal) return res.status(400).json({ error: personal, code: 'invalid_input' });

    // Tìm và xóa trong cùng một lệnh → liên kết chỉ dùng được một lần kể cả khi gửi đồng thời
    const reset = owner && (await PasswordReset.findOneAndDelete(active));
    const user = reset && owner;
    if (!user) {
      await resetFailuresByIp.hit(ip);
      return res.status(400).json(RESET_INVALID);
    }
    return await finishPasswordReset(req, res, user, password, 'link');
  } catch (e) {
    sendAccountError(res, e, 'Không thể đặt lại mật khẩu.');
  }
});

// Mã 6 số trong cùng email: đặt mật khẩu ngay trong popup, không cần mở liên kết trên đúng thiết bị đang đăng nhập
router.post('/password/reset-code', async (req, res) => {
  try {
    if (!isResetCodeEnabled()) {
      return res.status(503).json({ error: 'Máy chủ chưa bật mã đặt lại mật khẩu. Hãy mở liên kết trong email.', code: 'reset_code_unavailable' });
    }
    const ip = clientIpKey(req);
    if (await resetFailuresByIp.isLimited(ip)) return tooManyRequests(res, RESET_FAILURES_IP_MESSAGE);
    const { password } = req.body;
    const email = normalizeEmail(req.body.email);
    const code = normalizeResetCode(req.body.code);
    const invalid = validateEmail(email) || validatePassword(password);
    if (invalid) return res.status(400).json({ error: invalid, code: 'invalid_input' });

    // Đếm theo email người dùng NHẬP (có tài khoản hay không) nên lỗi giới hạn không lộ gì
    const emailKey = hashToken(email);
    if (await resetCodeFailuresByEmail.isLimited(emailKey)) {
      return tooManyRequests(res, 'Đã nhập sai mã quá nhiều lần với email này. Hãy mở liên kết trong email đặt lại mật khẩu, hoặc thử lại sau 24 giờ.');
    }
    const fail = async () => {
      await Promise.all([resetFailuresByIp.hit(ip), resetCodeFailuresByEmail.hit(emailKey)]);
      return res.status(400).json(RESET_CODE_INVALID);
    };
    if (!RESET_CODE_PATTERN.test(code)) return await fail();

    const user = await User.findOne({ email });
    const record = await claimResetCode(user?._id, code);
    if (!user || !record) return await fail();

    // Chỉ kiểm tra mật khẩu theo thông tin cá nhân SAU khi đúng mã: làm trước thì lỗi này lộ email có tài khoản và họ tên của chủ tài khoản
    const personal = validatePassword(password, user);
    if (personal) {
      await releaseResetCodeAttempt(record);
      return res.status(400).json({ error: personal, code: 'invalid_input' });
    }
    if (!(await consumeResetRecord(record))) return await fail();
    await resetCodeFailuresByEmail.reset(emailKey);
    return await finishPasswordReset(req, res, user, password, 'code');
  } catch (e) {
    sendAccountError(res, e, 'Không thể đặt lại mật khẩu.');
  }
});

router.post('/password/change', requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = await User.findById(req.user._id).select('+passwordHash');
    if (!user?.passwordHash) {
      return res.status(400).json({
        error: user?.email
          ? 'Tài khoản chưa có mật khẩu. Dùng "Quên mật khẩu" với email của tài khoản để đặt mật khẩu.'
          : 'Tài khoản này đăng nhập bằng Google/Facebook/QR và chưa có mật khẩu.',
        code: 'no_password',
      });
    }

    const invalid = validatePassword(newPassword, user);
    if (invalid) return res.status(400).json({ error: invalid, code: 'invalid_input' });

    // Giữ chỗ trước khi băm: phiên bị đánh cắp không dò được mật khẩu bằng nhiều yêu cầu đồng thời
    const limitKey = user._id.toString();
    if (await changePasswordFailures.hit(limitKey)) {
      return tooManyRequests(res, 'Bạn đã nhập sai mật khẩu hiện tại quá nhiều lần. Vui lòng thử lại sau 15 phút.');
    }
    if (typeof currentPassword !== 'string' || !(await verifyPassword(currentPassword, user.passwordHash))) {
      return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng.', code: 'invalid_current_password' });
    }
    if (currentPassword === newPassword) {
      await changePasswordFailures.release(limitKey);
      return res.status(400).json({ error: 'Mật khẩu mới phải khác mật khẩu hiện tại.', code: 'invalid_input' });
    }

    user.passwordHash = await hashPassword(newPassword);
    user.passwordChangedAt = new Date();
    await user.save();
    await changePasswordFailures.reset(limitKey);
    await PasswordReset.deleteMany({ userId: user._id });
    // Giữ phiên hiện tại, đăng xuất các thiết bị khác
    const revokedSessions = await revokeUserSessions(user._id, { exceptHash: currentSessionHash(req) });
    await auditAccount(req, user, 'account.password_change', { revokedSessions });
    notifyAccount(user, 'password_changed');
    res.json({ ok: true, revokedSessions, user: serializeUser(user) });
  } catch (e) {
    sendAccountError(res, e, 'Không thể đổi mật khẩu.');
  }
});

// ---- Hủy liên kết nhà cung cấp: cách duy nhất để đuổi một liên kết lạ khỏi tài khoản ----

router.delete('/providers/:provider', requireAuth, async (req, res) => {
  try {
    const { provider } = req.params;
    if (!Object.hasOwn(PROVIDER_FIELDS, provider)) return res.status(404).json({ error: 'Không tìm thấy API.', code: 'not_found' });
    if (!(await isRecentlyAuthenticated(req))) {
      return res.status(403).json({ error: 'Cần xác thực lại trước khi hủy liên kết.', code: 'reauth_required' });
    }
    const field = PROVIDER_FIELDS[provider];
    if (!req.user[field]) return res.status(409).json({ error: 'Tài khoản chưa liên kết phương thức này.', code: 'not_linked' });

    // Điều kiện nằm trong cùng lệnh cập nhật: hai yêu cầu đồng thời không làm tài khoản mất hết phương thức đăng nhập
    const remaining = ['passwordChangedAt', ...Object.values(PROVIDER_FIELDS).filter((other) => other !== field)];
    const keepsAnother = (await hasPasskey(req.user._id)) ? {} : { $or: remaining.map((other) => ({ [other]: { $exists: true } })) };
    const user = await User.findOneAndUpdate(
      { _id: req.user._id, [field]: { $exists: true }, ...keepsAnother },
      { $unset: { [field]: 1 } },
      { new: true }
    );
    if (!user) {
      return res.status(409).json({ error: 'Không thể hủy phương thức đăng nhập cuối cùng. Hãy đặt mật khẩu hoặc liên kết phương thức khác trước.', code: 'last_login_method' });
    }
    // Phiên mở bằng liên kết này có thể là của kẻ đã gắn nó vào: chỉ giữ thiết bị đang thao tác
    await revokeUserSessions(user._id, { exceptHash: currentSessionHash(req) });
    await auditAccount(req, user, 'account.provider_unlink', { provider });
    notifyAccount(user, `${provider}_unlinked`);
    res.json({ ok: true, user: serializeUser(user) });
  } catch (e) {
    sendAccountError(res, e, 'Không thể hủy liên kết.');
  }
});

// ---- Google / Facebook OAuth (authorization code flow, xử lý hoàn toàn phía server) ----

for (const provider of Object.keys(PROVIDER_FIELDS)) {
  router.get(`/${provider}/start`, (req, res) => oauthStart(provider, req, res));
  router.get(`/${provider}/callback`, (req, res) => oauthCallback(provider, req, res));
}

/** Kết quả OAuth trả về trang Cá nhân bằng mã ngắn — client tự hiển thị thông báo tương ứng */
function redirectToProfile(res, params) {
  const url = new URL('/profile', clientOrigin());
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  res.redirect(url.toString());
}

async function oauthStart(provider, req, res) {
  try {
    const mode = req.query.mode === 'link' ? 'link' : 'login';
    // Thiếu cấu hình → báo rõ cho người dùng, không bao giờ giả lập đăng nhập thành công
    if (!isProviderConfigured(provider)) {
      return redirectToProfile(res, { auth_error: 'provider_not_configured', provider });
    }
    if (mode === 'link' && !(await getSessionUser(req))) {
      return redirectToProfile(res, { auth_error: 'login_required', provider });
    }
    if (mode === 'link' && !(await isRecentlyAuthenticated(req))) {
      return redirectToProfile(res, { auth_error: 'reauth_required', provider });
    }

    const state = randomToken();
    const codeVerifier = randomToken(48);
    // Cookie nằm ở trình duyệt nên không tin được: sessionHash buộc luồng liên kết vào đúng phiên đã bắt đầu nó
    const sessionHash = mode === 'link' ? currentSessionHash(req) : undefined;
    res.cookie(OAUTH_COOKIE, JSON.stringify({ provider, state, codeVerifier, mode, sessionHash }), cookieOptions(OAUTH_TTL_MS));
    res.redirect(buildAuthorizationUrl(provider, { state, codeVerifier }));
  } catch (e) {
    console.error(e);
    redirectToProfile(res, { auth_error: 'oauth_failed', provider });
  }
}

function readOAuthCookie(req) {
  try {
    return JSON.parse(readCookie(req, OAUTH_COOKIE) || 'null');
  } catch {
    return null;
  }
}

async function oauthCallback(provider, req, res) {
  const saved = readOAuthCookie(req);
  clearCookie(res, OAUTH_COOKIE);
  try {
    const { code, state, error } = req.query;
    if (error) {
      const cancelled = error === 'access_denied' || req.query.error_reason === 'user_denied';
      return redirectToProfile(res, { auth_error: cancelled ? 'oauth_cancelled' : 'oauth_failed', provider });
    }
    // state phải khớp giá trị lưu trong cookie httpOnly lúc bắt đầu → chống CSRF / gắn nhầm phiên đăng nhập
    if (
      !saved ||
      saved.provider !== provider ||
      typeof saved.state !== 'string' ||
      typeof state !== 'string' ||
      typeof code !== 'string' ||
      !safeEqual(saved.state, state)
    ) {
      return redirectToProfile(res, { auth_error: 'invalid_state', provider });
    }
    if (!isProviderConfigured(provider)) {
      return redirectToProfile(res, { auth_error: 'provider_not_configured', provider });
    }

    const profile = await fetchProviderProfile(provider, { code, codeVerifier: saved.codeVerifier });
    const field = PROVIDER_FIELDS[provider];
    const linkedUser = await User.findOne({ [field]: profile.providerId });

    if (saved.mode === 'link') {
      const current = await getSessionUser(req);
      if (!current) return redirectToProfile(res, { auth_error: 'login_required', provider });
      if (typeof saved.sessionHash !== 'string' || !safeEqual(saved.sessionHash, currentSessionHash(req))) {
        return redirectToProfile(res, { auth_error: 'invalid_state', provider });
      }
      if (!(await isRecentlyAuthenticated(req))) return redirectToProfile(res, { auth_error: 'reauth_required', provider });
      if (linkedUser && !linkedUser._id.equals(current._id)) {
        return redirectToProfile(res, { auth_error: 'provider_already_linked', provider });
      }
      if (current[field] && current[field] !== profile.providerId) {
        return redirectToProfile(res, { auth_error: 'different_account_linked', provider });
      }
      if (!linkedUser) {
        current[field] = profile.providerId;
        try {
          await current.save();
        } catch (e) {
          if (Number(e?.code) !== 11000) throw e;
          return redirectToProfile(res, { auth_error: 'provider_already_linked', provider });
        }
        await auditAccount(req, current, 'account.provider_link', { provider });
        notifyAccount(current, `${provider}_linked`);
      }
      return redirectToProfile(res, { auth: 'linked', provider });
    }

    if (linkedUser) {
      if (linkedUser.status === 'locked') return redirectToProfile(res, { auth_error: 'account_locked', provider });
      // Nhà cung cấp chỉ là bước một: tài khoản đã bật 2FA vẫn phải nhập mã, nếu không đường này vòng qua được 2FA
      if (await isUserMfaEnabled(linkedUser._id)) {
        await beginMfaLogin(res, linkedUser, { reauthenticated: true });
        return redirectToProfile(res, { auth: 'mfa_required', provider });
      }
      await startSession(req, res, linkedUser, { reauthenticated: true });
      return redirectToProfile(res, { auth: 'success', provider });
    }

    // Email của nhà cung cấp trùng một tài khoản sẵn có → không tạo tài khoản trùng và cũng không tự gộp
    // (email đăng ký bằng mật khẩu chưa được xác minh, gộp tự động có thể giao tài khoản cho người khác)
    if (profile.email && (await User.exists({ email: profile.email }))) {
      return redirectToProfile(res, { auth_error: 'email_in_use', provider });
    }

    // Danh tính mới: giữ tạm phía server, người dùng nhập họ tên + mã sinh viên để hoàn tất
    const token = randomToken();
    await PendingSignup.create({
      tokenHash: hashToken(token),
      provider,
      providerId: profile.providerId,
      email: profile.emailVerified && profile.email ? profile.email : undefined,
      name: profile.name.slice(0, 80),
      expiresAt: new Date(Date.now() + SIGNUP_TTL_MS),
    });
    res.cookie(SIGNUP_COOKIE, token, cookieOptions(SIGNUP_TTL_MS));
    redirectToProfile(res, { auth: 'complete_signup', provider });
  } catch (e) {
    console.error(`${provider} OAuth callback failed:`, e.message);
    redirectToProfile(res, { auth_error: 'oauth_failed', provider });
  }
}

// ---- Hoàn tất đăng ký sau Google/Facebook ----

const SIGNUP_EXPIRED = {
  error: 'Phiên đăng ký đã hết hạn. Vui lòng chọn lại Google hoặc Facebook.',
  code: 'signup_expired',
};

async function findPendingSignup(req) {
  const token = readCookie(req, SIGNUP_COOKIE);
  if (!token) return null;
  return PendingSignup.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } });
}

router.get('/signup/pending', async (req, res) => {
  try {
    const pending = await findPendingSignup(req);
    if (!pending) return res.status(404).json(SIGNUP_EXPIRED);
    res.json({ provider: pending.provider, name: pending.name, email: pending.email || '' });
  } catch (e) {
    sendAccountError(res, e, 'Lỗi máy chủ.');
  }
});

router.post('/signup/complete', async (req, res) => {
  try {
    const pending = await findPendingSignup(req);
    if (!pending) return res.status(410).json(SIGNUP_EXPIRED);

    const name = normalizeName(req.body.name);
    const studentId = normalizeStudentId(req.body.studentId);
    const invalid = validateName(name) || validateStudentId(studentId);
    if (invalid) return res.status(400).json({ error: invalid, code: 'invalid_input' });
    // Mã SV đã có trả về lỗi rõ ràng vì danh tính đã được nhà cung cấp xác thực; giới hạn để không thành chỗ dò mã SV hàng loạt
    if (await registrationsByIp.hit(clientIpKey(req))) return tooManyRequests(res, REGISTER_IP_LIMIT_MESSAGE);

    const credentials = { [PROVIDER_FIELDS[pending.provider]]: pending.providerId };
    if (pending.email && !(await User.exists({ email: pending.email }))) credentials.email = pending.email;

    const { user, claimed } = await createOrClaimAccount({
      name,
      studentId,
      claimCode: req.body.claimCode,
      credentials,
    });
    await PendingSignup.deleteOne({ _id: pending._id });
    clearCookie(res, SIGNUP_COOKIE);
    await startSession(req, res, user, { reauthenticated: true });
    res.status(201).json({ user: serializeUser(user), claimed });
  } catch (e) {
    sendAccountError(res, e, 'Không thể tạo tài khoản.');
  }
});

router.delete('/signup/pending', async (req, res) => {
  try {
    const token = readCookie(req, SIGNUP_COOKIE);
    if (token) await PendingSignup.deleteOne({ tokenHash: hashToken(token) });
  } catch (e) {
    console.error(e);
  }
  clearCookie(res, SIGNUP_COOKIE);
  res.json({ ok: true });
});

// Giữ route cũ cho tương thích, nhưng chỉ trả hồ sơ của chính người đang đăng nhập
router.get('/user/:studentId', requireAuth, requireOwnStudentId, (req, res) => {
  res.json({ user: serializeUser(req.user) });
});

export default router;
