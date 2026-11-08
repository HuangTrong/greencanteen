import { Router } from 'express';
import { GachaConfig } from '../models/GachaConfig.js';
import { GachaMedia } from '../models/GachaMedia.js';
import { GachaReward } from '../models/GachaReward.js';
import { requireAuth, requireOwnStudentId } from '../middleware/auth.js';
import { GACHA_PRIZE_TYPE, LEGACY_TOPUP_TYPE } from '../services/gacha.js';
import { drawablePrizes, getActiveGachaConfig, isKeychainConfig, keychainUsage, remainingOf } from '../services/gachaConfig.js';
import { mediaUrl, pickSticker } from '../services/gachaMedia.js';
import { listWithOutbox, spinGacha } from '../services/rewards.js';

// Quay thưởng tri ân. Đường dẫn /api/gacha giữ nguyên từ thời Gacha để bản PWA cũ còn trong cache không gọi nhầm địa chỉ.
const router = Router();

const MEDIA_ID = /^[a-f0-9]{24}$/i;
// Mỗi ảnh có URL riêng và nội dung không đổi; để hạn ngắn vì ảnh đã xóa không nên nằm lâu trong cache của người khác
const MEDIA_CACHE = 'public, max-age=86400';
const MAX_RESULTS = 50;

/**
 * Thể lệ công khai (trang /gacha-rules.html): cấu hình đang hiệu lực, ai cũng xem được kể cả khi chưa đăng nhập. Chỉ gồm điều người
 * quay cần để hiểu kết quả: mẫu móc khóa, ảnh, xác suất, số lượng còn, hướng dẫn nhận quà. Ghi chú nội bộ, người tạo / xuất bản không
 * công khai. "available" tính đúng như lúc rút: mẫu đã hết thì phần xác suất của nó tính là không trúng.
 */
