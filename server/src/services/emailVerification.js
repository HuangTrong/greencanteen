import { EmailVerification } from '../models/EmailVerification.js';
import { User } from '../models/User.js';
import { AccountError, createOrClaimAccount } from './accounts.js';
import { clientOrigin } from './config.js';
import { escapeHtml, mailFailureCode, sendEmail } from './email.js';
import { verifyPassword } from './password.js';
import { hashToken, randomToken } from './session.js';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const tokenInvalid = () =>
  new AccountError(400, 'verification_token_invalid', 'Liên kết xác minh không hợp lệ, đã hết hạn hoặc đã được sử dụng. Hãy yêu cầu gửi lại email xác minh.');
const passwordInvalid = () =>
  new AccountError(400, 'invalid_password', 'Mật khẩu chưa đúng với mật khẩu đã đặt khi đăng ký. Nếu bạn không đăng ký GreenCanteen, hãy bỏ qua email đó.');
// Chỉ người giữ liên kết trong thư mới nhận được lỗi này, và vẫn không nêu trường nào trùng
const registrationConflict = () =>
  new AccountError(409, 'registration_conflict', 'Không thể hoàn tất đăng ký vì thông tin đã nhập trùng với một tài khoản đang có. Hãy đăng nhập, dùng "Quên mật khẩu", hoặc liên hệ quản trị viên.');

const CONFLICT_CODES = new Set(['email_taken', 'student_id_taken', 'provider_already_linked']);

/** Lỗi do người gửi yêu cầu: bị đếm vào giới hạn theo IP */
export const VERIFY_FAILURE_CODES = new Set(['verification_token_invalid', 'invalid_password']);

// Thư gửi tới địa chỉ chưa xác minh nên KHÔNG chèn họ tên hay mã SV người gửi tự khai: tránh biến máy chủ thành công cụ gửi nội dung tùy ý
function verificationMail(token) {
  // Token nằm sau dấu # → trình duyệt không gửi nó lên server trong request hay header Referer
  const link = `${clientOrigin()}/profile#verify=${token}`;
  return {
    subject: 'Xác minh email để kích hoạt tài khoản GreenCanteen',
    text: [
      'Xin chào,',
      '',
      'Email này vừa được dùng để đăng ký tài khoản GreenCanteen.',
      'Mở liên kết sau trong vòng 24 giờ, rồi nhập mật khẩu bạn đã đặt để kích hoạt tài khoản (liên kết chỉ dùng được một lần):',
      '',
      link,
      '',
      'Nếu bạn không đăng ký, hãy bỏ qua email này: không có tài khoản nào được tạo.',
    ].join('\n'),
    html: `<p>Xin chào,</p>
<p>Email này vừa được dùng để đăng ký tài khoản GreenCanteen. Mở liên kết trong vòng 24 giờ, rồi nhập mật khẩu bạn đã đặt để kích hoạt tài khoản. Liên kết chỉ dùng được một lần:</p>
<p><a href="${escapeHtml(link)}">Kích hoạt tài khoản</a></p>
<p>Nếu bạn không đăng ký, hãy bỏ qua email này: không có tài khoản nào được tạo.</p>`,
  };
}

function accountExistsMail() {
  const text = 'Có người vừa dùng email này để đăng ký GreenCanteen, nhưng email này đã có tài khoản nên tài khoản của bạn không thay đổi.';
  const hint = 'Nếu là bạn, hãy đăng nhập bằng phương thức đã đăng ký hoặc dùng "Quên mật khẩu". Nếu không phải bạn, hãy bỏ qua email này.';
  return {
    subject: 'Yêu cầu đăng ký GreenCanteen bằng email của bạn',
    text: ['Xin chào,', '', text, hint].join('\n'),
    html: `<p>Xin chào,</p><p>${escapeHtml(text)}</p><p>${escapeHtml(hint)}</p>`,
  };
}

