import crypto from 'crypto';
import { AdminSession } from '../models/AdminSession.js';
import { SystemMarker } from '../models/SystemMarker.js';
import { User } from '../models/User.js';
import { normalizeEmail, normalizeName, normalizeStudentId, validateEmail, validateName, validateStudentId } from './accounts.js';
import { AdminError } from './adminErrors.js';
import { isAdminConfigured } from './adminConfig.js';
import { isMfaEnrolled, issueEnrollCode } from './adminMfa.js';
import { writeAudit } from './audit.js';
import { hashPassword } from './password.js';
import { COMMON_PASSWORD_MESSAGE, PERSONAL_PASSWORD_MESSAGE, containsPersonalInfo, isCommonPassword } from './passwordPolicy.js';
import { maskEmail } from './privacy.js';
import { revokeUserSessions } from './session.js';

const BOOTSTRAP_MARKER = 'admin-bootstrap';
const BOOTSTRAP_MARKER_STALE_MS = 5 * 60 * 1000;
const MIN_ADMIN_PASSWORD = 12;
export const CLI_ACTOR = { type: 'cli', label: 'lệnh quản trị' };

/** Báo lúc khởi động để người vận hành biết khu quản trị đang bị tắt và vì sao */
export async function logAdminStatus() {
  if (!isAdminConfigured()) {
    console.warn('Khu quản trị: TẮT — chưa có ADMIN_MFA_KEY hợp lệ, mọi yêu cầu /api/admin bị từ chối.');
  } else if (!(await User.exists({ role: 'admin' }))) {
    console.warn('Khu quản trị: chưa có tài khoản admin — chạy npm run admin:bootstrap trên máy chủ.');
  } else {
    console.log('Khu quản trị: đã cấu hình.');
  }
}

function assertConfigured() {
  if (!isAdminConfigured()) {
    throw new AdminError(503, 'admin_not_configured', 'Chưa đặt ADMIN_MFA_KEY hợp lệ (32 byte, base64 hoặc hex).');
  }
}

/**
 * Khởi tạo admin đầu tiên. Chỉ chạy từ dòng lệnh trên máy chủ, không có API nào gọi tới. Đã có admin → từ chối; DB unique
 * của SystemMarker chặn hai lệnh chạy đồng thời. Tài khoản email đã tồn tại thì được nâng quyền và giữ nguyên mật khẩu.
 */
export async function bootstrapFirstAdmin({ email, name, studentId, password }) {
  assertConfigured();
  const normalizedEmail = normalizeEmail(email);
  const invalidEmail = validateEmail(normalizedEmail);
  if (invalidEmail) throw new AdminError(400, 'invalid_input', invalidEmail);
  if (await User.exists({ role: 'admin' })) {
    throw new AdminError(409, 'admin_exists', 'Đã có quản trị viên. Hãy cấp quyền trong khu quản trị.');
  }

  const existing = await User.findOne({ email: normalizedEmail });
  if (existing && !existing.passwordChangedAt) {
    throw new AdminError(409, 'password_required', 'Tài khoản này chưa có mật khẩu. Hãy đặt mật khẩu trước khi cấp quyền.');
  }
  const created = existing ? null : await prepareNewAdmin({ email: normalizedEmail, name, studentId, password });

  await claimBootstrap();
  const user = existing || (await User.create(created));
  await User.updateOne({ _id: user._id }, { $set: { role: 'admin', status: 'active' } });
  const enrollment = await issueEnrollCode(user._id);
  await writeAudit(null, {
    action: 'admin.bootstrap',
    actor: CLI_ACTOR,
    target: { type: 'user', id: user._id, label: maskEmail(normalizedEmail) },
    meta: { promotedExistingAccount: Boolean(existing) },
  });
  return { user, promotedExisting: Boolean(existing), ...enrollment };
}

/**
 * Marker có _id cố định nên hai lệnh chạy đồng thời chỉ một lệnh tạo được. Marker đã cũ mà không còn admin nào (DB được
 * khôi phục tay, hoặc lệnh trước dừng giữa chừng) thì được thay, để không khóa vĩnh viễn việc khởi tạo.
 */
