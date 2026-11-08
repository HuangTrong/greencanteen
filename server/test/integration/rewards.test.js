import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import mongoose from 'mongoose';
import { User } from '../../src/models/User.js';
import { CheckIn } from '../../src/models/CheckIn.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { GachaConfig } from '../../src/models/GachaConfig.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { uploadDir } from '../../src/routes/checkin.js';
import { syncStories } from '../../src/services/stories.js';
import { recoverOutboxes } from '../../src/services/rewards.js';
import { publishKeychainConfig } from '../gachaHelpers.js';
import {
  createClient,
  imageForm,
  realFetch,
  registerUser,
  setEnv,
  startTestServer,
  uniquePng,
} from '../helpers.js';

let ctx;
let uploadsBefore;
const client = () => createClient(ctx.base);
const SIMULATION = { VISION_SIMULATION: 'true' };

async function loggedInUser() {
  const c = client();
  const res = await registerUser(c);
  assert.equal(res.status, 201);
  return { c, id: res.data.user.id };
}

const checkIn = (c, buffer = uniquePng(), opts) => c.post('/api/checkin', { form: imageForm(buffer, opts) });

before(async () => {
  setEnv(SIMULATION);
  ctx = await startTestServer();
  await syncStories();
  uploadsBefore = fs.readdirSync(uploadDir).length;
});
after(async () => {
  globalThis.fetch = realFetch;
  await ctx.stop();
});
beforeEach(async () => {
  setEnv(SIMULATION);
  globalThis.fetch = realFetch;
  await RateLimit.deleteMany({});
});

