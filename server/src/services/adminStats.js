import { User } from '../models/User.js';
import { CheckIn } from '../models/CheckIn.js';
import { GachaReward } from '../models/GachaReward.js';
import { invalidInput } from './adminErrors.js';
import { REPORT_TIMEZONE, REPORT_UTC_OFFSET, localDate, periodExpression, trafficReport } from './analytics.js';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 366;
const MAX_MONTHS = 60;
const DEFAULT_DAYS = 30;

const startOfDay = (date) => new Date(`${date}T00:00:00${REPORT_UTC_OFFSET}`);

function parseDate(value, field) {
  if (typeof value !== 'string' || !DATE.test(value)) throw invalidInput({ [field]: 'Ngày phải có dạng YYYY-MM-DD.' });
  const parsed = startOfDay(value);
  // Date của JavaScript tự chuyển 2026-02-30 thành 02/03: đối chiếu lại để từ chối ngày không tồn tại
  if (Number.isNaN(parsed.getTime()) || localDate(parsed) !== value) throw invalidInput({ [field]: 'Ngày không tồn tại.' });
  return value;
}

const monthKey = (year, month) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`;

function listPeriods(from, to, granularity) {
  const periods = [];
  if (granularity === 'month') {
    let [year, month] = from.split('-').map(Number);
    const lastKey = to.slice(0, 7);
    for (;;) {
      const key = monthKey(year, month);
      month = month === 12 ? 1 : month + 1;
      year = month === 1 ? year + 1 : year;
      periods.push({ key, endsAt: startOfDay(`${monthKey(year, month)}-01`) });
      if (key === lastKey) return periods;
    }
  }
  for (let day = startOfDay(from).getTime(); day <= startOfDay(to).getTime(); day += DAY_MS) {
    periods.push({ key: localDate(new Date(day)), endsAt: new Date(day + DAY_MS) });
  }
  return periods;
}

/** Khoảng báo cáo tính theo ngày lịch Việt Nam, kết thúc tại nửa đêm sau ngày `to` */
export function parseReportRange(query, now = new Date()) {
  const granularity = query.granularity === 'month' ? 'month' : 'day';
  const to = query.to === undefined ? localDate(now) : parseDate(query.to, 'to');
  const from = query.from === undefined ? localDate(new Date(startOfDay(to).getTime() - (DEFAULT_DAYS - 1) * DAY_MS)) : parseDate(query.from, 'from');
  if (from > to) throw invalidInput({ from: 'Ngày bắt đầu phải trước ngày kết thúc.' });

  const days = Math.round((startOfDay(to) - startOfDay(from)) / DAY_MS) + 1;
  if (granularity === 'day' && days > MAX_DAYS) throw invalidInput({ from: `Xem theo ngày tối đa ${MAX_DAYS} ngày; hãy chọn xem theo tháng.` });
  // Kiểm tra trước khi dựng danh sách kỳ: khoảng nhiều nghìn năm không được chạy tới vòng lặp bên dưới
  const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  if (granularity === 'month' && months > MAX_MONTHS) throw invalidInput({ from: `Xem theo tháng tối đa ${MAX_MONTHS} tháng.` });
  const periods = listPeriods(from, to, granularity);

  return { from, to, granularity, periods, start: startOfDay(from), end: new Date(startOfDay(to).getTime() + DAY_MS) };
}

// Định nghĩa đi kèm dữ liệu, hiển thị ngay trên màn hình tổng quan: số nào cũng có đơn vị và nguồn
const DEFINITIONS = [
  { key: 'accountsNew', label: 'Tài khoản mới', unit: 'tài khoản', source: 'Collection users, trường createdAt', definition: 'Số tài khoản được tạo trong kỳ.' },
  { key: 'checkInsValid', label: 'Check-in hợp lệ', unit: 'lượt', source: 'Collection checkins, valid = true', definition: 'Lượt ảnh được server xác nhận là bình/ly cá nhân đạt ngưỡng tin cậy và đã cộng thưởng.' },
  { key: 'checkInsInvalid', label: 'Check-in không hợp lệ', unit: 'lượt', source: 'Collection checkins, valid = false', definition: 'Lượt ảnh đã phân loại nhưng không được thưởng. Lỗi bộ nhận diện không được ghi nhận nên không nằm trong số này.' },
  { key: 'gachaSpins', label: 'Lượt quay thưởng tri ân', unit: 'lượt', source: 'Collection gacharewards', definition: 'Số lượt quay đã có kết quả, gồm cả lượt không trúng và mã nạp demo đã phát trước khi đổi sang móc khóa.' },
  { key: 'gachaWins', label: 'Lượt trúng móc khóa', unit: 'lượt', source: 'Collection gacharewards, prizeType = keychain', definition: 'Số lượt quay trúng móc khóa, mỗi lượt một móc khóa và một mã nhận quà. Không gồm mã nạp demo trước đây.' },
  { key: 'pageViews', label: 'Lượt xem trang', unit: 'lượt', source: 'Sự kiện page_view', definition: 'Mỗi lần mở một trang công khai trong ứng dụng. Trình duyệt tự gửi, không cần đăng nhập nên có thể bị thổi phồng (server chỉ giới hạn theo lượt truy cập và theo IP): chỉ mang tính tham khảo.' },
  { key: 'visits', label: 'Lượt truy cập', unit: 'lượt', source: 'Sự kiện page_view, visitId khác nhau', definition: 'Một chuỗi xem trang trong một tab, kết thúc sau 30 phút không hoạt động. Trình duyệt tự gửi, không cần đăng nhập nên có thể bị thổi phồng (server chỉ giới hạn theo lượt truy cập và theo IP): chỉ mang tính tham khảo.' },
  { key: 'activeUsers', label: 'Người dùng hoạt động', unit: 'tài khoản', source: 'Sự kiện page_view có mã ẩn danh theo tháng', definition: 'Số tài khoản đã đăng nhập mở ít nhất một trang trong kỳ. Không suy ra từ số check-in. Mã ẩn danh đổi theo tháng nên khoảng nhiều tháng không có tổng, chỉ có số từng kỳ.' },
  { key: 'clickThrough', label: 'Tỉ lệ nhấp', unit: '%', source: 'Sự kiện impression và click', definition: 'Lượt nhấp chia lượt hiển thị của cùng một mục. Trình duyệt tự gửi, không cần đăng nhập nên có thể bị thổi phồng (server chỉ giới hạn theo lượt truy cập và theo IP): chỉ mang tính tham khảo.' },
];

const FINANCIAL = {
  status: 'no_data_source',
  revenueVnd: null,
  costVnd: null,
  profitVnd: null,
  note: 'Hệ thống chưa có tích hợp thanh toán hay dữ liệu giao dịch. Móc khóa và mã nạp demo trước đây không được tính là doanh thu hay chi phí.',
};

async function groupByPeriod(Model, granularity, range, accumulators, extraMatch = {}) {
  const rows = await Model.aggregate([
    { $match: { createdAt: range, ...extraMatch } },
    { $group: { _id: periodExpression(granularity), ...accumulators } },
  ]);
  return new Map(rows.map(({ _id, ...values }) => [_id, values]));
}

export async function buildOverview(query) {
  const { from, to, granularity, periods, start, end } = parseReportRange(query);
  const range = { $gte: start, $lt: end };

  const [accounts, valid, invalid, rewards, byAmount, accountsTotal, accountsLocked, traffic] = await Promise.all([
    groupByPeriod(User, granularity, range, { count: { $sum: 1 } }),
    groupByPeriod(
      CheckIn,
      granularity,
      range,
      { count: { $sum: 1 }, simulated: { $sum: { $cond: [{ $eq: ['$verification', 'simulated'] }, 1, 0] } } },
      { valid: true }
    ),
    groupByPeriod(CheckIn, granularity, range, { count: { $sum: 1 } }, { valid: false }),
    groupByPeriod(GachaReward, granularity, range, { count: { $sum: 1 }, wins: { $sum: { $cond: [{ $eq: ['$prizeType', 'keychain'] }, 1, 0] } } }),
    // Mã nạp demo đã phát trước khi đổi sang móc khóa: chỉ bản ghi cũ có mệnh giá
    GachaReward.aggregate([
      { $match: { createdAt: range, amountVnd: { $type: 'number' } } },
      { $group: { _id: '$amountVnd', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    User.countDocuments({}),
    User.countDocuments({ status: 'locked' }),
    trafficReport({ start, end, granularity, periods }),
  ]);

  const series = periods.map(({ key }) => ({
    period: key,
    accountsNew: accounts.get(key)?.count ?? 0,
    checkInsValid: valid.get(key)?.count ?? 0,
    checkInsInvalid: invalid.get(key)?.count ?? 0,
    gachaSpins: rewards.get(key)?.count ?? 0,
    gachaWins: rewards.get(key)?.wins ?? 0,
    pageViews: traffic.byPeriod.get(key)?.pageViews ?? null,
    visits: traffic.byPeriod.get(key)?.visits ?? null,
    activeUsers: traffic.byPeriod.get(key)?.activeUsers ?? null,
  }));
  const sum = (field) => series.reduce((total, row) => total + row[field], 0);
  const { byPeriod: _byPeriod, ...trafficSummary } = traffic;

  return {
    range: { from, to, granularity, timezone: REPORT_TIMEZONE, utcOffset: REPORT_UTC_OFFSET },
    generatedAt: new Date(),
    totals: {
      accountsTotal,
      accountsLocked,
      accountsNew: sum('accountsNew'),
      checkInsValid: sum('checkInsValid'),
      checkInsInvalid: sum('checkInsInvalid'),
      checkInsSimulated: [...valid.values()].reduce((total, row) => total + row.simulated, 0),
      gachaSpins: sum('gachaSpins'),
      gachaWins: sum('gachaWins'),
    },
    rewardsByAmount: byAmount.map(({ _id, count }) => ({ amountVnd: _id, count, faceValueVnd: _id * count })),
    series,
    traffic: trafficSummary,
    financial: FINANCIAL,
    definitions: DEFINITIONS,
  };
}
