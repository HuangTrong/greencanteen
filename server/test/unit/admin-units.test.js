// Các phần thuần tính toán của khu quản trị: TOTP, mã hóa secret, che dữ liệu, rút thăm, khoảng báo cáo, kiểm tra cấu hình
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { adminIdleTimeoutMs, adminMfaKey, adminReauthWindowMs, adminSessionMaxMs, isAdminConfigured } from '../../src/services/adminConfig.js';
import { parseReportRange } from '../../src/services/adminStats.js';
import { AdminError, toAdminError } from '../../src/services/adminErrors.js';
import { parsePaging, escapeRegex } from '../../src/services/adminQuery.js';
import { PROBABILITY_TOTAL_PPM, drawPrize, issueClaimCode, normalizeClaimCode, oneInN } from '../../src/services/gacha.js';
import { normalizeConfigInput, validateForPublish } from '../../src/services/gachaConfig.js';
import { maskEmail, maskStudentId } from '../../src/services/privacy.js';
import { actorKeyFor, localDate, parseAnalyticsEvent } from '../../src/services/analytics.js';
import { base32Decode, base32Encode, generateTotpSecret, matchTotpStep, openSecret, sealSecret, totpCode, totpStep, totpUri } from '../../src/services/totp.js';
import { setEnv } from '../helpers.js';

afterEach(() => setEnv());

describe('TOTP (RFC 6238)', () => {
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

  test('vector chuẩn của RFC 6238 phụ lục B (SHA-1), lấy 6 chữ số cuối', () => {
    for (const [seconds, code] of [
      [59, '287082'],
      [1111111109, '081804'],
      [1111111111, '050471'],
      [1234567890, '005924'],
      [2000000000, '279037'],
      [20000000000, '353130'],
    ]) {
      assert.equal(totpCode(RFC_SECRET, totpStep(seconds * 1000)), code, String(seconds));
    }
  });

  test('base32 theo RFC 4648, mã hóa rồi giải mã giữ nguyên dữ liệu', () => {
    assert.equal(base32Encode(Buffer.from('foobar')), 'MZXW6YTBOI');
    assert.equal(base32Decode('MZXW6YTBOI').toString(), 'foobar');
    assert.equal(base32Decode('mzxw6ytboi======').toString(), 'foobar');
    for (let length = 0; length < 40; length += 1) {
      const buffer = crypto.randomBytes(length);
      assert.deepEqual(base32Decode(base32Encode(buffer)), buffer);
    }
    assert.throws(() => base32Decode('M1'), /base32/);
  });

  test('cho phép lệch đúng một bước thời gian, không hơn', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    for (const offset of [-1, 0, 1]) assert.equal(matchTotpStep(secret, totpCode(secret, step + offset), now), step + offset);
    for (const offset of [-2, 2]) assert.equal(matchTotpStep(secret, totpCode(secret, step + offset), now), null);
  });

  test('mã sai định dạng bị loại trước khi so sánh', () => {
    const secret = generateTotpSecret();
    for (const code of ['', '12345', '1234567', 'abcdef', null, undefined, 123456, { $ne: null }]) {
      assert.equal(matchTotpStep(secret, code), null);
    }
  });

  test('secret mới đủ 160 bit, URI dùng được cho ứng dụng xác thực', () => {
    const secret = generateTotpSecret();
    assert.equal(base32Decode(secret).length, 20);
    assert.notEqual(secret, generateTotpSecret());
    const uri = new URL(totpUri({ secret, account: 'a+b@example.edu.vn' }));
    assert.equal(uri.protocol, 'otpauth:');
    assert.equal(uri.searchParams.get('secret'), secret);
    assert.equal(uri.searchParams.get('issuer'), 'GreenCanteen Admin');
    assert.match(decodeURIComponent(uri.pathname), /GreenCanteen Admin:a\+b@example\.edu\.vn/);
  });
});

