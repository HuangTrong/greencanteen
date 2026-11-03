// F-79, F-80: một nguồn gửi dồn dập và kết nối giữ chậm. Chỉ chạy trên 127.0.0.1 với MongoDB in-memory; số yêu cầu nhỏ, đủ để qua ngưỡng đặt riêng cho test.
import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import net from 'node:net';
import { createApp } from '../../src/app.js';
import { resetFloodGuard } from '../../src/middleware/floodGuard.js';
import { createHttpServer } from '../../src/services/httpServer.js';
import { createClient, setEnv, startTestServer } from '../helpers.js';

let ctx;
const client = () => createClient(ctx.base);

before(async () => {
  setEnv();
  ctx = await startTestServer();
});
after(() => ctx.stop());
beforeEach(() => {
  setEnv();
  resetFloodGuard();
});

describe('một nguồn gửi dồn dập', () => {
  test('quá ngưỡng: trả 429 kèm Retry-After, kể cả đường dẫn không tồn tại và thân JSON lớn', async () => {
    setEnv({ API_RATE_LIMIT_PER_MINUTE: '20' });
    const c = client();
    const sent = await Promise.all(Array.from({ length: 30 }, (_, i) => c.get(i % 2 ? '/api/site/settings' : '/api/khong-co-route')));
    assert.equal(sent.filter((res) => res.status === 429).length, 10);
    const blocked = await c.post('/api/auth/login', { json: { email: 'a@example.edu.vn', password: 'x'.repeat(90_000) } });
    assert.equal(blocked.status, 429);
    assert.equal(blocked.data.code, 'too_many_requests');
    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(retryAfter >= 1 && retryAfter <= 60, `Retry-After ${retryAfter}`);
  });

  test('/api/health không bị tính: giám sát vẫn thấy dịch vụ sống trong lúc bị dồn tải', async () => {
    setEnv({ API_RATE_LIMIT_PER_MINUTE: '3' });
    const c = client();
    for (let i = 0; i < 5; i += 1) await c.get('/api/stats/school');
    assert.equal((await c.get('/api/stats/school')).status, 429);
    assert.equal((await c.get('/api/health')).status, 200);
  });

  test('qua proxy tin cậy mỗi IP một ngân sách; X-Forwarded-For tự đặt không thoát được khi không có proxy', async () => {
    setEnv({ API_RATE_LIMIT_PER_MINUTE: '3' });
    const c = client();
    for (let i = 0; i < 3; i += 1) await c.get('/api/auth/providers', { headers: { 'X-Forwarded-For': `203.0.113.${i}` } });
    assert.equal((await c.get('/api/auth/providers', { headers: { 'X-Forwarded-For': '203.0.113.200' } })).status, 429);

    setEnv({ API_RATE_LIMIT_PER_MINUTE: '3', TRUST_PROXY: 'loopback' });
    resetFloodGuard();
    const server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const behindProxy = createClient(`http://127.0.0.1:${server.address().port}`);
      const from = (ip) => behindProxy.get('/api/auth/providers', { headers: { 'X-Forwarded-For': ip } });
      for (let i = 0; i < 3; i += 1) assert.equal((await from('203.0.113.1')).status, 200);
      assert.equal((await from('203.0.113.1')).status, 429);
      assert.equal((await from('203.0.113.2')).status, 200);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('đặt 0 thì tắt; giá trị sai thì dùng mặc định', async () => {
    setEnv({ API_RATE_LIMIT_PER_MINUTE: '0' });
    const c = client();
    const results = await Promise.all(Array.from({ length: 50 }, () => c.get('/api/auth/providers')));
    assert.ok(results.every((res) => res.status === 200));
    setEnv({ API_RATE_LIMIT_PER_MINUTE: 'abc' });
    assert.equal((await c.get('/api/auth/providers')).status, 200);
  });
});

describe('kết nối giữ chậm (slowloris)', () => {
  test('giá trị mặc định: header 20 giây, cả yêu cầu 120 giây', () => {
    const server = createHttpServer(createApp());
    assert.equal(server.headersTimeout, 20_000);
    assert.equal(server.requestTimeout, 120_000);
    server.close();
  });

  test('gửi header nhỏ giọt: server tự đóng kết nối, không chờ tới mặc định của Node', async () => {
    const server = createHttpServer(createApp(), { headersTimeout: 400, requestTimeout: 800, connectionsCheckingInterval: 100 });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const started = Date.now();
    const socket = net.connect(server.address().port, '127.0.0.1', () => socket.write('GET /api/health HTTP/1.1\r\nHost: 127.0.0.1\r\n'));
    const drip = setInterval(() => socket.writable && socket.write('X-Cham: 1\r\n'), 100);
    socket.on('error', () => {});
    await new Promise((resolve) => socket.on('close', resolve));
    clearInterval(drip);
    const elapsed = Date.now() - started;
    await new Promise((resolve) => server.close(resolve));
    assert.ok(elapsed < 3000, `đóng sau ${elapsed} ms`);
  });
});
