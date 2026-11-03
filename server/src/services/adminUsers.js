import { User } from '../models/User.js';
import { CheckIn } from '../models/CheckIn.js';
import { GachaReward } from '../models/GachaReward.js';
import { Session } from '../models/Session.js';
import { avatarUrl, findUserByStudentId, normalizeStudentId, validateStudentId } from './accounts.js';
import { AdminError, invalidInput, notFound } from './adminErrors.js';
import { isMfaEnrolled, issueEnrollCode, removeMfa } from './adminMfa.js';
import { escapeRegex, parsePaging } from './adminQuery.js';
import { revokeAdminSessions } from './adminSession.js';
import { removeAvatar } from './avatars.js';
import { maskEmail, maskStudentId } from './privacy.js';
import { flushOutbox } from './rewards.js';
import { hasPasskey } from './passkeys.js';
import { notifyAccount } from './securityNotice.js';
import { revokeUserSessions } from './session.js';
import { invalidatePublicStats } from './stats.js';
import { disableUserMfa, isUserMfaEnabled } from './userMfa.js';

const CASE_INSENSITIVE = { locale: 'en', strength: 2 };
const MAX_QUERY = 80;

/** Chỉ các trường được liệt kê mới ra khỏi server; dữ liệu cá nhân mặc định bị che */
function serializeUserRow(user) {
  return {
    id: user._id.toString(),
    name: user.name,
    studentId: maskStudentId(user.studentId),
    email: maskEmail(user.email),
    role: user.role || 'user',
    status: user.status || 'active',
    totalCheckIns: user.totalCheckIns || 0,
    ecoPoints: user.ecoPoints || 0,
    createdAt: user.createdAt,
  };
}

export async function searchUsers(query) {
  const { page, pageSize, skip } = parsePaging(query);
  const filter = {};
  if (query.status === 'locked') filter.status = 'locked';
  if (query.status === 'active') filter.status = { $ne: 'locked' };
  if (query.role === 'admin') filter.role = 'admin';
  if (query.role === 'user') filter.role = { $ne: 'admin' };

  // Mã SV và email chỉ khớp nguyên giá trị: tìm theo tiền tố sẽ đoán dần được dữ liệu đang bị che trên màn hình
  const q = typeof query.q === 'string' ? query.q.trim().slice(0, MAX_QUERY) : '';
  if (q) {
    const exact = q.includes('@') ? { email: q.toLowerCase() } : { studentId: q };
    const match = await User.findOne(exact).collation(CASE_INSENSITIVE).select('_id').lean();
    filter.$or = [{ name: { $regex: escapeRegex(q), $options: 'i' } }, ...(match ? [{ _id: match._id }] : [])];
  }

  const [rows, total] = await Promise.all([
    User.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(pageSize).lean(),
    User.countDocuments(filter),
  ]);
  return { items: rows.map(serializeUserRow), page, pageSize, total };
}

async function loadUser(id) {
  const user = await User.findById(id);
  if (!user) throw notFound('Không tìm thấy tài khoản.');
  return user;
}

export async function getUserDetail(id) {
  const user = await loadUser(id);
  const [validCheckIns, invalidCheckIns, rewards, sessions, mfaEnrolled, userMfaEnabled, passkey] = await Promise.all([
    CheckIn.countDocuments({ userId: user._id, valid: true }),
    CheckIn.countDocuments({ userId: user._id, valid: false }),
    GachaReward.countDocuments({ userId: user._id }),
    Session.countDocuments({ userId: user._id, expiresAt: { $gt: new Date() } }),
    user.role === 'admin' ? isMfaEnrolled(user._id) : false,
    isUserMfaEnabled(user._id),
    hasPasskey(user._id),
  ]);
  return {
    ...serializeUserRow(user),
    avatarUrl: avatarUrl(user.avatarId),
    authMethods: { password: Boolean(user.passwordChangedAt), google: Boolean(user.googleId), facebook: Boolean(user.facebookId) },
    lockedAt: user.lockedAt || null,
    lockReason: user.lockReason || '',
    pendingGachaSpins: user.pendingGachaSpins || 0,
    plasticSavedGrams: user.plasticSavedGrams || 0,
    updatedAt: user.updatedAt,
    counts: { validCheckIns, invalidCheckIns, rewards, sessions },
    mfaEnrolled,
    userMfaEnabled,
    hasPasskey: Boolean(passkey),
  };
}

/** Bỏ che dữ liệu của một tài khoản: route này yêu cầu xác thực lại và được ghi nhật ký */
export async function revealUser(id) {
  const user = await loadUser(id);
  return { user, revealed: { studentId: user.studentId, email: user.email || '' } };
}

export function requireReason(reason) {
  const value = typeof reason === 'string' ? reason.trim() : '';
  if (value.length < 3 || value.length > 300) throw invalidInput({ reason: 'Cần nhập lý do từ 3 đến 300 ký tự.' });
  return value;
}

const hasActiveAdmin = () => User.exists({ role: 'admin', status: { $ne: 'locked' } });

/** Chạy sau khi đã ghi: hai admin khóa nhau đồng thời cũng không thể làm hệ thống mất admin cuối cùng */
async function assertAdminRemains(rollback) {
  if (await hasActiveAdmin()) return;
  await rollback();
  throw new AdminError(409, 'last_admin', 'Không thể thực hiện: hệ thống phải còn ít nhất một quản trị viên đang hoạt động.');
}

function forbidSelf(actor, target, message) {
  if (actor._id.equals(target._id)) throw new AdminError(409, 'self_action_forbidden', message);
}

