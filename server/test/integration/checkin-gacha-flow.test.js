// Luồng check-in → phân loại tại server → ghi điểm/lịch sử → Gacha: kiểm thử chuyển trạng thái, giá trị biên huy hiệu,
// lỗi giữa chừng (tính nhất quán), yêu cầu trùng lặp và đồng thời. Bộ nhận diện chạy ở chế độ mô phỏng (kết quả cố định
// theo biến môi trường, cùng hàm quyết định thưởng); lỗi riêng của bộ phân loại ONNX nằm ở vision-classifier.test.js.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { deleteAccount } from '../../src/services/accountDeletion.js';
import { syncStories } from '../../src/services/stories.js';
import { createClient, imageForm, registerUser, setEnv, startTestServer, uniquePng } from '../helpers.js';
import { publishKeychainConfig } from '../gachaHelpers.js';

let ctx;
const client = () => createClient(ctx.base);
const SIMULATION = { VISION_SIMULATION: 'true' };
/** Bộ nhận diện trả kết quả cố định (chế độ mô phỏng, chỉ có khi NODE_ENV khác production) */
const simulatedVision = (category = 'reusable_bottle', confidence = 0.95) => ({
  ...SIMULATION,
  VISION_SIMULATED_CATEGORY: category,
  VISION_SIMULATED_CONFIDENCE: String(confidence),
});