describe('check-in: server quyết định kết quả', () => {
  test('ảnh hợp lệ (mô phỏng) được cộng thưởng, đánh dấu rõ là mô phỏng và kèm câu chuyện có nguồn', async () => {
    const { c, id } = await loggedInUser();
    const status = await c.get('/api/checkin/status');
    assert.equal(status.data.mode, 'simulated');

    const res = await checkIn(c);
    assert.equal(res.status, 200);
    assert.equal(res.data.success, true);
    assert.equal(res.data.classification.status, 'simulated');
    assert.equal(res.data.classification.simulated, true);
    assert.equal(res.data.classification.category, 'reusable_bottle');
    assert.equal(res.data.user.ecoPoints, 10);
    assert.equal(res.data.user.pendingGachaSpins, 1);
    assert.ok(res.data.user.badges.includes('first_sip'));
    assert.match(res.data.story.source.url, /^https:\/\/doi\.org\//);
    assert.ok(res.data.story.source.authors.length > 0);
    assert.ok(res.data.story.source.journal && res.data.story.source.year && res.data.story.source.doi);

    const record = await CheckIn.findById(res.data.checkInId).lean();
    assert.equal(record.valid, true);
    assert.equal(record.verification, 'simulated');
    assert.equal(String(record.userId), id);
    const user = await User.findById(id).lean();
    assert.equal(user.checkInOutbox.length, 0, 'outbox đã chuyển xong');
  });

  test('gửi lại cùng một ảnh không được thưởng lần hai', async () => {
    const { c } = await loggedInUser();
    const image = uniquePng();
    assert.equal((await checkIn(c, image)).status, 200);
    const again = await checkIn(c, image);
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'duplicate_image');
    const other = await loggedInUser();
    assert.equal((await checkIn(other.c, image)).status, 409, 'người khác dùng lại ảnh cũng bị chặn');
  });

  test('nhiều check-in đồng thời không làm mất điểm: tổng trên tài khoản khớp số bản ghi', async () => {
    const { c, id } = await loggedInUser();
    const results = await Promise.all(Array.from({ length: 8 }, () => checkIn(c)));
    assert.deepEqual(results.map((r) => r.status), Array(8).fill(200));
    const user = await User.findById(id).lean();
    const records = await CheckIn.countDocuments({ userId: id, valid: true });
    assert.equal(records, 8);
    assert.equal(user.totalCheckIns, 8);
    assert.equal(user.ecoPoints, 80);
    assert.equal(user.pendingGachaSpins, 8);
  });

  test('thời gian chờ được áp dụng nguyên tử khi gửi đồng thời', async () => {
    setEnv({ ...SIMULATION, CHECKIN_COOLDOWN_MINUTES: '30' });
    const { c, id } = await loggedInUser();
    const results = await Promise.all(Array.from({ length: 5 }, () => checkIn(c)));
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 429, 429, 429, 429]);
    assert.equal((await User.findById(id).lean()).ecoPoints, 10);
    const later = await checkIn(c);
    assert.equal(later.status, 429);
    assert.equal(later.data.code, 'checkin_cooldown');
  });

  test('ly nhựa dùng một lần hoặc độ tin cậy dưới ngưỡng: không cộng điểm, có ghi nhận', async () => {
    const { c, id } = await loggedInUser();
    setEnv({ ...SIMULATION, VISION_SIMULATED_CATEGORY: 'single_use_plastic_cup' });
    const plastic = await checkIn(c);
    assert.equal(plastic.status, 422);
    assert.equal(plastic.data.code, 'container_not_accepted');
    assert.equal(plastic.data.classification.category, 'single_use_plastic_cup');

    setEnv({ ...SIMULATION, VISION_SIMULATED_CATEGORY: 'reusable_cup', VISION_SIMULATED_CONFIDENCE: '0.6' });
    const unsure = await checkIn(c);
    assert.equal(unsure.status, 422);
    assert.equal(unsure.data.classification.accepted, false);
    assert.match(unsure.data.reason, /ngưỡng/);

    const user = await User.findById(id).lean();
    assert.equal(user.ecoPoints, 0);
    assert.equal(user.pendingGachaSpins, 0);
    assert.equal(await CheckIn.countDocuments({ userId: id, valid: false }), 2);
    assert.equal(await CheckIn.countDocuments({ userId: id, valid: true }), 0);
  });

  test('bộ nhận diện tắt / chưa cài mô hình: từ chối rõ ràng, không tự chấp nhận ảnh', async () => {
    const { c, id } = await loggedInUser();
    setEnv({ VISION_ENGINE: 'off' });
    assert.equal((await c.get('/api/checkin/status')).data.mode, 'unavailable');
    const res = await checkIn(c);
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'vision_not_configured');

    // Mô phỏng bị chặn khi production → dùng bộ nhận diện thật; thư mục mô hình trống → chưa sẵn sàng, không thưởng
    setEnv({ VISION_SIMULATION: 'true', NODE_ENV: 'production', VISION_MODEL_DIR: 'test/.khong-co-mo-hinh' });
    const status = (await c.get('/api/checkin/status')).data;
    assert.deepEqual([status.mode, status.engine], ['local', 'classifier']);
    const blocked = await checkIn(c);
    assert.equal(blocked.status, 503, 'mô phỏng bị chặn trong production');
    assert.equal(blocked.data.code, 'vision_not_configured');
    assert.equal(await CheckIn.countDocuments({ userId: id }), 0);
  });

  test('biên dung lượng ảnh: đúng bằng giới hạn được nhận, hơn 1 byte bị từ chối', async () => {
    const { c } = await loggedInUser();
    setEnv({ ...SIMULATION, CHECKIN_MAX_IMAGE_MB: '1' });
    const sized = (bytes) => {
      const png = uniquePng();
      return Buffer.concat([png, Buffer.alloc(bytes - png.length)]);
    };
    const limit = 1024 * 1024;
    assert.equal((await checkIn(c, sized(limit))).status, 200);
    const over = await checkIn(c, sized(limit + 1));
    assert.equal(over.status, 413);
    assert.equal(over.data.code, 'image_too_large');
  });

  test('ảnh rỗng, sai loại, hỏng, quá lớn, nhiều tệp hoặc thiếu ảnh đều trả lỗi JSON', async () => {
    const { c, id } = await loggedInUser();
    const cases = [
      [Buffer.alloc(0), 400, 'image_empty'],
      [Buffer.from('day khong phai la anh'), 415, 'image_type_unsupported', { type: 'image/jpeg', name: 'fake.jpg' }],
      [uniquePng().subarray(0, 40), 400, 'image_unreadable'],
    ];
    for (const [buffer, status, code, opts] of cases) {
      const res = await checkIn(c, buffer, opts);
      assert.equal(res.status, status, code);
      assert.equal(res.data.code, code);
    }

    setEnv({ ...SIMULATION, CHECKIN_MAX_IMAGE_MB: '1' });
    const big = await checkIn(c, Buffer.concat([uniquePng(), Buffer.alloc(1.2 * 1024 * 1024)]));
    assert.equal(big.status, 413);
    assert.equal(big.data.code, 'image_too_large');

    const two = imageForm(uniquePng());
    two.append('image', new Blob([uniquePng()], { type: 'image/png' }), 'b.png');
    const multi = await c.post('/api/checkin', { form: two });
    assert.equal(multi.status, 400);
    assert.equal(multi.data.code, 'invalid_upload');

    const none = await c.post('/api/checkin', { json: { image: 'abc' } });
    assert.equal(none.status, 400);
    assert.equal(none.data.code, 'image_required');

    assert.equal((await User.findById(id).lean()).ecoPoints, 0);
  });
});