export async function setUserStatus(actor, id, status, reason) {
  if (!['active', 'locked'].includes(status)) throw invalidInput({ status: 'Trạng thái không hợp lệ.' });
  const target = await loadUser(id);
  forbidSelf(actor, target, 'Không thể tự khóa hoặc mở khóa tài khoản đang đăng nhập.');
  const previous = target.status || 'active';
  if (previous === status) throw new AdminError(409, 'no_change', 'Tài khoản đã ở trạng thái này.');

  if (status === 'locked') {
    await User.updateOne({ _id: target._id }, { $set: { status, lockedAt: new Date(), lockReason: reason } });
    if (target.role === 'admin') {
      await assertAdminRemains(() =>
        User.updateOne({ _id: target._id }, { $set: { status: 'active' }, $unset: { lockedAt: 1, lockReason: 1 } })
      );
    }
    await revokeUserSessions(target._id);
  } else {
    await User.updateOne({ _id: target._id }, { $set: { status }, $unset: { lockedAt: 1, lockReason: 1 } });
  }
  invalidatePublicStats(); // bảng xếp hạng công khai không còn tài khoản bị khóa
  return { target, previous };
}

/**
 * Đổi mã SV: unique index không phân biệt hoa/thường là chốt chặn cuối. userId mới là khóa liên kết thật; mã SV trong
 * CheckIn / GachaReward chỉ là bản sao để tra cứu nên được cập nhật sau, sai lệch nếu bị ngắt không ảnh hưởng dữ liệu người dùng.
 */
export async function changeStudentId(id, nextStudentId) {
  const studentId = normalizeStudentId(nextStudentId);
  const invalid = validateStudentId(studentId);
  if (invalid) throw invalidInput({ studentId: invalid });

  const target = await loadUser(id);
  const previous = target.studentId;
  if (previous === studentId) throw new AdminError(409, 'no_change', 'Mã sinh viên không thay đổi.');
  const owner = await findUserByStudentId(studentId);
  if (owner && !owner._id.equals(target._id)) {
    throw new AdminError(409, 'student_id_taken', 'Mã sinh viên này đang thuộc tài khoản khác.');
  }

  await Promise.all([flushOutbox(target._id, 'checkInOutbox'), flushOutbox(target._id, 'gachaOutbox')]);
  try {
    await User.updateOne({ _id: target._id }, { $set: { studentId } });
  } catch (err) {
    if (Number(err?.code) === 11000) throw new AdminError(409, 'student_id_taken', 'Mã sinh viên này đang thuộc tài khoản khác.');
    throw err;
  }
  await Promise.all([
    CheckIn.updateMany({ userId: target._id }, { $set: { studentId } }),
    GachaReward.updateMany({ userId: target._id }, { $set: { studentId } }),
  ]);
  return { target, previous, studentId };
}

/** Ảnh vi phạm không cần khóa cả tài khoản: chỉ xóa ảnh, sinh viên vẫn dùng bình thường và có thể đặt ảnh khác */
export async function removeUserAvatar(id) {
  const target = await loadUser(id);
  if (!target.avatarId) throw new AdminError(409, 'no_change', 'Tài khoản này chưa có ảnh đại diện.');
  await removeAvatar(target._id);
  return { target };
}

/** Cấp quyền trả về mã đăng ký MFA dùng một lần: người được cấp phải có mã này mới gắn được thiết bị xác thực */
export async function changeRole(actor, id, role) {
  if (!['user', 'admin'].includes(role)) throw invalidInput({ role: 'Vai trò không hợp lệ.' });
  const target = await loadUser(id);
  forbidSelf(actor, target, 'Không thể tự đổi quyền của tài khoản đang đăng nhập.');
  const previous = target.role || 'user';
  if (previous === role) throw new AdminError(409, 'no_change', 'Tài khoản đã có vai trò này.');

  if (role === 'admin') {
    if (target.status === 'locked') throw new AdminError(409, 'account_locked', 'Hãy mở khóa tài khoản trước khi cấp quyền.');
    if (!target.email || !target.passwordChangedAt) {
      throw new AdminError(409, 'password_required', 'Quản trị viên phải đăng nhập bằng email và mật khẩu; tài khoản này chưa có mật khẩu.');
    }
    await User.updateOne({ _id: target._id }, { $set: { role } });
    return { target, previous, ...(await issueEnrollCode(target._id)) };
  }

  await User.updateOne({ _id: target._id }, { $set: { role } });
  await assertAdminRemains(() => User.updateOne({ _id: target._id }, { $set: { role: 'admin' } }));
  await Promise.all([revokeAdminSessions(target._id), removeMfa(target._id)]);
  return { target, previous };
}

/** Sinh viên mất thiết bị 2FA và cả mã khôi phục: tắt để đăng nhập lại được, thu hồi phiên vì chưa chắc người yêu cầu là chủ tài khoản */
export async function resetStudentMfa(id) {
  const target = await loadUser(id);
  if (!(await disableUserMfa(target._id))) throw new AdminError(409, 'no_change', 'Tài khoản này chưa bật xác thực hai lớp.');
  await revokeUserSessions(target._id);
  notifyAccount(target, 'mfa_disabled');
  return { target };
}

/** Thiết bị xác thực của một admin khác bị mất: thu hồi phiên, xóa MFA cũ, cấp mã đăng ký mới */
export async function resetAdminMfa(actor, id) {
  const target = await loadUser(id);
  forbidSelf(actor, target, 'Không thể tự đặt lại MFA khi đang đăng nhập. Nhờ quản trị viên khác hoặc dùng lệnh npm run admin:reset-mfa.');
  if (target.role !== 'admin') throw new AdminError(409, 'not_admin', 'Tài khoản này không phải quản trị viên.');
  await revokeAdminSessions(target._id);
  return { target, ...(await issueEnrollCode(target._id)) };
}
