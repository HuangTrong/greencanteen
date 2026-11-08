import crypto from 'crypto';
import mongoose from 'mongoose';
import { PasswordReset } from '../models/PasswordReset.js';
import { adminMfaKey } from './adminConfig.js';
import { hashToken, randomToken, safeEqual } from './session.js';

export const RESET_TTL_MS = 30 * 60 * 1000;
export const RESET_CODE_LENGTH = 6;
/** Số lần nhập mã cho một email đặt lại; quá ngưỡng thì mã bị khóa, liên kết trong cùng email vẫn dùng được */
export const RESET_CODE_MAX_ATTEMPTS = 5;
export const RESET_CODE_PATTERN = new RegExp(`^\\d{${RESET_CODE_LENGTH}}$`);

/**
 * Khóa HMAC của mã đặt lại, dẫn xuất từ ADMIN_MFA_KEY giống khóa MFA sinh viên: không thêm bí mật phải quản lý, và mã 6 số
 * (một triệu khả năng) không dò ngoại tuyến được khi lộ DB. Chưa có khóa thì không phát mã, thư chỉ có liên kết.
 */
function resetCodeKey() {
  const master = adminMfaKey();
  return master ? Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'greencanteen-password-reset-code', 32)) : null;
}

export const isResetCodeEnabled = () => resetCodeKey() !== null;

const codeHash = (key, userId, code) => crypto.createHmac('sha256', key).update(`${userId}:${code}`).digest('hex');

/** Bỏ khoảng trắng và dấu gạch người dùng có thể gõ khi chép mã ("123 456", "123-456") */
export const normalizeResetCode = (code) => (typeof code === 'string' ? code.replace(/[\s-]/g, '') : '');

/** Tạo yêu cầu đặt lại mới cho tài khoản, thay mọi yêu cầu cũ (chỉ email mới nhất còn hiệu lực). Trả về { token, code } — code null nếu chưa có khóa */
export async function issuePasswordReset(userId) {
  const key = resetCodeKey();
  const token = randomToken(32);
  const code = key ? String(crypto.randomInt(10 ** RESET_CODE_LENGTH)).padStart(RESET_CODE_LENGTH, '0') : null;
  await PasswordReset.deleteMany({ userId });
  await PasswordReset.create({
    tokenHash: hashToken(token),
    userId,
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
    ...(code && { codeHash: codeHash(key, userId, code) }),
  });
  return { token, code };
}

/**
 * Kiểm tra mã của một tài khoản. Lượt nhập được giữ chỗ (tăng bộ đếm) TRƯỚC khi so sánh, trong cùng một lệnh với điều kiện còn lượt,
 * nên nhiều yêu cầu đồng thời không vượt được ngưỡng. Trả về bản ghi nếu đúng mã, null nếu sai / hết lượt / hết hạn / không có.
 * userId null (email không có tài khoản) vẫn chạy cùng truy vấn để thời gian phản hồi không lộ email nào có tài khoản.
 */
export async function claimResetCode(userId, code) {
  const key = resetCodeKey();
  const owner = userId || new mongoose.Types.ObjectId();
  const record = await PasswordReset.findOneAndUpdate(
    { userId: owner, expiresAt: { $gt: new Date() }, codeHash: { $type: 'string' }, codeAttempts: { $lt: RESET_CODE_MAX_ATTEMPTS } },
    { $inc: { codeAttempts: 1 } },
    { new: true }
  );
  const expected = codeHash(key || Buffer.alloc(32), owner, code);
  if (!record || !key || !safeEqual(record.codeHash, expected)) return null;
  return record;
}

/** Đúng mã nhưng chưa đặt được mật khẩu (vd. mật khẩu chứa họ tên): trả lại lượt nhập, mã vẫn dùng tiếp được */
export async function releaseResetCodeAttempt(record) {
  await PasswordReset.updateOne({ _id: record._id, codeAttempts: { $gt: 0 } }, { $inc: { codeAttempts: -1 } });
}

/** Tiêu bản ghi đã kiểm tra: tìm và xóa trong một lệnh → mã chỉ dùng được một lần kể cả khi gửi đồng thời */
export const consumeResetRecord = (record) => PasswordReset.findOneAndDelete({ _id: record._id, expiresAt: { $gt: new Date() } });
