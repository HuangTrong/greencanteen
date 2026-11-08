import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CheckIn } from '../models/CheckIn.js';
import { requireAuth, requireOwnStudentId } from '../middleware/auth.js';
import {
  CATEGORY_LABELS,
  REWARDABLE_CATEGORIES,
  classifyContainerImage,
  visionConfig,
} from '../services/vision.js';
import { RewardedImage } from '../models/RewardedImage.js';
import { ACCEPTED_IMAGE_TYPES, imageFingerprints, inspectImage, sha256 } from '../services/image.js';
import { blockUnsafeUpload } from '../services/malwareScan.js';
import { POINTS_PER_CHECKIN } from '../services/gamification.js';
import { getSchoolStats } from '../services/stats.js';
import { findNearDuplicate, grantCheckInReward, listWithOutbox } from '../services/rewards.js';
import { pickRandomStory, serializeStory } from '../services/stories.js';
import { createRateLimiter, tooManyRequests } from '../services/rateLimit.js';
import { serializeUser } from '../services/accounts.js';
import { envNumber } from '../services/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const uploadDir = path.join(__dirname, '../../uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const maxImageBytes = () => envNumber('CHECKIN_MAX_IMAGE_MB', 8, { min: 1, max: 20 }) * 1024 * 1024;
// SEC-02: mặc định 30 phút giữa hai lượt được thưởng và tối đa 3 lượt được thưởng mỗi ngày (giờ Việt Nam). 0 = tắt (chỉ nên dùng khi
// phát triển; production đặt 0 thì log khởi động cảnh báo)
const cooldownMs = () => envNumber('CHECKIN_COOLDOWN_MINUTES', 30, { min: 0, max: 24 * 60 }) * 60 * 1000;
const dailyMax = () => envNumber('CHECKIN_DAILY_MAX', 3, { min: 0, max: 50 });

const DAY_MS = 24 * 60 * 60 * 1000;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
/** Ngày theo giờ Việt Nam (YYYY-MM-DD) và số ms tới nửa đêm kế tiếp */
const vnDay = (now = Date.now()) => new Date(now + VN_OFFSET_MS).toISOString().slice(0, 10);
const msUntilVnMidnight = (now = Date.now()) => DAY_MS - ((now + VN_OFFSET_MS) % DAY_MS);

// Mỗi lần gửi ảnh tốn một lượt nhận diện → giới hạn theo tài khoản
const attemptLimiter = createRateLimiter({ name: 'checkin-attempt', max: 20, windowMs: 60 * 60 * 1000 });
// Lượt được thưởng trong ngày: khóa gồm tài khoản và ngày, cửa sổ hết lúc nửa đêm (giờ Việt Nam)
const dailyRewards = createRateLimiter({ name: 'checkin-daily', max: () => dailyMax(), windowMs: () => msUntilVnMidnight() });
const dailyKey = (user) => `${user._id}:${vnDay()}`;

