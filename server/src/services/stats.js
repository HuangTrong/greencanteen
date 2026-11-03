import { CheckIn } from '../models/CheckIn.js';
import { envNumber } from './config.js';
import { PLASTIC_GRAMS_PER_CUP, TREES_SYMBOLIC_DIVISOR } from './gamification.js';

export async function getSchoolStats() {
  const validCheckIns = await CheckIn.countDocuments({ valid: true });
  const plasticSavedGrams = validCheckIns * PLASTIC_GRAMS_PER_CUP;
  const treesProtected = Math.floor(validCheckIns / TREES_SYMBOLIC_DIVISOR);
  return {
    totalCheckIns: validCheckIns,
    plasticSavedGrams,
    treesProtected,
  };
}

const publicCache = new Map();

/**
 * Cache rất ngắn cho API thống kê công khai: ai cũng gọi được mà không cần đăng nhập, và mỗi lần gọi là một truy vấn gộp trên toàn bộ
 * check-in (đo được chậm hơn /api/health gần 40 lần, xem F-64). Yêu cầu đồng thời dùng chung một truy vấn; truy vấn lỗi không bị giữ lại.
 */
export function cachedPublicStats(key, load) {
  const ttlMs = envNumber('STATS_CACHE_SECONDS', 15, { min: 0, max: 300 }) * 1000;
  if (ttlMs === 0) return load();
  const now = Date.now();
  const cached = publicCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  const entry = { value: load(), expiresAt: now + ttlMs };
  publicCache.set(key, entry);
  entry.value.catch(() => {
    if (publicCache.get(key) === entry) publicCache.delete(key);
  });
  return entry.value;
}

/** Dữ liệu vừa đổi: lần đọc sau tính lại. Chỉ có tác dụng trong tiến trình này; tiến trình khác thấy thay đổi chậm nhất sau STATS_CACHE_SECONDS */
export function invalidatePublicStats() {
  publicCache.clear();
}