describe('quay thưởng tri ân', () => {
  test('một lượt quay không thể dùng nhiều lần khi gửi đồng thời', async () => {
    const { c, id } = await loggedInUser();
    const config = await publishKeychainConfig();
    await User.updateOne({ _id: id }, { $set: { pendingGachaSpins: 1 } });
    const results = await Promise.all(Array.from({ length: 10 }, () => c.post('/api/gacha/draw')));
    const statuses = results.map((r) => r.status);
    assert.equal(statuses.filter((s) => s === 200).length, 1);
    assert.equal(statuses.filter((s) => s === 400).length, 9);
    assert.equal(await GachaReward.countDocuments({ userId: id }), 1);
    assert.equal((await User.findById(id).lean()).pendingGachaSpins, 0);
    assert.equal(await GachaConfig.countDocuments(), 1, 'không tự tạo thêm cấu hình');
    assert.equal(await GachaReward.countDocuments({ userId: id, configVersion: config.version }), 1);

    await User.updateOne({ _id: id }, { $set: { pendingGachaSpins: 3 } });
    const more = await Promise.all(Array.from({ length: 10 }, () => c.post('/api/gacha/draw')));
    assert.equal(more.filter((r) => r.status === 200).length, 3);
    assert.equal(await GachaReward.countDocuments({ userId: id, configVersion: config.version }), 4);

    const list = await c.get('/api/gacha/results');
    assert.equal(list.data.rewards.length, 4);
    assert.deepEqual(list.data.stats, { spins: 4, wins: 4 });
    assert.equal(list.data.pendingGachaSpins, 0);
  });
});

describe('khôi phục sau khi server dừng giữa chừng', () => {
  test('bản ghi còn trong outbox được hiển thị ngay và chuyển đúng một lần khi khôi phục', async () => {
    const { c, id } = await loggedInUser();
    const checkInId = new mongoose.Types.ObjectId();
    const rewardId = new mongoose.Types.ObjectId();
    const now = new Date();
    // Như thể server dừng ngay sau lệnh cộng điểm / trừ lượt nguyên tử, trước khi chuyển sang collection
    await User.updateOne(
      { _id: id },
      {
        $inc: { ecoPoints: 10, totalCheckIns: 1 },
        $push: {
          checkInOutbox: { _id: checkInId, studentId: 'x', valid: true, pointsEarned: 10, plasticSavedGrams: 12, createdAt: now },
          gachaOutbox: { _id: rewardId, studentId: 'x', outcome: 'win', prizeType: 'keychain', prizeLabel: 'Lá xanh', claimCode: 'TA-23456-789AB', deliveryStatus: 'pending', createdAt: now },
        },
      }
    );

    assert.equal((await c.get('/api/checkin/history')).data.history.length, 1);
    assert.equal((await c.get('/api/gacha/results')).data.rewards.length, 1);

    await recoverOutboxes();
    await recoverOutboxes();
    assert.equal(await CheckIn.countDocuments({ _id: checkInId }), 1);
    assert.equal(await GachaReward.countDocuments({ _id: rewardId }), 1);
    const user = await User.findById(id).lean();
    assert.equal(user.checkInOutbox.length, 0);
    assert.equal(user.gachaOutbox.length, 0);
    assert.equal((await c.get('/api/checkin/history')).data.history.length, 1, 'không bị nhân đôi');
  });
});

describe('bảng xếp hạng và thống kê', () => {
  test('không lộ mã sinh viên hay khoa/lớp', async () => {
    const res = await client().get('/api/stats/leaderboard?period=week');
    assert.equal(res.status, 200);
    assert.ok(res.data.personal.length > 0);
    for (const row of res.data.personal) {
      assert.deepEqual(Object.keys(row).sort(), ['avatarUrl', 'checkIns', 'name', 'points', 'rank']);
    }
    assert.deepEqual(res.data.byDepartment, []);
    const school = await client().get('/api/stats/school');
    assert.equal(school.data.totalCheckIns, await CheckIn.countDocuments({ valid: true }));
  });

  test('không còn tệp tạm sau mọi lần upload (thành công lẫn lỗi)', () => {
    assert.equal(fs.readdirSync(uploadDir).length, uploadsBefore);
  });
});
