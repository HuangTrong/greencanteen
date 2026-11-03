// Khởi động lại THẬT: chạy src/index.js thành tiến trình riêng trên cùng một MongoDB, admin thay đổi dữ liệu, tắt, chạy lại.
// Chứng minh nội dung admin quản lý còn nguyên sau khi server khởi động lại hoặc triển khai lại.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { GachaReward } from '../../src/models/GachaReward.js';
import { Story } from '../../src/models/Story.js';
import { User } from '../../src/models/User.js';
import { bootstrapFirstAdmin } from '../../src/services/adminBootstrap.js';
import { loadSeedStories } from '../../src/services/stories.js';
import { VERIFY_TOKEN, createClient, realFetch, setEnv } from '../helpers.js';
import { adminClient, currentCode, loginPassword } from '../adminHelpers.js';

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/index.js');
const password = 'mat-khau-quan-tri-khoi-dong-lai';
const mfaKey = crypto.randomBytes(32).toString('base64');

let mem;
let uri;
let port;
let running = null;

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });

/** Chạy server thật trên cùng một cổng. cwd là thư mục tạm nên server/.env của máy không được nạp. */
async function startServer() {
  const child = spawn(process.execPath, [entry], {
    cwd: os.tmpdir(),
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      PORT: String(port),
      MONGODB_URI: uri,
      NODE_ENV: 'test',
      ADMIN_MFA_KEY: mfaKey,
      VISION_SIMULATION: 'true',
      EMAIL_TRANSPORT: 'console',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running = child;
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (let i = 0; i < 150; i += 1) {
    try {
      if ((await realFetch(`http://127.0.0.1:${port}/api/health`)).ok) return { child, output: () => output };
    } catch {
      // chưa mở cổng
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error(`Server không khởi động được:\n${output}`);
}

async function stopServer({ child }) {
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

before(async () => {
  setEnv({ ADMIN_MFA_KEY: mfaKey });
  mem = await MongoMemoryServer.create();
  uri = mem.getUri('greencanteen-restart');
  port = await freePort();
  await mongoose.connect(uri);
});
after(async () => {
  // Test thất bại giữa chừng cũng không để lại tiến trình server (nếu không `node --test` sẽ treo mãi)
  running?.kill();
  await mongoose.disconnect();
  await mem.stop();
});

test('thay đổi câu chuyện, cấu hình Gacha, thiết lập và nhật ký còn nguyên qua hai lần khởi động lại', { timeout: 120_000 }, async () => {
  const base = `http://127.0.0.1:${port}`;
  const [firstSeed, secondSeed] = loadSeedStories();

  let server = await startServer();
  assert.match(server.output(), /Gacha: đã tạo cấu hình phiên bản 1/);

  const { user, enrollCode } = await bootstrapFirstAdmin({ email: 'can-bo-canteen@example.edu.vn', name: 'Cán Bộ Căn Tin', password });
  const admin = adminClient(base);
  await loginPassword(admin, user.email, password);
  const { secret } = (await admin.post('/api/admin/auth/mfa/setup', { json: { enrollCode } })).data;
  const verified = await admin.post('/api/admin/auth/mfa/verify', { json: { code: currentCode(secret) } });
  assert.equal(verified.status, 200);
  admin.setCsrf(verified.data.csrfToken);

  // Sửa một câu chuyện seed, gỡ một câu chuyện seed, tạo một bản nháp chưa có nguồn
  const stories = (await admin.get('/api/admin/stories?pageSize=100')).data.items;
  const edited = stories.find((s) => s.slug === firstSeed.slug);
  assert.equal((await admin.put(`/api/admin/stories/${edited.id}`, { json: { ...edited, title: 'Tiêu đề do admin sửa', revision: edited.revision } })).status, 200);
  const removed = stories.find((s) => s.slug === secondSeed.slug);
  assert.equal((await admin.post(`/api/admin/stories/${removed.id}/unpublish`, { json: { revision: removed.revision } })).status, 200);
  assert.equal((await admin.post('/api/admin/stories', { json: { slug: 'nhap-qua-khoi-dong', title: 'Nháp chưa có nguồn' } })).status, 201);

  // Xuất bản cấu hình Gacha mới
  const draft = (await admin.post('/api/admin/gacha/configs', { json: {} })).data;
  const prizes = [{ prizeId: 'chi-20k', label: 'Mã nạp điện thoại', carrier: 'Viettel', amountVnd: 20_000, probabilityPpm: 1_000_000, enabled: true, maxQuantity: 100 }];
  const saved = await admin.put(`/api/admin/gacha/configs/${draft.id}`, { json: { prizes, revision: draft.revision } });
  assert.equal((await admin.post(`/api/admin/gacha/configs/${draft.id}/publish`, { json: { revision: saved.data.revision } })).status, 200);

  // Thiết lập website
  const { revision, headerTagline, seoDescription, announcementEnabled, announcementText, supportContact } = (await admin.get('/api/admin/site-settings')).data;
  const settings = await admin.put('/api/admin/site-settings', {
    json: { revision, headerTagline, seoDescription, announcementEnabled, announcementText, supportContact, heroTitle: 'Tiêu đề do admin đặt' },
  });
  assert.equal(settings.status, 200);

  // Sinh viên quay Gacha theo cấu hình mới
  const student = createClient(base);
  const form = { name: 'Sinh Viên Khởi Động', studentId: 'SV-KHOI-DONG', email: 'sv-khoi-dong@example.edu.vn', password: 'mat-khau-an-toan-1' };
  assert.equal((await student.post('/api/auth/register', { json: form })).status, 202);
  // Server là tiến trình riêng ở chế độ email console: đọc liên kết từ log của nó
  for (let i = 0; i < 50 && !VERIFY_TOKEN.test(server.output()); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  const reg = await student.post('/api/auth/email/verify', { json: { token: server.output().match(VERIFY_TOKEN)[1], password: form.password } });
  await User.updateOne({ _id: reg.data.user.id }, { $set: { pendingGachaSpins: 1 } });
  assert.equal((await student.post('/api/gacha/spin')).data.prize.amountVnd, 20_000);

  for (let restart = 1; restart <= 2; restart += 1) {
    await stopServer(server);
    server = await startServer();
    assert.match(server.output(), /kept \d+ admin-managed/, `lần khởi động lại ${restart}`);

    assert.equal((await Story.findOne({ slug: firstSeed.slug }).lean()).title, 'Tiêu đề do admin sửa');
    assert.equal((await Story.findOne({ slug: secondSeed.slug }).lean()).status, 'archived');
    assert.equal((await Story.findOne({ slug: 'nhap-qua-khoi-dong' }).lean()).status, 'draft');
    assert.equal((await createClient(base).get('/api/site/settings')).data.heroTitle, 'Tiêu đề do admin đặt');

    await User.updateOne({ _id: reg.data.user.id }, { $set: { pendingGachaSpins: 1 } });
    assert.equal((await student.post('/api/gacha/spin')).data.prize.amountVnd, 20_000, 'cấu hình mới vẫn có hiệu lực');
  }

  const rewards = await GachaReward.find({ userId: reg.data.user.id }).lean();
  assert.equal(rewards.length, 3);
  assert.ok(rewards.every((reward) => reward.configVersion === draft.version && reward.prizeId === 'chi-20k'));

  // Phiên quản trị lưu trong DB nên còn dùng được sau khởi động lại; nhật ký còn đủ
  const logs = await admin.get('/api/admin/audit-logs?pageSize=100');
  assert.equal(logs.status, 200);
  const actions = logs.data.items.map((item) => item.action);
  for (const action of ['admin.bootstrap', 'story.update', 'story.unpublish', 'story.create', 'gacha.config_publish', 'site_settings.update']) {
    assert.ok(actions.includes(action), action);
  }

  await stopServer(server);
});
