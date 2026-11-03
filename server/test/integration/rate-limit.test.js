// Bộ giới hạn tần suất lưu trong MongoDB: biên của ngưỡng, hết cửa sổ, đồng thời, không phân biệt hoa/thường
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimit } from '../../src/models/RateLimit.js';
import { RateLimitUnavailableError, createRateLimiter, tooManyRequests } from '../../src/services/rateLimit.js';
import { setEnv, startTestServer } from '../helpers.js';

let ctx;
before(async () => {
  setEnv();
  ctx = await startTestServer();
});
after(() => ctx.stop());
beforeEach(() => RateLimit.deleteMany({}));

describe('createRateLimiter', () => {
  test('ngưỡng 3: lần 1..3 chưa vượt, lần 4 vượt; reset xóa bộ đếm', async () => {
    const limiter = createRateLimiter({ name: 'unit', max: 3, windowMs: 60_000 });
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push([await limiter.isLimited('k'), await limiter.hit('k')]);
    }
    assert.deepEqual(results, [
      [false, false],
      [false, false],
      [false, false],
      [true, true],
    ]);
    await limiter.reset('k');
    assert.equal(await limiter.isLimited('k'), false);
    assert.equal(await RateLimit.countDocuments(), 0);
  });

  test('hết cửa sổ thời gian → đếm lại từ 1', async () => {
    const limiter = createRateLimiter({ name: 'window', max: 1, windowMs: 60_000 });
    await limiter.hit('k');
    assert.equal(await limiter.hit('k'), true);
    await RateLimit.updateOne({ key: 'window:k' }, { $set: { resetAt: new Date(Date.now() - 1) } });
    assert.equal(await limiter.isLimited('k'), false, 'cửa sổ cũ hết hạn');
    assert.equal(await limiter.hit('k'), false);
    assert.equal((await RateLimit.findOne({ key: 'window:k' }).lean()).count, 1);
  });

  test('20 lần đồng thời được đếm đủ, không mất lượt (upsert trùng khóa được thử lại)', async () => {
    const limiter = createRateLimiter({ name: 'race', max: 10, windowMs: 60_000 });
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.hit('same-key')));
    assert.equal((await RateLimit.findOne({ key: 'race:same-key' }).lean()).count, 20);
    assert.equal(results.filter(Boolean).length, 10);
  });

  test('khóa không phân biệt hoa/thường; tên bộ đếm tách biệt nhau', async () => {
    const a = createRateLimiter({ name: 'a', max: 1, windowMs: 60_000 });
    const b = createRateLimiter({ name: 'b', max: 1, windowMs: 60_000 });
    await a.hit('An@Example.VN');
    assert.equal(await a.isLimited('an@example.vn'), true);
    assert.equal(await b.isLimited('an@example.vn'), false);
  });

  test('release trả lại một lượt đã giữ chỗ, không xuống dưới 0; lượt khác vẫn được giữ', async () => {
    const limiter = createRateLimiter({ name: 'release', max: 2, windowMs: 60_000 });
    await limiter.hit('k');
    await limiter.hit('k');
    await limiter.release('k');
    assert.equal((await RateLimit.findOne({ key: 'release:k' }).lean()).count, 1);
    await limiter.release('k');
    await limiter.release('k');
    assert.equal((await RateLimit.findOne({ key: 'release:k' }).lean()).count, 0);
    await limiter.release('khong-co');
    assert.equal(await RateLimit.countDocuments({ key: 'release:khong-co' }), 0);
  });

  test('max và windowMs có thể là hàm: đọc cấu hình lúc gọi, không phải lúc tạo bộ đếm', async () => {
    let max = 1;
    const limiter = createRateLimiter({ name: 'dyn', max: () => max, windowMs: () => 5_000 });
    assert.equal(limiter.windowMs, 5_000);
    await limiter.hit('k');
    assert.equal(await limiter.hit('k'), true);
    max = 5;
    assert.equal(await limiter.hit('k'), false);
    assert.ok((await RateLimit.findOne({ key: 'dyn:k' }).lean()).resetAt - Date.now() <= 5_000);
  });

  test('DB lỗi: mọi thao tác ném RateLimitUnavailableError, thông điệp không chứa khóa bộ đếm', async () => {
    const limiter = createRateLimiter({ name: 'broken', max: 1, windowMs: 60_000 });
    const originals = { findOne: RateLimit.findOne, findOneAndUpdate: RateLimit.findOneAndUpdate, updateOne: RateLimit.updateOne, deleteOne: RateLimit.deleteOne };
    const leak = () => ({ lean: () => Promise.reject(Object.assign(new Error('dup key: broken:nan-nhan@example.edu.vn'), { codeName: 'NetworkTimeout' })) });
    RateLimit.findOne = leak;
    RateLimit.findOneAndUpdate = leak;
    RateLimit.updateOne = () => Promise.reject(new Error('dup key: broken:nan-nhan@example.edu.vn'));
    RateLimit.deleteOne = RateLimit.updateOne;
    try {
      for (const action of [limiter.isLimited, limiter.hit, limiter.release, limiter.reset]) {
        await assert.rejects(action('nan-nhan@example.edu.vn'), (err) => {
          assert.ok(err instanceof RateLimitUnavailableError);
          assert.ok(!err.message.includes('nan-nhan'));
          return true;
        });
      }
    } finally {
      Object.assign(RateLimit, originals);
    }
  });

  test('tooManyRequests trả 429 JSON có code', () => {
    const res = {
      status(code) {
        this.code = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };
    tooManyRequests(res);
    assert.equal(res.code, 429);
    assert.equal(res.body.code, 'too_many_attempts');
    assert.ok(res.body.error);
  });
});
