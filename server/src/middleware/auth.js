import { getSessionUser } from '../services/session.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CLIENT_HEADER_VALUE = 'GreenCanteen';

/**
 * Chống CSRF cho API dùng cookie: mọi request thay đổi dữ liệu phải có header X-Requested-With.
 * Trang web khác không gửi được header tùy chỉnh nếu CORS không cho phép (chỉ CLIENT_ORIGIN được phép).
 */
export function requireClientHeader(req, res, next) {
  if (SAFE_METHODS.has(req.method) || req.get('x-requested-with') === CLIENT_HEADER_VALUE) return next();
  res.status(403).json({ error: 'Yêu cầu không hợp lệ.', code: 'csrf_rejected' });
}

export async function requireAuth(req, res, next) {
  try {
    req.user = await getSessionUser(req);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
  if (!req.user) {
    return res.status(401).json({ error: 'Bạn cần đăng nhập để tiếp tục.', code: 'auth_required' });
  }
  next();
}

/** Route cũ nhận :studentId trên URL — chỉ trả dữ liệu của chính tài khoản đang đăng nhập */
export function requireOwnStudentId(req, res, next) {
  if (req.params.studentId !== req.user.studentId) {
    return res.status(403).json({ error: 'Bạn chỉ xem được dữ liệu của tài khoản mình.', code: 'forbidden' });
  }
  next();
}