router.get('/rules', async (_req, res) => {
  try {
    const config = await getActiveGachaConfig();
    if (!isKeychainConfig(config)) return res.json({ active: false, prizes: [] });

    const prizes = drawablePrizes(config);
    const usage = await keychainUsage(prizes.map((prize) => prize.prizeId));
    res.json({
      active: true,
      version: config.version,
      effectiveFrom: config.effectiveFrom || null,
      effectiveTo: config.effectiveTo || null,
      claimInstructions: config.claimInstructions || '',
      prizes: prizes.map((prize) => {
        const remaining = remainingOf(prize, usage);
        return {
          label: prize.label,
          description: prize.description || '',
          imageUrl: mediaUrl(prize.imageId),
          probabilityPpm: prize.probabilityPpm,
          maxQuantity: prize.maxQuantity,
          remaining,
          available: remaining > 0,
        };
      }),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Không tải được thể lệ quay thưởng.', code: 'server_error' });
  }
});

// Ảnh móc khóa và sticker: công khai vì hiện trên trang thể lệ; mã trên URL ngẫu nhiên. Nội dung luôn là WebP do máy chủ mã hóa lại
router.get('/media/:id', async (req, res) => {
  try {
    const media = MEDIA_ID.test(req.params.id) ? await GachaMedia.findById(req.params.id).select('data') : null;
    if (!media) return res.status(404).json({ error: 'Không tìm thấy ảnh.', code: 'not_found' });
    res.set('Cache-Control', MEDIA_CACHE).type('image/webp').send(Buffer.from(media.data));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

// Tài khoản lấy từ phiên đăng nhập; studentId client gửi kèm (bản cũ) chỉ được chấp nhận khi trùng tài khoản đó
router.post('/draw', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const requestedId = typeof req.body.studentId === 'string' ? req.body.studentId.trim() : '';
    if (requestedId && requestedId !== user.studentId) {
      return res.status(403).json({ error: 'Không thể quay thưởng cho tài khoản khác.', code: 'forbidden' });
    }

    const result = await spinGacha(user);
    if (!result) {
      return res.status(400).json({ error: 'Bạn chưa có lượt quay thưởng tri ân.', code: 'no_spins' });
    }
    // Không trừ lượt khi không rút được — sinh viên quay lại sau
    if (result.unavailable === 'no_config') {
      return res.status(503).json({ error: 'Quay thưởng tri ân đang tạm dừng. Lượt quay của bạn vẫn được giữ.', code: 'gacha_not_configured' });
    }
    if (result.unavailable === 'out_of_stock') {
      return res.status(409).json({ error: 'Móc khóa đợt này đã được trao hết. Lượt quay của bạn vẫn được giữ.', code: 'gacha_out_of_stock' });
    }

    // Sticker chỉ là hình trang trí, chọn sau khi đã có kết quả; lỗi chọn sticker không làm mất kết quả đã ghi
    const sticker = await pickSticker(result.outcome).catch(() => null);
    res.json({
      outcome: result.outcome,
      prize: result.prize && {
        type: GACHA_PRIZE_TYPE,
        label: result.prize.label,
        description: result.prize.description,
        imageUrl: mediaUrl(result.prize.imageId),
        claimCode: result.prize.claimCode,
      },
      claimInstructions: result.outcome === 'win' ? result.claimInstructions : '',
      sticker,
      pendingGachaSpins: result.pendingGachaSpins,
      rewardId: result.rewardId.toString(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Quay thưởng thất bại. Vui lòng xem lại kết quả trong trang Cá nhân rồi thử lại.',
      code: 'server_error',
    });
  }
});

// Bản PWA cũ (mã nạp) còn trong cache gọi địa chỉ này và không hiển thị được móc khóa: báo tải lại trang, không trừ lượt
router.post('/spin', requireAuth, (_req, res) => {
  res.status(409).json({ error: 'Ứng dụng vừa được cập nhật. Tải lại trang để quay thưởng tri ân, lượt quay của bạn vẫn được giữ.', code: 'client_outdated' });
});

const isWin = (reward) => reward.outcome !== 'lose';

/**
 * Kết quả quay của chính chủ tài khoản: các lượt trúng (móc khóa kèm mã nhận quà, mã nạp demo cũ) và số lượt đã quay / đã trúng.
 * Lượt không trúng không liệt kê từng dòng để quà đã trúng không bị đẩy khỏi danh sách.
 */
router.get('/results', requireAuth, async (req, res) => {
  try {
    const userId = req.user._id;
    const [merged, spins, wins] = await Promise.all([
      listWithOutbox(
        userId,
        'gachaOutbox',
        GachaReward.find({ userId, outcome: { $ne: 'lose' } })
          .sort({ createdAt: -1 })
          .limit(MAX_RESULTS)
          .select('outcome prizeType prizeLabel imageId claimCode deliveryStatus deliveredAt configId carrier amountVnd topUpCode createdAt')
          .lean()
      ),
      GachaReward.countDocuments({ userId }),
      GachaReward.countDocuments({ userId, prizeType: GACHA_PRIZE_TYPE }),
    ]);
    const rewards = merged.filter(isWin).slice(0, MAX_RESULTS);
    const configIds = [...new Set(rewards.filter((r) => r.prizeType === GACHA_PRIZE_TYPE && r.configId).map((r) => String(r.configId)))];
    const configs = await GachaConfig.find({ _id: { $in: configIds } }).select('claimInstructions').lean();
    const instructions = new Map(configs.map((config) => [config._id.toString(), config.claimInstructions || '']));

    res.json({
      pendingGachaSpins: req.user.pendingGachaSpins || 0,
      stats: { spins, wins },
      rewards: rewards.map((r) =>
        r.prizeType === GACHA_PRIZE_TYPE
          ? {
              id: String(r._id),
              type: GACHA_PRIZE_TYPE,
              label: r.prizeLabel,
              imageUrl: mediaUrl(r.imageId),
              claimCode: r.claimCode,
              deliveryStatus: r.deliveryStatus || 'pending',
              deliveredAt: r.deliveredAt || null,
              claimInstructions: instructions.get(String(r.configId)) || '',
              createdAt: r.createdAt,
            }
          : {
              id: String(r._id),
              type: LEGACY_TOPUP_TYPE,
              carrier: r.carrier || '',
              amountVnd: r.amountVnd ?? null,
              topUpCode: r.topUpCode || '',
              createdAt: r.createdAt,
            }
      ),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

// Định dạng cũ cho bản PWA cũ: chỉ các mã nạp demo đã nhận trước đây (bản cũ không hiển thị được móc khóa)
async function listLegacyRewards(req, res) {
  try {
    const rewards = await GachaReward.find({ userId: req.user._id, prizeType: { $ne: GACHA_PRIZE_TYPE }, outcome: { $ne: 'lose' } })
      .sort({ createdAt: -1 })
      .limit(30)
      .select('carrier amountVnd topUpCode prizeType createdAt')
      .lean();
    res.json({
      pendingGachaSpins: req.user.pendingGachaSpins || 0,
      rewards: rewards
        .filter((r) => Number.isFinite(r.amountVnd))
        .map((r) => ({
          _id: String(r._id),
          carrier: r.carrier || '',
          amountVnd: r.amountVnd,
          topUpCode: r.topUpCode || '',
          prizeType: r.prizeType || LEGACY_TOPUP_TYPE,
          createdAt: r.createdAt,
        })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
}

router.get('/rewards', requireAuth, listLegacyRewards);
// Route cũ có :studentId trên URL — giữ cho bản client cũ còn trong cache PWA
router.get('/rewards/:studentId', requireAuth, requireOwnStudentId, listLegacyRewards);

export default router;