describe('mã hóa secret khi lưu', () => {
  const key = crypto.randomBytes(32);
  const sealed = sealSecret('BI-MAT', key, 'user-1');

  test('giải mã đúng; mỗi lần mã hóa cho kết quả khác nhau; không chứa bản rõ', () => {
    assert.equal(openSecret(sealed, key, 'user-1'), 'BI-MAT');
    assert.notEqual(sealSecret('BI-MAT', key, 'user-1'), sealed);
    assert.ok(!sealed.includes('BI-MAT'));
  });

  test('sai khóa, sai chủ sở hữu, bị sửa một ký tự, sai định dạng đều không giải mã được', () => {
    assert.throws(() => openSecret(sealed, crypto.randomBytes(32), 'user-1'));
    assert.throws(() => openSecret(sealed, key, 'user-2'));
    const parts = sealed.split('.');
    parts[3] = `${parts[3].startsWith('A') ? 'B' : 'A'}${parts[3].slice(1)}`;
    assert.throws(() => openSecret(parts.join('.'), key, 'user-1'));
    assert.throws(() => openSecret('v2.a.b.c', key, 'user-1'));
    assert.throws(() => openSecret('', key, 'user-1'));
  });
});

describe('cấu hình khu quản trị', () => {
  test('khóa MFA: nhận 32 byte hex hoặc base64; thiếu, ngắn, sai định dạng → tắt khu quản trị', () => {
    const raw = crypto.randomBytes(32);
    for (const value of [raw.toString('hex'), raw.toString('base64')]) {
      setEnv({ ADMIN_MFA_KEY: value });
      assert.deepEqual(adminMfaKey(), raw);
      assert.equal(isAdminConfigured(), true);
    }
    for (const value of [undefined, '', 'abc', crypto.randomBytes(16).toString('base64'), crypto.randomBytes(33).toString('hex')]) {
      setEnv(value === undefined ? {} : { ADMIN_MFA_KEY: value });
      assert.equal(adminMfaKey(), null, String(value));
      assert.equal(isAdminConfigured(), false);
    }
  });

  test('thời hạn phiên có mặc định và bị kẹp trong khoảng an toàn', () => {
    assert.equal(adminIdleTimeoutMs(), 15 * 60_000);
    assert.equal(adminSessionMaxMs(), 8 * 3_600_000);
    assert.equal(adminReauthWindowMs(), 5 * 60_000);
    setEnv({ ADMIN_SESSION_IDLE_MINUTES: '99999', ADMIN_SESSION_MAX_HOURS: '9999', ADMIN_REAUTH_MINUTES: '0' });
    assert.equal(adminIdleTimeoutMs(), 120 * 60_000);
    assert.equal(adminSessionMaxMs(), 24 * 3_600_000);
    assert.equal(adminReauthWindowMs(), 60_000);
  });
});

describe('che dữ liệu cá nhân', () => {
  test('email', () => {
    assert.equal(maskEmail('nguyenan@truong.edu.vn'), 'ng***@truong.edu.vn');
    assert.equal(maskEmail('ab@x.vn'), 'a***@x.vn');
    assert.equal(maskEmail('a@x.vn'), 'a***@x.vn');
    assert.equal(maskEmail(''), '');
    assert.equal(maskEmail(undefined), '');
    assert.equal(maskEmail('khong-co-a-cong'), '***');
  });

  test('mã sinh viên', () => {
    assert.equal(maskStudentId('SV20231234'), 'SV***34');
    assert.equal(maskStudentId('SV001'), 'SV***01');
    assert.equal(maskStudentId('AB12'), 'A***');
    assert.equal(maskStudentId('A'), 'A***');
    assert.equal(maskStudentId(''), '');
    assert.equal(maskStudentId(undefined), '');
  });
});

