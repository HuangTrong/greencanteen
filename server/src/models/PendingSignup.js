import mongoose from 'mongoose';

// Danh tính Google/Facebook mới chưa có tài khoản: giữ tạm phía server cho tới khi
// người dùng nhập họ tên + mã sinh viên để hoàn tất đăng ký
const pendingSignupSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    provider: { type: String, enum: ['google', 'facebook'], required: true },
    providerId: { type: String, required: true },
    email: { type: String },
    name: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

pendingSignupSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PendingSignup = mongoose.model('PendingSignup', pendingSignupSchema);
