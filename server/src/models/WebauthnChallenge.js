import mongoose from 'mongoose';

// Thử thách WebAuthn dùng một lần, gắn với trình duyệt đã xin nó qua cookie httpOnly: lấy được thử thách ở trình duyệt khác cũng không dùng được
const webauthnChallengeSchema = new mongoose.Schema(
  {
    tokenHash: { type: String, required: true, unique: true },
    purpose: { type: String, enum: ['register', 'login', 'admin'], required: true },
    challenge: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

webauthnChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const WebauthnChallenge = mongoose.model('WebauthnChallenge', webauthnChallengeSchema);
