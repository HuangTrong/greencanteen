// Luồng check-in → phân loại tại server → ghi điểm/lịch sử → Gacha: kiểm thử chuyển trạng thái, giá trị biên huy hiệu,
// lỗi giữa chừng (tính nhất quán), yêu cầu trùng lặp và đồng thời. Bộ nhận diện là Ollama giả trên 127.0.0.1 (HTTP thật).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import sharp from 'sharp';
import { User } from '../../src/models/User.js';
import { CheckIn } from '../../src/models/CheckIn.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { RewardedImage } from '../../src/models/RewardedImage.js';
import { Story } from '../../src/models/Story.js';
import { uploadDir } from '../../src/routes/checkin.js';
import { sha256 } from '../../src/services/image.js';
import { recoverOutboxes } from '../../src/services/rewards.js';
import { syncStories } from '../../src/services/stories.js';
import { createClient, imageForm, registerUser, setEnv, startTestServer, uniquePng } from '../helpers.js';
import { startFakeOllama } from '../fakes/ollama.js';

let ctx;
let ollama;
const client = () => createClient(ctx.base);
const SIMULATION = { VISION_SIMULATION: 'true' };
const LOCAL_VLM = () => ({ VISION_ENGINE: 'ollama', VISION_OLLAMA_URL: ollama.url });

async function loggedInUser() {
  const c = client();
  const res = await registerUser(c);
  assert.equal(res.status, 201);
  return { c, id: res.data.user.id, studentId: res.body.studentId };
}
const checkIn = (c, buffer = uniquePng(), opts) => c.post('/api/checkin', { form: imageForm(buffer, opts) });

/** VLM local giả: trả phân loại cố định; `gate` giữ phản hồi tới khi đủ số request đang chờ; `delayMs` làm chậm */
function fakeVision({ category = 'reusable_bottle', confidence = 0.95, gate = 0, delayMs = 0 } = {}) {
  Object.assign(ollama, { reply: { category, confidence, reason: 'Ảnh giả lập cho kiểm thử' }, gate, delayMs });
}

async function withStub(target, method, impl, fn) {
  const original = target[method];
  const originalError = console.error;
  target[method] = impl;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    target[method] = original;
    console.error = originalError;
  }
}

before(async () => {
  setEnv(SIMULATION);
  ctx = await startTestServer();
  ollama = await startFakeOllama();
  await syncStories();
});
after(async () => {
  await ollama.close();
  await ctx.stop();
});
beforeEach(async () => {
  setEnv(SIMULATION);
  fakeVision();
  await RateLimit.deleteMany({});
});

