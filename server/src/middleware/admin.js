import { User } from '../models/User.js';
import { writeAudit } from '../services/audit.js';
import { toAdminError } from '../services/adminErrors.js';
import { adminReauthWindowMs, isAdminConfigured } from '../services/adminConfig.js';
import { adminCsrfToken, loadAdminSession, revokeAdminSessions, touchAdminSession } from '../services/adminSession.js';
import { isMfaEnrolled } from '../services/adminMfa.js';
import { safeEqual } from '../services/session.js';
import { createRateLimiter, tooManyRequests } from '../services/rateLimit.js';
import { clientOrigin } from '../services/config.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const adminReads = createRateLimiter({ name: 'admin-api', max: 600, windowMs: 5 * 60 * 1000 });
const adminWrites = createRateLimiter({ name: 'admin-write', max: 120, windowMs: 5 * 60 * 1000 });

/** Phản hồi quản trị không được nằm trong bất kỳ cache nào và không được lập chỉ mục (Cache-Control đã đặt cho toàn /api) */
export function adminResponseHeaders(_req, res, next) {
  res.set({
    Pragma: 'no-cache',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  next();
}

/** Lớp phụ cho CSRF: request ghi từ trình duyệt luôn có Origin và phải đúng địa chỉ frontend */
export function requireAdminOrigin(req, res, next) {
  const origin = req.get('origin');
  if (SAFE_METHODS.has(req.method) || !origin || origin === clientOrigin()) return next();
  res.status(403).json({ error: 'Yêu cầu không hợp lệ.', code: 'csrf_rejected' });
}

/** Chưa có ADMIN_MFA_KEY hợp lệ thì không ai vào được khu quản trị */
export function requireAdminConfigured(_req, res, next) {
  if (isAdminConfigured()) return next();
  res.status(503).json({ error: 'Khu quản trị chưa được cấu hình trên máy chủ.', code: 'admin_not_configured' });
}

const AUTH_REQUIRED = { error: 'Cần đăng nhập quản trị.', code: 'admin_auth_required' };

/**
 * Xác thực và phân quyền cho mọi API quản trị. Vai trò, trạng thái tài khoản và MFA được đọc lại từ DB ở từng request nên
 * việc thu hồi quyền có hiệu lực ngay. Phiên end-user (gc_session) không có tác dụng ở đây.
 */
export async function requireAdmin(req, res, next) {
  try {
    const session = await loadAdminSession(req);
    if (session?.stage !== 'active') return res.status(401).json(AUTH_REQUIRED);
    const user = await User.findById(session.userId);
    if (user?.role !== 'admin' || user.status === 'locked' || !(await isMfaEnrolled(user._id))) {
      await revokeAdminSessions(session.userId);
      return res.status(401).json(AUTH_REQUIRED);
    }
    await touchAdminSession(session);
    req.admin = user;
    req.adminSession = session;
    next();
  } catch (err) {
    sendAdminError(res, err);
  }
}

/** Token CSRF theo phiên, bắt buộc với mọi request ghi kèm phiên quản trị */
export function requireAdminCsrf(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const expected = adminCsrfToken(req);
  const given = req.get('x-csrf-token');
  if (expected && given && safeEqual(expected, given)) return next();
  res.status(403).json({ error: 'Phiên làm việc không hợp lệ. Tải lại trang rồi thử lại.', code: 'csrf_rejected' });
}

export async function limitAdminApi(req, res, next) {
  try {
    const key = req.admin._id;
    const limited = SAFE_METHODS.has(req.method) ? await adminReads.hit(key) : await adminWrites.hit(key);
    if (limited) return tooManyRequests(res, 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.');
    next();
  } catch (err) {
    sendAdminError(res, err);
  }
}

/**
 * Thao tác nhạy cảm: phải vừa nhập lại mật khẩu + mã MFA trong khoảng ADMIN_REAUTH_MINUTES. Lần bị chặn cũng được ghi: đây là dấu vết
 * đầu tiên khi một phiên quản trị bị đánh cắp thử chạm vào dữ liệu nhạy cảm. Chỉ ghi đường dẫn, không ghi tham số truy vấn.
 */
export async function requireReauth(req, res, next) {
  const at = req.adminSession.reauthAt?.getTime() || 0;
  if (Date.now() - at <= adminReauthWindowMs()) return next();
  await writeAudit(req, {
    action: 'admin.reauth_required',
    result: 'denied',
    reason: 'reauth_required',
    meta: { method: req.method, path: req.originalUrl.split('?')[0] },
  });
  res.status(403).json({ error: 'Cần xác thực lại trước khi thực hiện thao tác này.', code: 'reauth_required' });
}

export function sendAdminError(res, err) {
  const known = toAdminError(err);
  res.status(known.status).json({ error: known.message, code: known.code, ...known.extra });
}

/** Route chỉ đọc */
export function adminRead(handler) {
  return async (req, res) => {
    try {
      res.json(await handler(req));
    } catch (err) {
      sendAdminError(res, err);
    }
  };
}

const auditResult = (status) => (status === 403 || status === 409 ? 'denied' : 'failure');

/**
 * Route ghi dữ liệu: luôn ghi nhật ký kiểm toán, cả khi thành công lẫn thất bại, trước khi trả phản hồi.
 * handler(req, ctx) đặt ctx.target (đối tượng) và ctx.meta (chi tiết, đã được lọc bí mật), ctx.status nếu khác 200.
 */
export function adminAction(action, handler) {
  return async (req, res) => {
    const ctx = { status: 200, target: null, meta: null };
    try {
      const body = await handler(req, ctx);
      await writeAudit(req, { action, target: ctx.target, meta: ctx.meta });
      res.status(ctx.status).json(body);
    } catch (err) {
      const known = toAdminError(err);
      await writeAudit(req, { action, result: auditResult(known.status), reason: known.code, target: ctx.target, meta: ctx.meta });
      sendAdminError(res, known);
    }
  };
}
