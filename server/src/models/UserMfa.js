import mongoose from 'mongoose';

// 2FA của sinh viên, tự bật. Tách khỏi AdminMfa vì quản trị viên đăng ký bằng mã do người cấp quyền trao và có khóa riêng
const userMfaSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    secretEnc: { type: String },
    pendingSecretEnc: { type: String },
    enabledAt: { type: Date },
    // Bước thời gian TOTP đã dùng gần nhất: mỗi mã chỉ được chấp nhận một lần
    lastUsedStep: { type: Number },
    recoveryCodeHashes: { type: [String], default: undefined },
  },
  { timestamps: true }
);

export const UserMfa = mongoose.model('UserMfa', userMfaSchema);
