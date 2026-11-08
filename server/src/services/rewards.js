import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { CheckIn } from '../models/CheckIn.js';
import { GachaReward } from '../models/GachaReward.js';
import { RewardedImage } from '../models/RewardedImage.js';
import {
  CO2_GRAMS_PER_CUP,
  PLASTIC_GRAMS_PER_CUP,
  POINTS_PER_CHECKIN,
  computeBadges,
} from './gamification.js';
import { GACHA_PRIZE_TYPE, issueClaimCode } from './gacha.js';
import { drawFromConfig, getActiveGachaConfig, isKeychainConfig } from './gachaConfig.js';
import { NEAR_DUPLICATE_MAX_BITS, hammingDistance } from './image.js';
import { invalidatePublicStats } from './stats.js';

// Số băm ảnh gần nhất giữ trong user để chặn gửi lại cùng một ảnh, kể cả khi gửi đồng thời
const RECENT_IMAGE_HASHES = 30;
// Ảnh gần trùng (SEC-02): ảnh của chính tài khoản đó thì luôn so; ảnh của tài khoản khác chỉ so trong cửa sổ này, để số ảnh đem so (và
// khả năng chặn nhầm hai ảnh khác nhau) không lớn dần theo thời gian
const CROSS_ACCOUNT_NEAR_DUPLICATE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_NEAR_DUPLICATE_CANDIDATES = 500;

/**
 * Ảnh đã được thưởng gần trùng với ảnh này (cùng ảnh đã nén lại, thu nhỏ, đổi định dạng) hay không. perceptual = dấu gần đúng của
 * services/image.js (null khi ảnh quá ít chi tiết → không so). Tìm ứng viên qua index các dải 16 bit rồi mới đếm bit khác nhau.
 * Không nguyên tử giữa hai tài khoản gửi đồng thời; trần lượt mỗi ngày và thời gian chờ giới hạn phần lọt qua.
 */
export async function findNearDuplicate(userId, perceptual, now = new Date()) {
  if (!perceptual) return null;
  const candidates = await RewardedImage.find({
    phashBands: { $in: perceptual.bands },
    $or: [{ userId }, { createdAt: { $gte: new Date(now.getTime() - CROSS_ACCOUNT_NEAR_DUPLICATE_MS) } }],
  })
    .select('phash')
    .limit(MAX_NEAR_DUPLICATE_CANDIDATES)
    .lean();
  return candidates.find((candidate) => candidate.phash && hammingDistance(candidate.phash, perceptual.hash) <= NEAR_DUPLICATE_MAX_BITS) || null;
}

const OUTBOXES = {
  checkInOutbox: CheckIn,
  gachaOutbox: GachaReward,
};

/**
 * Chuyển các bản ghi còn trong outbox của user sang collection riêng. Bản ghi giữ nguyên _id đã cấp
 * nên chạy lại bao nhiêu lần cũng không tạo bản sao (trùng _id → đã chuyển rồi).
 */
export async function flushOutbox(userId, field) {
  const Model = OUTBOXES[field];
  const user = await User.findById(userId).select(field).lean();
  for (const entry of user?.[field] || []) {
    try {
      const doc = new Model({ ...entry, userId, updatedAt: entry.createdAt });
      await doc.save({ timestamps: false });
    } catch (err) {
      if (Number(err?.code) !== 11000) throw err;
    }
    await User.updateOne({ _id: userId }, { $pull: { [field]: { _id: entry._id } } });
  }
}

/** Gọi khi khởi động (trước khi nhận request) và định kỳ: hoàn tất các thao tác bị gián đoạn */
export async function recoverOutboxes() {
  let recovered = 0;
  for (const field of Object.keys(OUTBOXES)) {
    const users = await User.find({ [`${field}._id`]: { $exists: true } }).select('_id').lean();
    for (const { _id } of users) {
      try {
        await flushOutbox(_id, field);
        recovered += 1;
      } catch (err) {
        console.error(`Không chuyển được ${field} của user ${_id}:`, err.message);
      }
    }
  }
  return recovered;
}

