import mongoose from 'mongoose';

// Dấu mốc chạy một lần: migration đã xong, tài khoản admin đầu tiên đã khởi tạo. _id duy nhất nên chỉ một tiến trình ghi được.
const systemMarkerSchema = new mongoose.Schema(
  { _id: { type: String, required: true } },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false }
);

export const SystemMarker = mongoose.model('SystemMarker', systemMarkerSchema);
