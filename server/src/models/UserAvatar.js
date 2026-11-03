import mongoose from 'mongoose';

// Ảnh đại diện đã chuẩn hóa. Tách khỏi User để mọi truy vấn tài khoản không kéo theo dữ liệu ảnh. _id ngẫu nhiên nằm trên URL
// công khai nên không lộ id tài khoản, và mỗi ảnh có URL riêng nên trình duyệt cache được mà không sợ hiện ảnh cũ.
const userAvatarSchema = new mongoose.Schema(
  {
    _id: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    data: { type: Buffer, required: true },
  },
  { timestamps: true }
);

export const UserAvatar = mongoose.model('UserAvatar', userAvatarSchema);
