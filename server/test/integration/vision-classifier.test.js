// Check-in qua API với bộ phân loại ONNX thật (engine 'classifier', cần tệp mô hình đã tải — tự bỏ qua nếu thiếu):
// trạng thái, từ chối ảnh không thưởng, bản ghi CheckIn, chặn trùng ảnh, ảnh bom giải nén, đường được thưởng
// (não giả lập thay session thật — đường cộng thưởng nguyên tử dùng chung với mọi engine đã có test riêng).
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CheckIn } from '../../src/models/CheckIn.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { RewardedImage } from '../../src/models/RewardedImage.js';
import { syncStories } from '../../src/services/stories.js';
import { DEFAULT_CLASSIFIER_MODEL, modelDir, verifyModelFiles } from '../../src/services/visionModels.js';
import { loadClassifier } from '../../src/services/visionClassifier.js';
import { createClient, imageForm, registerUser, setEnv, startTestServer } from '../helpers.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/vision');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));
const modelReady = (await verifyModelFiles(DEFAULT_CLASSIFIER_MODEL)).length === 0;
const SKIP_WITHOUT_MODEL = modelReady ? false : `chưa có mô hình ${DEFAULT_CLASSIFIER_MODEL} — chạy "npm run vision:download ${DEFAULT_CLASSIFIER_MODEL}"`;

let ctx;
const client = () => createClient(ctx.base);
const checkIn = (c, buffer, { name = 'anh.jpg', type = 'image/jpeg' } = {}) => c.post('/api/checkin', { form: imageForm(buffer, { name, type }) });

async function loggedIn() {
  const c = client();
  assert.equal((await registerUser(c)).status, 201);
  return c;
}

/** Thay hàm run của session thật (cùng key cache với server: modelDir()) để test và server dùng chung một session */
async function stubSession(run) {
  const { session } = await loadClassifier({
    classifier: { model: DEFAULT_CLASSIFIER_MODEL, dir: modelDir(), threads: 1 },
    maxQueue: 5,
    timeoutMs: 30000,
  });
  const original = session.run.bind(session);
  session.run = (feeds) => run(feeds, session);
  return () => {
    session.run = original;
  };
}

const logitsOutput = (session, index) => {
  const logits = new Float32Array(1000);
  logits[index] = 20;
  return { [session.outputNames[0]]: { data: logits, dims: [1, 1000], location: 'cpu', type: 'float32' } };
};

/** Logits cố định: 898=water bottle (reusable_bottle) hoặc 737=pop bottle (other_container) */
const stubLogits = (index) => stubSession(async (_feeds, session) => logitsOutput(session, index));

