import mongoose from 'mongoose';
import { GACHA_PRIZE_TYPE } from '../services/gacha.js';

const wholeNumber = { validator: Number.isSafeInteger, message: 'Cần là số nguyên.' };
const optionalWholeNumber = { validator: (value) => value === null || Number.isSafeInteger(value), message: 'Cần là số nguyên.' };

const prizeSchema = new mongoose.Schema(
  {
    prizeId: { type: String, required: true, match: /^[a-z0-9][a-z0-9-]{0,39}$/ },
    label: { type: String, required: true, trim: true, maxlength: 80 },
    prizeType: { type: String, enum: [GACHA_PRIZE_TYPE], default: GACHA_PRIZE_TYPE },
    carrier: { type: String, required: true, trim: true, maxlength: 40 },
    // Tiền là số nguyên VND; xác suất là số nguyên phần triệu (ppm) để tổng kiểm tra được chính xác, không dùng số thực
    amountVnd: { type: Number, required: true, min: 1000, max: 10_000_000, validate: wholeNumber },
    probabilityPpm: { type: Number, required: true, min: 0, max: 1_000_000, validate: wholeNumber },
    enabled: { type: Boolean, default: true },
    // null = không giới hạn kho
    maxQuantity: { type: Number, default: null, min: 1, validate: optionalWholeNumber },
  },
  { _id: false }
);

// Mỗi phiên bản là một bản chụp: sau khi xuất bản, danh mục giải không đổi nữa, phần thưởng tham chiếu đúng bản đã tạo ra nó
const gachaConfigSchema = new mongoose.Schema(
  {
    version: { type: Number, required: true, unique: true, min: 1, validate: wholeNumber },
    status: { type: String, enum: ['draft', 'published', 'discarded'], default: 'draft' },
    prizes: { type: [prizeSchema], default: [] },
    // null = không giới hạn ngân sách (tổng mệnh giá được phát hành, số nguyên VND)
    budgetVnd: { type: Number, default: null, min: 1, validate: optionalWholeNumber },
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
