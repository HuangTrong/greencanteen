import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { floodGuard, resetFloodGuard } from '../../src/middleware/floodGuard.js';

afterEach(() => {
  resetFloodGuard();
  delete process.env.API_RATE_LIMIT_PER_MINUTE;
});

describe('giới hạn tần suất toàn API', () => {
  test('bảng IP đầy: địa chỉ mới dùng chung giới hạn tràn thay vì bỏ qua bộ đếm', () => {
    process.env.API_RATE_LIMIT_PER_MINUTE = '1';
    let passed = 0;
    const send = (ip) => {
      let status = 0;
      const res = {
        set() { return this; },
        status(value) { status = value; return this; },
        json() { return this; },
      };
      floodGuard({ ip, path: '/api/stats/school' }, res, () => { passed += 1; });
      return status;
    };

    // Dải tài liệu IPv6 tạo đúng 200.000 khóa /64 khác nhau mà không mở kết nối mạng.
    for (let i = 0; i < 200_000; i += 1) {
      const ip = `2001:db8:${(i >>> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`;
      assert.equal(send(ip), 0);
    }

    assert.equal(send('2001:db8:3:86a0::1'), 0);
    assert.equal(send('2001:db8:3:86a1::1'), 429);
    assert.equal(send('2001:db8:3:86a1::1'), 429);
    assert.equal(passed, 200_001);
  });
});
