// Module trọng tâm (mục 1.1.1): services/vision.js + visionClassifier.js — nhận diện ảnh TẠI MÁY CHỦ bằng bộ phân loại
// ONNX trong tiến trình (engine 'classifier', chỉ CPU) và quyết định cộng thưởng. Kỹ thuật: bảng quyết định cấu hình,
// phân vùng tương đương + giá trị biên (độ tin cậy, ngưỡng), softmax + ánh xạ lớp → loại nghiệp vụ, tiền xử lý đúng manifest,
// lần nhìn thứ hai (F-26), kiểm thử lỗi phụ thuộc (bộ phân loại giả lập — không cần mô hình thật).
// Các test nạp session thật được bỏ qua khi chưa có tệp mô hình (chạy `npm run vision:download`).
import { after, afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {
  aggregateMappedClasses,
  classifyWithClassifier,
  loadClassifier,
  preprocessImage,
  rankedDeviation,
  softmax,
  suppressText,
} from '../../src/services/visionClassifier.js';
import {
  CATEGORIES,
  REWARDABLE_CATEGORIES,
  VisionEngineError,
  classifyContainerImage,
  isRewardable,
  logVisionStatus,
  visionConfig,
  warmUpVision,
} from '../../src/services/vision.js';
import { CLASSIFIER_MANIFEST, DEFAULT_CLASSIFIER_MODEL, modelDir, modelFilePath, verifyModelFiles } from '../../src/services/visionModels.js';
import { setEnv, uniquePng } from '../helpers.js';

const IMAGE = { buffer: uniquePng(), mimeType: 'image/png' };
const LOCAL = (engine = 'classifier', patch = {}) => ({
  mode: 'local',
  engine,
  problem: null,
  threshold: 0.8,
  timeoutMs: 5000,
  maxQueue: 5,
  classifier: { model: DEFAULT_CLASSIFIER_MODEL, dir: 'models', threads: 1 },
  ...patch,
});
const raw = (category, confidence, extra = {}) => ({ category, confidence, reason: 'Mô tả ngắn', model: 'test', ...extra });
const engineFailing = (status, detail = 'lỗi giả lập') => async () => {
  throw new VisionEngineError(status, detail);
};

function captureConsole(methods = ['log', 'warn', 'error']) {
  const lines = [];
  const originals = methods.map((m) => [m, console[m]]);
  for (const m of methods) console[m] = (...args) => lines.push(`${m}: ${args.join(' ')}`);
  return { lines, restore: () => originals.forEach(([m, fn]) => (console[m] = fn)) };
}
const modelReady = (await verifyModelFiles(DEFAULT_CLASSIFIER_MODEL)).length === 0;
const SKIP_WITHOUT_MODEL = modelReady ? false : `chưa có mô hình ${DEFAULT_CLASSIFIER_MODEL} — npm run vision:download ${DEFAULT_CLASSIFIER_MODEL}`;

beforeEach(() => setEnv());
after(() => setEnv());

describe('softmax', () => {
  test('tổng xác suất = 1, giữ thứ tự logits', () => {
    const p = softmax([1, 2, 3]);
    const total = [...p].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-6);
    assert.ok(p[2] > p[1] && p[1] > p[0]);
  });

  test('ổn định số học với logits lớn (không tràn số)', () => {
    const p = softmax([1000, 1001, 1002]);
    const total = [...p].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - 1) < 1e-6);
    assert.ok(p[2] > 0.5);
  });
});

describe('aggregateMappedClasses — ánh xạ lớp ImageNet sang loại nghiệp vụ', () => {
  const MAPPING = CLASSIFIER_MANIFEST[DEFAULT_CLASSIFIER_MODEL].classMapping;

  test('cộng xác suất theo ánh xạ; residual thành unclear', () => {
    const p = new Float32Array(1000);
    p[898] = 0.3; // reusable_bottle
    p[504] = 0.2; // reusable_cup
    p[737] = 0.1; // other_container (pop bottle)
    p[0] = 0.4; // không ánh xạ
    const ranked = aggregateMappedClasses(p, MAPPING);
    const byCategory = Object.fromEntries(ranked.map((r) => [r.category, r.probability]));
    assert.equal(byCategory.reusable_bottle, 0.3);
    assert.equal(byCategory.reusable_cup, 0.2);
    assert.equal(byCategory.other_container, 0.1);
    assert.equal(byCategory.single_use_plastic_cup, 0, 'ImageNet không có lớp ly nhựa dùng một lần');
    assert.equal(byCategory.no_container, 0);
    assert.ok(Math.abs(byCategory.unclear - 0.4) < 0.001);
    assert.equal(ranked[0].category, 'unclear', 'residual 0.4 > điểm loại cao nhất 0.3 → ngoài phạm vi');
    const total = ranked.reduce((a, r) => a + r.probability, 0);
    assert.ok(Math.abs(total - 1) < 0.001, `tổng phải ≈ 1, nhận ${total}`);
  });

  test('loại ánh xạ chiếm ưu thế khi residual thấp hơn', () => {
    const p = new Float32Array(1000);
    p[898] = 0.5;
    p[0] = 0.2;
    p[1] = 0.05;
    p[2] = 0.05;
    p[3] = 0.05;
    p[4] = 0.05;
    const ranked = aggregateMappedClasses(p, MAPPING);
    assert.equal(ranked[0].category, 'reusable_bottle');
    assert.equal(ranked[0].probability, 0.5);
  });

  test('sắp giảm dần và đủ 6 loại', () => {
    const p = new Float32Array(1000);
    p[504] = 0.6;
    const ranked = aggregateMappedClasses(p, MAPPING);
    assert.deepEqual(ranked.map((r) => r.category).sort(), [...CATEGORIES].sort());
    for (let i = 1; i < ranked.length; i += 1) assert.ok(ranked[i - 1].probability >= ranked[i].probability);
  });

  test('chỉ số ngoài [0, 1000) bị bỏ qua, không ném lỗi', () => {
    const p = new Float32Array(1000);
    p[898] = 0.7;
    const mapping = { reusable_bottle: [898, 12345, -1], unclear: 'residual' };
    const ranked = aggregateMappedClasses(p, mapping);
    assert.equal(ranked[0].category, 'reusable_bottle');
  });
});

