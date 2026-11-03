import { Router } from 'express';
import { AuditLog } from '../models/AuditLog.js';
import { adminRead } from '../middleware/admin.js';
import { parsePaging } from '../services/adminQuery.js';

const router = Router();

const ACTION = /^[a-z_.]{1,60}$/;

function parseDay(value, endOfDay) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}+07:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Chỉ có route đọc: nhật ký không sửa, không xóa được qua API
router.get(
  '/',
  adminRead(async (req) => {
    const { page, pageSize, skip } = parsePaging(req.query);
    const { action, result, targetType, targetId, from, to } = req.query;
    const filter = {};
    if (typeof action === 'string' && ACTION.test(action)) filter.action = action;
    if (['success', 'failure', 'denied'].includes(result)) filter.result = result;
    if (typeof targetType === 'string' && ACTION.test(targetType)) filter.targetType = targetType;
    if (typeof targetId === 'string' && /^[a-z0-9_-]{1,40}$/i.test(targetId)) filter.targetId = targetId;
    const start = parseDay(from, false);
    const end = parseDay(to, true);
    if (start || end) filter.createdAt = { ...(start && { $gte: start }), ...(end && { $lte: end }) };

    const [rows, total, actions] = await Promise.all([
      AuditLog.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
      AuditLog.countDocuments(filter),
      AuditLog.distinct('action'),
    ]);
    return {
      items: rows.map((row) => ({
        id: row._id.toString(),
        at: row.createdAt,
        action: row.action,
        result: row.result,
        reason: row.reason || '',
        actorType: row.actorType,
        actorLabel: row.actorLabel || '',
        targetType: row.targetType || '',
        targetId: row.targetId || '',
        targetLabel: row.targetLabel || '',
        meta: row.meta ?? null,
        ip: row.ip || '',
      })),
      page,
      pageSize,
      total,
      actions: actions.sort(),
    };
  })
);

export default router;