describe('rút thăm quay thưởng tri ân', () => {
  test('mẫu có xác suất 0 không bao giờ trúng; tổng 100% luôn trúng; tổng 0 luôn không trúng', () => {
    const prizes = [{ prizeId: 'a', probabilityPpm: 0 }, { prizeId: 'b', probabilityPpm: PROBABILITY_TOTAL_PPM }];
    for (let i = 0; i < 200; i += 1) assert.equal(drawPrize(prizes).prizeId, 'b');
    assert.equal(drawPrize([]), null);
    assert.equal(drawPrize([{ prizeId: 'a', probabilityPpm: 0 }]), null);
  });

  test('khoảng số của từng mẫu nối tiếp nhau theo thứ tự cấu hình; ngoài mọi khoảng là không trúng', () => {
    const prizes = [{ prizeId: 'a', probabilityPpm: 10 }, { prizeId: 'b', probabilityPpm: 5 }];
    const at = (value) => drawPrize(prizes, () => value)?.prizeId ?? null;
    assert.deepEqual([at(0), at(9), at(10), at(14), at(15), at(999_999)], ['a', 'a', 'b', 'b', null, null]);
  });

  test('rút thăm và tạo mã nhận quà không dùng Math.random', () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error('Math.random không đủ an toàn cho kết quả có giá trị');
    };
    try {
      drawPrize([{ prizeId: 'a', probabilityPpm: 500_000 }]);
      assert.match(issueClaimCode(), /^TA-[2-9A-HJKMNP-Z]{5}-[2-9A-HJKMNP-Z]{5}$/);
    } finally {
      Math.random = original;
    }
  });

  test('mã nhận quà không trùng trong 5.000 lần tạo; chuẩn hóa mã người dùng gõ', () => {
    assert.equal(new Set(Array.from({ length: 5000 }, issueClaimCode)).size, 5000);
    assert.equal(normalizeClaimCode(' ta-abcde - fghjk '), 'TA-ABCDE-FGHJK');
    assert.equal(normalizeClaimCode({ $ne: null }), '');
  });

  test('cách nói "1 trên N"', () => {
    assert.deepEqual([oneInN(1), oneInN(100), oneInN(333_333), oneInN(0)], [1_000_000, 10_000, 3, null]);
  });
});

describe('kiểm tra cấu hình quay thưởng', () => {
  const now = new Date('2026-06-01T00:00:00Z');
  const prize = (probabilityPpm, extra = {}) => ({ prizeId: 'a', prizeType: 'keychain', enabled: true, imageId: 'x', maxQuantity: 10, probabilityPpm, ...extra });
  const config = (prizes, extra = {}) => ({ prizes, claimInstructions: 'Nhận ở quầy', ...extra });
  const fieldsOf = (fn) => {
    try {
      fn();
    } catch (err) {
      assert.ok(err instanceof AdminError);
      return err.extra.fields;
    }
    return null;
  };

  test('giá trị biên của tổng xác suất: tối đa 100%, dưới 100% là có phần không trúng', () => {
    assert.equal(fieldsOf(() => validateForPublish(config([prize(1_000_000)]), now)), null);
    assert.equal(fieldsOf(() => validateForPublish(config([prize(1)]), now)), null);
    assert.ok(fieldsOf(() => validateForPublish(config([prize(1_000_001)]), now)).probabilityTotal);
    assert.ok(fieldsOf(() => validateForPublish(config([prize(600_000), prize(400_001, { prizeId: 'b' })]), now)).probabilityTotal);
  });

  test('để trống thời điểm bắt đầu nghĩa là áp dụng ngay; hẹn giờ giữ đúng mốc', () => {
    assert.equal(validateForPublish(config([prize(1_000)]), now), now);
    const later = new Date(now.getTime() + 3_600_000);
    assert.equal(validateForPublish(config([prize(1_000)], { effectiveFrom: later }), now), later);
  });

  test('số lượng phải lớn hơn số đã trúng; thiếu ảnh, thiếu hướng dẫn nhận quà, còn giải mã nạp cũ bị từ chối', () => {
    const usage = new Map([['a', 10]]);
    assert.match(fieldsOf(() => validateForPublish(config([prize(1_000)]), now, usage))['prizes.0.maxQuantity'], /Đã trúng 10/);
    assert.equal(fieldsOf(() => validateForPublish(config([prize(1_000, { maxQuantity: 11 })]), now, usage)), null);
    assert.ok(fieldsOf(() => validateForPublish(config([prize(1_000, { imageId: null })]), now))['prizes.0.imageId']);
    assert.ok(fieldsOf(() => validateForPublish(config([prize(1_000)], { claimInstructions: ' ' }), now)).claimInstructions);
    assert.ok(fieldsOf(() => validateForPublish(config([prize(1_000, { prizeType: 'phone_topup' })]), now))['prizes.0.label']);
  });

  test('chuẩn hóa: trường lạ bị bỏ, chuỗi được cắt khoảng trắng, loại giải luôn là móc khóa, ngân sách luôn trống', () => {
    const { prizes, budgetVnd } = normalizeConfigInput({
      prizes: [{ prizeId: ' a ', label: ' Tên ', description: ' Mô tả ', imageId: ' 0123456789abcdef01234567 ', probabilityPpm: 1, maxQuantity: 3, enabled: true, prizeType: 'tien-mat', carrier: 'Viettel', amountVnd: 10_000, hack: true }],
      budgetVnd: 50_000,
    });
    assert.deepEqual(prizes[0], { prizeId: 'a', label: 'Tên', prizeType: 'keychain', description: 'Mô tả', imageId: '0123456789abcdef01234567', probabilityPpm: 1, enabled: true, maxQuantity: 3 });
    assert.equal(budgetVnd, null);
  });
});

