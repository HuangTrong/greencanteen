// Kiểm tra dữ liệu nhập khi đăng ký / đăng nhập: phân vùng tương đương + giá trị biên
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import {
  AccountError,
  generateClaimCode,
  hasCredentials,
  isPlausibleEmail,
  normalizeClaimCode,
  normalizeEmail,
  normalizeName,
  normalizeStudentId,
  sendAccountError,
  serializeUser,
  validateEmail,
  validateName,
  validatePassword,
  validateStudentId,
} from '../../src/services/accounts.js';

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

const emailOfLength = (length) => {
  const domain = '@example.edu.vn';
  return 'a'.repeat(length - domain.length) + domain;
};

describe('chuẩn hóa dữ liệu nhập', () => {
  test('họ tên: bỏ khoảng trắng thừa; không phải chuỗi → rỗng', () => {
    assert.equal(normalizeName('  Nguyễn   Văn\t\nAn  '), 'Nguyễn Văn An');
    for (const v of [undefined, null, 42, { $ne: '' }, ['a']]) assert.equal(normalizeName(v), '');
  });

  test('mã SV chỉ cắt khoảng trắng hai đầu; email đổi về chữ thường', () => {
    assert.equal(normalizeStudentId('  SV001 '), 'SV001');
    assert.equal(normalizeStudentId(123), '');
    assert.equal(normalizeEmail('  An.Nguyen@Truong.EDU.vn '), 'an.nguyen@truong.edu.vn');
    assert.equal(normalizeEmail({ $gt: '' }), '');
  });
});

describe('validateName — biên 2..80 ký tự', () => {
  for (const [length, ok] of [[0, false], [1, false], [2, true], [80, true], [81, false]]) {
    test(`${length} ký tự → ${ok ? 'hợp lệ' : 'lỗi'}`, () => {
      assert.equal(validateName('A'.repeat(length)) === null, ok);
    });
  }
});

describe('validateStudentId — bắt buộc, tối đa 40 ký tự', () => {
  test('rỗng / 1 / 40 / 41 ký tự', () => {
    assert.equal(validateStudentId(''), 'Cần nhập mã sinh viên.');
    assert.equal(validateStudentId('S'), null);
    assert.equal(validateStudentId('S'.repeat(40)), null);
    assert.equal(validateStudentId('S'.repeat(41)), 'Mã sinh viên quá dài.');
  });
});

describe('validateEmail — cú pháp như ô type=email, tối đa 254 ký tự', () => {
  for (const email of ['sv@truong.edu.vn', 'a.b+tag@x.io', "o'neil@example.com", 'x@sub-domain.example.vn', emailOfLength(254)]) {
    test(`hợp lệ: ${email.length > 40 ? `${email.length} ký tự` : email}`, () => assert.equal(validateEmail(email), null));
  }
  for (const email of [
    '',
    'khong-co-a-cong',
    'a@b',
    'a@-b.com',
    'a@b-.com',
    'a b@c.com',
    'a@b..com',
    'a@b,c.com',
    '"a"@b.com',
    '<a>@b.com',
    'a@b.com\nBcc: x@y.com',
    emailOfLength(255),
  ]) {
    test(`không hợp lệ: ${JSON.stringify(email.length > 40 ? `${email.length} ký tự` : email)}`, () =>
      assert.equal(validateEmail(email), 'Email không hợp lệ.'));
  }

  test('đăng nhập kiểm tra lỏng hơn nhưng vẫn chặn chuỗi rõ ràng sai', () => {
    assert.equal(isPlausibleEmail('a@b.c'), true);
    assert.equal(isPlausibleEmail('a@b'), false);
    assert.equal(isPlausibleEmail(''), false);
    assert.equal(isPlausibleEmail('a @b.c'), false);
    assert.equal(isPlausibleEmail(emailOfLength(254)), true);
    assert.equal(isPlausibleEmail(emailOfLength(255)), false);
  });
});

