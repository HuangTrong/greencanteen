import { User } from '../models/User.js';
import { UserAvatar } from '../models/UserAvatar.js';
import { randomToken } from './session.js';
import { MAX_INPUT_PIXELS } from './image.js';
import { invalidatePublicStats } from './stats.js';

const AVATAR_SIZE = 256;

/**
 * Giải mã rồi mã hóa lại thành WebP vuông: chỉ điểm ảnh đi qua, EXIF (vị trí GPS) và mọi dữ liệu chèn trong tệp đều bị bỏ.
 * Dùng chung giới hạn điểm ảnh với check-in để chặn ảnh "bom giải nén".
 */
export async function renderAvatar(buffer) {
  const { default: sharp } = await import('sharp');
  return sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS })
    .rotate() // theo hướng chụp trong EXIF
    .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: sharp.strategy.attention })
    .webp({ quality: 80 })
    .toBuffer();
}

/**
 * Lưu bản mới, đổi con trỏ trên User bằng một lệnh nguyên tử, rồi mới xóa đúng bản mà lệnh đó thay thế: lỗi giữa chừng không
 * làm mất ảnh đang dùng, nhiều yêu cầu đồng thời không để con trỏ trỏ vào ảnh đã xóa. Trả về mã ảnh mới.
 */
export async function replaceAvatar(userId, data) {
  const id = randomToken(16);
  await UserAvatar.create({ _id: id, userId, data });
  const previous = await User.findByIdAndUpdate(userId, { $set: { avatarId: id } }).select('avatarId').lean();
  if (previous?.avatarId) await UserAvatar.deleteOne({ _id: previous.avatarId });
  invalidatePublicStats();
  return id;
}

export async function removeAvatar(userId) {
  const previous = await User.findByIdAndUpdate(userId, { $unset: { avatarId: 1 } }).select('avatarId').lean();
  if (previous?.avatarId) await UserAvatar.deleteOne({ _id: previous.avatarId });
  invalidatePublicStats();
}
