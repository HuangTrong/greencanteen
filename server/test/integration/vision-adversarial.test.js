// F-26: ảnh đối kháng (chữ đánh lừa bộ nhận diện) không được thưởng; bình/ly có nhãn được đo để biết nguy cơ từ chối nhầm.
// Tập ảnh: test/fixtures/vision/adversarial và adversarial-holdout (HÌNH VẼ tổng hợp, không phải ảnh chụp; không dùng để kết luận độ chính
// xác trên ảnh thật). adversarial dùng khi thiết kế biện pháp, adversarial-holdout chỉ dùng để chấm sau khi đã chốt thiết kế.
// Phần "fake" tái lập được ở mọi máy. Phần CLIP/VLM thật tự bỏ qua khi thiếu mô hình: khi đó ghi BLOCKED, không ghi PASS.
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
import { classifyWithClip } from '../../src/services/visionClip.js';
import { DEFAULT_CLIP_MODEL, verifyModelFiles } from '../../src/services/visionModels.js';
import { classifyContainerImage, visionConfig } from '../../src/services/vision.js';
import { createClient, imageForm, realFetch, registerUser, setEnv, startTestServer } from '../helpers.js';
import { startFakeOllama } from '../fakes/ollama.js';

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

const modelReady = (await verifyModelFiles(DEFAULT_CLIP_MODEL)).length === 0;
const BLOCKED_NO_CLIP = modelReady ? false : 'BLOCKED: chưa có mô hình CLIP — chạy "npm run vision:download"';

const REAL_OLLAMA = { url: process.env.TEST_OLLAMA_URL || 'http://127.0.0.1:11434', model: process.env.TEST_OLLAMA_MODEL || 'qwen3-vl:4b-instruct' };
async function realOllamaReady() {
  try {
    const res = await fetch(`${REAL_OLLAMA.url}/api/tags`, { signal: AbortSignal.timeout(2000) });
    const { models = [] } = await res.json();
    return models.some((m) => m.name === REAL_OLLAMA.model || m.model === REAL_OLLAMA.model);
  } catch {
    return false;
  }
}
const BLOCKED_NO_VLM = (await realOllamaReady()) ? false : `BLOCKED: chưa có Ollama với mô hình ${REAL_OLLAMA.model} tại ${REAL_OLLAMA.url}`;
const REAL_VLM_ENV = { VISION_OLLAMA_URL: REAL_OLLAMA.url, VISION_OLLAMA_MODEL: REAL_OLLAMA.model, VISION_TIMEOUT_MS: '120000' };

let ctx;
let ollama;
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
  assert.equal((await User.findById(id).lean()).checkInOutbox?.length ?? 0, 0, 'không có thưởng chờ chuyển');
}

before(async () => {
  setEnv();
  ctx = await startTestServer();
  ollama = await startFakeOllama();
  await syncStories();
  outboundCalls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('http://127.0.0.1')) return realFetch(url, init);
    outboundCalls.push(String(url));
    throw new Error(`Chặn request ra ngoài trong test: ${url}`);
  };
});
after(async () => {
  globalThis.fetch = realFetch;
  await ollama.close();
  await ctx.stop();
});
beforeEach(async () => {
  setEnv();
  outboundCalls.length = 0;
  Object.assign(ollama, { reply: { category: 'reusable_bottle', confidence: 0.95, reason: 'Bình giữ nhiệt inox' }, delayMs: 0, gate: 0 });
  await RateLimit.deleteMany({});
  await RewardedImage.deleteMany({});
});

