import { AuditLog } from '../models/AuditLog.js';
import { AuditOutbox } from '../models/AuditOutbox.js';
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

function auditFields(req, { action, result, reason = '', target = null, meta = null, actor = null }) {
  const who = actor || actorFromRequest(req);
  return {
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
  };
}

/**
 * Ghi một dòng nhật ký kiểm toán. Nhật ký lỗi không được làm hỏng phản hồi đã thực hiện xong, nên lỗi ghi được báo ra log
 * máy chủ với tiền tố cố định để hệ thống giám sát bắt được; dòng log chỉ có tên thao tác, không có dữ liệu.
 */
export async function writeAudit(req, { action, result = 'success', reason = '', target = null, meta = null, actor = null }) {
  try {
    await AuditLog.create(auditFields(req, { action, result, reason, target, meta, actor }));
  } catch (err) {
    console.error(`[audit-write-failed] ${action} (${result}): ${err.name}`);
  }
}

/**
 * SEC-07: thao tác ghi của quản trị viên ghi dấu vết TRƯỚC khi chạy. Không ghi được thì hàm ném lỗi và nơi gọi không được chạy
 * thao tác (fail-closed): mọi thay đổi đều có dấu vết, kể cả khi server dừng ngay sau đó.
 */
export async function beginAudit(req, action) {
  const fields = auditFields(req, { action });
  delete fields.result; // chưa biết kết quả
  return AuditOutbox.create(fields);
}

/**
 * Chuyển dấu vết thành dòng nhật ký có kết quả (cùng _id nên lần khôi phục không ghi trùng) rồi xóa dấu vết. Không bao giờ ném lỗi:
 * thao tác đã xong. Ghi nhật ký thất bại → dấu vết ở lại kèm kết quả, flushAuditOutbox ghi nốt.
 */
export async function finishAudit(req, intent, { result, reason = '', target = null, meta = null }) {
  const fields = auditFields(req, { action: intent.action, result, reason, target, meta });
  try {
    await AuditLog.create({ ...fields, _id: intent._id });
  } catch (err) {
    if (Number(err?.code) === 11000) {
      // Thao tác chạy quá lâu, lần khôi phục đã ghi dấu vết này là "không rõ kết quả" → ghi thêm dòng có kết quả thật
      await writeAudit(req, { action: intent.action, result, reason, target, meta });
    } else {
      console.error(`[audit-write-failed] ${intent.action} (${result}): ${err.name}`);
      await AuditOutbox.updateOne({ _id: intent._id }, { $set: fields }).catch((updateErr) =>
        console.error(`[audit-write-failed] ${intent.action} (giữ kết quả): ${updateErr.name}`)
      );
      return;
    }
  }
  await AuditOutbox.deleteOne({ _id: intent._id }).catch(() => {}); // còn sót thì lần khôi phục gặp trùng _id và chỉ xóa
}

/**
 * Chuyển các dấu vết còn lại (cũ hơn olderThanMs, để không đụng thao tác đang chạy) thành nhật ký. Dấu vết không có kết quả → nhật
 * ký ghi failure / outcome_unknown: thao tác có thể đã thay đổi dữ liệu. Dòng nhật ký mang thời điểm ghi (lúc khôi phục, nên luôn
 * nằm ở đầu danh sách mới nhất), thời điểm bắt đầu thao tác nằm trong meta.startedAt. Trả về số dòng nhật ký đã ghi.
 */
export async function flushAuditOutbox({ olderThanMs = 60_000 } = {}) {
  const pending = await AuditOutbox.find({ createdAt: { $lte: new Date(Date.now() - olderThanMs) } })
    .sort({ createdAt: 1 })
    .limit(500)
    .lean();
  let written = 0;
  for (const { _id, result, reason, createdAt, meta, ...rest } of pending) {
    try {
      await AuditLog.create({
        ...rest,
        _id,
        result: result || 'failure',
        reason: result ? reason || '' : 'outcome_unknown',
        meta: { ...(meta && typeof meta === 'object' ? meta : {}), startedAt: createdAt?.toISOString?.() ?? null, recoveredFromOutbox: true },
      });
      written += 1;
    } catch (err) {
      if (Number(err?.code) !== 11000) {
        console.error(`[audit-write-failed] ${rest.action} (khôi phục): ${err.name}`);
        continue;
      }
    }
    await AuditOutbox.deleteOne({ _id });
  }
  return written;
}