describe('phân loại ảnh — bảng quyết định loại × độ tin cậy (ngưỡng 0.8)', () => {
  const table = [
    ['reusable_bottle', 0.8, 200, 'biên: đúng bằng ngưỡng'],
    ['reusable_cup', 0.79, 422, 'biên: dưới ngưỡng 0.01'],
    ['reusable_cup', 1, 200, 'tối đa'],
    ['single_use_plastic_cup', 0.99, 422, 'ly nhựa dùng một lần'],
    ['other_container', 0.99, 422, 'vật chứa khác'],
    ['no_container', 0.99, 422, 'không có vật chứa'],
    ['unclear', 0.99, 422, 'ảnh không rõ'],
  ];
  for (const [category, confidence, status, label] of table) {
    test(`${category} @ ${confidence} → ${status} (${label})`, async () => {
      const { c, id } = await loggedInUser();
      setEnv(LOCAL_VLM());
      fakeVision({ category, confidence });
      const res = await checkIn(c);
      assert.equal(res.status, status);
      assert.equal(res.data.classification.category, category);
      assert.equal(res.data.classification.threshold, 0.8);
      const user = await User.findById(id).lean();
      if (status === 200) {
        assert.equal(res.data.pointsEarned, 10);
        assert.equal(res.data.gachaSpinGranted, 1);
        assert.equal(user.ecoPoints, 10);
        assert.equal(user.pendingGachaSpins, 1);
      } else {
        assert.equal(res.data.code, 'container_not_accepted');
        assert.ok(res.data.reason.length > 10);
        assert.equal(user.ecoPoints, 0, 'không cộng điểm');
        assert.equal(user.pendingGachaSpins, 0, 'không cộng lượt Gacha');
        assert.equal(await CheckIn.countDocuments({ userId: id, valid: true }), 0);
        assert.equal((await c.get('/api/checkin/history')).data.history.length, 0, 'lịch sử chỉ có lượt hợp lệ');
      }
    });
  }

  test('VLM local quá thời gian / chưa pull mô hình / không chạy → 502, không ghi nhận gì', async () => {
    const { c, id } = await loggedInUser();
    const originalError = console.error;
    console.error = () => {};
    try {
      setEnv({ ...LOCAL_VLM(), VISION_TIMEOUT_MS: '3000' });
      fakeVision({ delayMs: 3300 });
      const timeout = await checkIn(c);
      assert.equal(timeout.status, 502);
      assert.equal(timeout.data.code, 'vision_timeout');

      ollama.reply = { status: 404, error: 'model "qwen3-vl:4b-instruct" not found, try pulling it first' };
      ollama.delayMs = 0;
      const notPulled = await checkIn(c);
      assert.equal(notPulled.status, 502);
      assert.equal(notPulled.data.code, 'vision_provider_error');

      // Cổng vừa đóng → kết nối bị từ chối như khi Ollama chưa chạy (không dùng cổng 9: fetch chặn sẵn là "bad port")
      const closedPort = await new Promise((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
          const { port } = probe.address();
          probe.close(() => resolve(port));
        });
      });
      setEnv({ VISION_ENGINE: 'ollama', VISION_OLLAMA_URL: `http://127.0.0.1:${closedPort}` });
      const down = await checkIn(c);
      assert.equal(down.status, 502);
      assert.equal(down.data.code, 'vision_provider_error');
    } finally {
      console.error = originalError;
    }
    assert.equal(await CheckIn.countDocuments({ userId: id }), 0);
    assert.equal((await User.findById(id).lean()).ecoPoints, 0);
  });

  test('kết hợp CLIP + VLM khi CLIP chưa có mô hình → 503, không tự hạ xuống chỉ dùng VLM; không thưởng', async () => {
    const { c, id } = await loggedInUser();
    // Thư mục mô hình trống → CLIP "chưa sẵn sàng"; VLM giả vẫn trả "bình cá nhân 95%" nhưng không được dùng một mình
    setEnv({ ...LOCAL_VLM(), VISION_ENGINE: 'ensemble', VISION_MODEL_DIR: 'test/.khong-co-mo-hinh' });
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await checkIn(c);
      assert.equal(res.status, 503);
      assert.equal(res.data.code, 'vision_not_configured');
    } finally {
      console.error = originalError;
    }
    assert.equal((await User.findById(id).lean()).ecoPoints, 0);
  });
});

describe('huy hiệu qua API — trước / đúng / sau ngưỡng', () => {
  for (const [before, points, expectedNew] of [
    [0, 0, 'first_sip'],
    [4, 40, 'green_starter'],
    [19, 190, 'eco_warrior'],
    [49, 490, 'planet_guardian'],
    [3, 90, 'century_points'],
  ]) {
    test(`${before} lượt / ${points} điểm → +1 check-in nhận ${expectedNew}`, async () => {
      const { c, id } = await loggedInUser();
      await User.updateOne({ _id: id }, { $set: { totalCheckIns: before, ecoPoints: points } });
      const beforeBadges = (await c.get('/api/auth/me')).data.user.badges;
      assert.ok(!beforeBadges.includes(expectedNew), 'trước ngưỡng chưa có');
      const res = await checkIn(c);
      assert.equal(res.status, 200);
      assert.ok(res.data.user.badges.includes(expectedNew), 'đúng ngưỡng có huy hiệu');
      assert.ok((await User.findById(id).lean()).badges.includes(expectedNew), 'được lưu vào DB');
      assert.ok((await checkIn(c)).data.user.badges.includes(expectedNew), 'sau ngưỡng vẫn giữ');
    });
  }
});

