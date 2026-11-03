import mongoose from 'mongoose';

// Sự kiện truy cập ở mức tối thiểu: tên trang / mục cố định, không có URL, IP, user-agent, mã sinh viên, token hay mã thưởng.
// visitId ngẫu nhiên do trình duyệt sinh, chỉ sống trong một lượt truy cập; actorKey là HMAC theo tháng của tài khoản đã
// đăng nhập, không suy ngược được và không nối được giữa các tháng. Bản ghi tự xóa khi tới expiresAt.
const analyticsEventSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['page_view', 'impression', 'click'], required: true },
    page: { type: String },
    target: { type: String },
    visitId: { type: String, required: true },
    actorKey: { type: String },
    createdAt: { type: Date, required: true, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);

analyticsEventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
analyticsEventSchema.index({ type: 1, createdAt: 1 });
analyticsEventSchema.index({ createdAt: 1 });

export const AnalyticsEvent = mongoose.model('AnalyticsEvent', analyticsEventSchema);
