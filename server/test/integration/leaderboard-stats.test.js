// Bảng xếp hạng tuần/tháng và thống kê trường: không có dữ liệu, giá trị biên của cửa sổ thời gian, giới hạn top 20
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { User } from '../../src/models/User.js';
import { CheckIn } from '../../src/models/CheckIn.js';
import { setUserStatus } from '../../src/services/adminUsers.js';
import { removeAvatar, replaceAvatar } from '../../src/services/avatars.js';
import { invalidatePublicStats } from '../../src/services/stats.js';
import { syncStories } from '../../src/services/stories.js';
import { createClient, imageForm, registerUser, setEnv, startTestServer, uniquePng, uniqueSuffix } from '../helpers.js';

let ctx;
const client = () => createClient(ctx.base);
const DAY = 24 * 60 * 60 * 1000;

before(async () => {
  setEnv();
  ctx = await startTestServer();
  await syncStories();
});
after(() => ctx.stop());
beforeEach(async () => {
  await CheckIn.deleteMany({});
  await User.deleteMany({});
});

async function makeUser(name) {
  return User.create({ studentId: `LB${uniqueSuffix()}`, name });
}

/** Ghi thẳng vào collection để đặt createdAt tùy ý (bỏ qua timestamps của Mongoose) */
function insertCheckIns(userId, count, { ageMs = 0, points = 10, valid = true } = {}) {
  const createdAt = new Date(Date.now() - ageMs);
  return CheckIn.collection.insertMany(
    Array.from({ length: count }, () => ({ userId, studentId: 'x', valid, pointsEarned: points, createdAt, updatedAt: createdAt }))
  );
}

const leaderboard = async (period) => (await client().get(`/api/stats/leaderboard${period === undefined ? '' : `?period=${period}`}`)).data;

describe('không có dữ liệu', () => {
  test('bảng xếp hạng rỗng ở cả tuần và tháng; thống kê bằng 0', async () => {
    for (const period of ['week', 'month']) {
      const data = await leaderboard(period);
      assert.deepEqual(data, { period, personal: [], byDepartment: [] });
    }
    assert.deepEqual((await client().get('/api/stats/school')).data, { totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 });
  });
});

describe('cửa sổ thời gian (giá trị biên)', () => {
  test('tuần = 7 ngày gần nhất, tháng = 30 ngày gần nhất; check-in không hợp lệ bị loại', async () => {
    const inWeek = await makeUser('Trong tuần');
    const justOutWeek = await makeUser('Vừa quá 7 ngày');
    const inMonth = await makeUser('Gần 30 ngày');
    const outMonth = await makeUser('Quá 30 ngày');
    const invalidOnly = await makeUser('Chỉ có check-in bị từ chối');
    await insertCheckIns(inWeek._id, 1, { ageMs: 7 * DAY - 60_000 });
    await insertCheckIns(justOutWeek._id, 1, { ageMs: 7 * DAY + 60_000 });
    await insertCheckIns(inMonth._id, 1, { ageMs: 30 * DAY - 60_000 });
    await insertCheckIns(outMonth._id, 1, { ageMs: 30 * DAY + 60_000 });
    await insertCheckIns(invalidOnly._id, 3, { valid: false });

    assert.deepEqual((await leaderboard('week')).personal.map((r) => r.name), ['Trong tuần']);
    assert.deepEqual(
      (await leaderboard('month')).personal.map((r) => r.name).sort(),
      ['Gần 30 ngày', 'Trong tuần', 'Vừa quá 7 ngày'].sort()
    );
  });

  test('period thiếu / không hợp lệ / dạng object → mặc định tuần', async () => {
    const u = await makeUser('Ai đó');
    await insertCheckIns(u._id, 1, { ageMs: 10 * DAY });
    for (const period of [undefined, 'year', 'MONTH', '', 'week%00', 'month[$ne]']) {
      const data = await leaderboard(period);
      assert.equal(data.period, 'week', String(period));
      assert.deepEqual(data.personal, []);
    }
    const object = (await client().get('/api/stats/leaderboard?period[$gt]=')).data;
    assert.equal(object.period, 'week');
  });
});

describe('xếp hạng', () => {
  test('sắp xếp theo số lượt rồi điểm; hạng 1..n; chỉ trả tên, ảnh đại diện + số liệu', async () => {
    const a = await makeUser('An');
    const b = await makeUser('Bình');
    const c = await makeUser('Chi');
    await insertCheckIns(a._id, 3, { points: 10 });
    await insertCheckIns(b._id, 3, { points: 15 });
    await insertCheckIns(c._id, 5, { points: 10 });
    const { personal } = await leaderboard('week');
    assert.deepEqual(personal, [
      { rank: 1, name: 'Chi', avatarUrl: null, checkIns: 5, points: 50 },
      { rank: 2, name: 'Bình', avatarUrl: null, checkIns: 3, points: 45 },
      { rank: 3, name: 'An', avatarUrl: null, checkIns: 3, points: 30 },
    ]);
  });

  test('tối đa 20 người; người dùng đã xóa hiển thị "Ẩn danh"', async () => {
    for (let i = 0; i < 25; i += 1) {
      const u = await makeUser(`Người ${String(i).padStart(2, '0')}`);
      await insertCheckIns(u._id, i + 1);
    }
    await insertCheckIns(new mongoose.Types.ObjectId(), 100);
    const { personal } = await leaderboard('month');
    assert.equal(personal.length, 20);
    assert.deepEqual(personal[0], { rank: 1, name: 'Ẩn danh', avatarUrl: null, checkIns: 100, points: 1000 });
    assert.equal(personal[1].name, 'Người 24');
    assert.equal(personal[19].rank, 20);
    assert.ok(personal.every((r, i) => i === 0 || r.checkIns <= personal[i - 1].checkIns));
  });
});

