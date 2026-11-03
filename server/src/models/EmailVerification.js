import mongoose from 'mongoose';

// Đăng ký email/mật khẩu đang chờ xác minh. Chưa có tài khoản nào được tạo: email và mã SV không bị chiếm trước, đăng nhập
// không dùng được. Giống PasswordReset, DB chỉ lưu SHA-256 của token. Mỗi email một bản ghi, đăng ký sau thay bản ghi trước.
const emailVerificationSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    studentId: { type: String, required: true },
    passwordHash: { type: String, required: true, select: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const EmailVerification = mongoose.model('EmailVerification', emailVerificationSchema);
