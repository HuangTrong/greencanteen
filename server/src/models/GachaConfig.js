import mongoose from 'mongoose';
import { GACHA_PRIZE_TYPE, LEGACY_TOPUP_TYPE } from '../services/gacha.js';

const wholeNumber = { validator: Number.isSafeInteger, message: 'Cần là số nguyên.' };
const optionalWholeNumber = { validator: (value) => value === null || value === undefined || Number.isSafeInteger(value), message: 'Cần là số nguyên.' };

const prizeSchema = new mongoose.Schema(
  {
    prizeId: { type: String, required: true, match: /^[a-z0-9][a-z0-9-]{0,39}$/ },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    prizeType: { type: String, enum: [GACHA_PRIZE_TYPE, LEGACY_TOPUP_TYPE], default: GACHA_PRIZE_TYPE },
    // Móc khóa: mô tả ngắn và ảnh trong thư viện ảnh quay thưởng (GachaMedia, loại "keychain")
    description: { type: String, trim: true, maxlength: 300, default: '' },
    imageId: { type: mongoose.Schema.Types.ObjectId, ref: 'GachaMedia', default: null },
    // Chỉ có ở giải mã nạp điện thoại cũ: nhà mạng, mệnh giá (số nguyên VND)
    carrier: { type: String, trim: true, maxlength: 40 },
    amountVnd: { type: Number, min: 1000, max: 10_000_000, validate: optionalWholeNumber },
    // Xác suất là số nguyên phần triệu (ppm) để tổng kiểm tra được chính xác, không dùng số thực
    probabilityPpm: { type: Number, required: true, min: 0, max: 1_000_000, validate: wholeNumber },
    enabled: { type: Boolean, default: true },
    // Móc khóa: tổng số móc khóa của mẫu này, tính cả số đã trúng ở mọi phiên bản (bộ đếm dùng chung theo prizeId).
    // Giải cũ: giới hạn kho riêng của phiên bản; null = không giới hạn
    maxQuantity: { type: Number, default: null, min: 1, validate: optionalWholeNumber },
  },
  { _id: false }
);

// Mỗi phiên bản là một bản chụp: sau khi xuất bản, danh mục giải và xác suất không đổi nữa, kết quả quay tham chiếu đúng bản đã tạo ra nó
const gachaConfigSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true, min: 1, validate: wholeNumber },
    status: { type: String, enum: ['draft', 'published', 'discarded'], default: 'draft' },
    prizes: { type: [prizeSchema], default: [] },
    // Chỉ dùng cho giải mã nạp cũ: tổng mệnh giá được phát (số nguyên VND), null = không giới hạn
    budgetVnd: { type: Number, default: null, min: 1, validate: optionalWholeNumber },
    // Nơi, thời gian, giấy tờ cần mang khi nhận quà: hiện cho người trúng và trên trang thể lệ
    claimInstructions: { type: String, trim: true, maxlength: 500, default: '' },
    effectiveFrom: { type: Date },
    effectiveTo: { type: Date, default: null },
    note: { type: String, trim: true, maxlength: 500, default: '' },
    basedOnVersion: { type: Number },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdByLabel: { type: String, default: '' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedByLabel: { type: String, default: '' },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    publishedByLabel: { type: String, default: '' },
    publishedAt: { type: Date },
    endedByLabel: { type: String, default: '' },
  },
  { timestamps: true, optimisticConcurrency: true }
);

gachaConfigSchema.index({ status: 1, effectiveFrom: -1, version: -1 });

export const GachaConfig = mongoose.model('GachaConfig', gachaConfigSchema);
