// F-51: tấn công upload ở mức giao thức, gửi byte thô qua socket 127.0.0.1 tới API ở tiến trình riêng (test/fakes/upload-target.mjs).
// Payload chỉ là chuỗi multipart tự tạo, không có mã độc. Tiêu chí: server không sập, event loop không bị chặn, tệp tạm được dọn.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { uploadDir } from '../../src/routes/checkin.js';
import { realFetch, uniquePng } from '../helpers.js';

const TARGET = fileURLToPath(new URL('../fakes/upload-target.mjs', import.meta.url));
const BOUNDARY = 'gcboundary';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const HEALTH_LIMIT_MS = 3000;

const part = (disposition, type = '') => Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n${type && `Content-Type: ${type}\r\n`}\r\n`);
const textField = (name, value) => Buffer.concat([part(`form-data; name="${name}"`), Buffer.from(`${value}\r\n`)]);
const imagePart = (name = 'image') => Buffer.concat([part(`form-data; name="${name}"; filename="a.png"`, 'image/png'), PNG, Buffer.from('\r\n')]);
const closing = Buffer.from(`--${BOUNDARY}--\r\n`);
const body = (...parts) => Buffer.concat(parts);

let target;

function startTarget() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TARGET], { stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, exitCode: null, output: '' };
    const timer = setTimeout(() => reject(new Error(`tiến trình đích không chạy: ${state.output}`)), 60_000);
    child.on('exit', (code) => {
      state.exitCode = code;
    });
    const collect = (chunk) => {
      state.output += chunk;
      const line = state.output.split('\n').find((text) => text.startsWith('{'));
      if (line && !state.base) {
        clearTimeout(timer);
        resolve(Object.assign(state, JSON.parse(line)));
      }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
  });
}

/** Gửi nguyên văn qua socket: pieces là các khối gửi tách nhau, declared là Content-Length khai báo, closeEarlyMs ngắt kết nối sau khi gửi */
function send(method, url, pieces, { declared, closeEarlyMs, timeoutMs = 5000 } = {}) {
  const total = pieces.reduce((sum, piece) => sum + piece.length, 0);
  return new Promise((resolve) => {
    let reply = '';
    const socket = net.connect(new URL(target.base).port, '127.0.0.1', async () => {
      socket.write(
        `${method} ${url} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${target.cookie}\r\nX-Requested-With: GreenCanteen\r\nContent-Type: multipart/form-data; boundary=${BOUNDARY}\r\nContent-Length: ${declared ?? total}\r\nConnection: close\r\n\r\n`
      );
      for (const piece of pieces) {
        if (socket.destroyed) return;
        socket.write(piece);
        await new Promise((next) => setImmediate(next));
      }
      if (closeEarlyMs !== undefined) setTimeout(() => socket.destroy(), closeEarlyMs);
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve({ status: null });
    }, timeoutMs);
    socket.on('data', (chunk) => (reply += chunk));
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ status: Number(reply.split(' ')[1]) || null, reply });
    });
  });
}

async function assertServerAlive(label) {
  assert.equal(target.exitCode, null, `${label}: tiến trình sập: ${target.output.split('\n').filter((line) => /UNCAUGHT|UNHANDLED/.test(line)).join(' ')}`);
  const res = await realFetch(`${target.base}/api/health`, { signal: AbortSignal.timeout(HEALTH_LIMIT_MS) });
  assert.equal(res.status, 200, label);
}

/** Nếu server đã chết hay bị treo thì dựng lại, để một ca đỏ không kéo theo các ca sau */
async function restartIfDown() {
  const alive = target.exitCode === null && (await realFetch(`${target.base}/api/health`, { signal: AbortSignal.timeout(HEALTH_LIMIT_MS) }).then((res) => res.ok, () => false));
  if (alive) return;
  target.child.kill('SIGKILL');
  target = await startTarget();
}

before(async () => {
  target = await startTarget();
});
after(() => {
  target.child.kill('SIGKILL');
});

describe('F-51: multipart không làm sập hay treo tiến trình API', () => {
  const checkInCases = [
    ['chỉ số mảng khổng lồ trong tên trường (GHSA-535w-7cp7-47q4)', () => [body(textField('a[4294967294]', '1'), textField('a[x]', '2'), closing)]],
    ['tên trường lồng sâu', () => [body(textField(`a${'[b]'.repeat(32)}`, '1'), closing)]],
    ['khóa __proto__ và constructor', () => [body(textField('__proto__[x]', '1'), textField('constructor[prototype][y]', '1'), imagePart(), closing)]],
    ['tệp không có name', () => [body(Buffer.concat([part('form-data; filename="a.png"', 'image/png'), PNG, Buffer.from('\r\n')]), closing)]],
    ['tệp name rỗng', () => [body(Buffer.concat([part('form-data; name=""; filename="a.png"', 'image/png'), PNG, Buffer.from('\r\n')]), closing)]],
    ['đầu phần hỏng', () => [body(Buffer.from(`--${BOUNDARY}\r\n${'x'.repeat(20_000)}\r\n\r\n`), closing)]],
    ['thiếu boundary đóng', () => [body(imagePart())]],
    ['tệp ở trường lạ, thiếu boundary đóng', () => [body(imagePart('khac'))]],
  ];

  for (const [label, pieces] of checkInCases) {
    test(`POST /api/checkin: ${label}`, async () => {
      await restartIfDown();
      const res = await send('POST', '/api/checkin', pieces());
      await new Promise((resolve) => setTimeout(resolve, 100));
      await assertServerAlive(label);
      assert.ok(res.status === null || res.status < 500, `HTTP ${res.status}`);
    });
  }

  test('nhiều trường văn bản hoặc tên trường dài bị từ chối trước khi vào bộ phân tích tên trường của thư viện', async () => {
    await restartIfDown();
    for (const payload of [
      body(textField('studentId', 'SV01'), textField('khac', '1'), closing),
      body(textField('a[1]', '1'), closing),
      body(textField('a[b]', '1'), closing),
      body(textField('a'.repeat(33), '1'), closing),
      body(textField('studentId', 'x'.repeat(300)), closing),
    ]) {
      const res = await send('POST', '/api/checkin', [payload]);
      assert.equal(res.status, 400, payload.toString().slice(0, 80));
      assert.match(res.reply, /invalid_upload/);
    }
    await assertServerAlive('giới hạn trường');
  });

  // Lỗi của multer 1.x phụ thuộc thứ tự sự kiện khi thân bị cắt giữa phần đầu: lặp nhiều lần với nhiều vị trí cắt và nhiều cách chia khối
  test('thân bị cắt ở mọi vị trí, gửi theo một hoặc hai khối: tiến trình không sập', async () => {
    await restartIfDown();
    const full = body(textField('studentId', 'SV01'), imagePart(), closing);
    for (let round = 0; round < 3; round += 1) {
      for (let cut = 1; cut < full.length; cut += 7) {
        const payload = full.subarray(0, cut);
        const split = Math.ceil(cut / 2);
        await send('POST', '/api/checkin', split < cut ? [payload.subarray(0, split), payload.subarray(split)] : [payload], { timeoutMs: 1000 });
        assert.equal(target.exitCode, null, `sập khi cắt ở byte ${cut}: ${target.output.split('\n').filter((line) => /UNCAUGHT|UNHANDLED/.test(line)).join(' ')}`);
      }
    }
    await assertServerAlive('thân bị cắt');
  });

  test('PUT /api/avatars/me: trường văn bản bị từ chối ngay, tệp hỏng không làm sập', async () => {
    await restartIfDown();
    const fields = await send('PUT', '/api/avatars/me', [body(textField('a[4294967294]', '1'), textField('a[x]', '2'), closing)]);
    assert.equal(fields.status, 400);
    await send('PUT', '/api/avatars/me', [body(imagePart())]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await assertServerAlive('avatar');
  });

  test('sau mọi phép thử, ảnh hợp lệ vẫn check-in được', async () => {
    await restartIfDown();
    const image = Buffer.concat([part('form-data; name="image"; filename="b.png"', 'image/png'), uniquePng(), Buffer.from('\r\n')]);
    const valid = await send('POST', '/api/checkin', [body(image, closing)]);
    assert.equal(valid.status, 200);
  });
});

describe('F-51: ngắt kết nối giữa lúc upload', () => {
  test('tệp tạm được dọn ngay, không chờ tới lần dọn định kỳ', async () => {
    await restartIfDown();
    const before = new Set(fs.readdirSync(uploadDir));
    const partial = Buffer.concat([part('form-data; name="image"; filename="a.png"', 'image/png'), Buffer.alloc(256 * 1024, 0x41)]);
    for (let i = 0; i < 3; i += 1) {
      await send('POST', '/api/checkin', [partial], { declared: 4 * 1024 * 1024, closeEarlyMs: 50, timeoutMs: 1000 });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const left = fs.readdirSync(uploadDir).filter((name) => !before.has(name));
    for (const name of left) fs.rmSync(path.join(uploadDir, name), { force: true });
    assert.deepEqual(left, []);
    await assertServerAlive('ngắt kết nối');
  });
});
