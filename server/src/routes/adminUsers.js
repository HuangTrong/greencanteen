import { Router } from 'express';
import { adminAction, adminRead, requireReauth } from '../middleware/admin.js';
import { AdminError, invalidInput } from '../services/adminErrors.js';
import { writeAudit } from '../services/audit.js';
import {
  changeRole,
  changeStudentId,
  getUserDetail,
  removeUserAvatar,
  requireReason,
  resetAdminMfa,
  resetStudentMfa,
  revealUser,
  searchUsers,
  setUserStatus,
} from '../services/adminUsers.js';
import { maskEmail, maskStudentId } from '../services/privacy.js';
import { createRateLimiter } from '../services/rateLimit.js';
import { notifyAdmins } from '../services/securityNotice.js';

const router = Router();

const OBJECT_ID = /^[a-f0-9]{24}$/i;
const MAX_BULK = 50;
const userTarget = (id, label) => ({ type: 'user', id, label });
// Hỗ trợ từng trường hợp không cần nhiều hơn thế; phiên quản trị bị lạm dụng không rút được cả danh sách email qua route này
const reveals = createRateLimiter({ name: 'admin-reveal', max: 30, windowMs: 60 * 60 * 1000 });

router.param('id', (req, res, next, id) => {
  if (OBJECT_ID.test(id)) return next();
  res.status(404).json({ error: 'Không tìm thấy tài khoản.', code: 'not_found' });
});

router.get('/', adminRead((req) => searchUsers(req.query)));

// Thao tác hàng loạt có giới hạn số lượng; từng tài khoản có kết quả và dòng nhật ký riêng
router.post(
  '/bulk-status',
  requireReauth,
  adminAction('user.bulk_status', async (req, ctx) => {
    const { ids, status } = req.body;
    const reason = requireReason(req.body.reason);
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BULK || !ids.every((id) => typeof id === 'string' && OBJECT_ID.test(id))) {
      throw invalidInput({ ids: `Chọn từ 1 đến ${MAX_BULK} tài khoản.` });
    }
    const results = [];
    for (const id of new Set(ids)) {
      try {
        const { target } = await setUserStatus(req.admin, id, status, reason);
        await writeAudit(req, { action: 'user.status_change', target: userTarget(id, maskEmail(target.email)), meta: { status, reason, bulk: true } });
        results.push({ id, ok: true });
      } catch (err) {
        if (!(err instanceof AdminError)) throw err;
        await writeAudit(req, { action: 'user.status_change', result: 'denied', reason: err.code, target: userTarget(id), meta: { status, bulk: true } });
        results.push({ id, ok: false, code: err.code, error: err.message });
      }
    }
    ctx.meta = { status, requested: ids.length, succeeded: results.filter((r) => r.ok).length };
    return { results };
  })
);

router.get('/:id', adminRead((req) => getUserDetail(req.params.id)));

router.post(
  '/:id/reveal',
  requireReauth,
  adminAction('user.reveal_pii', async (req, ctx) => {
    ctx.target = userTarget(req.params.id);
    if (await reveals.hit(req.admin._id)) throw new AdminError(429, 'too_many_attempts', 'Bạn đã xem quá nhiều dữ liệu cá nhân trong một giờ. Vui lòng thử lại sau.');
    const { user, revealed } = await revealUser(req.params.id);
    ctx.target.label = maskEmail(user.email);
    return revealed;
  })
);

router.patch(
  '/:id/status',
  requireReauth,
  adminAction('user.status_change', async (req, ctx) => {
    ctx.target = userTarget(req.params.id);
    const { status } = req.body;
    const reason = requireReason(req.body.reason);
    ctx.meta = { status, reason };
    const { target, previous } = await setUserStatus(req.admin, req.params.id, status, reason);
    ctx.target.label = maskEmail(target.email);
    ctx.meta.previous = previous;
    return getUserDetail(req.params.id);
  })
);

router.patch(
  '/:id/student-id',
  requireReauth,
  adminAction('user.student_id_change', async (req, ctx) => {
    ctx.target = userTarget(req.params.id);
    const reason = requireReason(req.body.reason);
    ctx.meta = { reason };
    const { target, previous, studentId } = await changeStudentId(req.params.id, req.body.studentId);
    ctx.target.label = maskEmail(target.email);
    ctx.meta = { reason, from: maskStudentId(previous), to: maskStudentId(studentId) };
    return getUserDetail(req.params.id);
  })
);

router.patch(
  '/:id/role',
  requireReauth,
  adminAction('user.role_change', async (req, ctx) => {
    ctx.target = userTarget(req.params.id);
    const { role } = req.body;
    const reason = requireReason(req.body.reason);
    ctx.meta = { role, reason };
    const { target, previous, enrollCode, expiresAt } = await changeRole(req.admin, req.params.id, role);
    ctx.target.label = maskEmail(target.email);
    ctx.meta.previous = previous;
    if (role === 'admin') notifyAdmins('admin_granted');
    return { user: await getUserDetail(req.params.id), ...(enrollCode && { enrollCode, enrollCodeExpiresAt: expiresAt }) };
  })
);

router.post(
  '/:id/mfa-reset',
  requireReauth,
  adminAction('user.mfa_reset', async (req, ctx) => {
    ctx.target = userTarget(req.params.id);
    const reason = requireReason(req.body.reason);
    ctx.meta = { reason };
    const { target, enrollCode, expiresAt } = await resetAdminMfa(req.admin, req.params.id);
    ctx.target.label = maskEmail(target.email);
    notifyAdmins('admin_mfa_reset');
    return { enrollCode, enrollCodeExpiresAt: expiresAt };
  })
);

router.post(
  '/:id/student-mfa-reset',
  requireReauth,
  adminAction('user.student_mfa_reset', async (req, ctx) => {
    ctx.target = userTarget(req.params.id);
    const reason = requireReason(req.body.reason);
    ctx.meta = { reason };
    const { target } = await resetStudentMfa(req.params.id);
    ctx.target.label = maskEmail(target.email);
    return getUserDetail(req.params.id);
  })
);

router.post(
  '/:id/avatar-remove',
  requireReauth,
  adminAction('user.avatar_remove', async (req, ctx) => {
    ctx.target = userTarget(req.params.id);
    const reason = requireReason(req.body.reason);
    ctx.meta = { reason };
    const { target } = await removeUserAvatar(req.params.id);
    ctx.target.label = maskEmail(target.email);
    return getUserDetail(req.params.id);
  })
);

export default router;
