// Tổng quan và phân tích: nhóm theo ngày giờ Việt Nam, chỉ số chưa có nguồn, sự kiện tối thiểu, tài chính không có số giả
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { User } from '../../src/models/User.js';
import { CheckIn } from '../../src/models/CheckIn.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { AnalyticsEvent } from '../../src/models/AnalyticsEvent.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { createClient, registerUser, setEnv, startTestServer, uniqueSuffix } from '../helpers.js';
import { ADMIN_ENV, enrolledAdmin } from '../adminHelpers.js';

let ctx;
let admin;

const ANALYTICS = { ...ADMIN_ENV, ANALYTICS_ENABLED: 'true', ANALYTICS_HASH_KEY: 'khoa-thu-nghiem-analytics' };
const visitId = () => `visit-${uniqueSuffix()}-abcdefgh`.toLowerCase();
const overview = async (query) => (await admin.client.get(`/api/admin/overview?${query}`)).data;
const today = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function seedCheckIn(at, { valid = true, verification = 'local' } = {}) {
  await CheckIn.collection.insertOne({
    userId: new mongoose.Types.ObjectId(),
    studentId: 'x',
    valid,
    verification,
    pointsEarned: valid ? 10 : 0,
    createdAt: new Date(at),
    updatedAt: new Date(at),
  });
}

async function seedSpin(at, outcome) {
  await GachaReward.collection.insertOne({
    userId: new mongoose.Types.ObjectId(),
    studentId: 'x',
    outcome,
    ...(outcome === 'win' ? { prizeType: 'keychain', prizeLabel: 'Lá xanh', claimCode: `TA-${uniqueSuffix()}`, deliveryStatus: 'pending' } : {}),
    createdAt: new Date(at),
  });
}

async function seedReward(at, amountVnd) {
  await GachaReward.collection.insertOne({
    userId: new mongoose.Types.ObjectId(),
    studentId: 'x',
    amountVnd,
    carrier: 'Viettel',
    topUpCode: `GC-${uniqueSuffix()}`,
    createdAt: new Date(at),
  });
}

before(async () => {
  setEnv(ADMIN_ENV);
  ctx = await startTestServer();
  admin = await enrolledAdmin(ctx.base);
});
after(() => ctx.stop());
beforeEach(async () => {
  setEnv(ADMIN_ENV);
  await RateLimit.deleteMany({});
  await CheckIn.collection.deleteMany({});
  await GachaReward.collection.deleteMany({});
  await AnalyticsEvent.collection.deleteMany({});
});

