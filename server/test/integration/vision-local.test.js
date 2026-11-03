// Nhận diện ảnh TẠI MÁY CHỦ qua API: CLIP thật chạy ngoại tuyến (cần `npm run vision:download`; tự bỏ qua nếu chưa có),
// kết hợp CLIP + VLM local giả, VLM thật trên Ollama của máy này (tự bỏ qua nếu chưa cài / chưa pull mô hình), chặn gửi
// ảnh ra ngoài, HEIC. Ảnh là hình vẽ tổng hợp — KHÔNG dùng để đo độ chính xác.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { CheckIn } from '../../src/models/CheckIn.js';
import { RateLimit } from '../../src/models/RateLimit.js';
import { RewardedImage } from '../../src/models/RewardedImage.js';
import { syncStories } from '../../src/services/stories.js';
import { DEFAULT_CLIP_MODEL, verifyModelFiles } from '../../src/services/visionModels.js';
import { User } from '../../src/models/User.js';
import { classifyWithClip } from '../../src/services/visionClip.js';
import { visionConfig } from '../../src/services/vision.js';
import { createClient, imageForm, realFetch, registerUser, setEnv, startTestServer } from '../helpers.js';
import { startFakeOllama } from '../fakes/ollama.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/vision');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));
const modelReady = (await verifyModelFiles(DEFAULT_CLIP_MODEL)).length === 0;
const SKIP_WITHOUT_MODEL = modelReady ? false : 'chưa có mô hình CLIP — chạy "npm run vision:download"';

// VLM thật: Ollama trên chính máy chạy test (mặc định 127.0.0.1:11434, mô hình mặc định của server)
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
const SKIP_WITHOUT_VLM = (await realOllamaReady()) ? false : `chưa có Ollama với mô hình ${REAL_OLLAMA.model} tại ${REAL_OLLAMA.url}`;
const REAL_VLM_ENV = { VISION_OLLAMA_URL: REAL_OLLAMA.url, VISION_OLLAMA_MODEL: REAL_OLLAMA.model, VISION_TIMEOUT_MS: '120000' };

let ctx;
let ollama;
let outboundCalls;
const client = () => createClient(ctx.base);
const checkIn = (c, buffer, { name = 'anh.jpg', type = 'image/jpeg' } = {}) => c.post('/api/checkin', { form: imageForm(buffer, { name, type }) });

async function loggedIn() {
  const c = client();
  assert.equal((await registerUser(c)).status, 201);
  return c;
}