describe('trùng lặp và đồng thời', () => {
  test('cùng một ảnh gửi đồng thời từ hai tài khoản chỉ được thưởng một lần', async () => {
    const a = await loggedInUser();
    const b = await loggedInUser();
    setEnv(LOCAL_VLM());
    // Giữ phản hồi nhận diện tới khi cả hai request đã qua bước kiểm tra trùng ban đầu → tái hiện race ổn định
    fakeVision({ gate: 2 });
    const image = uniquePng();
    const results = await Promise.all([checkIn(a.c, image), checkIn(b.c, image)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409).data.code, 'duplicate_image');
    const totals = await User.find({ _id: { $in: [a.id, b.id] } }).lean();
    assert.equal(totals.reduce((sum, u) => sum + u.ecoPoints, 0), 10);
    assert.equal(await CheckIn.countDocuments({ userId: { $in: [a.id, b.id] }, valid: true }), 1);
  });

  test('F-55: cùng điểm ảnh, khác byte (thêm byte cuối tệp, đổi metadata, đổi mức nén PNG) không thành ảnh mới, kể cả ở tài khoản khác', async () => {
    const a = await loggedInUser();
    const b = await loggedInUser();
    const image = await sharp({ create: { width: 32, height: 24, channels: 3, background: { r: 40, g: 120, b: 200 } } }).png().toBuffer();
    assert.equal((await checkIn(a.c, image)).status, 200);
    const variants = [
      Buffer.concat([image, Buffer.from('them-vai-byte')]),
      await sharp(image).png({ compressionLevel: 0 }).toBuffer(),
      await sharp(image).withMetadata({ density: 300 }).png({ compressionLevel: 9 }).toBuffer(),
    ];
    for (const variant of variants) {
      assert.notEqual(sha256(variant), sha256(image), 'biến thể phải khác byte');
      for (const account of [a, b]) {
        const res = await checkIn(account.c, variant);
        assert.equal(res.status, 409);
        assert.equal(res.data.code, 'duplicate_image');
      }
    }
    const totals = await User.find({ _id: { $in: [a.id, b.id] } }).lean();
    assert.equal(totals.reduce((sum, u) => sum + u.ecoPoints, 0), 10);
  });

  test('F-55 (ghi nhận, còn mở): mã hóa lại JPEG ở chất lượng khác cho điểm ảnh khác nên vẫn được coi là ảnh mới', async () => {
    const { c, id } = await loggedInUser();
    const noisy = sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 60, b: 30 }, noise: { type: 'gaussian', mean: 128, sigma: 40 } } });
    const original = await noisy.jpeg({ quality: 92 }).toBuffer();
    const reEncoded = await sharp(original).jpeg({ quality: 60 }).toBuffer();
    assert.equal((await checkIn(c, original, { type: 'image/jpeg', name: 'a.jpg' })).status, 200);
    assert.equal((await checkIn(c, reEncoded, { type: 'image/jpeg', name: 'b.jpg' })).status, 200);
    assert.equal((await User.findById(id).lean()).ecoPoints, 20);
  });

  test('F-55: bản ghi cũ lưu băm theo byte vẫn chặn được ảnh đã thưởng trước khi đổi cách nhận dạng', async () => {
    const { c, id } = await loggedInUser();
    const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } } }).png().toBuffer();
    await CheckIn.collection.insertOne({ userId: new User({ _id: id })._id, studentId: 'cu', valid: true, imageSha256: sha256(image), createdAt: new Date() });
    const res = await checkIn(c, image);
    assert.equal(res.status, 409);
    assert.equal(res.data.code, 'duplicate_image');
  });

  test('F-55: ảnh không giải mã được vẫn đi đường cũ: dùng băm theo byte, không làm hỏng luồng từ chối', async () => {
    const { c } = await loggedInUser();
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('khong phai jpeg that'), Buffer.from([0xff, 0xd9])]);
    assert.equal((await checkIn(c, broken)).status, 200, 'chế độ mô phỏng không đọc nội dung ảnh');
    assert.equal((await checkIn(c, broken)).data.code, 'duplicate_image');
  });

  test('ảnh bị từ chối vì thời gian chờ được dùng lại khi hết thời gian chờ', async () => {
    setEnv({ ...SIMULATION, CHECKIN_COOLDOWN_MINUTES: '30' });
    const { c, id } = await loggedInUser();
    assert.equal((await checkIn(c)).status, 200);
    const image = uniquePng();
    const cooled = await checkIn(c, image);
    assert.equal(cooled.status, 429);
    assert.ok(Number(cooled.headers.get('retry-after')) > 0, 'có Retry-After');
    await User.updateOne({ _id: id }, { $set: { lastRewardedCheckInAt: new Date(Date.now() - 31 * 60_000) } });
    assert.equal((await checkIn(c, image)).status, 200);
  });

  test('tối đa 20 lần gửi ảnh mỗi giờ cho mỗi tài khoản (lần 21 → 429)', async () => {
    const { c } = await loggedInUser();
    const statuses = [];
    for (let i = 0; i < 21; i += 1) statuses.push((await checkIn(c, Buffer.from('khong phai anh'))).status);
    assert.deepEqual(statuses.slice(0, 20), Array(20).fill(415));
    assert.equal(statuses[20], 429);
  });
});