async function limitAttempts(req, res, next) {
  try {
    if (await attemptLimiter.hit(req.user._id)) {
      return tooManyRequests(res, 'Bạn gửi ảnh check-in quá nhiều lần. Vui lòng thử lại sau ít phút.');
    }
    next();
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
}

// Bọc middleware multer để mọi lỗi upload (ảnh quá lớn, nhiều tệp, multipart hỏng) trả JSON thống nhất.
// Multer tự xóa phần tệp đã ghi khi upload lỗi giữa chừng.
// Client chỉ gửi ảnh, bản cũ gửi thêm đúng một trường studentId. Hai giới hạn cuối mặc định là không giới hạn, phải tự đặt: tên trường
// a[4294967294] rồi a[x] làm thư viện duyệt mảng thưa 4 tỉ phần tử và chặn event loop hàng chục giây chỉ với một yêu cầu (F-51)
function uploadImage(req, res, next) {
  const limit = maxImageBytes();
  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: limit, files: 1, fields: 1, fieldSize: 256, fieldNameSize: 32, parts: 2, fieldNestingDepth: 0, fieldArrayIndexLimit: 0 },
  }).single('image');

  upload(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Ảnh quá lớn (tối đa ${Math.round(limit / 1024 / 1024)}MB). Vui lòng chụp lại hoặc chọn ảnh nhỏ hơn.`,
        code: 'image_too_large',
      });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: 'Chỉ gửi đúng một ảnh trong trường "image".', code: 'invalid_upload' });
    }
    res.status(400).json({ error: 'Dữ liệu tải lên bị lỗi. Vui lòng thử lại.', code: 'invalid_upload' });
  });
}

async function removeTempFile(file) {
  if (!file?.path) return;
  await fs.promises.unlink(file.path).catch((err) => {
    if (err.code !== 'ENOENT') console.error('Không xóa được tệp tạm:', err.message);
  });
}

/** Xóa tệp tạm còn sót (server dừng giữa lúc xử lý). Khi khởi động gọi với maxAgeMs = 0. */
export async function cleanupUploads(maxAgeMs = 0) {
  const now = Date.now();
  let removed = 0;
  for (const name of await fs.promises.readdir(uploadDir).catch(() => [])) {
    const file = path.join(uploadDir, name);
    try {
      const stat = await fs.promises.stat(file);
      if (stat.isFile() && now - stat.mtimeMs >= maxAgeMs) {
        await fs.promises.unlink(file);
        removed += 1;
      }
    } catch {
      // tệp vừa bị request khác xóa
    }
  }
  return removed;
}

const percent = (value) => `${Math.round(value * 100)}%`;

function publicClassification(result, threshold) {
  return {
    status: result.status,
    category: result.category,
    categoryLabel: result.category ? CATEGORY_LABELS[result.category] : null,
    confidence: result.confidence,
    threshold,
    reason: result.reason,
    simulated: result.status === 'simulated',
    accepted: result.accepted,
  };
}

// Lỗi của bộ nhận diện → mã HTTP: chưa sẵn sàng / đang bận → 503, ảnh không giải mã được → 400, còn lại → 502
const FAILURE_HTTP_STATUS = { not_configured: 503, busy: 503, invalid_image: 400 };

function rejectionMessage(result, threshold) {
  if (result.textDependent) {
    return 'Kết quả nhận diện phụ thuộc vào chữ trong ảnh nên chưa xác nhận được. Hãy chụp lại rõ hình dáng bình/ly cá nhân, tránh để nhãn hoặc chữ chiếm phần lớn ảnh.';
  }
  if (REWARDABLE_CATEGORIES.has(result.category)) {
    return `Nhận ra ${CATEGORY_LABELS[result.category].toLowerCase()} nhưng độ tin cậy ${percent(result.confidence)} chưa đạt ngưỡng ${percent(threshold)}. Hãy chụp lại rõ hơn, đủ sáng.`;
  }
  switch (result.category) {
    case 'single_use_plastic_cup':
      return 'Ảnh có ly nhựa dùng một lần — không được tính điểm. Lần sau hãy mang bình/ly cá nhân nhé!';
    case 'other_container':
      return 'Vật chứa trong ảnh không phải bình/ly cá nhân tái sử dụng nên chưa được tính điểm.';
    case 'no_container':
      return 'Không thấy bình/ly nào trong ảnh. Hãy chụp rõ bình/ly cá nhân của bạn.';
    default:
      return 'Ảnh chưa đủ rõ để xác nhận. Hãy chụp lại ở nơi đủ sáng, thấy rõ bình/ly.';
  }
}

function cooldownResponse(res, lastAt, cooldown) {
  const retryAt = new Date(new Date(lastAt).getTime() + cooldown);
  res.set('Retry-After', String(Math.max(1, Math.ceil((retryAt.getTime() - Date.now()) / 1000))));
  return res.status(429).json({
    error: `Mỗi lượt check-in được thưởng cách nhau ít nhất ${Math.round(cooldown / 60000)} phút. Bạn có thể check-in lại lúc ${retryAt.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Ho_Chi_Minh' })}.`,
    code: 'checkin_cooldown',
    retryAt,
  });
}

const DUPLICATE_IMAGE = {
  error: 'Ảnh này đã được dùng để check-in trước đó. Hãy chụp ảnh mới tại căn tin.',
  code: 'duplicate_image',
};

