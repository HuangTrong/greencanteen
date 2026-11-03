import mongoose from 'mongoose';

// Nội dung công khai do admin chỉnh. Chỉ có đúng các trường này: bí mật môi trường, khóa OAuth, cấu hình DB và hạ tầng
// không bao giờ nằm trong collection này hay trong giao diện quản trị.
const siteSettingSchema = new mongoose.Schema(
  {
    _id: { type: String, default: 'public' },
    headerTagline: { type: String, trim: true, maxlength: 120 },
    heroTitle: { type: String, trim: true, maxlength: 120 },
    seoDescription: { type: String, trim: true, maxlength: 200 },
    announcementEnabled: { type: Boolean, default: false },
    announcementText: { type: String, trim: true, maxlength: 300 },
    supportContact: { type: String, trim: true, maxlength: 200 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedByLabel: { type: String, default: '' },
  },
  { timestamps: true, optimisticConcurrency: true }
);

export const SiteSetting = mongoose.model('SiteSetting', siteSettingSchema);
