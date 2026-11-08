import { AdminMfa } from '../models/AdminMfa.js';
import { AdminSession } from '../models/AdminSession.js';
import { CheckIn } from '../models/CheckIn.js';
import { EmailVerification } from '../models/EmailVerification.js';
import { GachaReward } from '../models/GachaReward.js';
import { Passkey } from '../models/Passkey.js';
import { PasswordReset } from '../models/PasswordReset.js';
import { PendingMfaLogin } from '../models/PendingMfaLogin.js';
import { QrLogin } from '../models/QrLogin.js';
import { RewardedImage } from '../models/RewardedImage.js';
import { Session } from '../models/Session.js';
import { User } from '../models/User.js';
import { UserAvatar } from '../models/UserAvatar.js';
import { UserMfa } from '../models/UserMfa.js';
import { WebauthnChallenge } from '../models/WebauthnChallenge.js';
import { findUserByStudentId, normalizeEmail, normalizeStudentId } from './accounts.js';
import { CLI_ACTOR } from './adminBootstrap.js';
import { AdminError } from './adminErrors.js';
import { writeAudit } from './audit.js';
import { maskEmail } from './privacy.js';

// Mọi model có trường userId nằm ở một trong hai danh sách: bị xóa cùng tài khoản, hoặc được giữ lại nhưng bỏ liên kết với tài khoản.
// Thêm model mới gắn với tài khoản thì phải thêm vào một trong hai; test đối chiếu với mongoose
export const USER_DATA_MODELS = [
  Session,
  AdminSession,
  PendingMfaLogin,
  PasswordReset,
  QrLogin,
  WebauthnChallenge,
  Passkey,
  UserMfa,
  AdminMfa,
  UserAvatar,
  CheckIn,
  GachaReward,
];

/**
 * Giữ lại, bỏ userId (SEC-06): mã băm ảnh đã được thưởng. Xóa đi thì chính ảnh đó lại thành "ảnh mới" và được thưởng lần nữa ở tài
 * khoản khác. Bản ghi chỉ còn băm của điểm ảnh (không dựng lại được ảnh) và thời điểm; trang /data-deletion.html ghi rõ điều này.
 */
export const ANONYMIZED_USER_MODELS = [RewardedImage];

export async function findAccountToDelete({ email, studentId }) {
  if (Boolean(email) === Boolean(studentId)) throw new AdminError(400, 'invalid_input', 'Cần đúng một trong --email hoặc --student-id.');
  const user = email ? await User.findOne({ email: normalizeEmail(email) }) : await findUserByStudentId(normalizeStudentId(studentId));
  if (!user) throw new AdminError(404, 'not_found', 'Không tìm thấy tài khoản.');
  // Quyền quản trị phải được gỡ ở khu quản trị trước: lệnh này không được làm mất admin cuối cùng
  if (user.role === 'admin') throw new AdminError(409, 'admin_account', 'Đây là tài khoản quản trị. Gỡ quyền quản trị trước rồi chạy lại.');
  return user;
}

export async function countAccountData(user) {
  const [checkIns, rewards] = await Promise.all([CheckIn.countDocuments({ userId: user._id }), GachaReward.countDocuments({ userId: user._id })]);
  return { checkIns, rewards };
}

/**
 * Xóa hẳn một tài khoản theo yêu cầu của chủ tài khoản (trang /data-deletion.html). Chỉ chạy từ dòng lệnh sau khi người vận hành
 * đã xác minh danh tính, không có API nào gọi tới. Nhật ký kiểm toán chỉ ghi thêm nên được giữ lại; trong đó email đã được che.
 * Không có giao dịch nhiều tài liệu nên User xóa sau cùng: lệnh dừng giữa chừng thì chạy lại được.
 */
export async function deleteAccount(user) {
  // Khóa trước: phiên và đăng nhập bị từ chối ngay nên không còn yêu cầu nào ghi thêm dữ liệu sau bước xóa
  await User.updateOne({ _id: user._id }, { $set: { status: 'locked' } });
  for (const model of USER_DATA_MODELS) await model.deleteMany({ userId: user._id });
  const now = new Date();
  for (const model of ANONYMIZED_USER_MODELS) await model.updateMany({ userId: user._id }, { $unset: { userId: 1 }, $set: { accountDeletedAt: now } });
  if (user.email) await EmailVerification.deleteOne({ email: user.email });
  await User.deleteOne({ _id: user._id });
  await writeAudit(null, {
    action: 'account.deleted',
    actor: CLI_ACTOR,
    target: { type: 'user', id: user._id, label: maskEmail(user.email) },
  });
}
