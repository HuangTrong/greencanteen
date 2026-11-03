import crypto from 'crypto';
import { AdminSession } from '../models/AdminSession.js';
import { baseCookieOptions, hashToken, randomToken, readCookie } from './session.js';
import { adminIdleTimeoutMs, adminSessionMaxMs } from './adminConfig.js';

export const ADMIN_COOKIE = 'gc_admin';
// Cookie chỉ được gửi tới API quản trị: các request end-user không bao giờ mang theo phiên admin
const ADMIN_COOKIE_PATH = '/api/admin';
const PENDING_TTL_MS = 5 * 60 * 1000;
// lastSeenAt không cần chính xác tới từng giây; ghi thưa để mỗi request đọc không kéo theo một lần ghi,
// nhưng phải đủ dày so với hạn nhàn rỗi để phiên đang dùng không bị đẩy ra
const TOUCH_INTERVAL_MS = 60 * 1000;

function adminCookieOptions() {
  const { sameSite, secure } = baseCookieOptions();
  return { httpOnly: true, secure, sameSite: sameSite === 'none' ? 'none' : 'strict', path: ADMIN_COOKIE_PATH };
}

function setAdminCookie(res, token, maxAgeMs) {
  res.cookie(ADMIN_COOKIE, token, { ...adminCookieOptions(), maxAge: maxAgeMs });
}

export function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE, adminCookieOptions());
}

/** Token CSRF suy từ token phiên: không lưu trong DB, xoay cùng phiên, không tính được nếu không có cookie httpOnly */
export function adminCsrfToken(req) {
  const token = readCookie(req, ADMIN_COOKIE);
  return token ? csrfFor(token) : null;
}

const csrfFor = (token) => crypto.createHmac('sha256', token).update('gc-admin-csrf').digest('base64url');

/** Phiên hợp lệ của request này, ở bất kỳ giai đoạn nào. Phiên nhàn rỗi quá hạn bị xóa ngay. */
export async function loadAdminSession(req) {
  const token = readCookie(req, ADMIN_COOKIE);
  if (!token) return null;
  const now = Date.now();
  const session = await AdminSession.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date(now) } });
  if (!session) return null;
  if (session.stage === 'active' && now - session.lastSeenAt.getTime() > adminIdleTimeoutMs()) {
    await AdminSession.deleteOne({ _id: session._id });
    return null;
  }
  return session;
}

export async function touchAdminSession(session) {
  const interval = Math.min(TOUCH_INTERVAL_MS, adminIdleTimeoutMs() / 4);
  if (Date.now() - session.lastSeenAt.getTime() < interval) return;
  await AdminSession.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } });
}

/** Sau bước mật khẩu: phiên chờ MFA, sống 5 phút, chưa gọi được API quản trị. Phiên cũ trên trình duyệt này bị thu hồi. */
export async function beginAdminLogin(req, res, user) {
  await revokeCurrentAdminSession(req);
  const token = randomToken();
  const now = new Date();
  await AdminSession.create({
    tokenHash: hashToken(token),
    userId: user._id,
    stage: 'mfa',
    lastSeenAt: now,
    userAgent: (req.get('user-agent') || '').slice(0, 300),
    expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
  });
  setAdminCookie(res, token, PENDING_TTL_MS);
  return csrfFor(token);
}

/**
 * Sau bước MFA: đổi token (chống cố định phiên) và chuyển sang phiên đầy đủ. Mỗi tài khoản chỉ có một phiên quản trị:
 * đăng nhập nơi mới đẩy phiên cũ ra. Vừa qua mật khẩu + MFA nên được tính là đã xác thực lại.
 */
export async function completeAdminLogin(res, session) {
  const token = randomToken();
  const now = new Date();
  const maxAge = adminSessionMaxMs();
  const upgraded = await AdminSession.findOneAndUpdate(
    { _id: session._id, stage: 'mfa' },
    {
      $set: {
        tokenHash: hashToken(token),
        stage: 'active',
        lastSeenAt: now,
        reauthAt: now,
        expiresAt: new Date(now.getTime() + maxAge),
      },
    },
    { new: true }
  );
  if (!upgraded) return null;
  await AdminSession.deleteMany({ userId: session.userId, _id: { $ne: session._id } });
  setAdminCookie(res, token, maxAge);
  return { session: upgraded, csrfToken: csrfFor(token) };
}

export async function revokeCurrentAdminSession(req) {
  const token = readCookie(req, ADMIN_COOKIE);
  if (token) await AdminSession.deleteOne({ tokenHash: hashToken(token) });
}

export async function revokeAdminSessions(userId) {
  const { deletedCount } = await AdminSession.deleteMany({ userId });
  return deletedCount;
}
