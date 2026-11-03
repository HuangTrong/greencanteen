import mongoose from 'mongoose';

// Bộ đếm kho giải / ngân sách đã dùng, tách khỏi GachaConfig vì cấu hình đã xuất bản là bất biến.
// _id: "<configId>:prize:<prizeId>" (đơn vị: giải) hoặc "<configId>:budget" (đơn vị: VND)
const gachaStockSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    used: { type: Number, required: true, default: 0 },
  },
  { versionKey: false }
);

export const GachaStock = mongoose.model('GachaStock', gachaStockSchema);
