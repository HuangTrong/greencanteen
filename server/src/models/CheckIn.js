import mongoose from 'mongoose';

const checkInSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    studentId: { type: String, required: true },
    // true khi server xác nhận bình/ly cá nhân đạt ngưỡng tin cậy và đã cộng thưởng
    valid: { type: Boolean, required: true },
    // Kết quả phân loại ảnh (bản ghi cũ trước khi có phân loại không có các trường này)
    category: { type: String },
    confidence: { type: Number },
    // 'local' = nhận diện tại máy chủ (CLIP / VLM local); 'ai' = bản ghi cũ do Gemini cloud chấm;
    // 'simulated' = chế độ mô phỏng khi phát triển (không phải xác thực thật)
    verification: { type: String, enum: ['ai', 'local', 'simulated'] },
    model: { type: String },
    imageSha256: { type: String },
    aiReason: { type: String, default: '' },
    pointsEarned: { type: Number, default: 0 },
    plasticSavedGrams: { type: Number, default: 0 },
    storySlug: { type: String, default: '' },
  },
  { timestamps: true }
);

checkInSchema.index({ userId: 1, createdAt: -1 });
checkInSchema.index({ createdAt: -1 });
checkInSchema.index({ imageSha256: 1 }, { partialFilterExpression: { imageSha256: { $type: 'string' } } });

export const CheckIn = mongoose.model('CheckIn', checkInSchema);