describe('khoảng báo cáo', () => {
  const now = new Date('2026-03-15T20:00:00Z'); // 03:00 ngày 16/03 giờ Việt Nam

  test('mặc định 30 ngày tính theo lịch Việt Nam', () => {
    const range = parseReportRange({}, now);
    assert.equal(range.to, '2026-03-16');
    assert.equal(range.from, '2026-02-15');
    assert.equal(range.periods.length, 30);
    assert.equal(range.start.toISOString(), '2026-02-14T17:00:00.000Z');
    assert.equal(range.end.toISOString(), '2026-03-16T17:00:00.000Z');
  });

  test('biên 366 ngày / 60 tháng; năm nhuận', () => {
    assert.equal(parseReportRange({ from: '2024-01-01', to: '2024-12-31' }, now).periods.length, 366);
    assert.throws(() => parseReportRange({ from: '2024-01-01', to: '2025-01-01' }, now), AdminError);
    assert.equal(parseReportRange({ from: '2021-01-15', to: '2025-12-20', granularity: 'month' }, now).periods.length, 60);
    assert.throws(() => parseReportRange({ from: '2021-01-15', to: '2026-01-01', granularity: 'month' }, now), AdminError);
    assert.throws(() => parseReportRange({ from: '2025-02-29', to: '2025-03-01' }, now), AdminError);
    assert.equal(parseReportRange({ from: '2024-02-29', to: '2024-03-01' }, now).periods.length, 2);
  });

  // Chạy ở tiến trình riêng: nếu vòng lặp không dừng thì test này báo đỏ thay vì treo cả bộ test
  const inChild = (query) => {
    const code = `import { parseReportRange } from ${JSON.stringify(new URL('../../src/services/adminStats.js', import.meta.url).href)};
      try { console.log(JSON.stringify(parseReportRange(${JSON.stringify(query)}).periods.map((p) => p.key))); } catch (err) { console.log(err.code); }`;
    return spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 });
  };

  test('F-56: năm dưới 1000 không làm vòng lặp theo tháng chạy mãi; khoảng rất dài bị từ chối trước khi dựng danh sách kỳ', () => {
    const short = inChild({ granularity: 'month', from: '0999-01-01', to: '0999-02-01' });
    assert.equal(short.error, undefined, 'tiến trình phải tự kết thúc');
    assert.deepEqual(JSON.parse(short.stdout), ['0999-01', '0999-02']);
    const long = inChild({ granularity: 'month', from: '0001-01-01', to: '9999-12-31' });
    assert.equal(long.error, undefined, 'tiến trình phải tự kết thúc');
    assert.equal(long.stdout.trim(), 'invalid_input');
  });

  test('ngày theo giờ Việt Nam', () => {
    assert.equal(localDate(new Date('2026-01-01T16:59:59Z')), '2026-01-01');
    assert.equal(localDate(new Date('2026-01-01T17:00:00Z')), '2026-01-02');
  });
});

