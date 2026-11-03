import { User } from '../models/User.js';
import { EmailNotConfiguredError, escapeHtml, mailFailureCode, sendEmail } from './email.js';

const ADVICE =
  'Nếu không phải bạn, hãy đăng nhập ngay, đổi mật khẩu, hủy các liên kết đăng nhập lạ và đăng xuất các thiết bị khác. Không đăng nhập được thì dùng "Quên mật khẩu" hoặc liên hệ quản trị viên.';
const ADMIN_ADVICE = 'Nếu không phải bạn hoặc đồng nghiệp đã biết, hãy xem nhật ký kiểm toán và khóa tài khoản liên quan ngay.';

// Nội dung cố định, không có liên kết và không có dữ liệu do người dùng nhập: thư báo không được trở thành khuôn mẫu cho thư giả mạo
const NOTICES = {
  password_changed: ['Mật khẩu GreenCanteen vừa được đổi', 'Mật khẩu tài khoản GreenCanteen của bạn vừa được đổi.', ADVICE],
  password_reset: ['Mật khẩu GreenCanteen vừa được đặt lại', 'Mật khẩu tài khoản GreenCanteen của bạn vừa được đặt lại qua liên kết trong email.', ADVICE],
  google_linked: ['Google vừa được liên kết với GreenCanteen', 'Một tài khoản Google vừa được liên kết để đăng nhập vào tài khoản GreenCanteen của bạn.', ADVICE],
  facebook_linked: ['Facebook vừa được liên kết với GreenCanteen', 'Một tài khoản Facebook vừa được liên kết để đăng nhập vào tài khoản GreenCanteen của bạn.', ADVICE],
  google_unlinked: ['Google vừa bị hủy liên kết khỏi GreenCanteen', 'Tài khoản Google không còn đăng nhập được vào tài khoản GreenCanteen của bạn.', ADVICE],
  facebook_unlinked: ['Facebook vừa bị hủy liên kết khỏi GreenCanteen', 'Tài khoản Facebook không còn đăng nhập được vào tài khoản GreenCanteen của bạn.', ADVICE],
  mfa_enabled: ['Xác thực hai lớp GreenCanteen vừa được bật', 'Xác thực hai lớp vừa được bật cho tài khoản GreenCanteen của bạn. Các thiết bị khác đã bị đăng xuất.', ADVICE],
  mfa_disabled: ['Xác thực hai lớp GreenCanteen vừa được tắt', 'Xác thực hai lớp vừa được tắt cho tài khoản GreenCanteen của bạn.', ADVICE],
  mfa_recovery_used: ['Một mã khôi phục GreenCanteen vừa được dùng', 'Một mã khôi phục vừa được dùng để đăng nhập vào tài khoản GreenCanteen của bạn. Mã này không dùng lại được.', ADVICE],
  passkey_added: ['Passkey mới vừa được thêm vào GreenCanteen', 'Một passkey mới vừa được thêm vào tài khoản GreenCanteen của bạn.', ADVICE],
  passkey_removed: ['Một passkey vừa bị xóa khỏi GreenCanteen', 'Một passkey vừa bị xóa khỏi tài khoản GreenCanteen của bạn.', ADVICE],
  admin_granted: ['Có tài khoản vừa được cấp quyền quản trị GreenCanteen', 'Một tài khoản vừa được cấp quyền quản trị GreenCanteen.', ADMIN_ADVICE],
  admin_mfa_reset: ['Thiết bị xác thực của một quản trị viên vừa được đặt lại', 'Thiết bị xác thực của một quản trị viên GreenCanteen vừa được đặt lại.', ADMIN_ADVICE],
};

async function deliver(to, [subject, fact, advice]) {
  try {
    await sendEmail({
      to,
      subject,
      text: ['Xin chào,', '', fact, advice].join('\n'),
      html: `<p>Xin chào,</p><p>${escapeHtml(fact)}</p><p>${escapeHtml(advice)}</p>`,
    });
  } catch (err) {
    // Thao tác đã xong, không gửi được thư không làm hỏng phản hồi. Chưa cấu hình email thì không có gì để báo
    if (!(err instanceof EmailNotConfiguredError)) console.error('Gửi thư báo bảo mật thất bại:', mailFailureCode(err));
  }
}

/** Báo cho chủ tài khoản. Chạy sau khi đã trả lời nên chậm trễ của máy chủ thư không ảnh hưởng thao tác */
export function notifyAccount(user, kind) {
  if (user.email) setImmediate(() => deliver(user.email, NOTICES[kind]));
}

/** Báo cho mọi quản trị viên đang hoạt động: kẻ chiếm phiên quản trị thường tạo thêm tài khoản quản trị để giữ chỗ */
export function notifyAdmins(kind) {
  setImmediate(async () => {
    try {
      const admins = await User.find({ role: 'admin', status: { $ne: 'locked' }, email: { $exists: true } }).select('email').limit(50).lean();
      await Promise.all(admins.map(({ email }) => deliver(email, NOTICES[kind])));
    } catch (err) {
      console.error('Gửi thư báo quản trị thất bại:', err.name);
    }
  });
}