async function sendRegistrationMail(to, mail) {
  try {
    await sendEmail({ to, ...mail });
  } catch (err) {
    console.error('Gửi email xác minh thất bại:', mailFailureCode(err));
    throw new AccountError(502, 'email_send_failed', 'Chưa gửi được email xác minh nên tài khoản chưa được tạo. Vui lòng thử lại sau ít phút.');
  }
}

async function savePending(draft, tokenHash) {
  const filter = { email: draft.email };
  const update = { $set: { ...draft, tokenHash, expiresAt: new Date(Date.now() + VERIFY_TTL_MS) } };
  try {
    await EmailVerification.updateOne(filter, update, { upsert: true });
  } catch (err) {
    // Hai yêu cầu đầu tiên cùng upsert một email → một bên trùng khóa unique, thử lại sẽ cập nhật bản đã có
    if (Number(err?.code) !== 11000) throw err;
    await EmailVerification.updateOne(filter, update);
  }
}

/**
 * Nhận form đăng ký. Mọi nhánh gửi đúng một thư rồi mới trả lời, nên phản hồi và thời gian không cho biết email đã có tài khoản
 * hay chưa. Mã SV chỉ được đối chiếu ở bước xác minh: tại đây không tra mã SV, trùng hay không đều đi cùng một đường.
 * Gửi thư trước khi lưu: thư lỗi thì không có gì được lưu, đăng ký chờ trước đó của email này vẫn còn nguyên.
 */
export async function startRegistration(draft) {
  if (await User.exists({ email: draft.email })) {
    await sendRegistrationMail(draft.email, accountExistsMail());
    return;
  }
  const token = randomToken(32);
  await sendRegistrationMail(draft.email, verificationMail(token));
  await savePending(draft, hashToken(token));
}

/** Gửi lại liên kết mới; liên kết cũ chỉ mất hiệu lực khi thư mới đã đi. Chạy sau khi đã trả lời nên không lộ email nào đang chờ */
export async function resendVerification(email) {
  try {
    if (!(await EmailVerification.exists({ email }))) return;
    const token = randomToken(32);
    await sendEmail({ to: email, ...verificationMail(token) });
    await EmailVerification.updateOne({ email }, { $set: { tokenHash: hashToken(token), expiresAt: new Date(Date.now() + VERIFY_TTL_MS) } });
  } catch (err) {
    console.error('Gửi lại email xác minh thất bại:', mailFailureCode(err));
  }
}

/**
 * Tạo tài khoản từ đăng ký chờ. Phải có cả token trong thư lẫn mật khẩu đã đặt: chủ email bấm nhầm liên kết do người khác tạo
 * không kích hoạt được tài khoản mang mật khẩu của kẻ đó, và ai giữ liên kết mà không biết mật khẩu cũng không nhận được phiên.
 * Đăng ký chờ chỉ bị xóa sau khi tạo xong: lỗi DB giữa chừng thì thử lại được; ràng buộc unique của User chặn tạo trùng khi gửi đồng thời.
 */
export async function completeRegistration({ token, password, claimCode }) {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw tokenInvalid();
  const pending = await EmailVerification.findOne({ tokenHash: hashToken(token), expiresAt: { $gt: new Date() } }).select('+passwordHash');
  if (!pending) throw tokenInvalid();
  if (typeof password !== 'string' || password.length > 256 || !(await verifyPassword(password, pending.passwordHash))) throw passwordInvalid();

  const now = new Date();
  let result;
  try {
    result = await createOrClaimAccount({
      name: pending.name,
      studentId: pending.studentId,
      claimCode,
      credentials: { email: pending.email, passwordHash: pending.passwordHash, passwordChangedAt: now, emailVerifiedAt: now },
    });
  } catch (err) {
    if (!CONFLICT_CODES.has(err?.code)) throw err; // cần mã kích hoạt, mã sai: giữ đăng ký chờ để nhập lại
    await EmailVerification.deleteOne({ _id: pending._id });
    throw registrationConflict();
  }
  await EmailVerification.deleteOne({ _id: pending._id });
  return result;
}
