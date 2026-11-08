// F-26 với bộ phân loại ONNX (engine classifier, chạy trên CPU trong tiến trình): ảnh đối kháng (chữ đánh lừa bộ nhận diện)
// và ảnh đối chứng không được thưởng qua API; ảnh bình/ly có nhãn được đo để biết mức từ chối nhầm.
// Tập ảnh: test/fixtures/vision/adversarial và adversarial-holdout (HÌNH VẼ tổng hợp, không phải ảnh chụp; không dùng để kết luận độ
// chính xác trên ảnh thật). adversarial dùng khi thiết kế biện pháp, adversarial-holdout chỉ dùng để chấm sau khi đã chốt thiết kế.
// Phần cần mô hình thật tự bỏ qua khi thiếu tệp mô hình: khi đó ghi BLOCKED, không ghi PASS.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CheckIn } from '../../src/models/CheckIn.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { RewardedImage } from '../../src/models/RewardedImage.js';
import { User } from '../../src/models/User.js';
import { syncStories } from '../../src/services/stories.js';
import { DEFAULT_CLASSIFIER_MODEL, verifyModelFiles } from '../../src/services/visionModels.js';
import { classifyContainerImage, visionConfig } from '../../src/services/vision.js';
import { createClient, imageForm, realFetch, registerUser, setEnv, startTestServer } from '../helpers.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/vision');
function loadSet(dir) {
  const { images } = JSON.parse(fs.readFileSync(path.join(FIXTURES, dir, 'manifest.json'), 'utf8'));
  return images.map((image) => ({ ...image, path: path.join(FIXTURES, dir, image.file) }));
}
const SETS = { 'tập chính': loadSet('adversarial'), 'tập holdout': loadSet('adversarial-holdout') };
const MAIN = SETS['tập chính'];
const ATTACKS = MAIN.filter((image) => image.kind === 'attack');
const BENIGN = MAIN.filter((image) => image.kind === 'benign');
const read = (image) => fs.readFileSync(image.path);

const modelReady = (await verifyModelFiles(DEFAULT_CLASSIFIER_MODEL)).length === 0;
const BLOCKED_NO_MODEL = modelReady ? false : `BLOCKED: chưa có mô hình ${DEFAULT_CLASSIFIER_MODEL} — chạy "npm run vision:download"`;

let ctx;
let outboundCalls;
const client = () => createClient(ctx.base);
const checkIn = (c, buffer) => c.post('/api/checkin', { form: imageForm(buffer, { name: 'anh.jpg', type: 'image/jpeg' }) });

async function loggedIn() {
  const c = client();
  const res = await registerUser(c);
  assert.equal(res.status, 201);
  return { c, id: res.data.user.id };
}

/** Ảnh bị từ chối phải không để lại bất kỳ dấu vết thưởng nào */
async function assertNoReward(id) {
  const user = await User.findById(id).lean();
  assert.equal(user.ecoPoints, 0, 'không cộng điểm');
  assert.equal(user.pendingGachaSpins, 0, 'không cấp lượt Gacha');
  assert.equal(user.totalCheckIns, 0, 'không tính lượt check-in');
  assert.deepEqual(user.badges, [], 'không có huy hiệu');
  assert.equal(await CheckIn.countDocuments({ userId: id, valid: true }), 0, 'không có check-in hợp lệ');
  assert.equal(await GachaReward.countDocuments({ userId: id }), 0, 'không có phần thưởng');
  assert.equal(user.checkInOutbox?.length ?? 0, 0, 'không có thưởng chờ chuyển');
}

before(async () => {
  setEnv({ VISION_ENGINE: 'classifier' });
  ctx = await startTestServer();
  await syncStories();
  outboundCalls = [];
  // Bộ phân loại chạy trong tiến trình: không request nào được rời máy chủ
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    outboundCalls.push(String(url));
    throw new Error(`Chặn request ra ngoài trong test: ${url}`);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await ctx.stop();
});
beforeEach(async () => {
  setEnv({ VISION_ENGINE: 'classifier' });
  outboundCalls.length = 0;
  await RateLimit.deleteMany({});
  await RewardedImage.deleteMany({});
});

