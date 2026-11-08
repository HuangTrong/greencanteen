import mongoose from 'mongoose';

// Token đặt lại mật khẩu: email chứa token ngẫu nhiên, DB chỉ lưu SHA-256 của token —
// lộ DB cũng không dùng được để đặt lại mật khẩu. Xóa ngay khi dùng → chỉ dùng được một lần.
// Cùng email có mã 6 số (services/passwordReset.js): chỉ lưu HMAC với khóa ngoài DB nên lộ DB cũng không dò ngoại tuyến được.
// Mã và liên kết nằm chung một bản ghi: dùng một trong hai là cả hai mất hiệu lực.
const passwordResetSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    expiresAt: { type: Date, required: true },
    // Không có khi máy chủ chưa có khóa (ADMIN_MFA_KEY): thư chỉ có liên kết
    codeHash: { type: String },
    // Số lần đã nhập mã cho bản ghi này; đủ ngưỡng thì mã bị khóa, liên kết vẫn dùng được
    codeAttempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordReset = mongoose.model('PasswordReset', passwordResetSchema);