async function flushQuietly(userId, field) {
  try {
    await flushOutbox(userId, field);
  } catch (err) {
    // Dữ liệu đã nằm an toàn trong outbox của user → lần khôi phục định kỳ sẽ chuyển nốt
    console.error(`Chuyển ${field} thất bại, sẽ thử lại sau:`, err.message);
  }
}

/**
 * Cộng thưởng một check-in hợp lệ. Điểm, thống kê, lượt Gacha và bản ghi check-in (qua outbox) được ghi
 * trong MỘT lệnh cập nhật nguyên tử. Điều kiện trong cùng lệnh đó chặn ảnh trùng và thời gian chờ,
 * nên hai yêu cầu đồng thời không thể cùng được thưởng sai luật. Ảnh được giữ chỗ trước (RewardedImage, _id duy nhất)
 * để cùng một ảnh gửi đồng thời từ hai tài khoản khác nhau cũng chỉ được thưởng một lần.
 * Trả về { user, checkInId } hoặc { rejected: 'duplicate_image' | 'cooldown' | 'locked' }.
 */
export async function grantCheckInReward(user, { classification, imageSha256, perceptual = null, storySlug, cooldownMs = 0 }) {
  if (await findNearDuplicate(user._id, perceptual)) return { rejected: 'duplicate_image' };
  try {
    await RewardedImage.create({ _id: imageSha256, userId: user._id, ...(perceptual && { phash: perceptual.hash, phashBands: perceptual.bands }) });
  } catch (err) {
    if (Number(err?.code) === 11000) return { rejected: 'duplicate_image' };
    throw err;
  }

  const now = new Date();
  const checkInId = new mongoose.Types.ObjectId();
  const entry = {
    _id: checkInId,
    studentId: user.studentId,
    valid: true,
    category: classification.category,
    confidence: classification.confidence,
    verification: classification.status === 'simulated' ? 'simulated' : 'local',
    model: classification.model,
    aiReason: classification.reason,
    imageSha256,
    pointsEarned: POINTS_PER_CHECKIN,
    plasticSavedGrams: PLASTIC_GRAMS_PER_CUP,
    storySlug: storySlug || '',
    createdAt: now,
  };

  const filter = { _id: user._id, status: { $ne: 'locked' }, recentImageHashes: { $ne: imageSha256 } };
  if (cooldownMs > 0) {
    filter.$or = [
      { lastRewardedCheckInAt: null },
      { lastRewardedCheckInAt: { $lte: new Date(now.getTime() - cooldownMs) } },
    ];
  }

  let updated;
  try {
    updated = await User.findOneAndUpdate(
      filter,
      {
        $inc: {
          ecoPoints: POINTS_PER_CHECKIN,
          totalCheckIns: 1,
          plasticSavedGrams: PLASTIC_GRAMS_PER_CUP,
          co2SavedGrams: CO2_GRAMS_PER_CUP,
          pendingGachaSpins: 1,
        },
        $set: { lastRewardedCheckInAt: now },
        $push: {
          checkInOutbox: entry,
          recentImageHashes: { $each: [imageSha256], $slice: -RECENT_IMAGE_HASHES },
        },
      },
      { new: true }
    );
  } catch (err) {
    // Sinh viên được báo thử lại nên ảnh không được giữ ở trạng thái "đã dùng". Lệnh ghi có thể đã thành công mà mất phản hồi:
    // gửi lại vẫn an toàn vì recentImageHashes nằm trong cùng lệnh cộng thưởng
    await RewardedImage.deleteOne({ _id: imageSha256, userId: user._id }).catch(() => {});
    throw err;
  }

  if (!updated) {
    // Không được thưởng (ảnh cũ của chính tài khoản này / còn thời gian chờ) → trả chỗ để ảnh dùng lại được sau
    await RewardedImage.deleteOne({ _id: imageSha256, userId: user._id });
    const current = await User.findById(user._id).select('+recentImageHashes lastRewardedCheckInAt status').lean();
    if (!current) throw new Error('Không tìm thấy tài khoản');
    if (current.status === 'locked') return { rejected: 'locked' };
    if (current.recentImageHashes?.includes(imageSha256)) return { rejected: 'duplicate_image' };
    return { rejected: 'cooldown', lastRewardedCheckInAt: current.lastRewardedCheckInAt };
  }

  // Huy hiệu tính lại từ tổng mới; $addToSet không bao giờ làm mất huy hiệu đã có
  const badges = computeBadges(updated.totalCheckIns, updated.ecoPoints);
  await User.updateOne({ _id: user._id }, { $addToSet: { badges: { $each: badges } } }).catch((err) =>
    console.error('Cập nhật huy hiệu thất bại (sẽ tính lại ở lần sau):', err.message)
  );
  updated.badges = [...new Set([...(updated.badges || []), ...badges])];

  await flushQuietly(user._id, 'checkInOutbox');
  invalidatePublicStats();
  return { user: updated, checkInId };
}

