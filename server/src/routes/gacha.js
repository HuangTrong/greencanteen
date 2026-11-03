import { Router } from 'express';
import { GachaReward } from '../models/GachaReward.js';
import { requireAuth, requireOwnStudentId } from '../middleware/auth.js';
import { GACHA_PRIZE_TYPE } from '../services/gacha.js';
import { listWithOutbox, spinGacha } from '../services/rewards.js';

const router = Router();

// Tài khoản lấy từ phiên đăng nhập; studentId client gửi kèm (bản cũ) chỉ được chấp nhận khi trùng tài khoản đó
router.post('/spin', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const requestedId = typeof req.body.studentId === 'string' ? req.body.studentId.trim() : '';
    if (requestedId && requestedId !== user.studentId) {
      return res.status(403).json({ error: 'Không thể quay Gacha cho tài khoản khác.', code: 'forbidden' });
    }

    const result = await spinGacha(user);
    if (!result) {
      return res.status(400).json({ error: 'Bạn chưa có lượt quay Gacha.', code: 'no_spins' });
    }
    // Không trừ lượt khi không phát được giải — sinh viên quay lại sau
    if (result.unavailable === 'no_config') {
      return res.status(503).json({ error: 'Gacha đang tạm dừng. Lượt quay của bạn vẫn được giữ.', code: 'gacha_not_configured' });
    }
    if (result.unavailable === 'out_of_stock') {
      return res.status(409).json({ error: 'Giải thưởng đợt này đã hết. Lượt quay của bạn vẫn được giữ.', code: 'gacha_out_of_stock' });
    }

    res.json({
      prize: {
        type: GACHA_PRIZE_TYPE,
        label: result.prize.label,
        carrier: result.prize.carrier,
        amountVnd: result.prize.amountVnd,
        topUpCode: result.prize.topUpCode,
      },
      pendingGachaSpins: result.pendingGachaSpins,
      rewardId: result.rewardId.toString(),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({
      error: 'Quay Gacha thất bại. Vui lòng xem lại danh sách mã nạp rồi thử lại.',
      code: 'server_error',
    });
  }
});

// Mã nạp là dữ liệu nhạy cảm → chỉ chủ tài khoản đang đăng nhập được xem
async function listRewards(req, res) {
  try {
    const rewards = await listWithOutbox(
      req.user._id,
      'gachaOutbox',
      GachaReward.find({ userId: req.user._id })
        .sort({ createdAt: -1 })
        .limit(30)
        .select('carrier amountVnd topUpCode prizeType createdAt')
        .lean()
    );
    res.json({
      pendingGachaSpins: req.user.pendingGachaSpins || 0,
      rewards: rewards.slice(0, 30).map((r) => ({
        _id: String(r._id),
        carrier: r.carrier,
        amountVnd: r.amountVnd,
        topUpCode: r.topUpCode,
        prizeType: r.prizeType,
        createdAt: r.createdAt,
      })),
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
}

router.get('/rewards', requireAuth, listRewards);
// Route cũ có :studentId trên URL — giữ cho bản client cũ còn trong cache PWA
router.get('/rewards/:studentId', requireAuth, requireOwnStudentId, listRewards);

export default router;
