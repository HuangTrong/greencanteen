import mongoose from 'mongoose';

// Token đặt lại mật khẩu: email chứa token ngẫu nhiên, DB chỉ lưu SHA-256 của token —
// lộ DB cũng không dùng được để đặt lại mật khẩu. Xóa ngay khi dùng → chỉ dùng được một lần.
const passwordResetSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

passwordResetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PasswordReset = mongoose.model('PasswordReset', passwordResetSchema);