/**
 * Quay thưởng tri ân: server rút thăm theo cấu hình đang hiệu lực (trúng thì giữ một móc khóa trong kho), rồi trừ lượt có điều kiện
 * pendingGachaSpins >= 1 và ghi kết quả (qua outbox) trong MỘT lệnh nguyên tử → nhiều yêu cầu đồng thời không thể dùng chung một
 * lượt. Lượt không trúng cũng được ghi. Không còn lượt thì trả móc khóa đã giữ; server dừng đúng lúc giữa hai bước chỉ làm kho hụt
 * đi một móc khóa (không bao giờ phát vượt số lượng).
 * Trả về null khi hết lượt, { unavailable: 'no_config' | 'out_of_stock' } khi không rút được (lượt được giữ nguyên), còn lại
 * { outcome: 'win' | 'lose', prize, rewardId, configVersion, claimInstructions, pendingGachaSpins }.
 */
export async function spinGacha(user) {
  if ((user.pendingGachaSpins || 0) < 1) return null;
  const config = await getActiveGachaConfig();
  if (!isKeychainConfig(config)) return { unavailable: 'no_config' };
  const draw = await drawFromConfig(config);
  if (draw.unavailable) return draw;

  const rewardId = new mongoose.Types.ObjectId();
  const base = { _id: rewardId, studentId: user.studentId, configId: config._id, configVersion: config.version, createdAt: new Date() };
  const won = draw.prize;
  const prize = won && {
    prizeId: won.prizeId,
    label: won.label,
    description: won.description || '',
    imageId: won.imageId || null,
    claimCode: issueClaimCode(),
  };
  const entry = won
    ? {
        ...base,
        outcome: 'win',
        prizeType: GACHA_PRIZE_TYPE,
        prizeId: prize.prizeId,
        prizeLabel: prize.label,
        imageId: prize.imageId,
        claimCode: prize.claimCode,
        deliveryStatus: 'pending',
      }
    : { ...base, outcome: 'lose' };

  const updated = await User.findOneAndUpdate(
    { _id: user._id, status: { $ne: 'locked' }, pendingGachaSpins: { $gte: 1 } },
    { $inc: { pendingGachaSpins: -1 }, $push: { gachaOutbox: entry } },
    { new: true }
  );
  if (!updated) {
    await draw.release?.();
    return null;
  }

  await flushQuietly(user._id, 'gachaOutbox');
  return {
    outcome: won ? 'win' : 'lose',
    prize,
    rewardId,
    configVersion: config.version,
    claimInstructions: config.claimInstructions || '',
    pendingGachaSpins: updated.pendingGachaSpins,
  };
}

/** Bản ghi đã chuyển + bản ghi còn trong outbox (nếu lần chuyển trước lỗi) — người dùng luôn thấy đủ */
export async function listWithOutbox(userId, field, query) {
  const [docs, user] = await Promise.all([query, User.findById(userId).select(field).lean()]);
  const seen = new Set(docs.map((d) => String(d._id)));
  const pending = (user?.[field] || []).filter((entry) => !seen.has(String(entry._id)));
  return [...pending, ...docs].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}
