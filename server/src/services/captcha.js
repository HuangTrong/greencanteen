import crypto from 'crypto';
import { promisify } from 'util';
import { CaptchaChallenge } from '../models/CaptchaChallenge.js';
import { env, envNumber } from './config.js';
import { createRateLimiter } from './rateLimit.js';
import { hashToken, randomToken } from './session.js';

/**
 * CAPTCHA tự chứa kiểu proof-of-work: trình duyệt phải tốn CPU thật để giải, người dùng không phải làm gì và không có dữ liệu nào đi ra
 * dịch vụ ngoài. Dùng PBKDF2 vì trình duyệt tính nó bằng mã gốc: kẻ dò hàng loạt không nhanh hơn người dùng thật nhiều như với SHA-256 đơn.
 * Chỉ làm mỗi lượt dò đắt hơn, không phân biệt được người với máy, nên không thay được ngưỡng theo email, IP và MFA.
 */
const pbkdf2 = promisify(crypto.pbkdf2);

const TTL_MS = 5 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAIL_WINDOW_MS = 60 * 60 * 1000;
const COUNT = { min: 1, max: 1_000_000 };
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const NONCE_PATTERN = /^\d{1,10}$/;

export const captchaMode = () => {
  const mode = env('CAPTCHA_MODE').toLowerCase();
  return mode === 'off' || mode === 'always' ? mode : 'adaptive';
};

// Dò rải qua nhiều IP và nhiều email không chạm ngưỡng riêng nào, chỉ bộ đếm chung thấy được: quá ngưỡng thì mọi đăng nhập đều phải giải,
// nên đây không phải khóa cả trường mà chỉ làm chậm: trình duyệt thật tự giải trong khoảng một giây
const failuresEverywhere = createRateLimiter({ name: 'captcha-login-all', max: () => envNumber('CAPTCHA_GLOBAL_FAILURES', 200, COUNT), windowMs: LOGIN_WINDOW_MS });
const failuresByIp = createRateLimiter({ name: 'captcha-login-ip', max: () => envNumber('CAPTCHA_IP_FAILURES', 20, COUNT), windowMs: LOGIN_WINDOW_MS });
const failuresByEmail = createRateLimiter({ name: 'captcha-login-email', max: 3, windowMs: LOGIN_WINDOW_MS });
const mailEverywhere = createRateLimiter({ name: 'captcha-mail-all', max: () => envNumber('CAPTCHA_GLOBAL_MAIL', 300, COUNT), windowMs: MAIL_WINDOW_MS });
const issuedByIp = createRateLimiter({ name: 'captcha-issue-ip', max: () => envNumber('CAPTCHA_ISSUE_PER_10_MINUTES', 300, COUNT), windowMs: 10 * 60 * 1000 });

/** Đếm theo email người dùng NHẬP, có tài khoản hay không, nên việc bị đòi CAPTCHA không lộ email nào tồn tại */
export async function loginNeedsCaptcha(email, ip) {
  const mode = captchaMode();
  if (mode !== 'adaptive') return mode === 'always';
  const signals = await Promise.all([failuresEverywhere.isLimited('all'), failuresByIp.isLimited(ip), failuresByEmail.isLimited(hashToken(email))]);
  return signals.some(Boolean);
}

export async function noteLoginFailure(email, ip) {
  if (captchaMode() !== 'adaptive') return;
  await Promise.all([failuresEverywhere.hit('all'), failuresByIp.hit(ip), failuresByEmail.hit(hashToken(email))]);
}

/** Đăng ký, quên mật khẩu, gửi lại thư đều gửi email tới địa chỉ do người yêu cầu nhập: chung một bộ đếm để phát hiện gửi hàng loạt */
export async function mailNeedsCaptcha() {
  const mode = captchaMode();
  if (mode !== 'adaptive') return mode === 'always';
  return mailEverywhere.isLimited('all');
}

export async function noteMailRequest() {
  if (captchaMode() === 'adaptive') await mailEverywhere.hit('all');
}

function leadingZeroBits(bytes) {
  let bits = 0;
  for (const byte of bytes) {
    if (byte !== 0) return bits + Math.clz32(byte) - 24;
    bits += 8;
  }
  return bits;
}

/** Trả về null khi IP đã tạo quá nhiều thử thách */
export async function issueCaptcha(ip) {
  if (await issuedByIp.hit(ip)) return null;
  const challenge = randomToken();
  const iterations = envNumber('CAPTCHA_ITERATIONS', 5000, { min: 1, max: 1_000_000 });
  const bits = envNumber('CAPTCHA_DIFFICULTY_BITS', 8, { min: 0, max: 24 });
  const expiresAt = new Date(Date.now() + TTL_MS);
  await CaptchaChallenge.create({ _id: hashToken(challenge), iterations, bits, expiresAt });
  return { challenge, iterations, bits, expiresAt };
}

/** Xóa thử thách trong cùng lệnh tìm: sai một lần là mất, và một lời giải không dùng được cho hai yêu cầu đồng thời */
export async function verifyCaptcha(answer) {
  const { challenge, nonce } = answer && typeof answer === 'object' ? answer : {};
  if (typeof challenge !== 'string' || !CHALLENGE_PATTERN.test(challenge) || typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return false;
  const issued = await CaptchaChallenge.findOneAndDelete({ _id: hashToken(challenge), expiresAt: { $gt: new Date() } });
  if (!issued) return false;
  return leadingZeroBits(await pbkdf2(nonce, challenge, issued.iterations, 32, 'sha256')) >= issued.bits;
}