describe('lỗi giữa chừng — tính nhất quán', () => {
  test('lỗi DB trước khi cộng thưởng → 500, không cộng điểm/lượt, xóa tệp tạm', async () => {
    const { c, id } = await loggedInUser();
    const before = fs.readdirSync(uploadDir).length;
    const res = await withStub(Story, 'aggregate', () => Promise.reject(new Error('DB lỗi')), () => checkIn(c));
    assert.equal(res.status, 500);
    assert.equal(res.data.code, 'server_error');
    const user = await User.findById(id).lean();
    assert.equal(user.ecoPoints, 0);
    assert.equal(user.pendingGachaSpins, 0);
    assert.equal(await CheckIn.countDocuments({ userId: id }), 0);
    assert.equal(fs.readdirSync(uploadDir).length, before);
  });

  test('F-59: lỗi DB đúng lúc cộng thưởng → trả chỗ ảnh đã giữ, gửi lại cùng ảnh được thưởng bình thường', async () => {
    const { c, id } = await loggedInUser();
    const image = uniquePng();
    const failed = await withStub(User, 'findOneAndUpdate', () => Promise.reject(new Error('DB lỗi')), () => checkIn(c, image));
    assert.equal(failed.status, 500);
    assert.equal(await RewardedImage.countDocuments({ userId: id }), 0);
    assert.equal((await User.findById(id).lean()).ecoPoints, 0);
    assert.equal((await checkIn(c, image)).status, 200);
    assert.equal((await User.findById(id).lean()).ecoPoints, 10);
  });

  test('ghi bản ghi CheckIn thất bại sau khi cộng điểm → vẫn thấy trong lịch sử (outbox), khôi phục đúng một lần', async () => {
    const { c, id } = await loggedInUser();
    const res = await withStub(CheckIn.prototype, 'save', () => Promise.reject(new Error('ghi lỗi')), () => checkIn(c));
    assert.equal(res.status, 200);
    assert.equal(await CheckIn.countDocuments({ userId: id }), 0);
    const history = (await c.get('/api/checkin/history')).data.history;
    assert.equal(history.length, 1);
    assert.equal(history[0]._id, res.data.checkInId);
    await recoverOutboxes();
    assert.equal(await CheckIn.countDocuments({ userId: id, valid: true }), 1);
    assert.equal((await c.get('/api/checkin/history')).data.history.length, 1);
  });

  test('ghi phần thưởng Gacha thất bại → mã nạp vẫn hiện trong danh sách và được khôi phục', async () => {
    const { c, id } = await loggedInUser();
    assert.equal((await checkIn(c)).status, 200);
    const spin = await withStub(GachaReward.prototype, 'save', () => Promise.reject(new Error('ghi lỗi')), () => c.post('/api/gacha/spin'));
    assert.equal(spin.status, 200);
    const list = await c.get('/api/gacha/rewards');
    assert.equal(list.data.rewards.length, 1);
    assert.equal(list.data.rewards[0].topUpCode, spin.data.prize.topUpCode);
    assert.equal(list.data.pendingGachaSpins, 0);
    await recoverOutboxes();
    assert.equal(await GachaReward.countDocuments({ userId: id }), 1);
  });
});

