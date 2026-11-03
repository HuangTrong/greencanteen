import { envNumber } from '../services/config.js';
import { clientIpKey } from '../services/rateLimit.js';

const WINDOW_MS = 60_000;
const DEFAULT_PER_MINUTE = 3000;
// Dải IP lớn gửi mỗi IP một yêu cầu không được làm đầy bộ nhớ: hết chỗ thì mọi IP mới dùng chung một bộ đếm trong phút đó
const MAX_TRACKED_IPS = 200_000;

let windowStart = 0;
const buckets = new Map();
let overflowCount = 0;

export function resetFloodGuard() {
  windowStart = 0;
  buckets.clear();
  overflowCount = 0;
}

/**
 * Van xả cuối cùng khi một nguồn gửi dồn dập, đếm trong bộ nhớ nên chạy trước khi đọc thân yêu cầu và không tốn truy vấn DB.
 * Ngưỡng rộng vì cả trường có thể dùng chung một IP NAT; nhiều tiến trình thì mỗi tiến trình đếm riêng. Không thay được giới hạn ở
 * reverse proxy hay CDN: lưu lượng phân tán từ nhiều IP không bị lớp này chặn (README.md mục 8.5).
 */
export function floodGuard(req, res, next) {
  const max = envNumber('API_RATE_LIMIT_PER_MINUTE', DEFAULT_PER_MINUTE, { min: 0, max: 10_000_000 });
  if (!max || req.path === '/health') return next();

  const now = Date.now();
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now;
    buckets.clear();
    overflowCount = 0;
  }
  const key = clientIpKey(req);
  let count = buckets.get(key);
  if (count !== undefined) {
    count += 1;
    buckets.set(key, count);
  } else if (buckets.size < MAX_TRACKED_IPS) {
    count = 1;
    buckets.set(key, count);
  } else {
    // Bảng đầy thì chặn theo ngân sách chung, không bỏ qua: nếu không, mỗi địa chỉ mới gửi được không giới hạn
    count = ++overflowCount;
  }
  if (count <= max) return next();

  res.set('Retry-After', String(Math.max(1, Math.ceil((windowStart + WINDOW_MS - now) / 1000))));
  res.status(429).json({ error: 'Bạn gửi quá nhiều yêu cầu. Vui lòng thử lại sau ít phút.', code: 'too_many_requests' });
}
