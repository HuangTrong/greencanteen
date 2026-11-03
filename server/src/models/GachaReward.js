import mongoose from 'mongoose';

const gachaRewardSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    studentId: { type: String, required: true },
    checkInId: { type: mongoose.Schema.Types.ObjectId, ref: 'CheckIn' },
    prizeType: { type: String, default: 'phone_topup' },
    carrier: { type: String, default: 'Đa mạng' },
    amountVnd: { type: Number, required: true },
    topUpCode: { type: String, required: true },
    // Cấu hình đã tạo ra kết quả này. Bản ghi cũ (trước khi có cấu hình theo phiên bản) không có các trường này
    configId: { type: mongoose.Schema.Types.ObjectId, ref: 'GachaConfig' },
    configVersion: { type: Number },
    prizeId: { type: String },
  },
  { timestamps: true }
);

gachaRewardSchema.index({ userId: 1, createdAt: -1 });
gachaRewardSchema.index({ createdAt: -1 });
gachaRewardSchema.index({ configVersion: 1, prizeId: 1 }, { partialFilterExpression: { configVersion: { $type: 'number' } } });

export const GachaReward = mongoose.model('GachaReward', gachaRewardSchema);