before(async () => {
  setEnv();
  ctx = await startTestServer();
  ollama = await startFakeOllama();
  await syncStories();
  // Mọi request của server phải ở lại máy này (127.0.0.1) — ghi lại và chặn mọi thứ khác
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
const CLIP_ALONE = { VISION_ENGINE: 'clip', VISION_ALLOW_CLIP_ONLY: 'true' }; // chỉ để kiểm cơ chế của CLIP; production không dùng được
beforeEach(async () => {
  setEnv(CLIP_ALONE);
  outboundCalls.length = 0;
  await RateLimit.deleteMany({});
  // Server nhận ra ảnh trùng theo điểm ảnh: mỗi test bắt đầu như chưa có ảnh nào được thưởng
  await Promise.all([CheckIn.deleteMany({}), RewardedImage.deleteMany({})]);
});

describe('CLIP thật, chạy ngoại tuyến trong tiến trình server', { skip: SKIP_WITHOUT_MODEL }, () => {
  test('trạng thái: local / clip; chỉ nhận JPEG, PNG, WebP', async () => {
    const status = (await client().get('/api/checkin/status')).data;
    assert.deepEqual([status.mode, status.engine], ['local', 'clip']);
    assert.deepEqual(status.acceptedTypes, ['image/jpeg', 'image/png', 'image/webp']);
  });

  test('ly nhựa có ống hút → nhận ra ly nhựa dùng một lần, không thưởng; không request nào rời máy chủ', async () => {
    const c = await loggedIn();
    const res = await checkIn(c, fixture('plastic-cup-drawing.jpg'));
    assert.equal(res.status, 422);
    assert.equal(res.data.code, 'container_not_accepted');
    assert.equal(res.data.classification.category, 'single_use_plastic_cup');
    assert.match(res.data.classification.reason, /^Nhận diện tại máy chủ \(CLIP\)/);
    assert.deepEqual(outboundCalls, []);
  });

  test('nền trơn → không thưởng', async () => {
    const res = await checkIn(await loggedIn(), fixture('plain.jpg'));
    assert.equal(res.status, 422);
    assert.notEqual(res.data.classification.accepted, true);
  });

  test('bình vẽ: nhận ra bình cá nhân nhưng dưới ngưỡng 0.8 → không thưởng; ngưỡng 0.7 → thưởng, ghi nhận "local"', async () => {
    const c = await loggedIn();
    const image = fixture('bottle-drawing.jpg');
    const low = await checkIn(c, image);
    assert.equal(low.status, 422);
    assert.equal(low.data.classification.category, 'reusable_bottle');
    assert.ok(low.data.classification.confidence < 0.8);

    setEnv({ ...CLIP_ALONE, VISION_CONFIDENCE_THRESHOLD: '0.7' });
    const ok = await checkIn(c, image);
    assert.equal(ok.status, 200);
    assert.equal((await CheckIn.findById(ok.data.checkInId).lean()).verification, 'local');
  });

  test('sau lần nạp đầu, mỗi ảnh nhận diện dưới 2 giây trên CPU', async () => {
    const c = await loggedIn();
    const started = performance.now();
    await checkIn(c, fixture('plain.jpg'));
    const ms = performance.now() - started;
    assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
  });

  test('nhiều ảnh cùng lúc vượt VISION_MAX_QUEUE → 503 "máy chủ đang bận", không thưởng; ảnh đang chấm vẫn có kết quả', async () => {
    setEnv({ ...CLIP_ALONE, VISION_MAX_QUEUE: '1' });
    const c = await loggedIn();
    // 5 ảnh khác mã băm gửi cùng lúc; mỗi ảnh mất ~150 ms nên các ảnh sau đến khi ảnh đầu còn đang được chấm
    const base = fixture('plain.jpg');
    const original = console.error;
    console.error = () => {};
    let results;
    try {
      results = await Promise.all([1, 2, 3, 4, 5].map((i) => checkIn(c, Buffer.concat([base, Buffer.from(`hang-doi-${i}`)]))));
    } finally {
      console.error = original;
    }
    const statuses = results.map((r) => r.status);
    const busy = results.filter((r) => r.status === 503);
    assert.ok(busy.length >= 1, `không có yêu cầu nào bị từ chối vì bận: ${statuses}`);
    for (const r of busy) {
      assert.equal(r.data.code, 'vision_busy');
      assert.match(r.data.error, /đang bận/);
    }
    assert.ok(statuses.includes(422), `ảnh đầu tiên vẫn phải được chấm: ${statuses}`);
    assert.ok(statuses.every((s) => s === 422 || s === 503), String(statuses));
  });

  test('F-28: ảnh "bom giải nén" (PNG một màu 12000×12000, tệp ~440 KB) bị từ chối 400 trước khi giải mã toàn bộ; ảnh lớn hợp lệ vẫn được thu nhỏ và chấm', async () => {
    const c = await loggedIn();
    const solid = (side) =>
      sharp({ create: { width: side, height: side, channels: 3, background: { r: 200, g: 220, b: 240 } } }).png({ compressionLevel: 9 }).toBuffer();
    const bomb = await solid(12000);
    assert.ok(bomb.length < 1024 * 1024, `tệp ${bomb.length} byte — lọt qua giới hạn 8 MB`);
    const original = console.error;
    console.error = () => {};
    let res;
    try {
      res = await checkIn(c, bomb, { name: 'bom.png', type: 'image/png' });
    } finally {
      console.error = original;
    }
    assert.equal(res.status, 400, `144 MP phải bị từ chối, nhận ${res.status}`);
    assert.equal(res.data.code, 'vision_invalid_image');

    const large = await solid(6000); // 36 MP: lớn nhưng hợp lệ (ảnh điện thoại 12–50 MP)
    const ok = await checkIn(c, large, { name: 'lon.png', type: 'image/png' });
    assert.equal(ok.status, 422);
    assert.equal(ok.data.classification.status, 'classified');
  });

  test('F-26: ly nhựa dán nhãn "THERMOS" không được thưởng khi chỉ dùng CLIP', async () => {
    setEnv({ VISION_ENGINE: 'clip' });
    const c = await loggedIn();
    const res = await checkIn(c, fixture('plastic-cup-thermos-label.jpg'));
    assert.notEqual(res.status, 200, `CLIP: ${res.data.classification?.category} ${res.data.classification?.confidence}`);
    const { user } = (await c.get('/api/auth/me')).data;
    assert.deepEqual([user.ecoPoints, user.pendingGachaSpins, user.totalCheckIns], [0, 0, 0]);
    assert.equal(await CheckIn.countDocuments({ userId: user.id, valid: true }), 0);

    // Chặn bằng cấu hình chứ không phải vì CLIP đã hết bị lừa: chính ảnh này vẫn đánh lừa được CLIP
    setEnv(CLIP_ALONE);
    const clip = await classifyWithClip({ buffer: fixture('plastic-cup-thermos-label.jpg'), mimeType: 'image/jpeg' }, visionConfig());
    assert.equal(clip.category, 'reusable_bottle');
    assert.ok(clip.confidence >= 0.8, String(clip.confidence));
    assert.equal(await User.countDocuments({ _id: user.id, ecoPoints: { $gt: 0 } }), 0);
  });

  test('chế độ kết hợp chặn tấn công bằng chữ khi VLM nhận ra ly nhựa (hai bộ không thống nhất → không thưởng)', async () => {
    setEnv({ VISION_ENGINE: 'ensemble', VISION_OLLAMA_URL: ollama.url });
    ollama.reply = { category: 'single_use_plastic_cup', confidence: 0.95, reason: 'Ly nhựa có ống hút, dán nhãn giấy' };
    // Cùng điểm ảnh nhưng khác mã băm (byte thừa sau marker kết thúc JPEG) — ảnh gốc có thể đã được thưởng ở test F-26
    const image = Buffer.concat([fixture('plastic-cup-thermos-label.jpg'), Buffer.from('ensemble')]);
    const res = await checkIn(await loggedIn(), image);
    assert.equal(res.status, 422);
    assert.match(res.data.reason, /chưa thống nhất/);
    const engines = Object.fromEntries(res.data.classification.engines.map((e) => [e.engine, e.category]));
    assert.deepEqual(engines, { clip: 'reusable_bottle', ollama: 'single_use_plastic_cup' });
    assert.deepEqual(outboundCalls, []);
  });
});

describe('VLM thật trên Ollama của máy chủ', { skip: SKIP_WITHOUT_VLM }, () => {
  // Mỗi ảnh thêm vài byte sau marker kết thúc JPEG để có mã băm riêng (ảnh gốc có thể đã được thưởng ở test khác)
  const fresh = (name, tag) => Buffer.concat([fixture(name), Buffer.from(`vlm-${tag}`)]);
  const timed = async (c, buffer) => {
    const started = performance.now();
    const res = await checkIn(c, buffer);
    return { res, ms: Math.round(performance.now() - started) };
  };
  const describeResult = ({ res, ms }) => {
    const k = res.data.classification || {};
    const engines = (k.engines || []).map((e) => `${e.engine}=${e.category}@${e.confidence}`).join(' ');
    return `HTTP ${res.status} ${k.status} ${k.category}@${k.confidence} ${engines} (${ms} ms) — ${k.reason || res.data.error}`;
  };

  test('chỉ VLM: ly nhựa có ống hút → không thưởng; phản hồi đúng schema; ảnh chỉ tới Ollama trong máy', async (t) => {
    setEnv({ VISION_ENGINE: 'ollama', ...REAL_VLM_ENV });
    const result = await timed(await loggedIn(), fresh('plastic-cup-drawing.jpg', 'cup'));
    t.diagnostic(describeResult(result));
    assert.equal(result.res.data.classification.status, 'classified', describeResult(result));
    assert.equal(result.res.status, 422);
    assert.deepEqual(outboundCalls, []);
  });

  test('chỉ VLM: nền trơn → không thưởng', async (t) => {
    setEnv({ VISION_ENGINE: 'ollama', ...REAL_VLM_ENV });
    const result = await timed(await loggedIn(), fresh('plain.jpg', 'plain'));
    t.diagnostic(describeResult(result));
    assert.equal(result.res.data.classification.status, 'classified', describeResult(result));
    assert.equal(result.res.status, 422);
  });

  test('chỉ VLM: bình (hình vẽ) → phản hồi hợp lệ; ghi nhận loại và độ tin cậy', async (t) => {
    setEnv({ VISION_ENGINE: 'ollama', ...REAL_VLM_ENV });
    const result = await timed(await loggedIn(), fresh('bottle-drawing.jpg', 'bottle'));
    t.diagnostic(describeResult(result));
    assert.equal(result.res.data.classification.status, 'classified', describeResult(result));
    assert.ok([200, 422].includes(result.res.status));
  });

  test('chỉ VLM: ly nhựa dán nhãn "THERMOS" → không thưởng (VLM không bị chữ đánh lừa)', async (t) => {
    setEnv({ VISION_ENGINE: 'ollama', ...REAL_VLM_ENV });
    const result = await timed(await loggedIn(), fresh('plastic-cup-thermos-label.jpg', 'thermos-vlm'));
    t.diagnostic(describeResult(result));
    assert.equal(result.res.data.classification.status, 'classified', describeResult(result));
    assert.equal(result.res.status, 422, describeResult(result));
  });

  test('kết hợp CLIP + VLM thật: ảnh "THERMOS" không được thưởng — F-26 bị chặn', { skip: SKIP_WITHOUT_MODEL }, async (t) => {
    setEnv({ VISION_ENGINE: 'ensemble', ...REAL_VLM_ENV });
    const result = await timed(await loggedIn(), fresh('plastic-cup-thermos-label.jpg', 'thermos-ensemble'));
    t.diagnostic(describeResult(result));
    assert.equal(result.res.status, 422, describeResult(result));
    assert.deepEqual(outboundCalls, []);
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

  test('VLM đặt ngoài mạng nội bộ → check-in tắt, ảnh không được gửi đi', async () => {
    setEnv({ VISION_ENGINE: 'ollama', VISION_OLLAMA_URL: 'https://vlm.example.com' });
    assert.equal((await client().get('/api/checkin/status')).data.mode, 'unavailable');
    const res = await checkIn(await loggedIn(), fixture('plain.jpg'));
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'vision_not_configured');
    assert.deepEqual(outboundCalls, []);
  });

  test('F-31: mô hình cloud của Ollama (ảnh sẽ bị chuyển lên ollama.com) → check-in tắt, Ollama không nhận được ảnh', async () => {
    setEnv({ VISION_ENGINE: 'ollama', VISION_OLLAMA_URL: ollama.url, VISION_OLLAMA_MODEL: 'qwen3-vl:235b-cloud' });
    const before = ollama.requests.length;
    assert.equal((await client().get('/api/checkin/status')).data.mode, 'unavailable');
    const res = await checkIn(await loggedIn(), fixture('plain.jpg'));
    assert.equal(res.status, 503);
    assert.equal(res.data.code, 'vision_not_configured');
    assert.equal(ollama.requests.length, before, 'không có ảnh nào được gửi tới Ollama');
    assert.deepEqual(outboundCalls, []);
  });

  for (const status of [301, 302, 303, 307, 308]) {
    test(`F-53: máy Ollama trả chuyển hướng ${status} → không đi theo, ảnh không tới máy khác, không thưởng`, async () => {
      // "Máy ngoài" nằm trên 127.0.0.1 để test không rời khỏi máy; chỉ cần biết nó có nhận được request nào không
      const received = [];
      const outside = http.createServer((req, res) => {
        received.push(req.method);
        req.resume();
        res.end('{}');
      });
      await new Promise((resolve) => outside.listen(0, '127.0.0.1', resolve));
      const c = await loggedIn();
      setEnv({ VISION_ENGINE: 'ollama', VISION_OLLAMA_URL: ollama.url });
      ollama.reply = { status, headers: { Location: `http://127.0.0.1:${outside.address().port}/api/chat` }, json: {} };
      const original = console.error;
      console.error = () => {};
      try {
        const res = await checkIn(c, fixture('plain.jpg'));
        assert.equal(res.status, 502);
        assert.equal(res.data.code, 'vision_provider_error');
      } finally {
        console.error = original;
        Object.assign(ollama, { reply: { category: 'reusable_bottle', confidence: 0.95, reason: 'Bình giữ nhiệt inox' } });
        await new Promise((resolve) => outside.close(resolve));
      }
      assert.deepEqual(received, [], 'ảnh không được gửi theo chuyển hướng');
      assert.equal((await c.get('/api/auth/me')).data.user.ecoPoints, 0);
    });
  }

  test('F-54: nhiều ảnh cùng lúc vượt VISION_MAX_QUEUE → Ollama chỉ nhận đúng số ảnh của hàng đợi, phần còn lại 503 bận', async () => {
    const accounts = await Promise.all(Array.from({ length: 6 }, loggedIn));
    setEnv({ VISION_ENGINE: 'ollama', VISION_OLLAMA_URL: ollama.url, VISION_MAX_QUEUE: '2' });
    Object.assign(ollama, { reply: { category: 'other_container', confidence: 0.9, reason: 'Vật chứa khác' }, delayMs: 300 });
    const before = ollama.requests.length;
    try {
      const results = await Promise.all(accounts.map((c) => checkIn(c, fixture('plain.jpg'))));
      const statuses = results.map((res) => res.status).sort();
      assert.deepEqual(statuses, [422, 422, 503, 503, 503, 503]);
      for (const res of results.filter((r) => r.status === 503)) {
        assert.equal(res.data.code, 'vision_busy');
        assert.equal(res.data.classification.accepted, false);
      }
      assert.equal(ollama.requests.length - before, 2);
    } finally {
      Object.assign(ollama, { reply: { category: 'reusable_bottle', confidence: 0.95, reason: 'Bình giữ nhiệt inox' }, delayMs: 0 });
    }
    // Hàng đợi được trả lại sau khi xử lý xong, kể cả khi yêu cầu trước đó lỗi
    assert.notEqual((await checkIn(accounts[0], fixture('plain.jpg'))).status, 503);
  });

  test('thư mục mô hình trống → 503, server không tự tải mô hình từ Internet', async () => {
    setEnv({ ...CLIP_ALONE, VISION_MODEL_DIR: 'test/.khong-co-mo-hinh' });
    const original = console.error;
    console.error = () => {};
    try {
      const res = await checkIn(await loggedIn(), fixture('plain.jpg'));
      assert.equal(res.status, 503);
      assert.equal(res.data.code, 'vision_not_configured');
    } finally {
      console.error = original;
    }
    assert.deepEqual(outboundCalls, []);
  });
});
