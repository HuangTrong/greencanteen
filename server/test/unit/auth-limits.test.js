// F-04: giá trị cấu hình của giới hạn theo IP, khóa IP, cấu hình TRUST_PROXY (bảng quyết định)
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { authLimits } from '../../src/services/authLimits.js';
import { clientIpKey, logProxyStatus, trustProxySetting } from '../../src/services/rateLimit.js';
import { setEnv } from '../helpers.js';

afterEach(() => setEnv());

const ip = (value) => clientIpKey({ ip: value });

describe('ngưỡng cấu hình được', () => {
  test('giá trị mặc định đã ghi trong tài liệu', () => {
    setEnv({ AUTH_REGISTER_IP_MAX: '' });
    const limits = authLimits();
    assert.deepEqual(limits.loginIp, { max: 100, windowMs: 15 * 60_000 });
    assert.deepEqual(limits.registerIp, { max: 100, windowMs: 60 * 60_000 });
    assert.deepEqual(limits.verifyEmail, { max: 5, windowMs: 60 * 60_000 });
  });

  test('đọc từ biến môi trường lúc gọi', () => {
    setEnv({
      AUTH_LOGIN_IP_MAX: '250',
      AUTH_LOGIN_IP_WINDOW_MINUTES: '30',
      AUTH_REGISTER_IP_MAX: '400',
      AUTH_REGISTER_IP_WINDOW_MINUTES: '120',
      AUTH_VERIFY_EMAIL_MAX: '8',
      AUTH_VERIFY_EMAIL_WINDOW_MINUTES: '90',
    });
    assert.deepEqual(authLimits(), {
      loginIp: { max: 250, windowMs: 30 * 60_000 },
      registerIp: { max: 400, windowMs: 120 * 60_000 },
      verifyEmail: { max: 8, windowMs: 90 * 60_000 },
    });
  });

  test('giá trị sai định dạng → mặc định; 0 hoặc âm không tắt được giới hạn', () => {
    setEnv({ AUTH_LOGIN_IP_MAX: 'nhieu', AUTH_REGISTER_IP_MAX: '0', AUTH_VERIFY_EMAIL_MAX: '-5', AUTH_LOGIN_IP_WINDOW_MINUTES: '0' });
    const limits = authLimits();
    assert.equal(limits.loginIp.max, 100);
    assert.equal(limits.registerIp.max, 1);
    assert.equal(limits.verifyEmail.max, 1);
    assert.equal(limits.loginIp.windowMs, 60_000);
  });
});

describe('khóa giới hạn theo IP', () => {
  test('IPv4 giữ nguyên; IPv4 ánh xạ trong IPv6 quy về IPv4', () => {
    assert.equal(ip('203.0.113.7'), '203.0.113.7');
    assert.equal(ip('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(ip('::FFFF:203.0.113.7'), '203.0.113.7');
  });

  test('IPv6 gộp theo /64: cùng mạng cùng khóa, khác mạng khác khóa', () => {
    assert.equal(ip('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), ip('2001:db8:1:2::1'));
    assert.equal(ip('2001:0db8:0001:0002::1'), ip('2001:db8:1:2::ffff'));
    assert.notEqual(ip('2001:db8:1:2::1'), ip('2001:db8:1:3::1'));
    assert.equal(ip('::1'), '0:0:0:0::/64');
    assert.equal(ip('fe80::1%eth0'), ip('fe80::2'));
  });

  test('thiếu IP hoặc giá trị lạ không làm lỗi', () => {
    assert.equal(ip(undefined), 'unknown');
    assert.equal(ip(''), 'unknown');
    assert.equal(ip('khong-phai-ip'), 'khong-phai-ip');
  });
});

describe('TRUST_PROXY', () => {
  for (const [raw, expected] of [
    ['', false],
    ['false', false],
    ['0', false],
    ['true', false],
    ['TRUE', false],
    ['*', false],
    ['0.0.0.0/0', false],
    ['::/0', false],
    ['loopback, ::/0', false],
    ['1', 1],
    ['2', 2],
    ['loopback', ['loopback']],
    ['10.0.0.5', ['10.0.0.5']],
    ['10.0.0.5, 10.0.0.6', ['10.0.0.5', '10.0.0.6']],
    ['loopback,172.18.0.0/16', ['loopback', '172.18.0.0/16']],
  ]) {
    test(`"${raw}" → ${JSON.stringify(expected)}`, () => assert.deepEqual(trustProxySetting(raw), expected));
  }
});

describe('cảnh báo cấu hình TRUST_PROXY lúc khởi động', () => {
  function logsFor(raw) {
    const lines = [];
    const originals = { error: console.error, warn: console.warn };
    console.error = (...args) => lines.push(`error: ${args.join(' ')}`);
    console.warn = (...args) => lines.push(`warn: ${args.join(' ')}`);
    try {
      logProxyStatus(raw);
    } finally {
      Object.assign(console, originals);
    }
    return lines;
  }

  test('tin mọi nguồn → báo lỗi; số proxy → cảnh báo; địa chỉ proxy hoặc không có proxy → không có gì', () => {
    assert.match(logsFor('true')[0], /^error: TRUST_PROXY=true tin mọi nguồn nên bị bỏ qua/);
    assert.match(logsFor('1')[0], /^warn: TRUST_PROXY=1: chỉ an toàn khi cổng API không mở trực tiếp/);
    for (const raw of ['', 'false', '0', 'loopback', '10.0.0.5']) assert.deepEqual(logsFor(raw), [], raw);
  });
});