describe('tập ảnh đối kháng', () => {
  test('có đủ loại vật chứa, bố cục, từ ngữ và ảnh bình/ly thật có nhãn để đo từ chối nhầm', () => {
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

describe('CLIP một mình không đủ để thưởng', () => {
  for (const [label, env] of [
    ['VISION_ENGINE=clip', { VISION_ENGINE: 'clip' }],
    ['VISION_ENGINE=clip trong production', { VISION_ENGINE: 'clip', NODE_ENV: 'production' }],
    ['production không thể mở lại bằng cờ phát triển', { VISION_ENGINE: 'clip', NODE_ENV: 'production', VISION_ALLOW_CLIP_ONLY: 'true' }],
  ]) {
    test(`${label}: check-in tắt, ảnh không tới bộ nhận diện, không thưởng`, async () => {
      const { c, id } = await loggedIn();
      setEnv(env);
      assert.equal((await client().get('/api/checkin/status')).data.mode, 'unavailable');
      assert.equal(visionConfig().problem, 'clip_only_not_allowed');
      const res = await checkIn(c, read(ATTACKS[0]));
      assert.equal(res.status, 503);
      assert.equal(res.data.code, 'vision_not_configured');
      await assertNoReward(id);
    });
  }

  test('VLM một mình trong production: check-in tắt, ảnh không tới Ollama, không thưởng', async () => {
    const { c, id } = await loggedIn();
    setEnv({ VISION_ENGINE: 'ollama', NODE_ENV: 'production', VISION_OLLAMA_URL: ollama.url });
    const before = ollama.requests.length;
    assert.equal((await client().get('/api/checkin/status')).data.mode, 'unavailable');
    const res = await checkIn(c, read(ATTACKS[0]));
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'vision_not_configured');
    assert.equal(ollama.requests.length, before);
    await assertNoReward(id);
  });

  test('không đặt VISION_ENGINE: mặc định cần cả CLIP và VLM, không phải CLIP một mình', () => {
    assert.equal(visionConfig().engine, 'ensemble');
  });
});

describe('quyết định thưởng với VLM giả (tái lập được, không cần mô hình)', () => {
  const VLM_ONLY = () => ({ VISION_ENGINE: 'ollama', VISION_OLLAMA_URL: ollama.url });

  for (const reply of [
    { category: 'single_use_plastic_cup', confidence: 0.97, reason: 'Ly nhựa mỏng, dán nhãn giấy' },
    { category: 'other_container', confidence: 0.91, reason: 'Lon nước ngọt có dán chữ' },
    { category: 'no_container', confidence: 0.9, reason: 'Chỉ có chữ, không thấy vật chứa' },
    { category: 'unclear', confidence: 0.4, reason: 'Không phân biệt được chất liệu' },
    { category: 'reusable_bottle', confidence: 0.6, reason: 'Có thể là bình, chưa chắc chắn' },
  ]) {
    test(`${reply.category}@${reply.confidence}: 422, không có dấu vết thưởng`, async () => {
      const { c, id } = await loggedIn();
      setEnv(VLM_ONLY());
      ollama.reply = reply;
      const res = await checkIn(c, read(ATTACKS[1]));
      assert.equal(res.status, 422);
      assert.equal(res.data.classification.accepted, false);
      await assertNoReward(id);
    });
  }

  test('nhìn lại trên ảnh làm mờ cho kết quả khác: không thưởng, thông báo nêu lý do', async () => {
    const { c, id } = await loggedIn();
    setEnv(VLM_ONLY());
    let calls = 0;
    ollama.reply = () => ((calls += 1) === 1 ? { category: 'reusable_bottle', confidence: 0.95, reason: 'Đọc thấy chữ thermos' } : { category: 'other_container', confidence: 0.9, reason: 'Lon nước' });
    const res = await checkIn(c, read(ATTACKS[2]));
    assert.equal(res.status, 422);
    assert.equal(calls, 2);
    assert.equal(res.data.classification.accepted, false);
    assert.match(res.data.error, /chữ/);
    await assertNoReward(id);
    const stored = await CheckIn.findOne({ userId: id }).lean();
    assert.equal(stored.valid, false);
    assert.equal(stored.category, 'unclear');
  });

  test('ảnh gửi nhìn lần hai đã được làm mờ, khác ảnh gốc, và chỉ tới Ollama trong máy', async () => {
    const { c } = await loggedIn();
    setEnv(VLM_ONLY());
    const before = ollama.requests.length;
    const original = read(BENIGN[0]);
    const res = await checkIn(c, original);
    assert.equal(res.status, 200);
    const [first, second] = ollama.requests.slice(before).map((body) => body.messages[0].images[0]);
    assert.equal(first, original.toString('base64'));
    assert.notEqual(second, first);
    assert.deepEqual(outboundCalls, []);
  });

  test('VLM lỗi ở lần nhìn thứ hai: không thưởng, không tự coi như đạt', async () => {
    const { c, id } = await loggedIn();
    setEnv(VLM_ONLY());
    let calls = 0;
    ollama.reply = () => ((calls += 1) === 1 ? { category: 'reusable_bottle', confidence: 0.95, reason: 'Bình' } : { status: 500, error: 'mô hình lỗi' });
    const original = console.error;
    console.error = () => {};
    try {
      const res = await checkIn(c, read(ATTACKS[3]));
      assert.equal(res.status, 502);
      assert.equal(res.data.code, 'vision_provider_error');
    } finally {
      console.error = original;
    }
    await assertNoReward(id);
    assert.equal(await CheckIn.countDocuments({ userId: id }), 0, 'lỗi bộ nhận diện không ghi nhận');
  });

  test('VLM giữ nguyên kết quả cả hai lần: được thưởng đúng một lần (đường thành công không bị chặn)', async () => {
    const { c, id } = await loggedIn();
    setEnv(VLM_ONLY());
    const res = await checkIn(c, read(BENIGN[1]));
    assert.equal(res.status, 200);
    assert.equal((await User.findById(id).lean()).pendingGachaSpins, 1);
  });

  for (const [label, reply] of [
    ['Ollama trả lỗi', { status: 500, error: 'mô hình lỗi' }],
    ['Ollama sai schema', { category: 'reusable_bottle', confidence: 'cao', reason: 'x' }],
  ]) {
    test(`kết hợp: ${label} → không tự chuyển sang chỉ CLIP, không thưởng`, { skip: BLOCKED_NO_CLIP }, async () => {
      const { c, id } = await loggedIn();
      setEnv({ VISION_ENGINE: 'ensemble', VISION_OLLAMA_URL: ollama.url });
      ollama.reply = reply;
      const original = console.error;
      console.error = () => {};
      try {
        const res = await checkIn(c, read(ATTACKS[4]));
        assert.ok(res.status >= 500, String(res.status));
        assert.notEqual(res.data.classification?.accepted, true);
      } finally {
        console.error = original;
      }
      await assertNoReward(id);
    });
  }

  test('kết hợp: Ollama tắt hẳn → không tự chuyển sang chỉ CLIP, không thưởng', { skip: BLOCKED_NO_CLIP }, async () => {
    const { c, id } = await loggedIn();
    setEnv({ VISION_ENGINE: 'ensemble', VISION_OLLAMA_URL: 'http://127.0.0.1:9' });
    const original = console.error;
    console.error = () => {};
    try {
      const res = await checkIn(c, read(ATTACKS[5]));
      assert.equal(res.status, 502);
    } finally {
      console.error = original;
    }
    await assertNoReward(id);
  });
});

describe('CLIP thật trên tập ảnh đối kháng', { skip: BLOCKED_NO_CLIP }, () => {
  test('điểm yếu vẫn còn: CLIP một mình vẫn bị chữ đánh lừa, nên không được dùng để thưởng', async (t) => {
    setEnv({ VISION_ENGINE: 'clip', VISION_ALLOW_CLIP_ONLY: 'true', VISION_TIMEOUT_MS: '60000' });
    const cfg = visionConfig();
    for (const [name, set] of Object.entries(SETS)) {
      const attacks = set.filter((image) => image.kind === 'attack');
      const fooled = [];
      for (const image of attacks) {
        const result = await classifyWithClip({ buffer: read(image), mimeType: 'image/jpeg' }, cfg);
        if (['reusable_bottle', 'reusable_cup'].includes(result.category) && result.confidence >= cfg.threshold) fooled.push(image.file);
      }
      t.diagnostic(`${name}: CLIP một mình thưởng nhầm ${fooled.length}/${attacks.length} ảnh đối kháng ở ngưỡng ${cfg.threshold}`);
      assert.ok(fooled.length > 0, 'nếu CLIP không còn bị đánh lừa thì phải đánh giá lại quyết định chặn CLIP một mình');
    }
  });

  test('qua API với cấu hình mặc định về CLIP (VISION_ENGINE=clip): không ảnh đối kháng nào được thưởng', async () => {
    const { c, id } = await loggedIn();
    setEnv({ VISION_ENGINE: 'clip' });
    for (const image of ATTACKS) assert.notEqual((await checkIn(c, read(image))).status, 200, image.file);
    await assertNoReward(id);
  });

  test('CLIP thật bị lừa + VLM giả nhận ra đồ dùng một lần: 422 cho mọi ảnh đối kháng, không dấu vết thưởng', async () => {
    const { c, id } = await loggedIn();
    setEnv({ VISION_ENGINE: 'ensemble', VISION_OLLAMA_URL: ollama.url, VISION_TIMEOUT_MS: '60000' });
    ollama.reply = { category: 'single_use_plastic_cup', confidence: 0.95, reason: 'Vật chứa dùng một lần' };
    await User.updateOne({ _id: id }, { $set: { lastRewardedCheckInAt: null } });
    for (const image of ATTACKS) {
      await RateLimit.deleteMany({});
      const res = await checkIn(c, read(image));
      assert.equal(res.status, 422, image.file);
    }
    await assertNoReward(id);
    assert.deepEqual(outboundCalls, []);
  });
});

describe('CLIP + VLM thật trên tập ảnh đối kháng', { skip: BLOCKED_NO_CLIP || BLOCKED_NO_VLM }, () => {
  // F-61: Ollama cho kết quả khác ở lần gửi lại đúng một tệp (đo được: lần đầu đạt, các lần sau sinh chuỗi lặp tới hết num_predict, API trả 502).
  // Bộ test bên dưới mỗi ảnh chỉ gửi một lần nên không bắt được; ảnh gửi lại phải được chấm thật, không tính lỗi bộ nhận diện là đạt.
  test('F-61: gửi lại đúng một tệp nhiều lần: mỗi lần đều có kết quả chấm thật, không 502, không thưởng', { timeout: 300_000 }, async () => {
    const { c, id } = await loggedIn();
    setEnv({ VISION_ENGINE: 'ensemble', ...REAL_VLM_ENV });
    const image = MAIN.find((item) => item.file.endsWith('attack-06-clear_cup_straw-repeat.jpg'));
    const statuses = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await RateLimit.deleteMany({});
      statuses.push((await checkIn(c, read(image))).status);
    }
    assert.deepEqual(statuses, Array(6).fill(422));
    await assertNoReward(id);
    assert.equal(await RewardedImage.countDocuments({ userId: id }), 0);
    assert.deepEqual(outboundCalls, []);
  });

  for (const [name, set] of Object.entries(SETS)) {
    test(`${name}: không ảnh đối kháng hay đối chứng nào được thưởng qua API; đo tỉ lệ từ chối nhầm bình/ly`, { timeout: 900_000 }, async (t) => {
      const { c, id } = await loggedIn();
      setEnv({ VISION_ENGINE: 'ensemble', ...REAL_VLM_ENV });
      // VLM thật thỉnh thoảng sinh chuỗi lặp tới khi bị num_predict cắt: 502, không thưởng, nhưng ảnh chưa được chấm.
      // Thử lại để có kết quả chấm thật; lần lỗi không được tính là đạt, lỗi cả 3 lần thì test đỏ.
      let retries = 0;
      const graded = async (attempt, failed) => {
        for (let tries = 1; ; tries += 1) {
          const result = await attempt();
          if (!failed(result) || tries === 3) return result;
          retries += 1;
        }
      };

      const accepted = [];
      const disposable = set.filter((image) => image.kind !== 'benign');
      const engineDown = (res) => res.status === 502 || res.status === 503;
      for (const image of disposable) {
        const res = await graded(async () => {
          await RateLimit.deleteMany({});
          return checkIn(c, read(image));
        }, engineDown);
        assert.ok(!engineDown(res), `${image.file}: bộ nhận diện lỗi ${res.status}, kết quả không dùng được`);
        if (res.status === 200) accepted.push(`${image.file} (${image.word})`);
      }
      assert.deepEqual(accepted, [], 'ảnh dùng một lần được thưởng');
      await assertNoReward(id);

      const cfg = visionConfig();
      const benign = set.filter((image) => image.kind === 'benign');
      const rejected = [];
      for (const image of benign) {
        const result = await graded(() => classifyContainerImage({ buffer: read(image), mimeType: 'image/jpeg' }, cfg), (r) => r.status !== 'classified');
        assert.equal(result.status, 'classified', `${image.file}: bộ nhận diện lỗi, kết quả không dùng được`);
        if (!result.accepted) rejected.push(image.file);
      }
      t.diagnostic(`${name}: thưởng nhầm 0/${disposable.length}; từ chối nhầm ${rejected.length}/${benign.length} ảnh bình/ly (hình vẽ tổng hợp) ở ngưỡng ${cfg.threshold}; thử lại ${retries} lần do VLM trả về kết quả hỏng`);
      assert.ok(rejected.length < benign.length, 'vẫn còn đường thưởng cho bình/ly thật');
      assert.deepEqual(outboundCalls, []);
    });
  }
});
