import mongoose from 'mongoose';

// Passkey (WebAuthn) của tài khoản. Chỉ lưu khóa công khai: lộ DB không giả mạo được chữ ký, khóa riêng nằm trong thiết bị người dùng
const passkeySchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    credentialId: { type: String, required: true, unique: true },
    publicKey: { type: Buffer, required: true },
    // Bộ đếm chữ ký: giảm hoặc đứng yên ở thiết bị có bộ đếm nghĩa là khóa có thể đã bị sao chép
    counter: { type: Number, default: 0 },
    transports: { type: [String], default: undefined },
    backedUp: { type: Boolean, default: false },
    name: { type: String, default: '' },
    lastUsedAt: { type: Date },
  },
  { timestamps: true }
);

export const Passkey = mongoose.model('Passkey', passkeySchema);
