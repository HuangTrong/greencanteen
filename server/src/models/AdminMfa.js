import mongoose from 'mongoose';

// Bí mật MFA nằm ngoài document User để các truy vấn và serializer tài khoản không bao giờ chạm tới.
// Secret TOTP được mã hóa AES-256-GCM, mã khôi phục và mã đăng ký chỉ lưu HMAC (services/adminMfa.js)
const adminMfaSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    secretEnc: { type: String },
    pendingSecretEnc: { type: String },
    enabledAt: { type: Date },
    // Bước thời gian TOTP đã dùng gần nhất: mỗi mã chỉ được chấp nhận một lần
    lastUsedStep: { type: Number },
    recoveryCodeHashes: { type: [String], default: undefined },
    // Mã đăng ký MFA dùng một lần, trao ngoài băng cho admin mới: mật khẩu bị lộ không đủ để đăng ký thiết bị của kẻ khác
    enrollCodeHash: { type: String },
    enrollCodeExpiresAt: { type: Date },
  },
  { timestamps: true }
);

export const AdminMfa = mongoose.model('AdminMfa', adminMfaSchema);
