import crypto from 'crypto';
import { AnalyticsEvent } from '../models/AnalyticsEvent.js';
import { env, envFlag, envNumber } from './config.js';
import { getSessionUser } from './session.js';

export const REPORT_TIMEZONE = 'Asia/Ho_Chi_Minh';
export const REPORT_UTC_OFFSET = '+07:00';

/** Ngày YYYY-MM-DD theo giờ Việt Nam của một mốc thời gian */
export function localDate(date) {
  return new Date(date.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const localMonth = (date) => localDate(date).slice(0, 7);

// Chỉ nhận tên cố định: URL thật có thể chứa mã đặt lại mật khẩu hoặc mã QR nên không bao giờ được gửi lên
export const ANALYTICS_PAGES = ['home', 'checkin', 'leaderboard', 'profile'];
export const ANALYTICS_TARGETS = {
  home_primary_cta: 'Nút chính ở trang chủ',
  story_source_link: 'Liên kết nguồn nghiên cứu',
};
const VISIT_ID = /^[a-z0-9-]{16,40}$/i;

export const analyticsEnabled = () => envFlag('ANALYTICS_ENABLED');
export const analyticsRetentionDays = () => envNumber('ANALYTICS_RETENTION_DAYS', 90, { min: 7, max: 395 });
// SEC-07: sự kiện không cần đăng nhập. Trần số sự kiện mỗi lượt truy cập (30 phút) và số lượt truy cập mới mỗi IP (10 phút)
export const analyticsEventsPerVisit = () => envNumber('ANALYTICS_EVENTS_PER_VISIT', 120, { min: 1, max: 10_000 });
export const analyticsVisitsPerIp = () => envNumber('ANALYTICS_VISITS_PER_IP', 600, { min: 1, max: 100_000 });

/**
 * Mã ẩn danh của tài khoản, đổi theo tháng báo cáo (giờ Việt Nam) để không theo dấu được một người lâu dài.
 * Không có ANALYTICS_HASH_KEY thì không lưu, chỉ số người dùng hoạt động báo chưa có nguồn.
 */
export function actorKeyFor(userId, now) {
  const secret = env('ANALYTICS_HASH_KEY');
  if (!secret) return undefined;
  return crypto.createHmac('sha256', secret).update(`${userId}:${localMonth(now)}`).digest('base64url').slice(0, 32);
}

export const hasActorKey = () => Boolean(env('ANALYTICS_HASH_KEY'));

/** Kiểm tra sự kiện từ trình duyệt. Trả về dữ liệu đã lọc hoặc null nếu không đúng danh sách cho phép. */
export function parseAnalyticsEvent(body) {
  const { type, page, target, visitId } = body || {};
  if (typeof visitId !== 'string' || !VISIT_ID.test(visitId)) return null;
  if (type === 'page_view') return ANALYTICS_PAGES.includes(page) ? { type, page, visitId } : null;
  if (type === 'impression' || type === 'click') {
    return Object.hasOwn(ANALYTICS_TARGETS, target) ? { type, target, visitId } : null;
  }
  return null;
}

export async function recordAnalyticsEvent(req, event) {
  const now = new Date();
  // Lượt xem của tài khoản đã đăng nhập là nguồn của chỉ số "người dùng hoạt động". Danh tính lấy từ phiên ở server.
  const user = event.type === 'page_view' ? await getSessionUser(req) : null;
  await AnalyticsEvent.create({
    ...event,
    actorKey: user ? actorKeyFor(user._id, now) : undefined,
    createdAt: now,
    expiresAt: new Date(now.getTime() + analyticsRetentionDays() * 24 * 60 * 60 * 1000),
  });
}

/** Biểu thức nhóm theo ngày / tháng theo giờ Việt Nam */
export function periodExpression(granularity) {
  return {
    $dateToString: { date: '$createdAt', format: granularity === 'month' ? '%Y-%m' : '%Y-%m-%d', timezone: REPORT_TIMEZONE },
  };
}

async function countDistinct(match, field, groupId) {
  const rows = await AnalyticsEvent.aggregate([
    { $match: { ...match, [field]: { $type: 'string' } } },
    { $group: { _id: { period: groupId, value: `$${field}` } } },
    { $group: { _id: '$_id.period', count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
}

async function countEvents(match, groupId) {
  const rows = await AnalyticsEvent.aggregate([{ $match: match }, { $group: { _id: groupId, count: { $sum: 1 } } }]);
  return new Map(rows.map((row) => [row._id, row.count]));
}

/**
 * Báo cáo truy cập cho khoảng [start, end). Mỗi chỉ số đếm từ sự kiện thật; kỳ nằm ngoài thời gian có dữ liệu trả null
 * (chưa có nguồn), không trả 0. Tổng lượt truy cập / người dùng được đếm riêng vì một người có thể xuất hiện ở nhiều kỳ.
 * Khoảng nhiều tháng không có tổng người dùng: cùng một người ở hai tháng là hai mã, cộng gộp sẽ đếm trùng.
 */
export async function trafficReport({ start, end, granularity, periods }) {
  const firstEvent = await AnalyticsEvent.findOne().sort({ createdAt: 1 }).select('createdAt').lean();
  const enabled = analyticsEnabled();
  const base = { retentionDays: analyticsRetentionDays(), collectingSince: firstEvent?.createdAt || null, enabled };
  if (!firstEvent) {
    return { ...base, status: enabled ? 'no_data' : 'disabled', totals: null, activeUsersAvailable: false, clickThrough: [], byPeriod: new Map() };
  }

  const range = { createdAt: { $gte: start, $lt: end } };
  const pageViews = { ...range, type: 'page_view' };
  const period = periodExpression(granularity);
  const spansMonths = localMonth(start) !== localMonth(new Date(end.getTime() - 1));
  const [viewsByPeriod, visitsByPeriod, activeByPeriod, visitTotal, activeTotal, impressions, clicks] = await Promise.all([
    countEvents(pageViews, period),
    countDistinct(pageViews, 'visitId', period),
    countDistinct(pageViews, 'actorKey', period),
    countDistinct(pageViews, 'visitId', 'all'),
    spansMonths ? new Map() : countDistinct(pageViews, 'actorKey', 'all'),
    countEvents({ ...range, type: 'impression' }, '$target'),
    countEvents({ ...range, type: 'click' }, '$target'),
  ]);

  const coveredFrom = firstEvent.createdAt.getTime();
  const byPeriod = new Map(
    periods.map(({ key, endsAt }) => {
      if (endsAt.getTime() <= coveredFrom) return [key, { pageViews: null, visits: null, activeUsers: null }];
      return [
        key,
        {
          pageViews: viewsByPeriod.get(key) ?? 0,
          visits: visitsByPeriod.get(key) ?? 0,
          activeUsers: hasActorKey() ? (activeByPeriod.get(key) ?? 0) : null,
        },
      ];
    })
  );

  return {
    ...base,
    status: 'ok',
    activeUsersAvailable: hasActorKey(),
    activeUsersSpansMonths: spansMonths,
    totals: {
      pageViews: [...viewsByPeriod.values()].reduce((sum, n) => sum + n, 0),
      visits: visitTotal.get('all') ?? 0,
      activeUsers: hasActorKey() && !spansMonths ? (activeTotal.get('all') ?? 0) : null,
    },
    clickThrough: Object.entries(ANALYTICS_TARGETS).map(([target, label]) => {
      const shown = impressions.get(target) ?? 0;
      const clicked = clicks.get(target) ?? 0;
      return { target, label, impressions: shown, clicks: clicked, ratePercent: shown ? Number(((clicked / shown) * 100).toFixed(2)) : null };
    }),
    byPeriod,
  };
}
