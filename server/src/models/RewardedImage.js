import mongoose from 'mongoose';

// Ảnh (SHA-256) đã dùng để nhận thưởng check-in. _id là băm ảnh nên chỉ một yêu cầu ghi được: chặn hai tài khoản
// gửi cùng một ảnh đồng thời (điều kiện recentImageHashes trong lệnh cộng thưởng chỉ có hiệu lực trong một tài khoản)
const rewardedImageSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

export const RewardedImage = mongoose.model('RewardedImage', rewardedImageSchema);
