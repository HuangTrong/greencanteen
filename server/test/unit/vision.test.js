import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyContainerImage, isRewardable, parseClassification } from '../../src/services/vision.js';
import { classifyWithOllama } from '../../src/services/visionOllama.js';
import { detectImageType, inspectImage } from '../../src/services/image.js';
import { uniquePng } from '../helpers.js';

const IMAGE = { buffer: uniquePng(), mimeType: 'image/png' };

describe('kiểm tra schema phản hồi của mô hình', () => {
  test('chấp nhận đúng schema', () => {
    assert.deepEqual(parseClassification('{"category":"reusable_cup","confidence":0.91,"reason":"Cốc sứ có quai"}'), {
      category: 'reusable_cup',
      confidence: 0.91,
      reason: 'Cốc sứ có quai',
    });
    assert.ok(parseClassification('```json\n{"category":"unclear","confidence":0.2,"reason":"Ảnh mờ"}\n```'));
  });

  for (const [label, text] of [
    ['không phải JSON', 'Đây là bình nước'],
    ['mảng', '[{"category":"reusable_cup","confidence":0.9,"reason":"x"}]'],
    ['loại ngoài danh sách', '{"category":"thermos","confidence":0.9,"reason":"x"}'],
    ['độ tin cậy dạng chuỗi', '{"category":"reusable_cup","confidence":"0.9","reason":"x"}'],
    ['độ tin cậy > 1', '{"category":"reusable_cup","confidence":1.5,"reason":"x"}'],
    ['độ tin cậy âm', '{"category":"reusable_cup","confidence":-0.1,"reason":"x"}'],
    ['thiếu lý do', '{"category":"reusable_cup","confidence":0.9}'],
    ['lý do rỗng', '{"category":"reusable_cup","confidence":0.9,"reason":"  "}'],
    ['thừa khóa', '{"category":"reusable_cup","confidence":0.9,"reason":"x","accepted":true}'],
  ]) {
    test(`từ chối: ${label}`, () => assert.equal(parseClassification(text), null));
  }
});

describe('gọi VLM local (Ollama) — thay cho Gemini cloud', () => {
  const LOCAL = { mode: 'local', engine: 'ollama', threshold: 0.8, timeoutMs: 5000, ollama: { url: 'http://127.0.0.1:11434', model: 'qwen3-vl:4b-instruct' } };
  const ollamaAnswering = (content, status = 200) => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ message: { role: 'assistant', content } }), { status, headers: { 'Content-Type': 'application/json' } });
    };
    return { calls, engines: { ollama: (image, cfg) => classifyWithOllama(image, cfg, fetchImpl) } };
  };

  test('gửi ảnh + schema tới máy local, nhận diện bình cá nhân đạt ngưỡng → được thưởng', async () => {
    const { calls, engines } = ollamaAnswering('{"category":"reusable_bottle","confidence":0.93,"reason":"Bình giữ nhiệt kim loại"}');
    const result = await classifyContainerImage(IMAGE, LOCAL, engines);
    assert.equal(result.status, 'classified');
    assert.equal(result.accepted, true);
    assert.equal(result.model, 'ollama:qwen3-vl:4b-instruct');
    assert.equal(calls[0].url, 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.format.required, ['category', 'confidence', 'reason']);
    assert.equal(body.options.num_predict, 300, 'chặn trường hợp mô hình sinh chữ không dừng tới hết thời gian chờ');
    assert.equal(body.options.num_ctx, 16384, 'không phụ thuộc mặc định của máy chủ Ollama');
  });

  test('dưới ngưỡng hoặc sai loại → không thưởng', async () => {
    const low = await classifyContainerImage(IMAGE, LOCAL, ollamaAnswering('{"category":"reusable_bottle","confidence":0.7,"reason":"Có thể là bình"}').engines);
    assert.equal(low.status, 'classified');
    assert.equal(low.accepted, false);
    const plastic = await classifyContainerImage(IMAGE, LOCAL, ollamaAnswering('{"category":"single_use_plastic_cup","confidence":0.99,"reason":"Ly nhựa trà sữa"}').engines);
    assert.equal(plastic.accepted, false);
  });

  test('HTTP lỗi / sai schema → không thưởng', async () => {
    const original = console.error;
    console.error = () => {};
    try {
      assert.equal((await classifyContainerImage(IMAGE, LOCAL, ollamaAnswering('x', 500).engines)).status, 'provider_error');
      assert.equal((await classifyContainerImage(IMAGE, LOCAL, ollamaAnswering('{"category":"bottle","confidence":0.9,"reason":"x"}').engines)).status, 'invalid_response');
    } finally {
      console.error = original;
    }
  });

  test('không có cấu hình → not_configured, không gọi mạng', async () => {
    let called = false;
    const result = await classifyContainerImage(IMAGE, { ...LOCAL, mode: 'unavailable' }, { ollama: async () => { called = true; } });
    assert.equal(result.status, 'not_configured');
    assert.equal(called, false);
  });

  test('isRewardable chỉ nhận kết quả thật hoặc mô phỏng đã bật', () => {
    assert.equal(isRewardable({ status: 'classified', category: 'reusable_cup', confidence: 0.8 }, 0.8), true);
    assert.equal(isRewardable({ status: 'invalid_response', category: 'reusable_cup', confidence: 0.99 }, 0.8), false);
    assert.equal(isRewardable({ status: 'classified', category: 'other_container', confidence: 0.99 }, 0.8), false);
  });
});

describe('kiểm tra dữ liệu ảnh', () => {
  test('nhận diện loại ảnh theo nội dung, không theo khai báo', () => {
    assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
    assert.equal(detectImageType(uniquePng()), 'image/png');
    assert.equal(detectImageType(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')), 'image/webp');
    assert.equal(detectImageType(Buffer.from('\x00\x00\x00\x18ftypheic\x00\x00\x00\x00', 'latin1')), 'image/heic');
    assert.equal(detectImageType(Buffer.from('GIF89a')), null);
    assert.equal(detectImageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null);
  });

  test('ảnh rỗng, sai loại, bị cắt cụt', () => {
    assert.equal(inspectImage(Buffer.alloc(0)).code, 'image_empty');
    assert.equal(inspectImage(Buffer.from('hello')).code, 'image_type_unsupported');
    assert.equal(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])).code, 'image_unreadable');
    assert.equal(inspectImage(uniquePng().subarray(0, 30)).code, 'image_unreadable');
    assert.equal(inspectImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9])).ok, true);
    assert.equal(inspectImage(uniquePng()).ok, true);
  });
});