describe('thống kê từ dữ liệu bền vững', () => {
  test('bản ghi quanh nửa đêm rơi đúng ngày theo giờ Việt Nam (UTC+7)', async () => {
    await seedCheckIn('2026-03-01T16:59:59.000Z'); // 23:59:59 ngày 01/03 giờ VN
    await seedCheckIn('2026-03-01T17:00:00.000Z'); // 00:00:00 ngày 02/03 giờ VN
    const data = await overview('from=2026-03-01&to=2026-03-02');
    assert.deepEqual(data.series.map((row) => [row.period, row.checkInsValid]), [['2026-03-01', 1], ['2026-03-02', 1]]);
    assert.equal(data.range.timezone, 'Asia/Ho_Chi_Minh');
  });

  test('biên khoảng lọc: mốc đầu và cuối theo giờ Việt Nam được tính, ngoài khoảng không tính', async () => {
    await seedCheckIn('2026-02-28T16:59:59.999Z'); // trước khoảng
    await seedCheckIn('2026-02-28T17:00:00.000Z'); // 00:00 ngày đầu
    await seedCheckIn('2026-03-01T16:59:59.999Z'); // 23:59:59.999 ngày cuối
    await seedCheckIn('2026-03-01T17:00:00.000Z'); // sau khoảng
    assert.equal((await overview('from=2026-03-01&to=2026-03-01')).totals.checkInsValid, 2);
  });

  test('phân biệt hợp lệ / không hợp lệ / mô phỏng; ngày trống có giá trị 0', async () => {
    await seedCheckIn('2026-03-10T05:00:00Z');
    await seedCheckIn('2026-03-10T06:00:00Z', { verification: 'simulated' });
    await seedCheckIn('2026-03-12T05:00:00Z', { valid: false });
    const data = await overview('from=2026-03-10&to=2026-03-12');
    assert.deepEqual(data.series.map((row) => [row.checkInsValid, row.checkInsInvalid]), [[2, 0], [0, 0], [0, 1]]);
    assert.equal(data.totals.checkInsValid, 2);
    assert.equal(data.totals.checkInsInvalid, 1);
    assert.equal(data.totals.checkInsSimulated, 1);
  });

  test('tổng hợp theo tháng; tháng 12 sang năm mới; tháng trống vẫn có dòng', async () => {
    await seedCheckIn('2026-11-30T05:00:00Z');
    await seedCheckIn('2026-11-30T16:59:00Z');
    await seedCheckIn('2026-11-30T17:00:00Z'); // 00:00 ngày 01/12 giờ VN
    await seedCheckIn('2027-02-01T05:00:00Z');
    const data = await overview('from=2026-11-01&to=2027-02-28&granularity=month');
    assert.deepEqual(data.series.map((row) => [row.period, row.checkInsValid]), [['2026-11', 2], ['2026-12', 1], ['2027-01', 0], ['2027-02', 1]]);
  });

  test('lượt quay gồm cả lượt không trúng và mã nạp demo cũ; lượt trúng chỉ đếm móc khóa; mã nạp cũ theo mệnh giá', async () => {
    for (const amount of [10_000, 10_000, 20_000, 50_000]) await seedReward('2026-04-02T05:00:00Z', amount);
    await seedSpin('2026-04-03T05:00:00Z', 'win');
    await seedSpin('2026-04-03T06:00:00Z', 'lose');
    await seedSpin('2026-04-03T07:00:00Z', 'lose');
    const data = await overview('from=2026-04-01&to=2026-04-30');
    assert.equal(data.totals.gachaSpins, 7);
    assert.equal(data.totals.gachaWins, 1);
    assert.deepEqual(data.series.find((row) => row.period === '2026-04-03').gachaWins, 1);
    assert.ok(!('rewardFaceValueVnd' in data.totals));
    assert.deepEqual(data.rewardsByAmount, [
      { amountVnd: 10_000, count: 2, faceValueVnd: 20_000 },
      { amountVnd: 20_000, count: 1, faceValueVnd: 20_000 },
      { amountVnd: 50_000, count: 1, faceValueVnd: 50_000 },
    ]);
  });

  test('tài khoản mới đếm đúng kỳ, tài khoản bị khóa được tách riêng', async () => {
    const before = await overview(`from=${today()}&to=${today()}`);
    const res = await registerUser(createClient(ctx.base));
    await User.updateOne({ _id: res.data.user.id }, { $set: { status: 'locked' } });
    const after = await overview(`from=${today()}&to=${today()}`);
    assert.equal(after.totals.accountsNew, before.totals.accountsNew + 1);
    assert.equal(after.totals.accountsTotal, before.totals.accountsTotal + 1);
    assert.equal(after.totals.accountsLocked, before.totals.accountsLocked + 1);
    await User.updateOne({ _id: res.data.user.id }, { $set: { status: 'active' } });
  });

  test('mặc định 30 ngày gần nhất; mọi chỉ số có định nghĩa, đơn vị, nguồn', async () => {
    const data = await overview('');
    assert.equal(data.series.length, 30);
    assert.equal(data.range.granularity, 'day');
    for (const key of ['accountsNew', 'checkInsValid', 'checkInsInvalid', 'gachaSpins', 'gachaWins', 'pageViews', 'visits', 'activeUsers', 'clickThrough']) {
      const definition = data.definitions.find((d) => d.key === key);
      assert.ok(definition?.unit && definition.source && definition.definition, key);
    }
  });

  test('tham số thời gian sai bị từ chối', async () => {
    for (const query of ['from=hom-nay', 'from=2026-13-01', 'from=2026-02-30', 'from=2026-03-02&to=2026-03-01', 'from=2024-01-01&to=2026-01-01', 'from=2010-01-01&to=2026-01-01&granularity=month', 'from[$gt]=x']) {
      const res = await admin.client.get(`/api/admin/overview?${query}`);
      assert.equal(res.status, 400, query);
      assert.equal(res.data.code, 'invalid_input');
    }
  });
});