describe('preprocessImage — tiền xử lý đúng theo manifest', () => {
  const input = CLASSIFIER_MANIFEST[DEFAULT_CLASSIFIER_MODEL].input;

  test('ảnh đỏ đơn sắc → NCHW chuẩn hóa đúng mean/std', async () => {
    const buffer = await sharp({ create: { width: 300, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
    const tensor = await preprocessImage(buffer, input);
    assert.equal(tensor.length, 3 * input.crop * input.crop);
    const pixels = input.crop * input.crop;
    const expected = [(255 / 255 - input.mean[0]) / input.std[0], (0 / 255 - input.mean[1]) / input.std[1], (0 / 255 - input.mean[2]) / input.std[2]];
    // ảnh đơn sắc nên mọi điểm ảnh giống nhau sau resize/crop
    for (const i of [0, pixels - 1]) {
      for (const c of [0, 1, 2]) {
        assert.ok(Math.abs(tensor[c * pixels + i] - expected[c]) < 1e-4, `kênh ${c}[${i}]=${tensor[c * pixels + i]}, kỳ vọng ${expected[c]}`);
      }
    }
  });

  test('ảnh PNG trong suốt được phủ nền trắng', async () => {
    const buffer = await sharp({ create: { width: 256, height: 256, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 0 } } })
      .png()
      .toBuffer();
    const tensor = await preprocessImage(buffer, input);
    const pixels = input.crop * input.crop;
    // alpha 0 → trắng: kênh k ≈ (1 - mean[k])/std[k]
    for (const c of [0, 1, 2]) {
      const expectedWhite = (1 - input.mean[c]) / input.std[c];
      assert.ok(Math.abs(tensor[c * pixels] - expectedWhite) < 1e-4, `kênh ${c}=`);
    }
  });

  test('tệp rác → invalid_image', async () => {
    await assert.rejects(preprocessImage(Buffer.from('khong-phai-anh'), input), VisionEngineError);
  });
});

describe('loadClassifier — nạp session một lần, chỉ đọc tệp đã kiểm mã băm', () => {
  test('mô hình lạ → not_configured', async () => {
    await assert.rejects(
      loadClassifier(LOCAL('classifier', { classifier: { model: 'nguoi-la/mo-hinh', dir: 'models', threads: 1 } })),
      (err) => err instanceof VisionEngineError && err.status === 'not_configured'
    );
  });

  test('thiếu tệp mô hình → not_configured, hướng dẫn vision:download', async () => {
    await assert.rejects(
      loadClassifier(LOCAL('classifier', { classifier: { model: DEFAULT_CLASSIFIER_MODEL, dir: 'test/.khong-co-mo-hinh', threads: 1 } })),
      (err) => err instanceof VisionEngineError && err.status === 'not_configured' && /vision:download/.test(err.message)
    );
  });

  test('session thật: đầu vào đúng manifest, nạp lại dùng cùng session', { skip: SKIP_WITHOUT_MODEL }, async () => {
    const cfg = LOCAL();
    const loaded = await loadClassifier(cfg);
    assert.deepEqual(loaded.session.inputMetadata[0].shape, CLASSIFIER_MANIFEST[DEFAULT_CLASSIFIER_MODEL].input.shape);
    const again = await loadClassifier(cfg);
    assert.equal(again, loaded, 'session được dùng lại, không nạp đè');
  });
});

describe('visionConfig — bảng quyết định chế độ nhận diện (chỉ còn bộ phân loại ONNX trên CPU)', () => {
  const table = [
    // [biến môi trường] → [mode, engine, problem]
    [{}, 'local', 'classifier', null],
    [{ VISION_ENGINE: 'classifier' }, 'local', 'classifier', null],
    [{ VISION_ENGINE: 'CLASSIFIER' }, 'local', 'classifier', null],
    [{ VISION_ENGINE: 'classifier', NODE_ENV: 'production' }, 'local', 'classifier', null],
    [{ VISION_ENGINE: 'off' }, 'unavailable', null, 'disabled'],
    // Bộ nhận diện cũ đã gỡ: cấu hình còn sót tắt check-in, không tự chuyển sang classifier
    [{ VISION_ENGINE: 'ensemble' }, 'unavailable', null, 'removed_engine'],
    [{ VISION_ENGINE: 'clip' }, 'unavailable', null, 'removed_engine'],
    [{ VISION_ENGINE: 'Ollama' }, 'unavailable', null, 'removed_engine'],
    [{ VISION_ENGINE: 'ensemble', NODE_ENV: 'production' }, 'unavailable', null, 'removed_engine'],
    [{ VISION_ENGINE: 'gemini' }, 'unavailable', null, 'invalid_engine'],
    [{ VISION_CLASSIFIER_MODEL: 'nguoi-la/mo-hinh-la' }, 'unavailable', 'classifier', 'unknown_classifier_model'],
    [{ VISION_SIMULATION: 'true' }, 'simulated', 'classifier', null],
    [{ VISION_SIMULATION: 'true', NODE_ENV: 'production' }, 'local', 'classifier', null],
  ];
  for (const [vars, mode, engine, problem] of table) {
    test(`${JSON.stringify(vars)} → ${mode}${problem ? ` (${problem})` : ''}`, () => {
      setEnv(vars);
      const cfg = visionConfig();
      assert.equal(cfg.mode, mode);
      assert.equal(cfg.engine, engine);
      assert.equal(cfg.problem, problem);
    });
  }

  test('mô phỏng bị chặn khi production được ghi nhận', () => {
    setEnv({ VISION_SIMULATION: 'true', NODE_ENV: 'production' });
    assert.equal(visionConfig().simulationBlocked, true);
  });

  test('giá trị biên: ngưỡng [0.5, 1], thời gian chờ [3s, 120s], hàng đợi [1, 500]; mặc định mô hình và thư mục', () => {
    for (const [raw, expected] of [[undefined, 0.8], ['abc', 0.8], ['0.49', 0.5], ['0.5', 0.5], ['1', 1], ['1.01', 1]]) {
      setEnv(raw === undefined ? {} : { VISION_CONFIDENCE_THRESHOLD: raw });
      assert.equal(visionConfig().threshold, expected, `ngưỡng ${raw}`);
    }
    for (const [raw, expected] of [[undefined, 20000], ['2999', 3000], ['120001', 120000]]) {
      setEnv(raw === undefined ? {} : { VISION_TIMEOUT_MS: raw });
      assert.equal(visionConfig().timeoutMs, expected, `timeout ${raw}`);
    }
    for (const [raw, expected] of [[undefined, 20], ['0', 1], ['501', 500]]) {
      setEnv(raw === undefined ? {} : { VISION_MAX_QUEUE: raw });
      assert.equal(visionConfig().maxQueue, expected, `queue ${raw}`);
    }
    setEnv();
    const cfg = visionConfig();
    assert.equal(cfg.classifier.model, DEFAULT_CLASSIFIER_MODEL);
    assert.match(cfg.classifier.dir, /[\\/]server[\\/]models$/);
    assert.equal(cfg.clip, undefined, 'không còn cấu hình CLIP');
    assert.equal(cfg.ollama, undefined, 'không còn cấu hình Ollama');
  });

  test('được phép cả khi phát triển lẫn production', () => {
    setEnv({ VISION_ENGINE: 'classifier' });
    assert.deepEqual([visionConfig().mode, visionConfig().engine, visionConfig().problem], ['local', 'classifier', null]);
    setEnv({ VISION_ENGINE: 'classifier', NODE_ENV: 'production' });
    assert.deepEqual([visionConfig().mode, visionConfig().engine, visionConfig().problem], ['local', 'classifier', null]);
  });

  test('mô hình ngoài manifest → unavailable, unknown_classifier_model', () => {
    setEnv({ VISION_ENGINE: 'classifier', VISION_CLASSIFIER_MODEL: 'nguoi-la/x' });
    const cfg = visionConfig();
    assert.deepEqual([cfg.mode, cfg.problem], ['unavailable', 'unknown_classifier_model']);
  });

  test('số luồng CPU đọc từ môi trường, kẹp trong [1, 8]', () => {
    setEnv({ VISION_ENGINE: 'classifier', VISION_CLASSIFIER_THREADS: '4' });
    assert.equal(visionConfig().classifier.threads, 4);
    setEnv({ VISION_ENGINE: 'classifier', VISION_CLASSIFIER_THREADS: '99' });
    assert.equal(visionConfig().classifier.threads, 8);
    setEnv({ VISION_ENGINE: 'classifier' });
    assert.ok(visionConfig().classifier.threads >= 1);
  });
});

describe('isRewardable — chỉ bình/ly cá nhân đạt ngưỡng', () => {
  test('giá trị biên quanh ngưỡng 0.8 và 1', () => {
    const base = { status: 'classified', category: 'reusable_bottle' };
    assert.equal(isRewardable({ ...base, confidence: 0.799 }, 0.8), false);
    assert.equal(isRewardable({ ...base, confidence: 0.8 }, 0.8), true);
    assert.equal(isRewardable({ ...base, confidence: 0.801 }, 0.8), true);
    assert.equal(isRewardable({ ...base, confidence: 0.999 }, 1), false);
  });

  test('phân vùng loại và trạng thái', () => {
    assert.deepEqual([...REWARDABLE_CATEGORIES].sort(), ['reusable_bottle', 'reusable_cup']);
    for (const category of CATEGORIES) {
      assert.equal(isRewardable({ status: 'classified', category, confidence: 1 }, 0.8), REWARDABLE_CATEGORIES.has(category), category);
    }
    for (const status of ['not_configured', 'provider_error', 'timeout', 'busy', 'invalid_image', undefined]) {
      assert.equal(isRewardable({ status, category: 'reusable_cup', confidence: 1 }, 0.8), false, String(status));
    }
    assert.equal(isRewardable({ status: 'simulated', category: 'reusable_cup', confidence: 0.9 }, 0.8), true);
  });
});

describe('classifyContainerImage — điều phối, mô phỏng và lỗi bộ nhận diện', () => {
  let consoleCapture;
  beforeEach(() => {
    consoleCapture = captureConsole(['error']);
  });
  afterEach(() => consoleCapture.restore());

  test('chế độ unavailable: không gọi bộ nhận diện', async () => {
    const result = await classifyContainerImage(IMAGE, { ...LOCAL(), mode: 'unavailable' }, { classifier: () => assert.fail('không được gọi') });
    assert.equal(result.status, 'not_configured');
    assert.equal(result.accepted, false);
  });

  test('không truyền cấu hình → đọc môi trường (VISION_ENGINE=off → not_configured; tên engine cũ → not_configured)', async () => {
    setEnv({ VISION_ENGINE: 'off' });
    assert.equal((await classifyContainerImage(IMAGE)).status, 'not_configured');
    setEnv({ VISION_ENGINE: 'ensemble' });
    assert.equal((await classifyContainerImage(IMAGE)).status, 'not_configured');
  });

  test('chế độ mô phỏng: kết quả cố định, nhãn MÔ PHỎNG, không gọi bộ nhận diện', async () => {
    setEnv({ VISION_SIMULATED_CATEGORY: 'thermos', VISION_SIMULATED_CONFIDENCE: '5' });
    const result = await classifyContainerImage(IMAGE, { ...LOCAL(), mode: 'simulated' }, { classifier: () => assert.fail() });
    assert.equal(result.status, 'simulated');
    assert.equal(result.category, 'reusable_bottle');
    assert.equal(result.confidence, 1);
    assert.match(result.reason, /MÔ PHỎNG/);
    setEnv({ VISION_SIMULATED_CATEGORY: 'single_use_plastic_cup' });
    assert.equal((await classifyContainerImage(IMAGE, { ...LOCAL(), mode: 'simulated' })).accepted, false);
  });

  for (const status of ['not_configured', 'busy', 'timeout', 'invalid_image', 'invalid_response', 'provider_error']) {
    test(`lỗi bộ nhận diện "${status}" → không thưởng, lý do tiếng Việt`, async () => {
      const result = await classifyContainerImage(IMAGE, LOCAL(), { classifier: engineFailing(status) });
      assert.equal(result.status, status);
      assert.equal(result.accepted, false);
      assert.equal(result.category, null);
      assert.ok(/[ạ-ỹ]/.test(result.reason));
      assert.equal(result.model, `classifier:${DEFAULT_CLASSIFIER_MODEL}`);
    });
  }

  test('VisionEngineError có trạng thái lạ → provider_error', async () => {
    const result = await classifyContainerImage(IMAGE, LOCAL(), { classifier: engineFailing('trang_thai_la') });
    assert.equal(result.status, 'provider_error');
    assert.equal(result.accepted, false);
  });

  test('lỗi bất ngờ (không phải VisionEngineError) → provider_error; log không lộ dữ liệu ảnh', async () => {
    const result = await classifyContainerImage(IMAGE, LOCAL(), { classifier: async () => { throw new Error('onnxruntime crashed'); } });
    assert.equal(result.status, 'provider_error');
    assert.ok(consoleCapture.lines.length > 0);
    assert.ok(consoleCapture.lines.every((l) => !l.includes(IMAGE.buffer.toString('base64'))));
  });
});

describe('classifyContainerImage với engine classifier — quyết định và lần nhìn thứ hai (F-26)', () => {
  const blur = async () => {
    throw new Error('không được làm mờ nếu chưa đạt ngưỡng');
  };

  test('đúng loại + đạt ngưỡng → qua lần nhìn thứ hai; ảnh mờ vẫn cùng loại, đạt ngưỡng → được thưởng', async () => {
    const calls = [];
    const engines = {
      classifier: async (image) => {
        calls.push(image.buffer.length);
        return raw('reusable_bottle', 0.9);
      },
    };
    const result = await classifyContainerImage(IMAGE, LOCAL(), engines, async () => Buffer.from('anh-lam-mo'));
    assert.equal(result.status, 'classified');
    assert.equal(result.accepted, true);
    assert.equal(result.model, 'test');
    assert.equal(calls.length, 2, 'lần nhìn thứ hai chạy trên ảnh đã làm mờ');
    assert.equal(calls[1], Buffer.from('anh-lam-mo').length);
    assert.deepEqual(result.secondLook, [{ engine: 'classifier', category: 'reusable_bottle', confidence: 0.9 }]);
  });

  test('ảnh mờ ra loại khác → textDependent, không thưởng', async () => {
    let call = 0;
    const engines = {
      classifier: async () => (call++ === 0 ? raw('reusable_bottle', 0.9) : raw('other_container', 0.95)),
    };
    const result = await classifyContainerImage(IMAGE, LOCAL(), engines, async () => Buffer.from('mo'));
    assert.equal(result.accepted, false);
    assert.equal(result.category, 'unclear');
    assert.equal(result.textDependent, true);
  });

  test('ảnh mờ dưới ngưỡng → textDependent, không thưởng', async () => {
    let call = 0;
    const engines = {
      classifier: async () => (call++ === 0 ? raw('reusable_bottle', 0.9) : raw('reusable_bottle', 0.5)),
    };
    const result = await classifyContainerImage(IMAGE, LOCAL(), engines, async () => Buffer.from('mo'));
    assert.equal(result.accepted, false);
    assert.equal(result.textDependent, true);
  });

  test('mô hình khai báo secondLookMinConfidence: ảnh mờ chỉ cần vẫn là loại được thưởng ở mức đó; đổi sang loại khác vẫn bị chặn', async () => {
    const cfg = LOCAL('classifier', { threshold: 0.95, secondLookMinConfidence: 0.5 });
    let call = 0;
    const kept = { classifier: async () => (call++ === 0 ? raw('reusable_bottle', 0.97) : raw('reusable_cup', 0.55)) };
    const accepted = await classifyContainerImage(IMAGE, cfg, kept, async () => Buffer.from('mo'));
    assert.deepEqual([accepted.accepted, accepted.textDependent], [true, undefined]);
    assert.deepEqual(accepted.secondLook, [{ engine: 'classifier', category: 'reusable_cup', confidence: 0.55 }]);

    let again = 0;
    const flips = { classifier: async () => (again++ === 0 ? raw('reusable_bottle', 0.97) : raw('other_container', 0.6)) };
    const flipped = await classifyContainerImage(IMAGE, cfg, flips, async () => Buffer.from('mo'));
    assert.deepEqual([flipped.accepted, flipped.textDependent, flipped.category], [false, true, 'unclear']);

    let weak = 0;
    const tooWeak = { classifier: async () => (weak++ === 0 ? raw('reusable_bottle', 0.97) : raw('reusable_bottle', 0.4)) };
    assert.equal((await classifyContainerImage(IMAGE, cfg, tooWeak, async () => Buffer.from('mo'))).accepted, false);
  });

  test('visionConfig lấy secondLookMinConfidence từ manifest của mô hình; mô hình không khai báo → lần hai phải đạt ngưỡng như lần đầu', () => {
    setEnv({});
    assert.equal(visionConfig().secondLookMinConfidence, null);
    setEnv({ VISION_CLASSIFIER_MODEL: 'greencanteen/bev9-dinov2-vitb-280-int8', VISION_CONFIDENCE_THRESHOLD: '0.95' });
    assert.equal(visionConfig().secondLookMinConfidence, CLASSIFIER_MANIFEST['greencanteen/bev9-dinov2-vitb-280-int8'].secondLook.minConfidence);
  });

  test('dưới ngưỡng → không thưởng và không làm mờ lại', async () => {
    const engines = { classifier: async () => raw('reusable_bottle', 0.7) };
    const result = await classifyContainerImage(IMAGE, LOCAL(), engines, blur);
    assert.equal(result.accepted, false);
  });

  test('engine lỗi → không thưởng, không tự hạ xuống chế độ khác', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      const busy = await classifyContainerImage(IMAGE, LOCAL(), { classifier: async () => { throw new VisionEngineError('busy', 'đầy'); } }, blur);
      assert.equal(busy.status, 'busy');
      const provider = await classifyContainerImage(IMAGE, LOCAL(), { classifier: async () => { throw new Error('lặt vặt'); } }, blur);
      assert.equal(provider.status, 'provider_error');
    } finally {
      console.error = original;
    }
  });

  test('bộ phân loại lỗi ở lần nhìn thứ hai → không thưởng, không coi như đạt', async () => {
    const capture = captureConsole(['error']);
    try {
      let call = 0;
      const engines = {
        classifier: async () => {
          if (call++ === 0) return raw('reusable_cup', 0.95);
          throw new VisionEngineError('timeout', 'quá giờ');
        },
      };
      const result = await classifyContainerImage(IMAGE, LOCAL(), engines, async () => Buffer.from('mo'));
      assert.equal(result.status, 'timeout');
      assert.equal(result.accepted, false);
    } finally {
      capture.restore();
    }
  });

  test('làm mờ lỗi → invalid_image, không thưởng', async () => {
    const capture = captureConsole(['error']);
    try {
      const result = await classifyContainerImage(IMAGE, LOCAL(), { classifier: async () => raw('reusable_bottle', 0.95) }, async () => {
        throw new Error('ảnh hỏng');
      });
      assert.equal(result.status, 'invalid_image');
      assert.equal(result.accepted, false);
    } finally {
      capture.restore();
    }
  });

  test('suppressText: ảnh JPEG đầu ra, không giữ chi tiết nhỏ, từ chối ảnh quá lớn và tệp hỏng', async () => {
    const stripes = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="448" height="448"><rect width="448" height="448" fill="#fff"/>${Array.from({ length: 56 }, (_, i) => `<rect x="${i * 8}" width="4" height="448" fill="#000"/>`).join('')}</svg>`)).png().toBuffer();
    const blurred = await suppressText(stripes);
    assert.equal((await sharp(blurred).metadata()).format, 'jpeg');
    const contrast = async (buffer) => {
      const { channels } = await sharp(buffer).greyscale().stats();
      return channels[0].stdev;
    };
    assert.ok((await contrast(blurred)) < (await contrast(stripes)) / 10, 'chi tiết cỡ nét chữ bị xóa');
    await assert.rejects(suppressText(Buffer.from('khong-phai-anh')));
    assert.equal((await sharp(await suppressText(uniquePng())).metadata()).width > 0, true, 'ảnh 1×1 không làm lỗi');
  });
});

describe('logVisionStatus — thông báo khi khởi động', () => {
  for (const [label, vars, pattern] of [
    ['mặc định là bộ phân loại ONNX trên CPU', {}, /^log: Nhận diện ảnh tại máy chủ: bộ phân loại ONNX \(onnxmodelzoo\/mobilenetv3_small_075_Opset17, 2 luồng CPU\), ngưỡng 0\.8 — ảnh không gửi ra ngoài\.$/],
    ['số luồng CPU', { VISION_CLASSIFIER_THREADS: '1' }, /bộ phân loại ONNX \(.*, 1 luồng CPU\)/],
    ['tắt', { VISION_ENGINE: 'off' }, /^log: VISION_ENGINE=off/],
    ['engine cũ đã gỡ', { VISION_ENGINE: 'ensemble' }, /^error: VISION_ENGINE="ensemble": CLIP, Ollama và chế độ kết hợp đã bị gỡ .*VISION_ENGINE=classifier/],
    ['bộ nhận diện lạ', { VISION_ENGINE: 'gemini' }, /^error: VISION_ENGINE="gemini" không hợp lệ \(chỉ nhận classifier, off\)/],
    ['mô hình không có trong manifest', { VISION_CLASSIFIER_MODEL: 'nguoi-la/x' }, /^error: VISION_CLASSIFIER_MODEL="nguoi-la\/x" không có trong danh sách mô hình đã ghim/],
    ['mô phỏng, loại mặc định', { VISION_SIMULATION: 'true' }, /^warn: .*MÔ PHỎNG \(reusable_bottle\)/],
    ['mô phỏng', { VISION_SIMULATION: 'true', VISION_SIMULATED_CATEGORY: 'no_container' }, /^warn: .*MÔ PHỎNG \(no_container\)/],
    ['mô phỏng bị chặn', { VISION_SIMULATION: 'true', NODE_ENV: 'production' }, /^error: VISION_SIMULATION=true bị BỎ QUA/],
    [
      'mô hình có ngưỡng đã hiệu chỉnh mà cấu hình thấp hơn → cảnh báo',
      { VISION_CLASSIFIER_MODEL: 'greencanteen/bev9-dinov2-vitb-280-int8', VISION_CONFIDENCE_THRESHOLD: '0.8' },
      /^warn: VISION_CONFIDENCE_THRESHOLD=0\.8 thấp hơn ngưỡng đã hiệu chỉnh cho greencanteen\/bev9-dinov2-vitb-280-int8 \(0\.95\)/,
    ],
  ]) {
    test(label, () => {
      setEnv(vars);
      const capture = captureConsole();
      try {
        logVisionStatus();
      } finally {
        capture.restore();
      }
      assert.ok(capture.lines.some((l) => pattern.test(l)), capture.lines.join('\n'));
    });
  }

  test('đúng ngưỡng đã hiệu chỉnh của mô hình → không cảnh báo', () => {
    setEnv({ VISION_CLASSIFIER_MODEL: 'greencanteen/bev9-dinov2-vitb-280-int8', VISION_CONFIDENCE_THRESHOLD: '0.95' });
    const capture = captureConsole();
    try {
      logVisionStatus();
    } finally {
      capture.restore();
    }
    assert.ok(capture.lines.every((l) => !l.startsWith('warn:')), capture.lines.join('\n'));
    assert.ok(capture.lines.some((l) => l.includes('ngưỡng 0.95')), capture.lines.join('\n'));
  });

  test('cấu hình lỗi không in dòng "sẵn sàng"', () => {
    setEnv({ VISION_ENGINE: 'clip' });
    const capture = captureConsole();
    try {
      logVisionStatus();
    } finally {
      capture.restore();
    }
    assert.ok(capture.lines.every((l) => !l.startsWith('log: Nhận diện ảnh tại máy chủ')), capture.lines.join('\n'));
  });
});

describe('classifyWithClassifier với mô hình thật', { skip: SKIP_WITHOUT_MODEL }, () => {
  test('kết quả hợp lệ: đúng schema, đủ ranked, độ tin cậy trong [0,1]', async () => {
    const result = await classifyWithClassifier(IMAGE, LOCAL());
    assert.equal(result.status, undefined); // engine thô — caller bọc status
    assert.ok(CATEGORIES.includes(result.category), result.category);
    assert.ok(result.confidence >= 0 && result.confidence <= 1, String(result.confidence));
    assert.deepEqual(result.ranked.map((r) => r.category).sort(), [...CATEGORIES].sort());
    assert.equal(result.model, `classifier:${DEFAULT_CLASSIFIER_MODEL}`);
    assert.match(result.reason, /^Nhận diện tại máy chủ \(bộ phân loại/);
  });

  test('ảnh nền trơn không được thưởng', async () => {
    const buffer = await sharp({ create: { width: 200, height: 200, channels: 3, background: { r: 210, g: 210, b: 210 } } })
      .jpeg()
      .toBuffer();
    const result = await classifyWithClassifier({ buffer, mimeType: 'image/jpeg' }, LOCAL());
    assert.ok(!['reusable_bottle', 'reusable_cup'].includes(result.category), `${result.category} @ ${result.confidence}`);
  });

  test('hàng đợi đầy (maxQueue = 1) → ảnh gửi thêm bị từ chối ngay (busy)', async () => {
    const cfg = { ...LOCAL(), maxQueue: 1 };
    const [first, second] = await Promise.allSettled([
      classifyWithClassifier(IMAGE, cfg),
      classifyWithClassifier(IMAGE, cfg),
    ]);
    assert.equal(first.status, 'fulfilled', 'ảnh đầu vẫn được chấm');
    assert.equal(second.status, 'rejected');
    assert.ok(second.reason instanceof VisionEngineError && second.reason.status === 'busy', String(second.reason));
  });

  // Tương đương lỗi "VLM trả sai schema" của bộ nhận diện cũ: đầu ra hỏng phải là lỗi engine (fail-closed), không phải kết quả phân loại
  test('đầu ra mô hình sai dạng (NaN, Infinity, thiếu lớp, thiếu tensor) → invalid_response, không thành kết quả phân loại', async () => {
    const { session } = await loadClassifier(LOCAL());
    const original = session.run.bind(session);
    const output = (data) => ({ [session.outputNames[0]]: { data, dims: [1, data.length], location: 'cpu', type: 'float32' } });
    const withLogit = (index, value, length = 1000) => {
      const logits = new Float32Array(length);
      logits[index] = value;
      return logits;
    };
    const cases = {
      'mọi logit là NaN': output(new Float32Array(1000).fill(Number.NaN)),
      'một logit NaN, lớp bình nước cao': (() => {
        const logits = withLogit(898, 20);
        logits[5] = Number.NaN;
        return output(logits);
      })(),
      '+Infinity ở lớp bình nước': output(withLogit(898, Number.POSITIVE_INFINITY)),
      '-Infinity ở một lớp': output(withLogit(3, Number.NEGATIVE_INFINITY)),
      'chỉ 10 lớp': output(new Float32Array(10).fill(1)),
      'tensor rỗng': output(new Float32Array(0)),
      'thừa lớp (1001)': output(withLogit(898, 20, 1001)),
      'thiếu tensor đầu ra': {},
    };
    try {
      for (const [label, result] of Object.entries(cases)) {
        session.run = async () => result;
        await assert.rejects(
          classifyWithClassifier(IMAGE, LOCAL()),
          (err) => err instanceof VisionEngineError && err.status === 'invalid_response',
          label
        );
      }
      session.run = async () => output(withLogit(898, 20));
      assert.equal((await classifyWithClassifier(IMAGE, LOCAL())).category, 'reusable_bottle', 'đầu ra đúng dạng vẫn được chấm');
    } finally {
      session.run = original;
    }
  });

  test('tệp mô hình sai mã băm → not_configured, không nạp', async () => {
    // Dùng thư mục tạm có tệp rác đúng tên nhưng sai nội dung — verifyModelFiles phải chặn trước khi nạp
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gc-sai-bam-'));
    const [file] = Object.keys(CLASSIFIER_MANIFEST[DEFAULT_CLASSIFIER_MODEL].files);
    const target = modelFilePath(DEFAULT_CLASSIFIER_MODEL, file, dir);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from('noi-dung-sai'));
    try {
      await assert.rejects(
        loadClassifier(LOCAL('classifier', { classifier: { model: DEFAULT_CLASSIFIER_MODEL, dir, threads: 1 } })),
        (err) => err instanceof VisionEngineError && err.status === 'not_configured'
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('warmUpVision — nạp sẵn bộ phân loại khi khởi động', () => {
  afterEach(() => setEnv());

  test('engine classifier → gọi nạp session, ghi log sẵn sàng', async () => {
    const cfg = { ...LOCAL('classifier'), mode: 'local' };
    let loaded = 0;
    const lines = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => lines.push(`log: ${args.join(' ')}`);
    console.error = (...args) => lines.push(`error: ${args.join(' ')}`);
    try {
      await warmUpVision(cfg, { loadOnnx: async () => { loaded += 1; } });
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    assert.equal(loaded, 1);
    assert.ok(lines.some((l) => l.startsWith('log: Bộ phân loại ONNX đã sẵn sàng')), lines.join('\n'));
  });

  test('nạp lỗi → ghi log lỗi, không làm sập server', async () => {
    const cfg = { ...LOCAL('classifier'), mode: 'local' };
    const lines = [];
    const originalError = console.error;
    console.error = (...args) => lines.push(args.join(' '));
    try {
      await warmUpVision(cfg, { loadOnnx: async () => { throw new Error('lỗi nạp'); } });
    } finally {
      console.error = originalError;
    }
    assert.ok(lines.some((l) => l.includes('Chưa nạp được bộ phân loại ONNX')), lines.join('\n'));
  });

  test('chế độ khác local → không nạp gì', async () => {
    await warmUpVision({ ...LOCAL('classifier'), mode: 'unavailable' }, { loadOnnx: () => assert.fail('không được nạp') });
  });

  test('mô hình có bước tự kiểm → log sẵn sàng kèm số ảnh chuẩn và độ lệch lớn nhất', async () => {
    const cfg = { ...LOCAL('classifier'), mode: 'local' };
    const capture = captureConsole(['log', 'error']);
    try {
      await warmUpVision(cfg, { loadOnnx: async () => ({ selfCheck: { passed: true, images: 4, maxDiff: 0.0012, tolerance: 0.05 } }) });
    } finally {
      capture.restore();
    }
    assert.ok(capture.lines.some((l) => /^log: Bộ phân loại ONNX đã sẵn sàng .*tự kiểm 4 ảnh chuẩn: lệch lớn nhất 0\.0012 \(cho phép 0\.05\)/.test(l)), capture.lines.join('\n'));
  });
});

// Triển khai trên máy khác (vd. Railway: Linux, CPU khác) có thể làm mô hình int8 tính khác lúc hiệu chỉnh. Mô hình khai báo selfCheck
// trong manifest được chấm lại trên các ảnh chuẩn đi kèm repo khi nạp; lệch quá dung sai → không nạp, check-in báo "chưa sẵn sàng"
// (fail-closed), trừ khi người vận hành đã chấm lại trên máy đó và đặt VISION_SELF_CHECK=warn.
describe('tự kiểm bộ phân loại khi nạp', () => {
  test('độ lệch là giá trị lớn nhất trên mọi loại; loại không có trong kết quả tính là 0', () => {
    const ranked = [
      { category: 'reusable_bottle', probability: 0.9 },
      { category: 'other_container', probability: 0.07 },
      { category: 'unclear', probability: 0.03 },
    ];
    assert.deepEqual(rankedDeviation(ranked, { reusable_bottle: 0.9, other_container: 0.07, unclear: 0.03 }), { maxDiff: 0, category: null });
    const off = rankedDeviation(ranked, { reusable_bottle: 0.8, other_container: 0.12, unclear: 0.03 });
    assert.equal(off.category, 'reusable_bottle');
    assert.ok(Math.abs(off.maxDiff - 0.1) < 1e-9, String(off.maxDiff));
    assert.deepEqual(rankedDeviation([], { reusable_cup: 0.4 }), { maxDiff: 0.4, category: 'reusable_cup' });
  });

  test('chế độ đọc từ VISION_SELF_CHECK: mặc định enforce, chỉ nhận thêm warn', () => {
    assert.equal(visionConfig().selfCheck, 'enforce');
    setEnv({ VISION_SELF_CHECK: 'warn' });
    assert.equal(visionConfig().selfCheck, 'warn');
    setEnv({ VISION_SELF_CHECK: 'tat-di' });
    assert.equal(visionConfig().selfCheck, 'enforce');
  });
});

const SELF_CHECK_MODEL = 'greencanteen/bev9-dinov2-vitb-280-int8';
const selfCheckModelReady = (await verifyModelFiles(SELF_CHECK_MODEL)).length === 0;
const SKIP_WITHOUT_SELF_CHECK_MODEL = selfCheckModelReady ? false : `BLOCKED: chưa có tệp mô hình ${SELF_CHECK_MODEL} (chép vào server/models)`;

describe('tự kiểm với mô hình thật có selfCheck trong manifest', { skip: SKIP_WITHOUT_SELF_CHECK_MODEL }, () => {
  // Session được nhớ theo (mô hình, chuỗi thư mục): thêm "\." vào cuối để có session riêng mà vẫn đọc cùng tệp
  const variantDir = (n) => [modelDir(), ...Array(n).fill('.')].join(path.sep);
  const cfgFor = (n, patch = {}) =>
    LOCAL('classifier', { threshold: 0.95, selfCheck: 'enforce', timeoutMs: 60_000, classifier: { model: SELF_CHECK_MODEL, dir: variantDir(n), threads: 2 }, ...patch });
  /** Thay tạm selfCheck của mô hình trong manifest, chạy fn, rồi trả lại như cũ */
  async function withSelfCheck(change, fn) {
    const entry = CLASSIFIER_MANIFEST[SELF_CHECK_MODEL];
    const saved = entry.selfCheck;
    entry.selfCheck = structuredClone(saved);
    change(entry.selfCheck);
    try {
      return await fn();
    } finally {
      entry.selfCheck = saved;
    }
  }
  // Giả lập máy tính khác hẳn lúc hiệu chỉnh: loại cao nhất của ảnh chuẩn đầu tiên lệch 0,5
  const shiftFirstImage = (spec) => {
    const first = spec.images[0].firstLook;
    const [category, value] = Object.entries(first).sort((a, b) => b[1] - a[1])[0];
    first[category] = value - 0.5;
  };

  test('giá trị chuẩn ghi trong manifest khớp đầu ra thật của mô hình trên máy này', async () => {
    const spec = CLASSIFIER_MANIFEST[SELF_CHECK_MODEL].selfCheck;
    assert.ok(spec.images.length >= 3, 'đủ ảnh chuẩn');
    const loaded = await loadClassifier(cfgFor(0));
    assert.equal(loaded.selfCheck.passed, true);
    assert.equal(loaded.selfCheck.images, spec.images.length);
    assert.ok(loaded.selfCheck.maxDiff <= spec.tolerance, String(loaded.selfCheck.maxDiff));
  });

  test('lệch quá dung sai → không nạp (not_configured), lỗi giữ nguyên cho các lần gọi sau, check-in không được thưởng', async () => {
    const capture = captureConsole(['error']);
    try {
      await withSelfCheck(shiftFirstImage, async () => {
        const cfg = cfgFor(1);
        await assert.rejects(loadClassifier(cfg), (err) => err instanceof VisionEngineError && err.status === 'not_configured' && /tự kiểm/.test(err.message));
        await assert.rejects(loadClassifier(cfg), /tự kiểm/);
        const result = await classifyContainerImage(IMAGE, cfg);
        assert.deepEqual([result.status, result.accepted], ['not_configured', false]);
      });
    } finally {
      capture.restore();
    }
  });

  test('VISION_SELF_CHECK=warn: lệch chỉ ghi lỗi ra log, mô hình vẫn được nạp', async () => {
    const capture = captureConsole(['error']);
    let loaded;
    try {
      loaded = await withSelfCheck(shiftFirstImage, () => loadClassifier(cfgFor(2, { selfCheck: 'warn' })));
    } finally {
      capture.restore();
    }
    assert.equal(loaded.selfCheck.passed, false);
    assert.ok(loaded.selfCheck.maxDiff >= 0.4, String(loaded.selfCheck.maxDiff));
    assert.ok(capture.lines.some((l) => /^error: .*tự kiểm/.test(l)), capture.lines.join('\n'));
  });

  test('ảnh chuẩn bị sửa (sai mã băm) → không đạt tự kiểm, không nạp', async () => {
    const capture = captureConsole(['error']);
    try {
      await withSelfCheck(
        (spec) => {
          spec.images[0].sha256 = '0'.repeat(64);
        },
        () => assert.rejects(loadClassifier(cfgFor(3)), (err) => err.status === 'not_configured' && /tự kiểm/.test(err.message) && /mã băm/.test(err.message))
      );
    } finally {
      capture.restore();
    }
  });
});
