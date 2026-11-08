// Đọc biến môi trường lúc gọi (không phải lúc import) vì dotenv.config() chạy sau khi các module được nạp
export const env = (key) => (process.env[key] || '').trim();

export const isProduction = () => env('NODE_ENV') === 'production';

export const envFlag = (key) => ['1', 'true', 'yes', 'on'].includes(env(key).toLowerCase());

/** Số từ biến môi trường, kẹp trong [min, max]; thiếu hoặc sai định dạng → giá trị mặc định */
export function envNumber(key, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = env(key);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.min(Math.max(value, min), max) : fallback;
}

export const clientOrigin = () => env('CLIENT_ORIGIN') || 'http://localhost:5173';

/**
 * Địa chỉ API lắng nghe. Mặc định chỉ loopback: Nginx/Vite cùng máy chuyển tiếp vào, máy khác trong mạng (Wi-Fi trường) không gọi thẳng
 * được cổng API để vòng qua giới hạn ở proxy hay giả X-Forwarded-For. Container / nền tảng như Render cần HOST=0.0.0.0.
 */
export const listenHost = () => env('HOST') || '127.0.0.1';

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::', '[::]', '*']);
export const isWildcardHost = (host) => WILDCARD_HOSTS.has(host);
