import { Router } from 'express';
import { analyticsEnabled, parseAnalyticsEvent, recordAnalyticsEvent } from '../services/analytics.js';
import { clientIpKey, createRateLimiter, tooManyRequests } from '../services/rateLimit.js';

const router = Router();

// Chống ghi rác vào DB; ngưỡng rộng vì cả trường có thể dùng chung một IP qua NAT
const eventLimiter = createRateLimiter({ name: 'analytics-ip', max: 3000, windowMs: 10 * 60 * 1000 });

router.post('/events', async (req, res) => {
  try {
    if (!analyticsEnabled()) return res.status(202).json({ ok: true, recorded: false });
    const event = parseAnalyticsEvent(req.body);
    if (!event) return res.status(400).json({ error: 'Sự kiện không hợp lệ.', code: 'invalid_event' });
    if (await eventLimiter.hit(clientIpKey(req))) return tooManyRequests(res);
    await recordAnalyticsEvent(req, event);
    res.status(202).json({ ok: true, recorded: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

export default router;
