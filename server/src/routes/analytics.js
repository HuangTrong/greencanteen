import { Router } from 'express';
import {
  analyticsEnabled,
  analyticsEventsPerVisit,
  analyticsVisitsPerIp,
  parseAnalyticsEvent,
  recordAnalyticsEvent,
} from '../services/analytics.js';
import { clientIpKey, createRateLimiter, tooManyRequests } from '../services/rateLimit.js';

const router = Router();

// Chống ghi rác vào DB; ngưỡng rộng vì cả trường có thể dùng chung một IP qua NAT
const eventLimiter = createRateLimiter({ name: 'analytics-ip', max: 3000, windowMs: 10 * 60 * 1000 });
// SEC-07: mã lượt truy cập do trình duyệt tự tạo. Mỗi lượt chỉ ghi được một số sự kiện, mỗi IP chỉ mở được một số lượt mới → một nguồn
// không tự thổi phồng lượt xem, lượt truy cập, tỉ lệ nhấp quá mức đó (nhiều IP thì vẫn được: số liệu chỉ mang tính tham khảo)
const visitEvents = createRateLimiter({ name: 'analytics-visit', max: () => analyticsEventsPerVisit(), windowMs: 30 * 60 * 1000 });
const newVisitsByIp = createRateLimiter({ name: 'analytics-new-visit', max: () => analyticsVisitsPerIp(), windowMs: 10 * 60 * 1000 });

router.post('/events', async (req, res) => {
  try {
    if (!analyticsEnabled()) return res.status(202).json({ ok: true, recorded: false });
    const event = parseAnalyticsEvent(req.body);
    if (!event) return res.status(400).json({ error: 'Sự kiện không hợp lệ.', code: 'invalid_event' });
    const ip = clientIpKey(req);
    if (await eventLimiter.hit(ip)) return tooManyRequests(res);
    const visit = await visitEvents.consume(event.visitId);
    if (visit.limited) return tooManyRequests(res);
    if (visit.count === 1 && (await newVisitsByIp.hit(ip))) {
      // Lượt truy cập không được mở: trả lại lượt đếm để lần sau mã này vẫn được tính là lượt mới
      await visitEvents.release(event.visitId);
      return tooManyRequests(res);
    }
    await recordAnalyticsEvent(req, event);
    res.status(202).json({ ok: true, recorded: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Lỗi máy chủ.', code: 'server_error' });
  }
});

export default router;
