import mongoose from 'mongoose';

// Phiên đăng nhập: cookie httpOnly chứa token ngẫu nhiên, DB chỉ lưu SHA-256 của token
const sessionSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userAgent: { type: String, default: '' },
    // Lần gần nhất phiên này chứng minh lại quyền sở hữu tài khoản (services/session.js)
    reauthAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model('Session', sessionSchema);
