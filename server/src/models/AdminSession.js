import mongoose from 'mongoose';

// Phiên quản trị tách hẳn phiên end-user (models/Session.js): cookie riêng, thời hạn riêng, DB chỉ lưu SHA-256 của token.
// stage 'mfa': mới qua mật khẩu, chỉ gọi được các bước MFA; 'active': đã qua MFA, gọi được API quản trị
const adminSessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    stage: { type: String, enum: ['mfa', 'active'], required: true },
    lastSeenAt: { type: Date, required: true },
    reauthAt: { type: Date },
    userAgent: { type: String, default: '' },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

adminSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AdminSession = mongoose.model('AdminSession', adminSessionSchema);
