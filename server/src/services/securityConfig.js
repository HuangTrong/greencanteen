import { env, envFlag, envNumber, isProduction, isWildcardHost, listenHost } from './config.js';

const isLoopbackHost = (host) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host.toLowerCase());
// clamd nói giao thức không mã hóa nên ảnh chỉ được đi trong máy này hoặc mạng nội bộ
const isPrivateHost = (host) => isLoopbackHost(host) || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) || /\.(local|internal|lan)$/i.test(host);

function mongoProblem(uri) {
  const match = /^mongodb(\+srv)?:\/\/(?:([^@/]*)@)?([^/?]*)[^?]*(?:\?(.*))?$/i.exec(uri);
  if (!match) return null;
  const [, srv, credentials, hosts, query = ''] = match;
  if (hosts.split(',').every((entry) => isLoopbackHost(entry.replace(/:\d+$/, '')))) return null;
  if (!credentials) return 'MongoDB ngoài máy này không có tài khoản: ai tới được cổng DB đều đọc, xóa hay mã hóa được dữ liệu';
  const params = new URLSearchParams(query);
  const tls = params.get('tls') ?? params.get('ssl');
  if (tls === 'false' || (!srv && tls !== 'true')) return 'kết nối MongoDB ngoài máy này chưa bật TLS';
  return null;
}

/** Trả về các cấu hình làm yếu lớp vận chuyển hoặc để lộ dữ liệu. Chỉ có tên biến và lý do, không bao giờ có giá trị của biến */
export function securityConfigProblems() {
  const problems = [];
  const add = (key, message) => problems.push({ key, message });

  if (env('NODE_TLS_REJECT_UNAUTHORIZED') === '0') add('NODE_TLS_REJECT_UNAUTHORIZED', 'mọi kết nối TLS đi ra đang bỏ qua kiểm tra chứng chỉ');
  if (/^prod/i.test(env('NODE_ENV')) && !isProduction()) add('NODE_ENV', 'phải viết đúng "production", nếu không cookie Secure và HSTS không bật');
  if (!isProduction()) return problems;

  if (!/^https:\/\//i.test(env('CLIENT_ORIGIN'))) add('CLIENT_ORIGIN', 'cần địa chỉ https: liên kết trong email và CORS đọc từ biến này');
  if (env('COOKIE_SECURE').toLowerCase() === 'false') add('COOKIE_SECURE', 'cookie phiên có thể đi qua HTTP');
  if (envFlag('SMTP_ALLOW_PLAINTEXT')) add('SMTP_ALLOW_PLAINTEXT', 'liên kết đặt lại mật khẩu có thể đi qua SMTP không mã hóa');
  const mongo = mongoProblem(env('MONGODB_URI'));
  if (mongo) add('MONGODB_URI', mongo);
  const clamav = env('CLAMAV_HOST');
  if (!clamav) add('CLAMAV_HOST', 'ảnh tải lên chưa được quét mã độc');
  else if (!isPrivateHost(clamav)) add('CLAMAV_HOST', 'clamd không mã hóa nên chỉ được đặt trong máy này hoặc mạng nội bộ');
  if (isWildcardHost(listenHost())) {
    add('HOST', 'API nhận kết nối trực tiếp trên mọi địa chỉ mạng: chặn cổng bằng tường lửa, hoặc đặt HOST=127.0.0.1 khi proxy chạy cùng máy');
  }
  // Mặc định của mã là 30 phút và 3 lượt/ngày; đặt 0 là tắt hẳn, mở đường cày điểm, lượt quay và móc khóa thật (SEC-02)
  if (envNumber('CHECKIN_COOLDOWN_MINUTES', 30) <= 0) add('CHECKIN_COOLDOWN_MINUTES', 'không có thời gian chờ giữa hai lượt check-in được thưởng');
  if (envNumber('CHECKIN_DAILY_MAX', 3) <= 0) add('CHECKIN_DAILY_MAX', 'không giới hạn số lượt check-in được thưởng mỗi ngày');
  return problems;
}

/** Chỉ cảnh báo, không chặn khởi động: nhiều nơi đặt TLS ở lớp mạng mà ứng dụng không thấy được */
export function logSecurityConfig() {
  const problems = securityConfigProblems();
  if (problems.length) console.error(`Cấu hình chưa an toàn: ${problems.map(({ key, message }) => `${key}: ${message}`).join('; ')}.`);
}