async function loggedInUser() {
  const c = client();
  const res = await registerUser(c);
  assert.equal(res.status, 201);
  return { c, id: res.data.user.id, studentId: res.body.studentId };
}
const checkIn = (c, buffer = uniquePng(), opts) => c.post('/api/checkin', { form: imageForm(buffer, opts) });

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
  await syncStories();
});
after(async () => {
  await ctx.stop();
});
beforeEach(async () => {
  setEnv(SIMULATION);
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
      setEnv(simulatedVision(category, confidence));
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

  test('bộ phân loại chưa có mô hình → 503, không ghi nhận, không thưởng', async () => {
    const { c, id } = await loggedInUser();
    setEnv({ VISION_ENGINE: 'classifier', VISION_MODEL_DIR: 'test/.khong-co-mo-hinh' });
    const originalError = console.error;
    console.error = () => {};
    try {
      const res = await checkIn(c);
      assert.equal(res.status, 503);
      assert.equal(res.data.code, 'vision_not_configured');
    } finally {
      console.error = originalError;
    }
    assert.equal(await CheckIn.countDocuments({ userId: id }), 0);
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
    setEnv(simulatedVision());
    // Giữ cả hai request ở bước chọn câu chuyện (sau kiểm tra trùng ban đầu và nhận diện, trước lệnh cộng thưởng nguyên tử)
    // tới khi cả hai cùng tới → tái hiện race ổn định. Chờ tối đa 5 giây để lỗi hiện thành assert, không treo test.
    const pickStory = Story.aggregate;
    let arrived = 0;
    let release;
    const bothArrived = new Promise((resolve) => (release = resolve));
    const gated = async function gatedAggregate(...args) {
      arrived += 1;
      if (arrived >= 2) release();
      await Promise.race([bothArrived, new Promise((resolve) => setTimeout(resolve, 5000))]);
      return pickStory.apply(this, args);
    };
    const image = uniquePng();
    const results = await withStub(Story, 'aggregate', gated, () => Promise.all([checkIn(a.c, image), checkIn(b.c, image)]));
    assert.equal(arrived, 2, 'cả hai request đều qua kiểm tra trùng ban đầu trước khi một bên được cộng thưởng');
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

  // SEC-02 (trước đây F-55 "còn mở"): mã hóa lại, thu nhỏ hay đổi định dạng một ảnh đã thưởng cho điểm ảnh khác nhưng vẫn là cùng ảnh
  test('SEC-02: ảnh đã thưởng mã hóa lại JPEG, thu nhỏ, đổi sang WebP bị chặn 409 ở cùng tài khoản và tài khoản khác; ảnh khác vẫn được', async () => {
    await Promise.all([RewardedImage.deleteMany({}), CheckIn.deleteMany({})]);
    const a = await loggedInUser();
    const b = await loggedInUser();
    const original = fs.readFileSync(new URL('../fixtures/vision/bottle-drawing.jpg', import.meta.url));
    assert.equal((await checkIn(a.c, original, { type: 'image/jpeg', name: 'goc.jpg' })).status, 200);
    const variants = {
      'JPEG chất lượng 60': await sharp(original).jpeg({ quality: 60 }).toBuffer(),
      'thu nhỏ một nửa': await sharp(original).resize(224).jpeg({ quality: 85 }).toBuffer(),
      WebP: await sharp(original).webp({ quality: 80 }).toBuffer(),
    };
    for (const [label, variant] of Object.entries(variants)) {
      for (const account of [a, b]) {
        const res = await checkIn(account.c, variant, { type: 'image/jpeg', name: 'lai.jpg' });
        assert.deepEqual([res.status, res.data.code], [409, 'duplicate_image'], label);
      }
    }
    const other = fs.readFileSync(new URL('../fixtures/vision/plastic-cup-drawing.jpg', import.meta.url));
    assert.equal((await checkIn(b.c, other, { type: 'image/jpeg', name: 'khac.jpg' })).status, 200, 'ảnh khác hẳn không bị coi là trùng');
    const totals = await User.find({ _id: { $in: [a.id, b.id] } }).lean();
    assert.equal(totals.reduce((sum, u) => sum + u.ecoPoints, 0), 20);
  });

  test('SEC-02: ảnh gần trùng của tài khoản khác chỉ bị chặn trong 7 ngày; của chính mình thì luôn bị chặn', async () => {
    await Promise.all([RewardedImage.deleteMany({}), CheckIn.deleteMany({})]);
    const a = await loggedInUser();
    const b = await loggedInUser();
    const original = fs.readFileSync(new URL('../fixtures/vision/bottle-drawing.jpg', import.meta.url));
    const reEncoded = await sharp(original).jpeg({ quality: 70 }).toBuffer();
    assert.equal((await checkIn(a.c, original, { type: 'image/jpeg', name: 'goc.jpg' })).status, 200);
    // Ghi thẳng qua driver: Mongoose coi createdAt là bất biến và bỏ qua lệnh sửa
    await RewardedImage.collection.updateMany({}, { $set: { createdAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) } });
    assert.equal((await checkIn(a.c, reEncoded, { type: 'image/jpeg', name: 'lai.jpg' })).data.code, 'duplicate_image');
    assert.equal((await checkIn(b.c, reEncoded, { type: 'image/jpeg', name: 'lai.jpg' })).status, 200);
  });

  test('SEC-06: xóa tài khoản không giải phóng ảnh đã thưởng; bản ghi giữ lại không còn gắn với tài khoản', async () => {
    await Promise.all([RewardedImage.deleteMany({}), CheckIn.deleteMany({})]); // các test trước cũng để lại ảnh đã thưởng
    const a = await loggedInUser();
    const b = await loggedInUser();
    const image = uniquePng();
    assert.equal((await checkIn(a.c, image)).status, 200);
    await deleteAccount(await User.findById(a.id));
    const res = await checkIn(b.c, image);
    assert.deepEqual([res.status, res.data.code], [409, 'duplicate_image']);
    const kept = await RewardedImage.find({}).lean();
    assert.equal(kept.length, 1);
    assert.equal(kept[0].userId, undefined, 'không còn gắn với tài khoản đã xóa');
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

  test('SEC-02: mặc định thời gian chờ 30 phút và tối đa 3 lượt được thưởng mỗi ngày khi không đặt biến môi trường', async () => {
    setEnv(SIMULATION);
    delete process.env.CHECKIN_COOLDOWN_MINUTES;
    delete process.env.CHECKIN_DAILY_MAX;
    const status = (await client().get('/api/checkin/status')).data;
    assert.deepEqual([status.cooldownMinutes, status.dailyMax], [30, 3]);
  });

  test('SEC-02: quá số lượt được thưởng trong ngày (giờ Việt Nam) → 429 checkin_daily_limit, không cộng thưởng; gửi đồng thời không vượt trần', async () => {
    setEnv({ ...SIMULATION, CHECKIN_DAILY_MAX: '2' });
    const { c, id } = await loggedInUser();
    assert.equal((await checkIn(c)).status, 200);
    assert.equal((await checkIn(c)).status, 200);
    const third = await checkIn(c);
    assert.deepEqual([third.status, third.data.code], [429, 'checkin_daily_limit']);
    assert.ok(Number(third.headers.get('retry-after')) > 0, 'có Retry-After tới nửa đêm');
    assert.deepEqual([(await User.findById(id).lean()).ecoPoints, await CheckIn.countDocuments({ userId: id, valid: true })], [20, 2]);

    const other = await loggedInUser();
    const burst = await Promise.all([1, 2, 3, 4, 5].map(() => checkIn(other.c)));
    assert.equal(burst.filter((r) => r.status === 200).length, 2, String(burst.map((r) => r.status)));
    assert.ok(burst.filter((r) => r.status !== 200).every((r) => r.data.code === 'checkin_daily_limit'));
    const user = await User.findById(other.id).lean();
    assert.deepEqual([user.ecoPoints, user.pendingGachaSpins], [20, 2]);
  });

  test('SEC-02: lượt không được thưởng (ảnh bị từ chối) không tốn trần trong ngày', async () => {
    setEnv({ ...SIMULATION, CHECKIN_DAILY_MAX: '1' });
    const { c } = await loggedInUser();
    const image = uniquePng();
    setEnv({ ...simulatedVision('single_use_plastic_cup', 0.99), CHECKIN_DAILY_MAX: '1' });
    assert.equal((await checkIn(c, image)).status, 422);
    setEnv({ ...SIMULATION, CHECKIN_DAILY_MAX: '1' });
    assert.equal((await checkIn(c, image)).status, 200, 'lượt không được thưởng trước đó không tính vào trần');
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

  test('ghi kết quả quay thưởng thất bại → móc khóa và mã nhận quà vẫn hiện trong danh sách và được khôi phục', async () => {
    await publishKeychainConfig();
    const { c, id } = await loggedInUser();
    assert.equal((await checkIn(c)).status, 200);
    const spin = await withStub(GachaReward.prototype, 'save', () => Promise.reject(new Error('ghi lỗi')), () => c.post('/api/gacha/draw'));
    assert.equal(spin.status, 200);
    assert.equal(spin.data.outcome, 'win');
    const list = await c.get('/api/gacha/results');
    assert.equal(list.data.rewards.length, 1);
    assert.equal(list.data.rewards[0].claimCode, spin.data.prize.claimCode);
    assert.equal(list.data.pendingGachaSpins, 0);
    await recoverOutboxes();
    assert.equal(await GachaReward.countDocuments({ userId: id }), 1);
  });
});

describe('check-in → quay thưởng tri ân → hồ sơ (chuyển trạng thái)', () => {
  test('0 lượt → check-in (1 lượt) → quay (0 lượt, trúng móc khóa) → quay tiếp bị từ chối', async () => {
    await publishKeychainConfig();
    const { c } = await loggedInUser();
    const noSpin = await c.post('/api/gacha/draw');
    assert.equal(noSpin.status, 400);
    assert.equal(noSpin.data.code, 'no_spins');

    const ok = await checkIn(c);
    assert.equal(ok.data.user.pendingGachaSpins, 1);
    assert.ok(ok.data.story?.source?.url, 'kèm câu chuyện có nguồn');

    const spin = await c.post('/api/gacha/draw');
    assert.equal(spin.status, 200);
    assert.equal(spin.data.pendingGachaSpins, 0);
    assert.equal(spin.data.outcome, 'win');
    assert.match(spin.data.prize.claimCode, /^TA-[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);

    const me = (await c.get('/api/auth/me')).data.user;
    assert.equal(me.pendingGachaSpins, 0);
    assert.equal(me.ecoPoints, 10);
    const rewards = (await c.get('/api/gacha/results')).data.rewards;
    assert.deepEqual(rewards.map((r) => r.claimCode), [spin.data.prize.claimCode]);
    assert.equal((await c.post('/api/gacha/draw')).status, 400);
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