describe('validatePassword — 8..128 ký tự, phải là chuỗi', () => {
  for (const [value, ok] of [
    ['xK9#mPq', false],
    ['xK9#mPq2', true],
    ['xK9#mPq2'.repeat(16), true],
    [`${'xK9#mPq2'.repeat(16)}x`, false],
    ['bầu trời', true],
    [12345678, false],
    [undefined, false],
    [{ $ne: '' }, false],
  ]) {
    test(`${typeof value === 'string' ? `${value.length} ký tự` : typeof value} → ${ok ? 'hợp lệ' : 'lỗi'}`, () => {
      assert.equal(validatePassword(value) === null, ok);
    });
  }
});

describe('serializeUser — dữ liệu trả về client', () => {
  test('mặc định 0, huy hiệu suy ra từ tổng, không lộ trường bí mật', () => {
    const out = serializeUser({
      _id: new mongoose.Types.ObjectId(),
      studentId: 'SV1',
      name: 'An',
      totalCheckIns: 5,
      ecoPoints: 50,
      badges: ['first_sip', 'legacy_badge'],
      passwordHash: 'scrypt$...',
      claimCodeHash: 'abc',
      googleId: 'g-1',
      recentImageHashes: ['h'],
    });
    assert.deepEqual(Object.keys(out).sort(), [
      'authMethods',
      'avatarUrl',
      'badges',
      'co2SavedGrams',
      'createdAt',
      'ecoPoints',
      'email',
      'id',
      'name',
      'pendingGachaSpins',
      'plasticSavedGrams',
      'studentId',
      'totalCheckIns',
    ]);
    assert.deepEqual(out.authMethods, { password: false, google: true, facebook: false });
    assert.deepEqual(out.badges, ['first_sip', 'legacy_badge', 'green_starter'], 'gộp, không trùng, giữ huy hiệu cũ');
    assert.equal(out.email, '');
    assert.equal(out.plasticSavedGrams, 0);
    assert.equal(out.pendingGachaSpins, 0);
  });

  test('tài khoản cũ chưa có phương thức đăng nhập', () => {
    assert.equal(hasCredentials({}), false);
    assert.equal(hasCredentials({ passwordChangedAt: new Date() }), true);
    assert.equal(hasCredentials({ googleId: 'g' }), true);
    assert.equal(hasCredentials({ facebookId: 'f' }), true);
  });
});

describe('mã kích hoạt tài khoản cũ', () => {
  test('định dạng XXXX-XXXX-XXXX, bỏ ký tự dễ nhầm (I, O, 0, 1), không trùng', () => {
    const codes = new Set(Array.from({ length: 300 }, generateClaimCode));
    assert.equal(codes.size, 300);
    for (const code of codes) assert.match(code, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  });

  test('chuẩn hóa: không phân biệt hoa/thường, bỏ dấu gạch và khoảng trắng', () => {
    assert.equal(normalizeClaimCode(' abcd-efgh 2345 '), 'ABCDEFGH2345');
    assert.equal(normalizeClaimCode(undefined), '');
    assert.equal(normalizeClaimCode({ $ne: '' }), '');
  });
});

describe('sendAccountError — lỗi luôn trả JSON { error, code }', () => {
  test('AccountError giữ mã trạng thái và mã lỗi', () => {
    const res = sendAccountError(fakeResponse(), new AccountError(409, 'email_taken', 'Email đã dùng.'), 'x');
    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.body, { error: 'Email đã dùng.', code: 'email_taken' });
  });

  test('lỗi không lường trước → 500 kèm code server_error, không lộ chi tiết lỗi', () => {
    const original = console.error;
    console.error = () => {};
    try {
      const res = sendAccountError(fakeResponse(), new Error('E11000 duplicate key: secret@example.com'), 'Không thể tạo tài khoản.');
      assert.equal(res.statusCode, 500);
      assert.deepEqual(res.body, { error: 'Không thể tạo tài khoản.', code: 'server_error' });
    } finally {
      console.error = original;
    }
  });
});
