import mongoose from 'mongoose';

// Ảnh (SHA-256 theo điểm ảnh) đã dùng để nhận thưởng check-in. _id là băm ảnh nên chỉ một yêu cầu ghi được: chặn hai tài khoản
// gửi cùng một ảnh đồng thời (điều kiện recentImageHashes trong lệnh cộng thưởng chỉ có hiệu lực trong một tài khoản).
// phash: dấu gần đúng 128 bit (dHash ngang + dọc, services/image.js) để nhận ra cùng ảnh đã nén lại, thu nhỏ, đổi định dạng (SEC-02);
// phashBands: 8 dải 16 bit của phash, có index, để tìm ứng viên gần trùng mà không quét cả collection.
// Xóa tài khoản không xóa bản ghi này mà bỏ userId (SEC-06): ảnh đã thưởng không thành "ảnh mới" cho tài khoản khác.
const rewardedImageSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    phash: { type: String },
    phashBands: { type: [String], default: undefined },
    accountDeletedAt: { type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

rewardedImageSchema.index({ phashBands: 1 }, { sparse: true });
rewardedImageSchema.index({ userId: 1 }, { sparse: true });

export const RewardedImage = mongoose.model('RewardedImage', rewardedImageSchema);