function dailyLimitResponse(res) {
  res.set('Retry-After', String(Math.max(1, Math.ceil(msUntilVnMidnight() / 1000))));
  return res.status(429).json({
    error: `Hôm nay bạn đã nhận đủ ${dailyMax()} lượt check-in được thưởng. Hẹn bạn ngày mai!`,
    code: 'checkin_daily_limit',
  });
}

const router = Router();

/** Client hỏi trước: check-in có khả dụng không, có đang ở chế độ mô phỏng không, giới hạn ảnh */
router.get('/status', (_req, res) => {
  const cfg = visionConfig();
  res.json({
    mode: cfg.mode,
    engine: cfg.mode === 'local' ? cfg.engine : null,
    threshold: cfg.threshold,
    maxImageBytes: maxImageBytes(),
    acceptedTypes: ACCEPTED_IMAGE_TYPES,
    cooldownMinutes: Math.round(cooldownMs() / 60000),
    dailyMax: dailyMax(),
  });
});

// Server là nơi quyết định kết quả: tài khoản lấy từ phiên đăng nhập, loại ảnh kiểm tra từ nội dung tệp,
// chỉ cộng thưởng khi mô hình nhận ra bình/ly cá nhân với độ tin cậy đạt ngưỡng
router.post('/', requireAuth, limitAttempts, uploadImage, async (req, res) => {
  const file = req.file;
  const user = req.user;
  try {
    const requestedId = typeof req.body?.studentId === 'string' ? req.body.studentId.trim() : '';
    if (requestedId && requestedId !== user.studentId) {
      return res.status(403).json({ error: 'Không thể check-in cho tài khoản khác.', code: 'forbidden' });
    }
    if (!file) {
      return res.status(400).json({ error: 'Vui lòng gửi ảnh check-in.', code: 'image_required' });
    }

    const cfg = visionConfig();
    if (cfg.mode === 'unavailable') {
      return res.status(503).json({
        error: 'Máy chủ chưa sẵn sàng nhận diện ảnh nên chưa thể check-in. Vui lòng báo quản trị viên.',
        code: 'vision_not_configured',
      });
    }

    const buffer = await fs.promises.readFile(file.path);
    const image = inspectImage(buffer);
    if (!image.ok) return res.status(image.status).json({ error: image.error, code: image.code });
    // Trước mọi bước giải mã: tệp cài lỗi vào thư viện ảnh phải bị chặn trước khi thư viện đọc tới nó
    if (await blockUnsafeUpload(req, res, buffer, 'checkin')) return undefined;
    const fileHash = sha256(buffer);

    // Kiểm tra sớm để khỏi tốn lượt nhận diện ảnh; điều kiện quyết định vẫn nằm trong lệnh cộng thưởng nguyên tử
    const cooldown = cooldownMs();
    if (cooldown > 0 && user.lastRewardedCheckInAt && Date.now() - user.lastRewardedCheckInAt.getTime() < cooldown) {
      return cooldownResponse(res, user.lastRewardedCheckInAt, cooldown);
    }
    if (dailyMax() > 0 && (await dailyRewards.isLimited(dailyKey(user)))) return dailyLimitResponse(res);
    // Trùng ảnh xét theo điểm ảnh: nối thêm byte vào tệp không biến ảnh cũ thành ảnh mới. Bản ghi cũ lưu băm theo byte nên đối chiếu cả
    // hai; ảnh của tài khoản đã xóa chỉ còn ở RewardedImage (SEC-06). Gần trùng (nén lại, thu nhỏ, đổi định dạng) xét bằng dấu gần đúng
    const prints = await imageFingerprints(buffer);
    const imageSha256 = prints?.exact ?? fileHash;
    const perceptual = prints?.perceptual ?? null;
    const known = { $in: [imageSha256, fileHash] };
    if ((await CheckIn.exists({ imageSha256: known, valid: true })) || (await RewardedImage.exists({ _id: known }))) {
      return res.status(409).json(DUPLICATE_IMAGE);
    }
    if (await findNearDuplicate(user._id, perceptual)) return res.status(409).json(DUPLICATE_IMAGE);

    const result = await classifyContainerImage({ buffer, mimeType: image.mimeType }, cfg);
    const classification = publicClassification(result, cfg.threshold);

    // Bộ nhận diện lỗi / đang bận / phản hồi sai schema → không ghi nhận, không cộng thưởng, cho thử lại
    if (!['classified', 'simulated'].includes(result.status)) {
      return res.status(FAILURE_HTTP_STATUS[result.status] || 502).json({
        success: false,
        isValid: false,
        error: result.reason,
        reason: result.reason,
        code: `vision_${result.status}`,
        classification,
      });
    }

    if (!result.accepted) {
      await CheckIn.create({
        userId: user._id,
        studentId: user.studentId,
        valid: false,
        category: result.category,
        confidence: result.confidence,
        verification: result.status === 'simulated' ? 'simulated' : 'local',
        model: result.model,
        aiReason: result.reason,
        imageSha256,
      });
      const message = rejectionMessage(result, cfg.threshold);
      return res.status(422).json({
        success: false,
        isValid: false,
        error: message,
        reason: message,
        code: 'container_not_accepted',
        classification,
      });
    }

    // Giữ một lượt trong trần của ngày trước khi cộng thưởng: hit() nguyên tử nên nhiều ảnh gửi đồng thời không vượt trần.
    // Không được thưởng (trùng ảnh, thời gian chờ, bị khóa, lỗi) thì trả lượt
    const daily = dailyMax() > 0 ? dailyKey(user) : null;
    if (daily && (await dailyRewards.hit(daily))) {
      await dailyRewards.release(daily);
      return dailyLimitResponse(res);
    }
    let story;
    let grant;
    try {
      story = await pickRandomStory();
      grant = await grantCheckInReward(user, {
        classification: result,
        imageSha256,
        perceptual,
        storySlug: story?.slug,
        cooldownMs: cooldown,
      });
    } catch (err) {
      if (daily) await dailyRewards.release(daily).catch(() => {});
      throw err;
    }
    if (grant.rejected && daily) await dailyRewards.release(daily);
    if (grant.rejected === 'duplicate_image') return res.status(409).json(DUPLICATE_IMAGE);
    if (grant.rejected === 'locked') {
      return res.status(403).json({ error: 'Tài khoản này đang bị khóa.', code: 'account_locked' });
    }
    if (grant.rejected === 'cooldown') {
      return cooldownResponse(res, grant.lastRewardedCheckInAt || new Date(), cooldown);
    }

    const schoolStats = await getSchoolStats().catch(() => null);
    res.json({
      success: true,
      isValid: true,
      reason: result.reason,
      classification,
      pointsEarned: POINTS_PER_CHECKIN,
      gachaSpinGranted: 1,
      user: serializeUser(grant.user),
      checkInId: grant.checkInId.toString(),
      story: serializeStory(story),
      schoolStats,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Check-in thất bại do lỗi máy chủ. Vui lòng thử lại sau.', code: 'server_error' });
  } finally {
    await removeTempFile(file);
  }
});

async function listHistory(req, res) {
  try {
    const history = await listWithOutbox(
      req.user._id,
      'checkInOutbox',
      CheckIn.find({ userId: req.user._id, valid: true })
        .sort({ createdAt: -1 })
        .limit(50)
        .select('createdAt pointsEarned plasticSavedGrams aiReason storySlug category confidence verification')
        .lean()
    );
    res.json({
      history: history.slice(0, 50).map((h) => ({
        _id: String(h._id),
        createdAt: h.createdAt,
        pointsEarned: h.pointsEarned,
        plasticSavedGrams: h.plasticSavedGrams,
        aiReason: h.aiReason,
        storySlug: h.storySlug,
        category: h.category || null,
        categoryLabel: h.category ? CATEGORY_LABELS[h.category] || null : null,
        confidence: h.confidence ?? null,
        verification: h.verification || null,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
}

router.get('/history', requireAuth, listHistory);
// Route cũ có :studentId trên URL — chỉ trả lịch sử của chính tài khoản đang đăng nhập
router.get('/history/:studentId', requireAuth, requireOwnStudentId, listHistory);

export default router;
