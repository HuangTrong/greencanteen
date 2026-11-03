import mongoose from 'mongoose';

// Đã qua bước một (mật khẩu, nhà cung cấp hoặc liên kết đặt lại mật khẩu), đang chờ mã 2FA. Cookie giữ token, DB chỉ lưu băm.
// Không phải phiên: không gọi được API nào ngoài bước xác minh
const pendingMfaLoginSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    // Bước một là đăng nhập từ nhà cung cấp: phiên được cấp sau đó được tính là vừa xác thực (services/session.js)
    reauthenticated: { type: Boolean, default: false },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

pendingMfaLoginSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const PendingMfaLogin = mongoose.model('PendingMfaLogin', pendingMfaLoginSchema);
