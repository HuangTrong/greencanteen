import mongoose from 'mongoose';

export const MEDIA_KINDS = ['keychain', 'win', 'lose'];

/**
 * Ảnh do quản trị viên tải lên cho quay thưởng tri ân: ảnh móc khóa, sticker / ảnh động khi trúng và khi không trúng. Ảnh đã được
 * giải mã và mã hóa lại thành WebP (giữ chuyển động), không còn metadata của tệp gốc. Nội dung ảnh không sửa được: muốn đổi ảnh thì
 * tải ảnh mới, để phiên bản cấu hình đã xuất bản luôn hiển thị đúng ảnh lúc xuất bản.
 */
const gachaMediaSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: MEDIA_KINDS, required: true },
    // Hiện cho quản trị viên và làm văn bản thay thế của ảnh móc khóa
    name: { type: String, required: true, trim: true, maxlength: 80 },
    // Sticker đang tắt không được chọn cho lượt quay mới; ảnh móc khóa không dùng trường này
    active: { type: Boolean, default: true },
    data: { type: Buffer, required: true, select: false },
    width: { type: Number },
    height: { type: Number },
    bytes: { type: Number },
    animated: { type: Boolean, default: false },
    createdByLabel: { type: String, default: '' },
    updatedByLabel: { type: String, default: '' },
  },
  { timestamps: true }
);

gachaMediaSchema.index({ kind: 1, active: 1, createdAt: -1 });

export const GachaMedia = mongoose.model('GachaMedia', gachaMediaSchema);
