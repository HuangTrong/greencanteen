// Băm mật khẩu (scrypt) và các tiện ích phiên/cookie
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, verifyPasswordOrDummy } from '../../src/services/password.js';
import {
  baseCookieOptions,
  cookieOptions,
  hashToken,
  randomToken,
  readCookie,
  safeEqual,
} from '../../src/services/session.js';
import { setEnv } from '../helpers.js';

afterEach(() => setEnv());

describe('băm mật khẩu bằng scrypt', () => {
  test('định dạng lưu kèm tham số, muối ngẫu nhiên, không chứa mật khẩu gốc', async () => {
    const a = await hashPassword('mat-khau-an-toan');
    const b = await hashPassword('mat-khau-an-toan');
    assert.match(a, /^scrypt\$32768\$8\$3\$[A-Za-z0-9+/=]{24}\$[A-Za-z0-9+/=]{88}$/);
    assert.notEqual(a, b, 'cùng mật khẩu nhưng muối khác nhau');
    assert.ok(!a.includes('mat-khau-an-toan'));
  });

  test('xác minh đúng / sai mật khẩu', async () => {
    const stored = await hashPassword('Đúng-Mật-Khẩu-1');
    assert.equal(await verifyPassword('Đúng-Mật-Khẩu-1', stored), true);
    assert.equal(await verifyPassword('đúng-mật-khẩu-1', stored), false, 'phân biệt hoa/thường');
    assert.equal(await verifyPassword('', stored), false);
  });

  test('chuẩn hóa Unicode: dạng dựng sẵn (NFC) và tổ hợp (NFD) của chữ có dấu là cùng một mật khẩu', async () => {
    const composed = 'Mật khẩu tiếng Việt';
    const decomposed = composed.normalize('NFD');
    assert.notEqual(composed, decomposed);
    assert.equal(await verifyPassword(decomposed, await hashPassword(composed)), true);
  });

  test('chuỗi băm hỏng hoặc thuật toán khác → false, không ném lỗi', async () => {
    for (const stored of [undefined, null, '', 'bcrypt$2b$10$abc', 'scrypt$32768$8$3$', 'scrypt$32768$8$3$c2FsdA==']) {
      assert.equal(await verifyPassword('bat-ky', stored), false, String(stored));
    }
  });

  test('email không tồn tại vẫn chạy một lần băm (chống dò email qua thời gian phản hồi)', async () => {
    assert.equal(await verifyPasswordOrDummy('bat-ky', undefined), false);
    const stored = await hashPassword('mat-khau-dung');
    assert.equal(await verifyPasswordOrDummy('mat-khau-dung', stored), true);

    const timings = [];
    for (const stored of [undefined, await hashPassword('x-y-z-1234')]) {
      const start = performance.now();
      await verifyPasswordOrDummy('sai-mat-khau', stored);
      timings.push(performance.now() - start);
    }
    // Cùng bậc thời gian (không phải trả về tức thì khi không có tài khoản)
    assert.ok(timings[0] > timings[1] / 5, `không tài khoản: ${timings[0].toFixed(1)}ms, có tài khoản: ${timings[1].toFixed(1)}ms`);
  });
});

describe('token phiên', () => {
  test('randomToken 256 bit dạng base64url, không trùng', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => randomToken()));
    assert.equal(tokens.size, 200);
    for (const t of tokens) assert.match(t, /^[A-Za-z0-9_-]{43}$/);
  });

  test('hashToken: SHA-256 hex, ổn định; safeEqual so sánh an toàn', () => {
    assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    assert.equal(safeEqual('state-1', 'state-1'), true);
    assert.equal(safeEqual('state-1', 'state-2'), false);
    assert.equal(safeEqual('ngắn', 'dài hơn nhiều'), false);
    assert.equal(safeEqual(undefined, 'undefined'), true, 'đầu vào được ép kiểu chuỗi');
  });
});

describe('readCookie', () => {
  const req = (cookie) => ({ headers: cookie === undefined ? {} : { cookie } });
  for (const [label, header, expected] of [
    ['không có header', undefined, null],
    ['không có cookie cần tìm', 'a=1; b=2', null],
    ['nhiều cookie', 'a=1; gc_session=abc; b=2', 'abc'],
    ['tên là hậu tố của cookie khác', 'xgc_session=1; gc_session=2', '2'],
    ['giá trị chứa dấu =', 'gc_session=ab=c', 'ab=c'],
    ['giá trị mã hóa URL', 'gc_session=a%20b', 'a b'],
    ['mã hóa URL hỏng', 'gc_session=%E0%A4%A', null],
    ['phần tử không có dấu =', 'gc_session; a=1', null],
  ]) {
    test(label, () => assert.equal(readCookie(req(header), 'gc_session'), expected));
  }
});

describe('thuộc tính cookie — bảng quyết định theo môi trường', () => {
  for (const [vars, expected] of [
    [{}, { sameSite: 'lax', secure: false }],
    [{ NODE_ENV: 'production' }, { sameSite: 'lax', secure: true }],
    [{ NODE_ENV: 'production', COOKIE_SECURE: 'false' }, { sameSite: 'lax', secure: false }],
    [{ COOKIE_SECURE: 'true' }, { sameSite: 'lax', secure: true }],
    [{ COOKIE_SAMESITE: 'none', COOKIE_SECURE: 'false' }, { sameSite: 'none', secure: true }],
    [{ COOKIE_SAMESITE: 'strict' }, { sameSite: 'lax', secure: false }],
  ]) {
    test(JSON.stringify(vars), () => {
      setEnv(vars);
      assert.deepEqual(baseCookieOptions(), { httpOnly: true, path: '/', ...expected });
    });
  }

  test('cookieOptions thêm maxAge', () => {
    assert.equal(cookieOptions(1234).maxAge, 1234);
    assert.equal(cookieOptions(1234).httpOnly, true);
  });
});
