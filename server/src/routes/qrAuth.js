import crypto from 'crypto';
import { Router } from 'express';
import { QrLogin } from '../models/QrLogin.js';
import { User } from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';
import { serializeUser } from '../services/accounts.js';
import { isQrLoginEnabled } from '../services/oauth.js';
import { hashToken, randomToken, safeEqual, startSession } from '../services/session.js';
import { clientIpKey, createRateLimiter, tooManyRequests } from '../services/rateLimit.js';

const router = Router();

// Chặn tạo thử thách hàng loạt làm đầy DB; ngưỡng rộng vì cả lớp học có thể dùng chung một IP
const qrStartLimiter = createRateLimiter({ name: 'qr-start-ip', max: 60, windowMs: 10 * 60 * 1000 });

const QR_TTL_MS = 2 * 60 * 1000;
// Sau khi được xác nhận, thiết bị hiển thị QR có thêm chừng này thời gian để nhận phiên
const QR_PICKUP_MS = 60 * 1000;
const POLL_INTERVAL_MS = 2000;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;
const MATCH_CODE_PATTERN = /^\d{4}$/;
// Mỗi thử thách sống 2 phút và chỉ được đoán từng này lần trên 10 000 khả năng
const MATCH_ATTEMPTS = 3;

const INVALID_QR = {
  error: 'Mã QR không tồn tại, đã hết hạn hoặc đã được sử dụng.',
  code: 'qr_invalid',
};
const MATCH_REQUIRED = {
  error: 'Nhập mã đối chiếu đang hiển thị trên thiết bị muốn đăng nhập.',
  code: 'qr_match_required',
};
const MATCH_INVALID = {
  error: 'Mã đối chiếu không đúng. Kiểm tra lại mã trên thiết bị của bạn; nếu ai đó gửi mã QR cho bạn, hãy bấm Từ chối.',
  code: 'qr_match_invalid',
};

/**
 * Thiết bị CHƯA đăng nhập tạo thử thách. challengeId được đưa vào QR (chỉ để tìm thử thách);
 * pollToken chỉ thiết bị này giữ trong bộ nhớ để nhận phiên. QR không chứa gì tự đăng nhập được.
 * matchCode chỉ hiện trên màn hình thiết bị này: người bị lừa quét QR gửi qua mạng không có mã trước mặt nên không xác nhận nhầm được.
 */
router.post('/start', async (req, res) => {
  if (!isQrLoginEnabled()) {
    return res
      .status(503)
      .json({ error: 'Đăng nhập bằng mã QR chưa được bật trên máy chủ.', code: 'provider_not_configured' });
  }
  try {
    if (await qrStartLimiter.hit(clientIpKey(req))) {
      return tooManyRequests(res, 'Đã tạo quá nhiều mã QR. Vui lòng thử lại sau ít phút.');
    }
    const challengeId = randomToken(24);
    const pollToken = randomToken(32);
    const matchCode = String(crypto.randomInt(10_000)).padStart(4, '0');
    const expiresAt = new Date(Date.now() + QR_TTL_MS);
    await QrLogin.create({
      challengeHash: hashToken(challengeId),
      pollTokenHash: hashToken(pollToken),
      matchCodeHash: hashToken(matchCode),
      requesterUserAgent: (req.get('user-agent') || '').slice(0, 300),
      expiresAt,
    });
    res.json({ challengeId, pollToken, matchCode, expiresAt, expiresInMs: QR_TTL_MS, pollIntervalMs: POLL_INTERVAL_MS });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Không tạo được mã QR.', code: 'server_error' });
  }
});

