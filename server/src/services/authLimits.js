import { envNumber } from './config.js';
import { createRateLimiter } from './rateLimit.js';

const COUNT = { min: 1, max: 1_000_000 };
const MINUTES = { min: 1, max: 24 * 60 };
const minutes = (key, fallback) => envNumber(key, fallback, MINUTES) * 60_000;

/**
 * Ngưỡng theo IP phải rộng: một trường có thể đi Internet qua đúng một IP NAT. Chỉ lần đăng nhập SAI mới bị đếm, đăng nhập đúng
 * không tốn ngân sách. Cách chọn ngưỡng theo sĩ số: README.md mục 8.9. Đọc lúc gọi vì dotenv chạy sau khi module được nạp.
 */
export const authLimits = () => ({
  loginIp: { max: envNumber('AUTH_LOGIN_IP_MAX', 100, COUNT), windowMs: minutes('AUTH_LOGIN_IP_WINDOW_MINUTES', 15) },
  registerIp: { max: envNumber('AUTH_REGISTER_IP_MAX', 100, COUNT), windowMs: minutes('AUTH_REGISTER_IP_WINDOW_MINUTES', 60) },
  verifyEmail: { max: envNumber('AUTH_VERIFY_EMAIL_MAX', 5, COUNT), windowMs: minutes('AUTH_VERIFY_EMAIL_WINDOW_MINUTES', 60) },
});

/** Mọi chỗ nhập lại mật khẩu khi đang có phiên dùng chung một ngân sách: phiên bị đánh cắp không có thêm chỗ dò mật khẩu */
export const changePasswordFailures = createRateLimiter({ name: 'change-password-fail', max: 5, windowMs: 15 * 60 * 1000 });
