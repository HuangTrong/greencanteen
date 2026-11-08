import { once } from 'node:events';
import zlib from 'node:zlib';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp } from '../src/app.js';

// fetch gốc — các test có thể thay globalThis.fetch để giả lập nhà cung cấp AI mà không ảnh hưởng client test
export const realFetch = globalThis.fetch;

const MANAGED_ENV = [
  'NODE_ENV',
  'VISION_SIMULATION',
  'VISION_SIMULATED_CATEGORY',
  'VISION_SIMULATED_CONFIDENCE',
  'VISION_CONFIDENCE_THRESHOLD',
  'VISION_ENGINE',
  'VISION_CLASSIFIER_MODEL',
  'VISION_CLASSIFIER_THREADS',
  'VISION_MODEL_DIR',
  'VISION_MAX_QUEUE',
  'CHECKIN_COOLDOWN_MINUTES',
  'CHECKIN_MAX_IMAGE_MB',
  'EMAIL_TRANSPORT',
  'SMTP_HOST',
  'EMAIL_FROM',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'FACEBOOK_APP_ID',
  'FACEBOOK_APP_SECRET',
  'FACEBOOK_GRAPH_VERSION',
  'GOOGLE_CALLBACK_URL',
  'FACEBOOK_CALLBACK_URL',
  'CLIENT_ORIGIN',
  'COOKIE_SECURE',
  'COOKIE_SAMESITE',
  'QR_LOGIN_ENABLED',
  'VISION_TIMEOUT_MS',
  'VISION_SELF_CHECK',
  'VISION_MODEL_URL',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_ALLOW_PLAINTEXT',
  'ADMIN_MFA_KEY',
  'ADMIN_SESSION_IDLE_MINUTES',
  'ADMIN_SESSION_MAX_HOURS',
  'ADMIN_REAUTH_MINUTES',
  'ANALYTICS_ENABLED',
  'ANALYTICS_HASH_KEY',
  'ANALYTICS_RETENTION_DAYS',
  'TRUST_PROXY',
  'AUTH_LOGIN_IP_MAX',
  'AUTH_LOGIN_IP_WINDOW_MINUTES',
  'AUTH_REGISTER_IP_MAX',
  'AUTH_REGISTER_IP_WINDOW_MINUTES',
  'AUTH_VERIFY_EMAIL_MAX',
  'AUTH_VERIFY_EMAIL_WINDOW_MINUTES',
  'STATS_CACHE_SECONDS',
  'API_RATE_LIMIT_PER_MINUTE',
  'CAPTCHA_MODE',
  'CAPTCHA_ITERATIONS',
  'CAPTCHA_DIFFICULTY_BITS',
  'CAPTCHA_GLOBAL_FAILURES',
  'CAPTCHA_IP_FAILURES',
  'CAPTCHA_GLOBAL_MAIL',
  'CAPTCHA_ISSUE_PER_10_MINUTES',
  'CLAMAV_HOST',
  'CLAMAV_PORT',
  'CLAMAV_TIMEOUT_MS',
  'HOST',
  'CHECKIN_DAILY_MAX',
  'ANALYTICS_EVENTS_PER_VISIT',
  'ANALYTICS_VISITS_PER_IP',
];

/**
 * Đặt biến môi trường cho test (bỏ biến không liệt kê) — cấu hình được đọc lại ở mỗi request. Giới hạn đăng ký theo IP mặc định
 * được nới rộng vì mọi test chạy từ 127.0.0.1; test về chính giới hạn này tự đặt ngưỡng (chuỗi rỗng = giá trị mặc định của server).
 * Cache thống kê công khai tắt vì test ghi thẳng vào DB rồi đọc lại; test về chính cache tự bật. Giới hạn toàn cục tắt vì mọi test
 * dùng chung một IP; test về chính giới hạn này tự đặt ngưỡng. CAPTCHA tắt vì test không tự giải; test về chính CAPTCHA tự bật.
 */
export function setEnv(vars = {}) {
  for (const key of MANAGED_ENV) delete process.env[key];
  // Thời gian chờ và trần lượt thưởng mỗi ngày (SEC-02) tắt vì nhiều test check-in liên tiếp bằng một tài khoản; test về chính hai giới hạn này tự đặt
  Object.assign(
    process.env,
    { AUTH_REGISTER_IP_MAX: '1000000', STATS_CACHE_SECONDS: '0', API_RATE_LIMIT_PER_MINUTE: '0', CAPTCHA_MODE: 'off', CHECKIN_COOLDOWN_MINUTES: '0', CHECKIN_DAILY_MAX: '0' },
    vars
  );
}