describe('sự kiện phân tích', () => {
  const visitId = 'abcdef0123456789';

  test('chỉ giữ đúng trường trong danh sách cho phép', () => {
    assert.deepEqual(parseAnalyticsEvent({ type: 'page_view', page: 'home', visitId, target: 'x', email: 'a@b.vn' }), { type: 'page_view', page: 'home', visitId });
    assert.deepEqual(parseAnalyticsEvent({ type: 'click', target: 'home_primary_cta', visitId, page: 'home' }), { type: 'click', target: 'home_primary_cta', visitId });
  });

  test('tên trùng thuộc tính kế thừa không qua được', () => {
    for (const target of ['constructor', '__proto__', 'toString']) {
      assert.equal(parseAnalyticsEvent({ type: 'click', target, visitId }), null, target);
    }
    assert.equal(parseAnalyticsEvent(null), null);
    assert.equal(parseAnalyticsEvent(undefined), null);
  });

  test('mã ẩn danh đổi đúng lúc sang tháng theo giờ Việt Nam, không theo tháng UTC', () => {
    setEnv({ ANALYTICS_HASH_KEY: 'khoa-thu-nghiem-analytics' });
    const keyAt = (time) => actorKeyFor('507f1f77bcf86cd799439011', new Date(time));
    // 00:30 và 08:00 ngày 01/11 giờ Việt Nam: tháng UTC đổi giữa hai mốc nhưng vẫn là một tháng báo cáo
    assert.equal(keyAt('2026-10-31T17:30:00Z'), keyAt('2026-11-01T01:00:00Z'));
    // 23:59:59 ngày 31/10 và 00:00:00 ngày 01/11 giờ Việt Nam
    assert.notEqual(keyAt('2026-10-31T16:59:59Z'), keyAt('2026-10-31T17:00:00Z'));
  });
});

describe('tiện ích truy vấn và lỗi', () => {
  test('phân trang', () => {
    assert.deepEqual(parsePaging({}), { page: 1, pageSize: 20, skip: 0 });
    assert.deepEqual(parsePaging({ page: '3', pageSize: '10' }), { page: 3, pageSize: 10, skip: 20 });
    assert.deepEqual(parsePaging({ page: { $gt: 0 }, pageSize: '1000' }), { page: 1, pageSize: 100, skip: 0 });
  });

  test('ký tự đặc biệt của regex được thoát', () => {
    assert.equal(escapeRegex('a.b*c'), 'a\\.b\\*c');
    assert.equal(new RegExp(escapeRegex('(a|b)')).test('a'), false);
  });

  test('lỗi không lường trước trả thông báo chung, không lộ chi tiết; lỗi trùng khóa thành 409', () => {
    const original = console.error;
    console.error = () => {};
    try {
      const unknown = toAdminError(new Error('mongodb://user:pass@host'));
      assert.deepEqual([unknown.status, unknown.code, unknown.message], [500, 'server_error', 'Lỗi máy chủ.']);
    } finally {
      console.error = original;
    }
    assert.equal(toAdminError({ code: 11000 }).status, 409);
    assert.equal(toAdminError({ name: 'VersionError' }).code, 'version_conflict');
    assert.deepEqual(toAdminError({ name: 'ValidationError', errors: { a: { message: 'm' } } }).extra.fields, { a: 'm' });
  });
});
