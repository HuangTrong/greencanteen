import { Router } from 'express';
import multer from 'multer';
import { UserAvatar } from '../models/UserAvatar.js';
import { requireAuth } from '../middleware/auth.js';
import { serializeUser } from '../services/accounts.js';
import { removeAvatar, renderAvatar, replaceAvatar } from '../services/avatars.js';
import { inspectImage } from '../services/image.js';
import { blockUnsafeUpload } from '../services/malwareScan.js';
import { createRateLimiter, tooManyRequests } from '../services/rateLimit.js';

const router = Router();

// Bằng giới hạn ảnh check-in: ảnh gốc từ điện thoại thường vài MB
const MAX_AVATAR_BYTES = 8 * 1024 * 1024;
const AVATAR_ID = /^[\w-]{22}$/;
// Mỗi ảnh có URL riêng nên cache được; để hạn ngắn vì ảnh đã gỡ không nên nằm lâu trong cache của người khác
const AVATAR_CACHE = 'public, max-age=86400';

// Mỗi lần đổi ảnh tốn CPU giải mã và mã hóa lại → giới hạn theo tài khoản
const changeLimiter = createRateLimiter({ name: 'avatar-change', max: 20, windowMs: 60 * 60 * 1000 });

async function limitChanges(req, res, next) {
  try {
    if (await changeLimiter.hit(req.user._id)) {
      return tooManyRequests(res, 'Bạn đổi ảnh đại diện quá nhiều lần. Vui lòng thử lại sau.');
    }
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
}

// Giữ trong bộ nhớ: tệp nhỏ, xử lý xong là bỏ, không để lại tệp tạm trên đĩa
function receiveImage(req, res, next) {
  const upload = multer({ limits: { fileSize: MAX_AVATAR_BYTES, files: 1, fields: 0, parts: 2 } }).single('image');
  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'Ảnh quá lớn (tối đa 8MB). Vui lòng chọn ảnh nhỏ hơn.', code: 'image_too_large' });
    }
    res.status(400).json({ error: 'Chỉ gửi đúng một ảnh trong trường "image".', code: 'invalid_upload' });
  });
}

router.put('/me', requireAuth, limitChanges, receiveImage, async (req, res) => {
  const buffer = req.file?.buffer;
  const inspected = inspectImage(buffer);
  if (!inspected.ok) {
    const { status, code, error } = inspected;
    // Thông báo HEIC của inspectImage nói về check-in, không đúng ngữ cảnh ở đây
    const message = code === 'image_type_unsupported' ? 'Chỉ nhận ảnh JPEG, PNG hoặc WebP.' : error;
    return res.status(status).json({ error: message, code });
  }

  try {
    if (await blockUnsafeUpload(req, res, buffer, 'avatar')) return undefined;
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }

  let data;
  try {
    data = await renderAvatar(buffer);
  } catch (e) {
    console.error('Không xử lý được ảnh đại diện:', e.message);
    return res.status(400).json({ error: 'Ảnh bị hỏng hoặc có kích thước quá lớn. Vui lòng chọn ảnh khác.', code: 'image_unreadable' });
  }

  try {
    req.user.avatarId = await replaceAvatar(req.user._id, data);
    res.json({ user: serializeUser(req.user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

router.delete('/me', requireAuth, async (req, res) => {
  try {
    await removeAvatar(req.user._id);
    req.user.avatarId = undefined;
    res.json({ user: serializeUser(req.user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

// Công khai vì bảng xếp hạng ai cũng xem được; mã trên URL ngẫu nhiên nên không dò được ảnh của ai
router.get('/:id', async (req, res) => {
  try {
    const avatar = AVATAR_ID.test(req.params.id) ? await UserAvatar.findById(req.params.id).select('data') : null;
    if (!avatar) return res.status(404).json({ error: 'Không tìm thấy ảnh.', code: 'not_found' });
    res.set('Cache-Control', AVATAR_CACHE).type('image/webp').send(Buffer.from(avatar.data));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

export default router;