router.post('/poll', async (req, res) => {
  try {
    const { pollToken } = req.body;
    if (typeof pollToken !== 'string' || !TOKEN_PATTERN.test(pollToken)) return res.json({ status: 'expired' });

    const qr = await QrLogin.findOne({ pollTokenHash: hashToken(pollToken) });
    if (!qr || qr.expiresAt <= new Date() || qr.status === 'consumed') return res.json({ status: 'expired' });
    if (qr.status === 'pending') return res.json({ status: 'pending', expiresAt: qr.expiresAt });
    if (qr.status === 'rejected') {
      await QrLogin.deleteOne({ _id: qr._id });
      return res.json({ status: 'rejected' });
    }

    // approved → consumed trong một lệnh nguyên tử: phiên chỉ được cấp đúng một lần
    const consumed = await QrLogin.findOneAndUpdate(
      { _id: qr._id, status: 'approved', expiresAt: { $gt: new Date() } },
      { $set: { status: 'consumed' } },
      { new: true }
    );
    const user = consumed && (await User.findById(consumed.userId));
    if (!user || user.status === 'locked') return res.json({ status: 'expired' });

    await startSession(req, res, user);
    res.json({ status: 'approved', user: serializeUser(user) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

// ---- Thiết bị ĐÃ đăng nhập xem và xác nhận / từ chối thử thách ----

function challengeFilter(challengeId) {
  if (typeof challengeId !== 'string' || !TOKEN_PATTERN.test(challengeId)) return null;
  return { challengeHash: hashToken(challengeId), status: 'pending', expiresAt: { $gt: new Date() } };
}

router.get('/challenge/:challengeId', requireAuth, async (req, res) => {
  try {
    const filter = challengeFilter(req.params.challengeId);
    const qr = filter && (await QrLogin.findOne(filter));
    if (!qr) return res.status(404).json(INVALID_QR);
    res.json({
      device: describeUserAgent(qr.requesterUserAgent),
      createdAt: qr.createdAt,
      expiresAt: qr.expiresAt,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

router.post('/challenge/:challengeId/approve', requireAuth, async (req, res) => {
  try {
    const filter = challengeFilter(req.params.challengeId);
    if (!filter || !(await QrLogin.exists(filter))) return res.status(410).json(INVALID_QR);
    const { matchCode } = req.body;
    if (typeof matchCode !== 'string' || !MATCH_CODE_PATTERN.test(matchCode)) return res.status(400).json(MATCH_REQUIRED);

    // Tiêu một lượt trước khi so: nhiều yêu cầu đồng thời không đoán được quá số lần cho phép
    const attempt = await QrLogin.findOneAndUpdate({ ...filter, matchAttempts: { $lt: MATCH_ATTEMPTS } }, { $inc: { matchAttempts: 1 } }, { new: true });
    if (!attempt) return res.status(410).json(INVALID_QR);
    if (!safeEqual(attempt.matchCodeHash, hashToken(matchCode))) {
      if (attempt.matchAttempts < MATCH_ATTEMPTS) return res.status(400).json(MATCH_INVALID);
      await QrLogin.updateOne({ _id: attempt._id, status: 'pending' }, { $set: { status: 'rejected' } });
      return res.status(410).json(INVALID_QR);
    }

    const now = new Date();
    const qr = await QrLogin.findOneAndUpdate(
      { _id: attempt._id, status: 'pending' },
      {
        $set: {
          status: 'approved',
          userId: req.user._id,
          approvedAt: now,
          expiresAt: new Date(now.getTime() + QR_PICKUP_MS),
        },
      },
      { new: true }
    );
    if (!qr) return res.status(410).json(INVALID_QR);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Không xác nhận được đăng nhập.', code: 'server_error' });
  }
});

router.post('/challenge/:challengeId/reject', requireAuth, async (req, res) => {
  try {
    const filter = challengeFilter(req.params.challengeId);
    const qr = filter && (await QrLogin.findOneAndUpdate(filter, { $set: { status: 'rejected' } }));
    if (!qr) return res.status(410).json(INVALID_QR);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

/** Mô tả ngắn thiết bị yêu cầu để người xác nhận nhận ra (chống bị lừa quét QR của kẻ khác) */
function describeUserAgent(ua = '') {
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /coc_coc/i.test(ua)
      ? 'Cốc Cốc'
      : /OPR\/|Opera/.test(ua)
        ? 'Opera'
        : /Firefox\//.test(ua)
          ? 'Firefox'
          : /Chrome\//.test(ua)
            ? 'Chrome'
            : /Safari\//.test(ua)
              ? 'Safari'
              : 'Trình duyệt';
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(ua)
        ? 'iOS'
        : /Mac OS X/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : 'hệ điều hành không rõ';
  return `${browser} trên ${os}`;
}

export default router;
