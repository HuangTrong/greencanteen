import mongoose from 'mongoose';

/**
 * Kết quả một lượt quay thưởng tri ân (tên collection giữ từ thời Gacha). Lượt không trúng cũng được ghi để người quay và quản trị
 * viên đối chiếu khi có khiếu nại. Bản ghi cũ (mã nạp demo) không có trường outcome và luôn là lượt có giải.
 */
const gachaRewardSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    studentId: { type: String, required: true },
    checkInId: { type: mongoose.Schema.Types.ObjectId, ref: 'CheckIn' },
    outcome: { type: String, enum: ['win', 'lose'] },
    // Lượt trúng: "keychain"; dữ liệu cũ: "phone_topup". Lượt không trúng không có loại giải
    prizeType: { type: String },
    // Móc khóa: bản chụp tên và ảnh tại lúc trúng, mã nhận quà, trạng thái trao quà
    prizeLabel: { type: String },
    imageId: { type: mongoose.Schema.Types.ObjectId, ref: 'GachaMedia' },
    claimCode: { type: String },
    deliveryStatus: { type: String, enum: ['pending', 'delivered'] },
    deliveredAt: { type: Date },
    deliveredByLabel: { type: String },
    deliveryNote: { type: String, maxlength: 300 },
    // Chỉ có ở mã nạp demo cũ
    carrier: { type: String },
    amountVnd: { type: Number },
    topUpCode: { type: String },
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
// Danh sách trao quà và tra cứu theo mã nhận quà trong khu quản trị
gachaRewardSchema.index({ deliveryStatus: 1, createdAt: -1 }, { partialFilterExpression: { deliveryStatus: { $type: 'string' } } });
gachaRewardSchema.index({ claimCode: 1 }, { partialFilterExpression: { claimCode: { $type: 'string' } } });

export const GachaReward = mongoose.model('GachaReward', gachaRewardSchema);