describe('check-in → Gacha → hồ sơ (chuyển trạng thái)', () => {
  test('0 lượt → check-in (1 lượt) → quay (0 lượt, có mã nạp) → quay tiếp bị từ chối', async () => {
    const { c } = await loggedInUser();
    const noSpin = await c.post('/api/gacha/spin');
    assert.equal(noSpin.status, 400);
    assert.equal(noSpin.data.code, 'no_spins');

    const ok = await checkIn(c);
    assert.equal(ok.data.user.pendingGachaSpins, 1);
    assert.ok(ok.data.story?.source?.url, 'kèm câu chuyện có nguồn');

    const spin = await c.post('/api/gacha/spin');
    assert.equal(spin.status, 200);
    assert.equal(spin.data.pendingGachaSpins, 0);
    assert.match(spin.data.prize.topUpCode, /^GC-\d+K-[0-9A-F]{8}$/);

    const me = (await c.get('/api/auth/me')).data.user;
    assert.equal(me.pendingGachaSpins, 0);
    assert.equal(me.ecoPoints, 10);
    const rewards = (await c.get('/api/gacha/rewards')).data.rewards;
    assert.deepEqual(rewards.map((r) => r.topUpCode), [spin.data.prize.topUpCode]);
    assert.equal((await c.post('/api/gacha/spin')).status, 400);
  });

  test('không còn câu chuyện nào có nguồn → check-in vẫn thành công, story = null', async () => {
    const { c } = await loggedInUser();
    const stories = await Story.find().lean();
    await Story.deleteMany({});
    try {
      const res = await checkIn(c);
      assert.equal(res.status, 200);
      assert.equal(res.data.story, null);
    } finally {
      await Story.insertMany(stories);
    }
  });

  test('lịch sử: chỉ lượt hợp lệ của chính mình, mới nhất trước, tối đa 50', async () => {
    const { c, id } = await loggedInUser();
    const other = await loggedInUser();
    const now = Date.now();
    await CheckIn.collection.insertMany(
      Array.from({ length: 55 }, (_, i) => ({
        userId: new User({ _id: id })._id,
        studentId: 'x',
        valid: true,
        pointsEarned: 10,
        createdAt: new Date(now - i * 60_000),
      }))
    );
    await CheckIn.collection.insertOne({ userId: new User({ _id: id })._id, studentId: 'x', valid: false, createdAt: new Date() });
    await CheckIn.collection.insertOne({ userId: new User({ _id: other.id })._id, studentId: 'y', valid: true, createdAt: new Date() });
    const history = (await c.get('/api/checkin/history')).data.history;
    assert.equal(history.length, 50);
    assert.ok(history.every((h, i) => i === 0 || new Date(h.createdAt) <= new Date(history[i - 1].createdAt)));
  });
});
