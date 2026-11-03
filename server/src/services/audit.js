import { AuditLog } from '../models/AuditLog.js';
import { maskEmail } from './privacy.js';

// Khóa có tên kiểu này không bao giờ được ghi giá trị vào nhật ký, kể cả khi lập trình viên lỡ truyền vào
const SECRET_KEY = /pass|secret|token|hash|cookie|otp|recovery|authorization|api.?key|code$/i;
const MAX_STRING = 300;
const MAX_ENTRIES = 40;
const MAX_DEPTH = 4;

export function sanitizeAuditMeta(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value.toHexString === 'function') return value.toHexString();
  if (depth >= MAX_DEPTH) return '[lược bớt]';
  if (Array.isArray(value)) return value.slice(0, MAX_ENTRIES).map((item) => sanitizeAuditMeta(item, depth + 1));
  if (typeof value === 'object') {
    const entries = Object.entries(value).slice(0, MAX_ENTRIES);
    return Object.fromEntries(entries.map(([key, item]) => [key, SECRET_KEY.test(key) ? '[đã ẩn]' : sanitizeAuditMeta(item, depth + 1)]));
  }
  return String(value);
}

export function adminActor(user) {
  return { type: 'admin', id: user._id, label: maskEmail(user.email) };
}

export function userActor(user) {
  return { type: 'user', id: user._id, label: maskEmail(user.email) };
}

/** Dấu vết cho quản trị viên khi điều tra tài khoản bị chiếm: không có giá trị bí mật, email đã được che */
export function auditAccount(req, user, action, meta) {
  const actor = userActor(user);
  return writeAudit(req, { action, actor, target: { type: 'user', id: user._id, label: actor.label }, meta });
}

function actorFromRequest(req) {
  return req?.admin ? adminActor(req.admin) : { type: 'anonymous', id: undefined, label: '' };
}

/**
 * Ghi một dòng nhật ký kiểm toán. Nhật ký lỗi không được làm hỏng phản hồi đã thực hiện xong, nên lỗi ghi được báo ra log
 * máy chủ với tiền tố cố định để hệ thống giám sát bắt được; dòng log chỉ có tên thao tác, không có dữ liệu.
 */
export async function writeAudit(req, { action, result = 'success', reason = '', target = null, meta = null, actor = null }) {
  const who = actor || actorFromRequest(req);
  try {
    await AuditLog.create({
      action,
      result,
      reason,
      actorType: who.type,
      actorId: who.id,
      actorLabel: who.label,
      targetType: target?.type,
      targetId: target?.id === undefined ? undefined : String(target.id),
      targetLabel: target?.label,
      meta: meta ? sanitizeAuditMeta(meta) : undefined,
      ip: req?.ip,
      userAgent: req?.get ? (req.get('user-agent') || '').slice(0, 200) : undefined,
    });
  } catch (err) {
    console.error(`[audit-write-failed] ${action} (${result}): ${err.name}`);
  }
}
