import crypto from 'crypto';
import { AdminSession } from '../models/AdminSession.js';
import { PendingMfaLogin } from '../models/PendingMfaLogin.js';
import { QrLogin } from '../models/QrLogin.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';

export const SESSION_COOKIE = 'gc_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REAUTH_WINDOW_MS = 10 * 60 * 1000;

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * COOKIE_SAMESITE=lax (mặc định, client và API cùng site) hoặc none (khác site — bắt buộc HTTPS).
 * Không đặt maxAge ở đây: Express 4 sẽ không xóa được cookie nếu clearCookie nhận maxAge.
 */
export function baseCookieOptions() {
  const sameSite = process.env.COOKIE_SAMESITE === 'none' ? 'none' : 'lax';
  const secure =
    sameSite === 'none' ||
    process.env.COOKIE_SECURE === 'true' ||
    (process.env.COOKIE_SECURE !== 'false' && process.env.NODE_ENV === 'production');
  return { httpOnly: true, sameSite, secure, path: '/' };
}

export function cookieOptions(maxAgeMs) {
  return { ...baseCookieOptions(), maxAge: maxAgeMs };
}

export function clearCookie(res, name) {
  res.clearCookie(name, baseCookieOptions());
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0 || part.slice(0, idx).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(idx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

async function findSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  return token ? Session.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }) : null;
}

export async function getSessionUser(req) {
  const session = await findSession(req);
  if (!session) return null;
  const user = await User.findById(session.userId);
  // Tài khoản bị khóa không dùng được phiên nào, kể cả phiên cấp ở một luồng đăng nhập chưa kiểm tra trạng thái
  return user?.status === 'locked' ? null : user;
}

/**
 * Thay đổi cách đăng nhập không được dựa vào riêng cookie phiên: ai lấy được cookie sẽ gắn thêm cửa vào tài khoản và giữ được nó sau
 * khi chủ tài khoản đặt lại mật khẩu. Phiên chỉ được tính là vừa xác thực khi vừa nhập lại mật khẩu hoặc vừa đăng nhập từ nhà cung cấp.
 */
export async function isRecentlyAuthenticated(req) {
  const at = (await findSession(req))?.reauthAt?.getTime() || 0;
  return Date.now() - at <= REAUTH_WINDOW_MS;
}

export async function markReauthenticated(req) {
  await Session.updateOne({ tokenHash: currentSessionHash(req) }, { $set: { reauthAt: new Date() } });
}

export async function revokeSession(req) {
  const token = readCookie(req, SESSION_COOKIE);
  if (token) await Session.deleteOne({ tokenHash: hashToken(token) });
}

export function currentSessionHash(req) {
  const token = readCookie(req, SESSION_COOKIE);
  return token ? hashToken(token) : null;
}

/**
 * Thu hồi mọi phiên của tài khoản (trừ phiên exceptHash nếu có) — dùng khi đổi / đặt lại mật khẩu, khóa tài khoản.
 * Phiên quản trị luôn bị thu hồi hết: nó không được sống lâu hơn thông tin đăng nhập đã tạo ra nó. QR đã xác nhận nhưng chưa nhận
 * phiên và lượt đăng nhập đang chờ mã 2FA cũng là phiên sắp được cấp nên bị hủy theo.
 */
export async function revokeUserSessions(userId, { exceptHash = null } = {}) {
  const filter = exceptHash ? { userId, tokenHash: { $ne: exceptHash } } : { userId };
  const [{ deletedCount }] = await Promise.all([
    Session.deleteMany(filter),
    AdminSession.deleteMany({ userId }),
    QrLogin.deleteMany({ userId, status: 'approved' }),
    PendingMfaLogin.deleteMany({ userId }),
  ]);
  return deletedCount;
}

/** Tạo phiên mới (thu hồi phiên cũ trên trình duyệt này nếu có) và đặt cookie httpOnly. reauthenticated: danh tính vừa được nhà cung cấp xác nhận */
export async function startSession(req, res, user, { reauthenticated = false } = {}) {
  await revokeSession(req);
  const token = randomToken();
  await Session.create({
    tokenHash: hashToken(token),
    userId: user._id,
    userAgent: (req.get('user-agent') || '').slice(0, 300),
    ...(reauthenticated && { reauthAt: new Date() }),
    expiresAt: new Date(Date.now() + SESSION_TTL_MS),
  });
  res.cookie(SESSION_COOKIE, token, cookieOptions(SESSION_TTL_MS));
}
