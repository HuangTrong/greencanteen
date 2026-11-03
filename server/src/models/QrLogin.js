import mongoose from 'mongoose';

// Thử thách đăng nhập bằng QR (dùng một lần, có hạn):
// - challengeHash: băm của mã nằm trong QR — chỉ dùng để thiết bị ĐÃ đăng nhập tìm và xác nhận
// - pollTokenHash: băm của token bí mật chỉ thiết bị hiển thị QR giữ — dùng để nhận phiên sau khi được xác nhận
// - matchCodeHash: băm của mã đối chiếu chỉ hiện trên thiết bị tạo QR — người xác nhận phải nhập đúng, nên QR do kẻ khác gửi không tự cấp phiên
const qrLoginSchema = new mongoose.Schema(
  {
    challengeHash: { type: String, required: true, unique: true },
    pollTokenHash: { type: String, required: true, unique: true },
    matchCodeHash: { type: String },
    matchAttempts: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'consumed'],
      default: 'pending',
    },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    requesterUserAgent: { type: String, default: '' },
    approvedAt: { type: Date },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

qrLoginSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const QrLogin = mongoose.model('QrLogin', qrLoginSchema);