async function quietly(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

before(async () => {
  setEnv({ VISION_ENGINE: 'classifier' });
  ctx = await startTestServer();
  await syncStories();
});
after(async () => {
  await ctx.stop();
});
beforeEach(async () => {
  setEnv({ VISION_ENGINE: 'classifier' });
  await RateLimit.deleteMany({});
  await Promise.all([CheckIn.deleteMany({}), RewardedImage.deleteMany({})]);
});

describe('check-in bằng bộ phân loại ONNX trong tiến trình', { skip: SKIP_WITHOUT_MODEL }, () => {
  test('trạng thái: local / classifier, ngưỡng và loại ảnh nhận', async () => {
    const status = (await client().get('/api/checkin/status')).data;
    assert.deepEqual([status.mode, status.engine], ['local', 'classifier']);
    assert.deepEqual(status.acceptedTypes, ['image/jpeg', 'image/png', 'image/webp']);
    assert.equal(status.threshold, 0.8);
  });

  test('ảnh đồ họa (ngoài phân bố ImageNet) → unclear, không thưởng, ghi bản ghi "local"', async () => {
    const c = await loggedIn();
    const res = await checkIn(c, fixture('plastic-cup-drawing.jpg'));
    assert.equal(res.status, 422);
    assert.equal(res.data.code, 'container_not_accepted');
    assert.equal(res.data.classification.category, 'unclear');
    assert.match(res.data.classification.reason, /^Nhận diện tại máy chủ \(bộ phân loại/);
    assert.equal(res.data.classification.accepted, false);
    const record = await CheckIn.findOne({ userId: (await c.get('/api/auth/me')).data.user.id }).lean();
    assert.equal(record.valid, false);
    assert.equal(record.verification, 'local');
    assert.match(record.model, /^classifier:onnxmodelzoo\//);
    const { user } = (await c.get('/api/auth/me')).data;
    assert.deepEqual([user.ecoPoints, user.pendingGachaSpins], [0, 0]);
  });

  test('ảnh được thưởng → gửi lại cùng ảnh bị chặn 409 trùng ảnh (chặn theo điểm ảnh vẫn hoạt động)', async () => {
    const restore = await stubLogits(898);
    const c = await loggedIn();
    const first = await checkIn(c, fixture('bottle-drawing.jpg'));
    assert.equal(first.status, 200, JSON.stringify(first.data));
    restore(); // ảnh sau chấm bằng mô hình thật — nhưng chặn trùng ảnh diễn ra TRƯỚC khi chấm
    const second = await checkIn(c, fixture('bottle-drawing.jpg'));
    assert.equal(second.status, 409);
    assert.equal(second.data.code, 'duplicate_image');
  });

  test('F-28: ảnh bom giải nén (PNG 12000×12000) → 400 trước khi chấm', async () => {
    const c = await loggedIn();
    const bomb = await sharp({ create: { width: 12000, height: 12000, channels: 3, background: { r: 200, g: 220, b: 240 } } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const original = console.error;
    console.error = () => {};
    let res;
    try {
      res = await checkIn(c, bomb, { name: 'bom.png', type: 'image/png' });
    } finally {
      console.error = original;
    }
    assert.equal(res.status, 400);
    assert.equal(res.data.code, 'vision_invalid_image');
    assert.equal(await CheckIn.countDocuments(), 0, 'không ghi nhận ảnh lỗi');
  });

  test('ảnh nhận ra bình (session thay logits) → đạt ngưỡng + qua lần nhìn thứ hai → cộng thưởng, ghi "local"', async () => {
    const restore = await stubLogits(898); // water bottle → reusable_bottle
    try {
      const c = await loggedIn();
      const res = await checkIn(c, fixture('bottle-drawing.jpg'));
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.success, true);
      assert.equal(res.data.pointsEarned, 10);
      assert.equal(res.data.gachaSpinGranted, 1);
      assert.equal(res.data.classification.category, 'reusable_bottle');
      assert.equal(res.data.classification.accepted, true);
      const record = await CheckIn.findById(res.data.checkInId).lean();
      assert.equal(record.valid, true);
      assert.equal(record.verification, 'local');
      assert.equal(record.category, 'reusable_bottle');
      assert.equal(record.confidence, 1);
      assert.match(record.model, /^classifier:/);
      const { user } = (await c.get('/api/auth/me')).data;
      assert.equal(user.ecoPoints, 10);
      assert.equal(user.pendingGachaSpins, 1);
    } finally {
      restore();
    }
  });

  test('ảnh nhận ra PET bottle (737) → other_container, KHÔNG thưởng dù độ tin cậy cao', async () => {
    const restore = await stubLogits(737);
    try {
      const c = await loggedIn();
      const res = await checkIn(c, fixture('bottle-drawing.jpg'));
      assert.equal(res.status, 422);
      assert.equal(res.data.classification.category, 'other_container');
      const { user } = (await c.get('/api/auth/me')).data;
      assert.deepEqual([user.ecoPoints, user.pendingGachaSpins], [0, 0]);
    } finally {
      restore();
    }
  });

  test('lần nhìn thứ hai đổi kết luận khi làm mờ chữ (F-26) → không thưởng', async () => {
    let call = 0;
    const { session } = await loadClassifier({
      classifier: { model: DEFAULT_CLASSIFIER_MODEL, dir: modelDir(), threads: 1 },
      maxQueue: 5,
      timeoutMs: 30000,
    });
    const original = session.run.bind(session);
    session.run = async () => {
      const logits = new Float32Array(1000);
      logits[call++ === 0 ? 898 : 737] = 20; // lần 1: water bottle (thưởng được), lần 2 trên ảnh mờ: pop bottle (không thưởng)
      return { [session.outputNames[0]]: { data: logits, dims: [1, 1000], location: 'cpu', type: 'float32' } };
    };
    try {
      const c = await loggedIn();
      const res = await checkIn(c, fixture('bottle-drawing.jpg'));
      assert.equal(res.status, 422);
      assert.equal(res.data.classification.accepted, false);
      const { user } = (await c.get('/api/auth/me')).data;
      assert.equal(user.ecoPoints, 0);
    } finally {
      session.run = original;
    }
  });

  test('mô hình thiếu → 503 vision_not_configured, không tự tải từ Internet', async () => {
    setEnv({ VISION_ENGINE: 'classifier', VISION_MODEL_DIR: 'test/.khong-co-mo-hinh' });
    const original = console.error;
    console.error = () => {};
    let res;
    try {
      res = await checkIn(await loggedIn(), fixture('plain.jpg'));
    } finally {
      console.error = original;
    }
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'vision_not_configured');
  });

  test('lần nhìn thứ hai chạy trên ảnh đã làm mờ (tensor khác ảnh gốc); được thưởng, ghi "local", không phải mô phỏng', async () => {
    const inputs = [];
    const restore = await stubSession(async (feeds, session) => {
      inputs.push(Float32Array.from(feeds[session.inputNames[0]].data));
      return logitsOutput(session, 898);
    });
    try {
      const c = await loggedIn();
      const res = await checkIn(c, fixture('bottle-drawing.jpg'));
      assert.equal(res.status, 200, JSON.stringify(res.data));
      assert.equal(res.data.classification.status, 'classified');
      assert.equal(res.data.classification.simulated, false);
      assert.equal((await CheckIn.findById(res.data.checkInId).lean()).verification, 'local');
      assert.equal(inputs.length, 2, 'ảnh được thưởng được chấm hai lần');
      assert.ok(inputs[0].some((v, i) => Math.abs(v - inputs[1][i]) > 1e-3), 'lần hai không được chấm lại đúng ảnh gốc');
    } finally {
      restore();
    }
  });

  test('suy luận lỗi → 502 vision_provider_error, không ghi nhận, không thưởng', async () => {
    const restore = await stubSession(async () => {
      throw new Error('onnxruntime: lỗi giả lập');
    });
    try {
      const c = await loggedIn();
      const res = await quietly(() => checkIn(c, fixture('bottle-drawing.jpg')));
      assert.equal(res.status, 502);
      assert.equal(res.data.code, 'vision_provider_error');
      assert.equal(res.data.classification.accepted, false);
      assert.equal(await CheckIn.countDocuments(), 0);
      const { user } = (await c.get('/api/auth/me')).data;
      assert.deepEqual([user.ecoPoints, user.pendingGachaSpins], [0, 0]);
    } finally {
      restore();
    }
  });

  // Lỗi "VLM trả sai schema → 502" của bộ nhận diện cũ, áp cho bộ phân loại: đầu ra hỏng là lỗi bộ nhận diện, không phải lượt bị từ chối
  test('đầu ra mô hình sai dạng (NaN, Infinity, thiếu lớp) → 502 vision_invalid_response, không ghi nhận, không thưởng', async () => {
    const c = await loggedIn();
    const outputs = {
      'NaN ở mọi logit': new Float32Array(1000).fill(Number.NaN),
      '+Infinity ở lớp bình nước': Object.assign(new Float32Array(1000), { 898: Number.POSITIVE_INFINITY }),
      'chỉ 10 lớp': new Float32Array(10).fill(1),
    };
    for (const [label, logits] of Object.entries(outputs)) {
      const restore = await stubSession(async (_feeds, session) => ({
        [session.outputNames[0]]: { data: logits, dims: [1, logits.length], location: 'cpu', type: 'float32' },
      }));
      try {
        const res = await quietly(() => checkIn(c, fixture('bottle-drawing.jpg')));
        assert.equal(res.status, 502, `${label}: ${JSON.stringify(res.data)}`);
        assert.equal(res.data.code, 'vision_invalid_response', label);
        assert.equal(res.data.classification.accepted, false, label);
        assert.equal(res.data.classification.category, null, `${label}: không có loại nào được ghi nhận`);
      } finally {
        restore();
      }
    }
    assert.equal(await CheckIn.countDocuments(), 0, 'lỗi bộ nhận diện không thành lượt check-in bị từ chối');
    assert.equal(await RewardedImage.countDocuments(), 0);
    const { user } = (await c.get('/api/auth/me')).data;
    assert.deepEqual([user.ecoPoints, user.pendingGachaSpins, user.totalCheckIns], [0, 0, 0]);
  });

  test('suy luận quá VISION_TIMEOUT_MS → 502 vision_timeout, không ghi nhận', async () => {
    setEnv({ VISION_ENGINE: 'classifier', VISION_TIMEOUT_MS: '3000' });
    const restore = await stubSession(async (_feeds, session) => {
      await new Promise((resolve) => setTimeout(resolve, 3300));
      return logitsOutput(session, 898);
    });
    try {
      const c = await loggedIn();
      const res = await quietly(() => checkIn(c, fixture('bottle-drawing.jpg')));
      assert.equal(res.status, 502);
      assert.equal(res.data.code, 'vision_timeout');
      assert.equal(await CheckIn.countDocuments(), 0);
    } finally {
      restore();
    }
  });

  test('nhiều ảnh cùng lúc vượt VISION_MAX_QUEUE → 503 "máy chủ đang bận", không thưởng; ảnh đang chấm vẫn có kết quả', async () => {
    setEnv({ VISION_ENGINE: 'classifier', VISION_MAX_QUEUE: '1' });
    // Mỗi lượt chấm mất 300 ms nên các ảnh sau tới khi ảnh đầu còn đang được chấm; logits lớp 0 (ngoài ánh xạ) → unclear
    const restore = await stubSession(async (_feeds, session) => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return logitsOutput(session, 0);
    });
    try {
      const c = await loggedIn();
      const base = fixture('plain.jpg');
      const results = await quietly(() => Promise.all([1, 2, 3, 4, 5].map((i) => checkIn(c, Buffer.concat([base, Buffer.from(`hang-doi-${i}`)])))));
      const statuses = results.map((r) => r.status);
      const busy = results.filter((r) => r.status === 503);
      assert.ok(busy.length >= 1, `không có yêu cầu nào bị từ chối vì bận: ${statuses}`);
      for (const r of busy) {
        assert.equal(r.data.code, 'vision_busy');
        assert.match(r.data.error, /đang bận/);
      }
      assert.ok(statuses.includes(422), `ảnh đầu tiên vẫn phải được chấm: ${statuses}`);
      assert.ok(statuses.every((s) => s === 422 || s === 503), String(statuses));
      const { user } = (await c.get('/api/auth/me')).data;
      assert.equal(user.ecoPoints, 0);
    } finally {
      restore();
    }
  });
});

describe('không cần mô hình', () => {
  test('ảnh HEIC → 415 kèm hướng dẫn dùng camera hoặc JPEG/PNG/WebP', async () => {
    const heic = Buffer.concat([Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00', 'latin1'), Buffer.alloc(256, 7)]);
    const res = await checkIn(await loggedIn(), heic, { name: 'IMG_0001.HEIC', type: 'image/heic' });
    assert.equal(res.status, 415);
    assert.equal(res.data.code, 'image_type_unsupported');
    assert.match(res.data.error, /HEIC\/HEIF/);
  });

  // Đường VLM trên Ollama và CLIP đã gỡ khỏi server (2026-11-07): cấu hình còn sót tên cũ không được chạy bộ nhận diện nào
  for (const engine of ['ensemble', 'clip', 'ollama']) {
    test(`tên bộ nhận diện cũ (${engine}) → 503, ảnh không được chấm, không thưởng`, async () => {
      setEnv({ VISION_ENGINE: engine });
      const c = await loggedIn();
      const status = (await c.get('/api/checkin/status')).data;
      assert.deepEqual([status.mode, status.engine], ['unavailable', null]);
      const res = await checkIn(c, fixture('bottle-drawing.jpg'));
      assert.equal(res.status, 503);
      assert.equal(res.data.code, 'vision_not_configured');
      assert.equal(await CheckIn.countDocuments(), 0);
      const { user } = (await c.get('/api/auth/me')).data;
      assert.deepEqual([user.ecoPoints, user.pendingGachaSpins], [0, 0]);
    });
  }
});