export async function startTestServer() {
  const mem = await MongoMemoryServer.create();
  await mongoose.connect(mem.getUri('greencanteen-test'));
  // Đảm bảo index (unique, TTL...) đã tạo xong trước khi test các tình huống đồng thời
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
      await mongoose.disconnect();
      await mem.stop();
    },
  };
}

/** Client HTTP có "hũ cookie" riêng — mô phỏng một trình duyệt / thiết bị */
export function createClient(base) {
  const jar = new Map();

  async function request(method, path, { json, form, headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (csrf) h['X-Requested-With'] = 'GreenCanteen';
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let body;
    if (json !== undefined) {
      h['Content-Type'] = 'application/json';
      body = typeof json === 'string' ? json : JSON.stringify(json);
    } else if (form) {
      body = form;
    }
    const res = await realFetch(base + path, { method, headers: h, body, redirect: 'manual' });
    for (const cookie of res.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (!value || /expires=thu, 01 jan 1970/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data, headers: res.headers };
  }

  return {
    jar,
    request,
    get: (path, opts) => request('GET', path, opts),
    post: (path, opts) => request('POST', path, opts),
    put: (path, opts) => request('PUT', path, opts),
    patch: (path, opts) => request('PATCH', path, opts),
    del: (path, opts) => request('DELETE', path, opts),
  };
}

let counter = 0;
export function uniqueSuffix() {
  counter += 1;
  return `${Date.now().toString(36)}${counter}`;
}

// Thư do /register gửi được giữ trong bộ nhớ: không in ra log, không cần SMTP thật. Test về chính luồng thư dùng test/fakes/smtp.js.
const consoleMail = new Map();
const consoleMailState = { depth: 0, restore: null };

function holdConsoleMail() {
  if (consoleMailState.depth++ > 0) return;
  const saved = { log: console.log, env: { ...process.env } };
  console.log = (...args) => {
    const text = args.join(' ');
    if (!text.includes('[EMAIL — chế độ console')) return saved.log(...args);
    consoleMail.set(text.match(/Tới: (.+)/)?.[1]?.trim(), text);
  };
  process.env.EMAIL_TRANSPORT = 'console';
  delete process.env.NODE_ENV; // chế độ console bị chặn khi production; bước xác minh vẫn chạy với NODE_ENV của test
  consoleMailState.restore = () => {
    console.log = saved.log;
    for (const key of ['EMAIL_TRANSPORT', 'NODE_ENV']) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
  };
}

function releaseConsoleMail() {
  if (--consoleMailState.depth === 0) consoleMailState.restore();
}

export const VERIFY_TOKEN = /#verify=([A-Za-z0-9_-]{43})/;

/**
 * Gửi form đăng ký, chưa xác minh. Trả về phản hồi của /register, thư đã gửi (mail) và token trong thư nếu có.
 * raw: chuỗi JSON gửi nguyên văn thay cho form (vd. khóa __proto__), overrides khi đó chỉ để biết email và mật khẩu.
 */
export async function submitRegistration(client, overrides = {}, { raw } = {}) {
  const suffix = uniqueSuffix();
  const body = {
    name: 'Sinh Viên Test',
    studentId: `SV${suffix}`,
    email: `sv${suffix}@example.edu.vn`,
    password: 'mat-khau-an-toan-1',
    ...overrides,
  };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  holdConsoleMail();
  try {
    consoleMail.delete(email);
    const res = await client.post('/api/auth/register', { json: raw ?? body });
    const mail = consoleMail.get(email) || null;
    consoleMail.delete(email);
    return { ...res, body, mail, token: mail?.match(VERIFY_TOKEN)?.[1] || null };
  } finally {
    releaseConsoleMail();
  }
}

/** Tài khoản đã kích hoạt, client có phiên đăng nhập: đi đủ luồng đăng ký → thư → xác minh. Bị từ chối → trả nguyên phản hồi của /register */
export async function registerUser(client, overrides = {}, options) {
  const res = await submitRegistration(client, overrides, options);
  if (res.status !== 202 || !res.token) return res;
  const { body, token } = res;
  const verified = await client.post('/api/auth/email/verify', { json: { token, password: body.password, claimCode: body.claimCode } });
  return { ...verified, body, token };
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** Ảnh PNG 1×1 hợp lệ, mỗi lần một màu: server nhận dạng ảnh theo điểm ảnh (F-55) nên nối thêm byte vào tệp không tạo được ảnh mới */
export function uniquePng() {
  counter += 1;
  const header = Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]); // 1×1, 8 bit, RGB
  const pixel = Buffer.from([0, (counter >> 16) & 255, (counter >> 8) & 255, counter & 255]);
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', zlib.deflateSync(pixel)), pngChunk('IEND', Buffer.alloc(0))]);
}

export function imageForm(buffer, { type = 'image/png', name = 'photo.png', field = 'image', extra } = {}) {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), name);
  if (extra) for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}
