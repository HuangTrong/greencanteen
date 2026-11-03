import mongoose from 'mongoose';

// Thử thách CAPTCHA dùng một lần. _id là băm của thử thách: đọc được DB cũng không lấy được thử thách để nộp lại
const captchaChallengeSchema = new mongoose.Schema(
  {
    _id: { type: String },
    iterations: { type: Number, required: true },
    bits: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

captchaChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const CaptchaChallenge = mongoose.model('CaptchaChallenge', captchaChallengeSchema);