describe('tài chính', () => {
  test('không có nguồn giao dịch: doanh thu, chi phí, lợi nhuận là null; quà quay thưởng không bị tính là doanh thu', async () => {
    await seedReward('2026-04-02T05:00:00Z', 50_000);
    const { financial, totals } = await overview('from=2026-04-01&to=2026-04-30');
    assert.equal(financial.status, 'no_data_source');
    assert.equal(financial.revenueVnd, null);
    assert.equal(financial.costVnd, null);
    assert.equal(financial.profitVnd, null);
    assert.equal(totals.gachaSpins, 1);
  });
});

describe('chỉ số truy cập', () => {
  const send = (client, json) => client.post('/api/analytics/events', { json });

  test('chưa có sự kiện: trạng thái chưa có dữ liệu, chỉ số là null, không suy ra từ check-in', async () => {
    setEnv(ANALYTICS);
    await seedCheckIn('2026-04-02T05:00:00Z');
    const { traffic, series } = await overview('from=2026-04-01&to=2026-04-03');
    assert.equal(traffic.status, 'no_data');
    assert.equal(traffic.totals, null);
    assert.ok(series.every((row) => row.pageViews === null && row.visits === null && row.activeUsers === null));
  });

  test('tắt thu thập: sự kiện không được ghi, báo trạng thái đã tắt', async () => {
    const res = await send(createClient(ctx.base), { type: 'page_view', page: 'home', visitId: visitId() });
    assert.equal(res.status, 202);
    assert.equal(res.data.recorded, false);
    assert.equal(await AnalyticsEvent.countDocuments(), 0);
    assert.equal((await overview('')).traffic.status, 'disabled');
  });

  test('lượt xem, lượt truy cập, người dùng hoạt động là ba con số khác nhau', async () => {
    setEnv(ANALYTICS);
    const student = createClient(ctx.base);
    await registerUser(student);
    const [visitA, visitB] = [visitId(), visitId()];
    await send(student, { type: 'page_view', page: 'home', visitId: visitA });
    await send(student, { type: 'page_view', page: 'profile', visitId: visitA });
    await send(student, { type: 'page_view', page: 'home', visitId: visitB });
    await send(createClient(ctx.base), { type: 'page_view', page: 'home', visitId: visitId() });
    const { traffic, series } = await overview(`from=${today()}&to=${today()}`);
    assert.equal(traffic.status, 'ok');
    assert.deepEqual(traffic.totals, { pageViews: 4, visits: 3, activeUsers: 1 });
    assert.deepEqual([series[0].pageViews, series[0].visits, series[0].activeUsers], [4, 3, 1]);
  });

  test('khoảng vắt qua hai tháng: không có tổng người dùng hoạt động vì mã đổi theo tháng, số từng kỳ vẫn đúng', async () => {
    setEnv(ANALYTICS);
    // Cùng một người: sang tháng mới thì có mã mới, cộng gộp sẽ thành hai người
    const pageView = (at, actorKey) => ({ type: 'page_view', page: 'home', visitId: visitId(), actorKey, createdAt: new Date(at), expiresAt: new Date(Date.now() + 60_000) });
    await AnalyticsEvent.collection.insertMany([pageView('2026-04-30T05:00:00Z', 'ma-thang-4'), pageView('2026-05-01T05:00:00Z', 'ma-thang-5')]);

    const acrossMonths = await overview('from=2026-04-30&to=2026-05-01');
    assert.equal(acrossMonths.traffic.activeUsersSpansMonths, true);
    assert.equal(acrossMonths.traffic.activeUsersAvailable, true);
    assert.equal(acrossMonths.traffic.totals.activeUsers, null);
    assert.deepEqual(acrossMonths.series.map((row) => row.activeUsers), [1, 1]);

    const byMonth = await overview('from=2026-04-01&to=2026-05-31&granularity=month');
    assert.equal(byMonth.traffic.totals.activeUsers, null);
    assert.deepEqual(byMonth.series.map((row) => row.activeUsers), [1, 1]);

    const oneMonth = await overview('from=2026-05-01&to=2026-05-31');
    assert.equal(oneMonth.traffic.activeUsersSpansMonths, false);
    assert.equal(oneMonth.traffic.totals.activeUsers, 1);
  });

  test('tỉ lệ nhấp tính theo từng mục; chưa có lượt hiển thị thì tỉ lệ là null', async () => {
    setEnv(ANALYTICS);
    const client = createClient(ctx.base);
    const id = visitId();
    for (let i = 0; i < 4; i += 1) await send(client, { type: 'impression', target: 'home_primary_cta', visitId: id });
    await send(client, { type: 'click', target: 'home_primary_cta', visitId: id });
    const { traffic } = await overview('');
    const row = traffic.clickThrough.find((item) => item.target === 'home_primary_cta');
    assert.deepEqual([row.impressions, row.clicks, row.ratePercent], [4, 1, 25]);
    assert.equal(traffic.clickThrough.find((item) => item.target === 'story_source_link').ratePercent, null);
  });

  test('kỳ trước khi bắt đầu thu thập là null chứ không phải 0', async () => {
    setEnv(ANALYTICS);
    await send(createClient(ctx.base), { type: 'page_view', page: 'home', visitId: visitId() });
    const { series } = await overview(`from=2026-01-01&to=${today()}&granularity=month`);
    assert.equal(series[0].pageViews, null);
    assert.equal(series.at(-1).pageViews, 1);
    assert.equal(series.at(-1).visits, 1);
  });

  test('không có khóa băm: không lưu mã ẩn danh, người dùng hoạt động là null thay vì 0', async () => {
    setEnv({ ...ADMIN_ENV, ANALYTICS_ENABLED: 'true' });
    const student = createClient(ctx.base);
    await registerUser(student);
    await send(student, { type: 'page_view', page: 'home', visitId: visitId() });
    assert.equal((await AnalyticsEvent.findOne().lean()).actorKey, undefined);
    const { traffic } = await overview('');
    assert.equal(traffic.activeUsersAvailable, false);
    assert.equal(traffic.totals.activeUsers, null);
  });

  test('sự kiện lạ bị từ chối; chỉ lưu đúng các trường cho phép, không có dữ liệu định danh', async () => {
    setEnv(ANALYTICS);
    const client = createClient(ctx.base);
    const res = await registerUser(client);
    const id = visitId();
    for (const json of [
      { type: 'page_view', page: '/profile#reset=abc', visitId: id },
      { type: 'page_view', page: 'admin', visitId: id },
      { type: 'click', target: 'tuy-y', visitId: id },
      { type: 'purchase', page: 'home', visitId: id },
      { type: 'page_view', page: 'home', visitId: 'ngan' },
      { type: 'page_view', page: 'home', visitId: { $ne: null } },
      { type: { $ne: null } },
    ]) {
      const bad = await send(client, json);
      assert.equal(bad.status, 400, JSON.stringify(json));
      assert.equal(bad.data.code, 'invalid_event');
    }
    assert.equal(await AnalyticsEvent.countDocuments(), 0);

    await send(client, { type: 'page_view', page: 'home', visitId: id, studentId: res.body.studentId, email: res.body.email, token: 'bi-mat', topUpCode: 'GC-10K-X', url: 'https://x/#reset=abc' });
    const stored = await AnalyticsEvent.findOne().lean();
    assert.deepEqual(Object.keys(stored).sort(), ['_id', 'actorKey', 'createdAt', 'expiresAt', 'page', 'type', 'visitId']);
    const text = JSON.stringify(stored);
    for (const secret of [res.body.studentId, res.body.email, res.data.user.id, 'bi-mat', 'GC-10K-X', 'reset']) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  test('mã ẩn danh khác nhau giữa các tài khoản, không chứa id tài khoản', async () => {
    setEnv(ANALYTICS);
    const clients = [createClient(ctx.base), createClient(ctx.base)];
    for (const client of clients) {
      await registerUser(client);
      await send(client, { type: 'page_view', page: 'home', visitId: visitId() });
    }
    const keys = (await AnalyticsEvent.find().lean()).map((event) => event.actorKey);
    assert.equal(new Set(keys).size, 2);
    assert.ok(keys.every((key) => /^[\w-]{32}$/.test(key)));
  });

  test('bản ghi tự hết hạn theo ANALYTICS_RETENTION_DAYS, có TTL index', async () => {
    setEnv({ ...ANALYTICS, ANALYTICS_RETENTION_DAYS: '30' });
    await send(createClient(ctx.base), { type: 'page_view', page: 'home', visitId: visitId() });
    const event = await AnalyticsEvent.findOne().lean();
    const days = (event.expiresAt - event.createdAt) / (24 * 60 * 60 * 1000);
    assert.equal(Math.round(days), 30);
    const indexes = await AnalyticsEvent.collection.indexes();
    assert.ok(indexes.some((index) => index.key.expiresAt === 1 && index.expireAfterSeconds === 0));
  });

  test('giới hạn tần suất theo IP', async () => {
    setEnv(ANALYTICS);
    await RateLimit.create({ key: 'analytics-ip:127.0.0.1', count: 3000, resetAt: new Date(Date.now() + 60_000) });
    const res = await send(createClient(ctx.base), { type: 'page_view', page: 'home', visitId: visitId() });
    assert.equal(res.status, 429);
  });

  test('thiếu header chống CSRF bị từ chối như mọi request ghi khác', async () => {
    setEnv(ANALYTICS);
    const res = await createClient(ctx.base).request('POST', '/api/analytics/events', { csrf: false, json: { type: 'page_view', page: 'home', visitId: visitId() } });
    assert.equal(res.status, 403);
  });

  // SEC-07: sự kiện không cần đăng nhập nên số liệu thổi phồng được; trần theo lượt truy cập và theo số lượt truy cập mới của một IP
  // giới hạn mức thổi phồng mỗi nguồn (không chặn được nhiều IP: số liệu vẫn chỉ mang tính tham khảo, ghi rõ trong định nghĩa)
  test('SEC-07: một lượt truy cập ghi tối đa ANALYTICS_EVENTS_PER_VISIT sự kiện, phần vượt bị từ chối và không được ghi', async () => {
    setEnv({ ...ANALYTICS, ANALYTICS_EVENTS_PER_VISIT: '5' });
    await AnalyticsEvent.deleteMany({});
    const visit = visitId();
    const statuses = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await send(createClient(ctx.base), { type: 'page_view', page: 'home', visitId: visit })).status);
    assert.deepEqual(statuses, [202, 202, 202, 202, 202, 429, 429, 429]);
    assert.equal(await AnalyticsEvent.countDocuments({ visitId: visit }), 5);
  });

  test('SEC-07: một IP mở tối đa ANALYTICS_VISITS_PER_IP lượt truy cập mới trong 10 phút; lượt đã mở vẫn ghi tiếp được', async () => {
    setEnv({ ...ANALYTICS, ANALYTICS_VISITS_PER_IP: '3' });
    await AnalyticsEvent.deleteMany({});
    const visits = [visitId(), visitId(), visitId(), visitId(), visitId()];
    const statuses = [];
    for (const visit of visits) statuses.push((await send(createClient(ctx.base), { type: 'page_view', page: 'home', visitId: visit })).status);
    assert.deepEqual(statuses, [202, 202, 202, 429, 429]);
    assert.equal((await send(createClient(ctx.base), { type: 'click', target: 'home_primary_cta', visitId: visits[0] })).status, 202, 'lượt đã mở không bị chặn');
    assert.equal(await AnalyticsEvent.countDocuments(), 4);
  });

  test('SEC-07: định nghĩa chỉ số ghi rõ số liệu truy cập đến từ trình duyệt, chỉ mang tính tham khảo', async () => {
    setEnv(ANALYTICS);
    const { definitions } = await overview('');
    for (const key of ['pageViews', 'visits', 'clickThrough']) {
      assert.match(definitions.find((d) => d.key === key).definition, /tham khảo/, key);
    }
  });
});