describe('thống kê toàn trường', () => {
  test('biên 49 / 50 lượt hợp lệ → 0 / 1 sinh vật bảo vệ; nhựa = lượt × 12g; lượt bị từ chối không tính', async () => {
    const u = await makeUser('Thống kê');
    await insertCheckIns(u._id, 49);
    await insertCheckIns(u._id, 5, { valid: false });
    assert.deepEqual((await client().get('/api/stats/school')).data, { totalCheckIns: 49, plasticSavedGrams: 588, treesProtected: 0 });
    await insertCheckIns(u._id, 1);
    assert.deepEqual((await client().get('/api/stats/school')).data, { totalCheckIns: 50, plasticSavedGrams: 600, treesProtected: 1 });
    await insertCheckIns(u._id, 49);
    assert.equal((await client().get('/api/stats/school')).data.treesProtected, 1, '99 lượt vẫn là 1');
  });

  test('API công khai: không cần đăng nhập, không cần header chống CSRF (chỉ đọc)', async () => {
    const res = await client().get('/api/stats/school', { csrf: false });
    assert.equal(res.status, 200);
  });
});

describe('F-64: khách không làm server chạy lại truy vấn gộp cho mỗi yêu cầu', () => {
  const countCalls = (model, method) => {
    const original = model[method];
    const counter = { calls: 0, restore: () => (model[method] = original) };
    model[method] = function counted(...args) {
      counter.calls += 1;
      return original.apply(this, args);
    };
    return counter;
  };
  const CACHED = { STATS_CACHE_SECONDS: '15' };

  beforeEach(() => {
    setEnv(CACHED);
    invalidatePublicStats();
  });
  after(() => {
    setEnv();
    invalidatePublicStats();
  });

  test('30 yêu cầu đồng thời vào bảng xếp hạng chỉ chạy một truy vấn gộp, kết quả giống nhau', async () => {
    const user = await makeUser('Xếp hạng');
    await insertCheckIns(user._id, 3);
    const counter = countCalls(CheckIn, 'aggregate');
    try {
      const results = await Promise.all(Array.from({ length: 30 }, () => client().get('/api/stats/leaderboard?period=month')));
      assert.equal(counter.calls, 1);
      for (const res of results) assert.deepEqual(res.data, results[0].data);
    } finally {
      counter.restore();
    }
  });

  test('30 yêu cầu vào thống kê trường chỉ đếm một lần; tuần và tháng là hai mục riêng', async () => {
    const counter = countCalls(CheckIn, 'countDocuments');
    try {
      await Promise.all(Array.from({ length: 30 }, () => client().get('/api/stats/school')));
      assert.equal(counter.calls, 1);
    } finally {
      counter.restore();
    }
    const user = await makeUser('Hai kỳ');
    await insertCheckIns(user._id, 1, { ageMs: 20 * DAY });
    assert.equal((await leaderboard('week')).personal.length, 0);
    assert.equal((await leaderboard('month')).personal.length, 1);
  });

  test('hết hạn thì đọc lại; STATS_CACHE_SECONDS=0 tắt cache', async () => {
    setEnv({ STATS_CACHE_SECONDS: '1' });
    const user = await makeUser('Hết hạn');
    assert.equal((await leaderboard('month')).personal.length, 0);
    await insertCheckIns(user._id, 1);
    assert.equal((await leaderboard('month')).personal.length, 0, 'còn trong cache');
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await leaderboard('month')).personal.length, 1);
    setEnv({ STATS_CACHE_SECONDS: '0' });
    await insertCheckIns(user._id, 1);
    assert.equal((await leaderboard('month')).personal[0].checkIns, 2);
  });

  test('truy vấn lỗi không bị giữ lại: yêu cầu sau đọc lại DB', async () => {
    const original = { aggregate: CheckIn.aggregate, error: console.error };
    CheckIn.aggregate = () => Promise.reject(new Error('DB lỗi'));
    console.error = () => {};
    try {
      assert.equal((await client().get('/api/stats/leaderboard')).status, 500);
    } finally {
      CheckIn.aggregate = original.aggregate;
      console.error = original.error;
    }
    assert.equal((await client().get('/api/stats/leaderboard')).status, 200);
  });

  test('dữ liệu đổi trong tiến trình này làm mới ngay: check-in được thưởng, khóa tài khoản, đổi ảnh đại diện', async () => {
    const student = createClient(ctx.base);
    const registered = await registerUser(student);
    assert.equal(registered.status, 201);
    setEnv({ ...CACHED, VISION_SIMULATION: 'true' });
    assert.equal((await leaderboard('week')).personal.length, 0);
    assert.equal((await client().get('/api/stats/school')).data.totalCheckIns, 0);
    assert.equal((await student.post('/api/checkin', { form: imageForm(uniquePng()) })).status, 200);
    assert.equal((await leaderboard('week')).personal.length, 1);
    assert.equal((await client().get('/api/stats/school')).data.totalCheckIns, 1);

    await removeAvatar(registered.data.user.id);
    await replaceAvatar(registered.data.user.id, Buffer.from('anh'));
    assert.match((await leaderboard('week')).personal[0].avatarUrl, /^\/api\/avatars\//);

    const admin = await User.create({ studentId: `QT${uniqueSuffix()}`, name: 'Quản trị', role: 'admin' });
    await setUserStatus(admin, registered.data.user.id, 'locked', 'Kiểm thử cache');
    assert.equal((await leaderboard('week')).personal.length, 0, 'tài khoản bị khóa rời bảng xếp hạng ngay');
  });
});
