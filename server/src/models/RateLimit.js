import mongoose from 'mongoose';

// Bộ đếm giới hạn tần suất lưu trong DB: còn hiệu lực khi server khởi động lại hoặc chạy nhiều tiến trình
const rateLimitSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  count: { type: Number, required: true },
  resetAt: { type: Date, required: true },
});

rateLimitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit = mongoose.model('RateLimit', rateLimitSchema);
