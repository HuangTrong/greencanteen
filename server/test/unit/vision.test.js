import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyContainerImage, isRewardable } from '../../src/services/vision.js';
import { detectImageType, inspectImage } from '../../src/services/image.js';
import { uniquePng } from '../helpers.js';

const IMAGE = { buffer: uniquePng(), mimeType: 'image/png' };

describe('quyết định thưởng tại server', () => {
  test('không có cấu hình → not_configured, không gọi bộ nhận diện', async () => {
    let called = false;
    const result = await classifyContainerImage(IMAGE, { mode: 'unavailable', threshold: 0.8 }, { classifier: async () => { called = true; } });
    assert.equal(result.status, 'not_configured');
    assert.equal(result.accepted, false);
    assert.equal(called, false);
  });

  test('isRewardable chỉ nhận kết quả thật hoặc mô phỏng đã bật', () => {
    assert.equal(isRewardable({ status: 'classified', category: 'reusable_cup', confidence: 0.8 }, 0.8), true);
    assert.equal(isRewardable({ status: 'provider_error', category: 'reusable_cup', confidence: 0.99 }, 0.8), false);
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
