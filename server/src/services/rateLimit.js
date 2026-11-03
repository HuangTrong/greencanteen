import net from 'net';
import { RateLimit } from '../models/RateLimit.js';
import { env } from './config.js';

/** Bộ đếm không đọc/ghi được: nơi gọi phải từ chối yêu cầu, không được coi như chưa vượt giới hạn */
export class RateLimitUnavailableError extends Error {
  constructor(name, cause) {
    // Không chép thông điệp gốc: lỗi trùng khóa của MongoDB chứa nguyên khóa bộ đếm, có thể là email
    super(`Bộ đếm giới hạn ${name} không khả dụng (${cause?.codeName || cause?.name || 'lỗi không rõ'}).`);
    this.name = 'RateLimitUnavailableError';
  }
}

const resolve = (value) => (typeof value === 'function' ? value() : value);

/**
 * Giới hạn số lần trong một cửa sổ thời gian, đếm trong MongoDB nên vẫn còn hiệu lực khi server
 * khởi động lại hoặc chạy nhiều tiến trình. max và windowMs có thể là hàm để đọc cấu hình lúc gọi.
 * Giới hạn theo email / tài khoản dùng ngưỡng chặt; giới hạn theo IP dùng ngưỡng rộng vì học sinh trong trường
 * thường dùng chung một IP qua NAT (services/authLimits.js).
 */
export function createRateLimiter({ name, max, windowMs }) {
  const docKey = (key) => `${name}:${String(key).toLowerCase()}`;
  const guarded = (fn) => async (key) => {
    try {
      return await fn(key);
    } catch (err) {
      throw new RateLimitUnavailableError(name, err);
    }
  };

  return {
    get windowMs() {
      return resolve(windowMs);
    },

    isLimited: guarded(async (key) => {
      const bucket = await RateLimit.findOne({ key: docKey(key), resetAt: { $gt: new Date() } }).lean();
      return Boolean(bucket && bucket.count >= resolve(max));
    }),

    /** Ghi nhận một lần; trả về true nếu đã vượt giới hạn (tính cả lần này). Nguyên tử: dùng để giữ chỗ trước khi làm việc tốn kém */
    hit: guarded(async (key) => {
      const now = new Date();
      const active = { $gt: ['$resetAt', now] };
      // Một lệnh cập nhật (pipeline) vừa tăng bộ đếm vừa mở cửa sổ mới khi cửa sổ cũ đã hết → không cần khóa
      const update = [
        {
          $set: {
            count: { $cond: [active, { $add: ['$count', 1] }, 1] },
            resetAt: { $cond: [active, '$resetAt', new Date(now.getTime() + resolve(windowMs))] },
          },
        },
      ];
      let bucket;
      try {
        bucket = await RateLimit.findOneAndUpdate({ key: docKey(key) }, update, { upsert: true, new: true }).lean();
      } catch (err) {
        // Hai yêu cầu đầu tiên cùng upsert một khóa → một bên trùng khóa unique, thử lại sẽ cập nhật bản đã có
        if (Number(err?.code) !== 11000) throw err;
        bucket = await RateLimit.findOneAndUpdate({ key: docKey(key) }, update, { new: true }).lean();
      }
      return (bucket?.count ?? 1) > resolve(max);
    }),

    /** Trả lại một lượt đã giữ chỗ bằng hit() khi hóa ra không nên tính (vd. đăng nhập đúng) */
    release: guarded(async (key) => {
      await RateLimit.updateOne({ key: docKey(key), count: { $gt: 0 } }, { $inc: { count: -1 } });
    }),

    reset: guarded(async (key) => {
      await RateLimit.deleteOne({ key: docKey(key) });
    }),
  };
}

/**
 * Giữ chỗ lần lượt trên nhiều bộ đếm trước khi làm việc tốn kém hoặc nhạy cảm. Bộ đếm nào vượt ngưỡng thì trả lại các lượt đã giữ ở
 * những bộ trước và trả về false. Kiểm tra rồi mới đếm thì nhiều yêu cầu đồng thời cùng lọt qua bước kiểm tra.
 * entries: [[limiter, key], ...]
 */
export async function reserveAll(entries) {
  const held = [];
  for (const [limiter, key] of entries) {
    if (await limiter.hit(key)) {
      await Promise.all(held.map(([heldLimiter, heldKey]) => heldLimiter.release(heldKey)));
      return false;
    }
    held.push([limiter, key]);
  }
  return true;
}

export function tooManyRequests(res, message = 'Bạn thao tác quá nhiều lần. Vui lòng thử lại sau.') {
  return res.status(429).json({ error: message, code: 'too_many_attempts' });
}

/**
 * Khóa giới hạn theo IP. IPv4 dạng ::ffff:a.b.c.d quy về IPv4. IPv6 gộp theo mạng /64: một thiết bị thường được cấp cả dải /64
 * nên nếu tính từng địa chỉ, chỉ cần đổi địa chỉ trong dải là thoát mọi giới hạn.
 */
export function clientIpKey(req) {
  const ip = req.ip;
  if (!ip) return 'unknown';
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  const [address] = ip.split('%');
  if (net.isIP(address) !== 6) return ip;
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(':')}::/64`;
}

const TRUST_EVERYONE = new Set(['true', '*', '0.0.0.0/0', '::/0']);

/**
 * TRUST_PROXY: số proxy phía trước (vd. 1) hoặc địa chỉ / dải của proxy (vd. loopback, 10.0.0.5). Không bao giờ tin mọi nguồn:
 * khi đó client tự đặt X-Forwarded-For là đổi được IP và thoát mọi giới hạn theo IP, nên giá trị như vậy bị coi như không có proxy.
 */
export function trustProxySetting(raw = env('TRUST_PROXY')) {
  const value = raw.trim();
  if (!value || value.toLowerCase() === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value) || false;
  const entries = value.split(',').map((entry) => entry.trim()).filter(Boolean);
  return entries.some((entry) => TRUST_EVERYONE.has(entry.toLowerCase())) ? false : entries;
}

export function logProxyStatus(raw = env('TRUST_PROXY')) {
  const setting = trustProxySetting(raw);
  if (setting === false && raw && !['false', '0'].includes(raw.trim().toLowerCase())) {
    console.error(`TRUST_PROXY=${raw} tin mọi nguồn nên bị bỏ qua: client có thể tự đặt X-Forwarded-For để thoát giới hạn theo IP. Khai báo địa chỉ proxy (vd. loopback, 10.0.0.5) hoặc số proxy.`);
  } else if (typeof setting === 'number') {
    console.warn(`TRUST_PROXY=${setting}: chỉ an toàn khi cổng API không mở trực tiếp ra ngoài. Nên khai báo địa chỉ proxy (vd. loopback, 10.0.0.5) để X-Forwarded-For từ nguồn khác bị bỏ qua.`);
  }
}
