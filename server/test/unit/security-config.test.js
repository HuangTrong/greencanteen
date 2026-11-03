// F-78: cấu hình làm yếu TLS, cookie hoặc để lộ MongoDB bị báo ngay lúc khởi động. Chỉ nêu tên biến, không in giá trị.
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { logSecurityConfig, securityConfigProblems } from '../../src/services/securityConfig.js';
import { setEnv } from '../helpers.js';

const SAFE = {
  NODE_ENV: 'production',
  CLIENT_ORIGIN: 'https://gc.example.edu.vn',
  MONGODB_URI: 'mongodb://gc:mat-khau-mongo@db.example.edu.vn:27017/greencanteen?tls=true',
  VISION_OLLAMA_URL: 'http://127.0.0.1:11434',
  CLAMAV_HOST: '127.0.0.1',
};
const keys = (vars) => {
  setEnv(vars);
  return securityConfigProblems().map((problem) => problem.key);
};

afterEach(() => {
  setEnv();
  delete process.env.MONGODB_URI;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
});

describe('securityConfigProblems', () => {
  test('cấu hình production đúng và môi trường phát triển: không có cảnh báo', () => {
    assert.deepEqual(keys(SAFE), []);
    process.env.MONGODB_URI = '';
    assert.deepEqual(keys({ MONGODB_URI: 'mongodb://127.0.0.1:27017/greencanteen' }), []);
  });

  for (const [label, vars, key] of [
    ['thiếu CLIENT_ORIGIN', { CLIENT_ORIGIN: '' }, 'CLIENT_ORIGIN'],
    ['CLIENT_ORIGIN http', { CLIENT_ORIGIN: 'http://gc.example.edu.vn' }, 'CLIENT_ORIGIN'],
    ['tắt cookie Secure', { COOKIE_SECURE: 'false' }, 'COOKIE_SECURE'],
    ['cho phép SMTP không mã hóa', { SMTP_ALLOW_PLAINTEXT: 'true' }, 'SMTP_ALLOW_PLAINTEXT'],
    ['tắt kiểm tra chứng chỉ', { NODE_TLS_REJECT_UNAUTHORIZED: '0' }, 'NODE_TLS_REJECT_UNAUTHORIZED'],
    ['Ollama http ngoài máy này', { VISION_OLLAMA_URL: 'http://10.0.0.5:11434' }, 'VISION_OLLAMA_URL'],
    ['MongoDB không có tài khoản', { MONGODB_URI: 'mongodb://db.example.edu.vn:27017/greencanteen?tls=true' }, 'MONGODB_URI'],
    ['MongoDB không TLS ngoài máy này', { MONGODB_URI: 'mongodb://gc:mat-khau@db.example.edu.vn:27017/greencanteen' }, 'MONGODB_URI'],
    ['MongoDB tắt TLS', { MONGODB_URI: 'mongodb+srv://gc:mat-khau@db.example.edu.vn/greencanteen?tls=false' }, 'MONGODB_URI'],
  ]) {
    test(`production: ${label}`, () => assert.ok(keys({ ...SAFE, ...vars }).includes(key), label));
  }

  test('NODE_ENV viết khác "production": các lớp bảo vệ theo production không bật nên phải báo', () => {
    for (const value of ['Production', 'PRODUCTION', 'prod']) {
      assert.ok(keys({ ...SAFE, NODE_ENV: value }).includes('NODE_ENV'), value);
    }
    assert.ok(!keys({ ...SAFE, NODE_ENV: 'development' }).includes('NODE_ENV'));
    assert.ok(!keys({ ...SAFE, NODE_ENV: 'test' }).includes('NODE_ENV'));
  });

  test('tắt kiểm tra chứng chỉ bị báo cả khi không phải production', () => {
    assert.deepEqual(keys({ NODE_TLS_REJECT_UNAUTHORIZED: '0' }), ['NODE_TLS_REJECT_UNAUTHORIZED']);
  });

  test('MongoDB loopback không cần tài khoản hay TLS; mongodb+srv mặc định có TLS', () => {
    assert.deepEqual(keys({ ...SAFE, MONGODB_URI: 'mongodb://127.0.0.1:27017/gc' }), []);
    assert.deepEqual(keys({ ...SAFE, MONGODB_URI: 'mongodb://localhost/gc' }), []);
    assert.deepEqual(keys({ ...SAFE, MONGODB_URI: 'mongodb+srv://gc:mat-khau@db.example.edu.vn/gc' }), []);
  });
});

describe('logSecurityConfig', () => {
  test('in tên biến, không in giá trị', (t) => {
    setEnv({ ...SAFE, MONGODB_URI: 'mongodb://gc:mat-khau-bi-mat@db.example.edu.vn:27017/gc' });
    const lines = [];
    t.mock.method(console, 'error', (...args) => lines.push(args.join(' ')));
    logSecurityConfig();
    assert.equal(lines.length, 1);
    assert.match(lines[0], /MONGODB_URI/);
    assert.doesNotMatch(lines[0], /mat-khau-bi-mat|db\.example/);
  });
});

describe('chuỗi cung ứng', () => {
  test('F-82: gói tải tệp thực thi khi cài đặt nhưng production không dùng không nằm trong dependencies', () => {
    const { dependencies } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url)));
    assert.equal(dependencies['mongodb-memory-server'], undefined);
    const source = fs.readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /^import .*mongodb-memory-server/m, 'chỉ nạp động khi đã qua kiểm tra không phải production');
  });
});