describe('tập ảnh đối kháng', () => {
  test('có đủ loại vật chứa, bố cục, từ ngữ và ảnh bình/ly có nhãn để đo từ chối nhầm', () => {
    assert.ok(ATTACKS.length >= 40, `${ATTACKS.length} ảnh đối kháng`);
    assert.ok(BENIGN.length >= 20, `${BENIGN.length} ảnh có nhãn`);
    assert.ok(new Set(ATTACKS.map((a) => a.container)).size >= 7, 'nhiều vật chứa dùng một lần');
    assert.ok(new Set(ATTACKS.map((a) => a.layout)).size >= 6, 'nhiều bố cục');
    assert.ok(new Set(ATTACKS.map((a) => a.word)).size >= 8, 'nhiều từ ngữ');
    assert.ok(new Set(BENIGN.map((b) => b.expected)).size === 2, 'cả bình và ly');
    for (const set of Object.values(SETS)) {
      assert.ok(set.filter((image) => image.kind === 'control').length >= 7, 'có đối chứng không chữ');
      for (const image of set) assert.ok(fs.existsSync(image.path), image.file);
    }
  });

  test('tập holdout khác tập chính về từ ngữ, bố cục và tệp ảnh', () => {
    const holdout = SETS['tập holdout'];
    const words = new Set(ATTACKS.map((image) => image.word));
    assert.equal(holdout.filter((image) => image.kind === 'attack' && words.has(image.word)).length, 0, 'không dùng lại từ ngữ');
    assert.ok(new Set(holdout.map((image) => image.layout)).has('big'), 'có chữ rất lớn');
    const hashes = new Set(MAIN.map((image) => image.sha256));
    assert.equal(holdout.filter((image) => hashes.has(image.sha256)).length, 0, 'không dùng lại ảnh');
  });
});

describe('bộ phân loại ONNX thật trên tập ảnh đối kháng', { skip: BLOCKED_NO_MODEL }, () => {
  for (const [name, set] of Object.entries(SETS)) {
    test(`${name}: không ảnh đối kháng hay đối chứng nào được thưởng qua API; đo tỉ lệ từ chối nhầm bình/ly`, { timeout: 300_000 }, async (t) => {
      const { c, id } = await loggedIn();
      const accepted = [];
      const disposable = set.filter((image) => image.kind !== 'benign');
      for (const image of disposable) {
        await RateLimit.deleteMany({});
        const res = await checkIn(c, read(image));
        assert.ok(![502, 503].includes(res.status), `${image.file}: bộ nhận diện lỗi ${res.status}, kết quả không dùng được`);
        if (res.status === 200) accepted.push(`${image.file} (${image.word})`);
      }
      assert.deepEqual(accepted, [], 'ảnh dùng một lần được thưởng');
      await assertNoReward(id);

      // Chỉ đo, không đặt ngưỡng đạt: artifact hiện tại (ImageNet + bảng ánh xạ) chưa huấn luyện trên ảnh của trường
      const cfg = visionConfig();
      const benign = set.filter((image) => image.kind === 'benign');
      const rejected = [];
      for (const image of benign) {
        const result = await classifyContainerImage({ buffer: read(image), mimeType: 'image/jpeg' }, cfg);
        assert.equal(result.status, 'classified', `${image.file}: bộ nhận diện lỗi, kết quả không dùng được`);
        if (!result.accepted) rejected.push(image.file);
      }
      t.diagnostic(`${name}: thưởng nhầm 0/${disposable.length}; từ chối nhầm ${rejected.length}/${benign.length} ảnh bình/ly (hình vẽ tổng hợp) ở ngưỡng ${cfg.threshold}`);
      assert.deepEqual(outboundCalls, []);
    });
  }
});