async function claimBootstrap() {
  try {
    await SystemMarker.create({ _id: BOOTSTRAP_MARKER });
    return;
  } catch (err) {
    if (Number(err?.code) !== 11000) throw err;
  }
  const staleBefore = new Date(Date.now() - BOOTSTRAP_MARKER_STALE_MS);
  const { deletedCount } = await SystemMarker.deleteOne({ _id: BOOTSTRAP_MARKER, createdAt: { $lt: staleBefore } });
  if (!deletedCount) throw new AdminError(409, 'admin_exists', 'Một lệnh khởi tạo khác vừa chạy. Hãy thử lại sau vài phút.');
  await SystemMarker.create({ _id: BOOTSTRAP_MARKER });
}

function assertAdminPassword(password, profile) {
  if (typeof password !== 'string' || password.length < MIN_ADMIN_PASSWORD || password.length > 128) {
    throw new AdminError(400, 'invalid_input', `Mật khẩu quản trị cần từ ${MIN_ADMIN_PASSWORD} đến 128 ký tự.`);
  }
  if (isCommonPassword(password)) throw new AdminError(400, 'invalid_input', COMMON_PASSWORD_MESSAGE);
  if (containsPersonalInfo(password, profile)) throw new AdminError(400, 'invalid_input', PERSONAL_PASSWORD_MESSAGE);
}

async function prepareNewAdmin({ email, name, studentId, password }) {
  assertAdminPassword(password, { name, studentId, email });
  const displayName = normalizeName(name);
  const invalidName = validateName(displayName);
  if (invalidName) throw new AdminError(400, 'invalid_input', invalidName);
  // Mã SV là trường bắt buộc của User; cán bộ quản trị không có mã thật nên dùng mã riêng, không trùng mã sinh viên
  const id = normalizeStudentId(studentId) || `ADMIN-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const invalidId = validateStudentId(id);
  if (invalidId) throw new AdminError(400, 'invalid_input', invalidId);
  return { email, name: displayName, studentId: id, passwordHash: await hashPassword(password), passwordChangedAt: new Date() };
}

/** Lối thoát khi mất thiết bị xác thực và không còn admin nào khác: chạy từ máy chủ, có ghi nhật ký */
export async function resetAdminMfaFromCli(email) {
  assertConfigured();
  const user = await User.findOne({ email: normalizeEmail(email), role: 'admin' });
  if (!user) throw new AdminError(404, 'not_found', 'Không tìm thấy quản trị viên có email này.');
  await AdminSession.deleteMany({ userId: user._id });
  const enrollment = await issueEnrollCode(user._id);
  await writeAudit(null, {
    action: 'admin.mfa_reset',
    actor: CLI_ACTOR,
    target: { type: 'user', id: user._id, label: maskEmail(user.email) },
  });
  return { user, ...enrollment };
}

/**
 * Lối thoát khi quên mật khẩu hoặc gõ nhầm email lúc khởi tạo mà máy chưa có SMTP để dùng "Quên mật khẩu": chạy từ máy chủ, có ghi
 * nhật ký. MFA đã gắn được giữ nguyên, nên mật khẩu mới một mình không đủ để vào khu quản trị; chưa gắn thì cấp lại mã đăng ký.
 */
export async function resetAdminPasswordFromCli({ email, newEmail, password }) {
  assertConfigured();
  const user = await User.findOne({ email: normalizeEmail(email), role: 'admin' });
  if (!user) throw new AdminError(404, 'not_found', 'Không tìm thấy quản trị viên có email này.');
  const targetEmail = newEmail ? normalizeEmail(newEmail) : user.email;
  const invalidEmail = validateEmail(targetEmail);
  if (invalidEmail) throw new AdminError(400, 'invalid_input', invalidEmail);
  const emailChanged = targetEmail !== user.email;
  if (emailChanged && (await User.exists({ email: targetEmail }))) throw new AdminError(409, 'email_taken', 'Email này đã có tài khoản.');
  assertAdminPassword(password, { name: user.name, studentId: user.studentId, email: targetEmail });

  await User.updateOne({ _id: user._id }, { $set: { email: targetEmail, passwordHash: await hashPassword(password), passwordChangedAt: new Date() } });
  await revokeUserSessions(user._id);
  const enrollment = (await isMfaEnrolled(user._id)) ? null : await issueEnrollCode(user._id);
  await writeAudit(null, {
    action: 'admin.password_reset',
    actor: CLI_ACTOR,
    target: { type: 'user', id: user._id, label: maskEmail(targetEmail) },
    meta: { emailChanged },
  });
  return { email: targetEmail, ...enrollment };
}
