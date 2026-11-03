// Chạy thật lệnh quản trị bằng tiến trình riêng: đường duy nhất tạo được admin đầu tiên
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { AdminMfa } from '../../src/models/AdminMfa.js';
import { AdminSession } from '../../src/models/AdminSession.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { CheckIn } from '../../src/models/CheckIn.js';
import { EmailVerification } from '../../src/models/EmailVerification.js';
import { GachaReward } from '../../src/models/GachaReward.js';
import { Passkey } from '../../src/models/Passkey.js';
import { PasswordReset } from '../../src/models/PasswordReset.js';
import { PendingMfaLogin } from '../../src/models/PendingMfaLogin.js';
import { QrLogin } from '../../src/models/QrLogin.js';
import { RewardedImage } from '../../src/models/RewardedImage.js';
import { Session } from '../../src/models/Session.js';
import { User } from '../../src/models/User.js';
import { UserAvatar } from '../../src/models/UserAvatar.js';
import { UserMfa } from '../../src/models/UserMfa.js';
import { WebauthnChallenge } from '../../src/models/WebauthnChallenge.js';
import { USER_DATA_MODELS } from '../../src/services/accountDeletion.js';
import { verifyPassword } from '../../src/services/password.js';
import { setEnv } from '../helpers.js';

const entry = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/admin-cli.js');
const fakeTty = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fakes/tty-stdin.mjs')).href;
const mfaKey = crypto.randomBytes(32).toString('base64');
const password = 'mat-khau-quan-tri-tu-dong-lenh';
const email = 'can-bo-cli@example.edu.vn';

let mem;
let uri;

/** cwd là thư mục tạm nên server/.env của máy không được nạp; mật khẩu đưa qua stdin như dấu nhắc */
function runCli(args, { input = '', env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MONGODB_URI: uri, ADMIN_MFA_KEY: mfaKey, ...env },
    });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.stdin.end(input);
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Như người gõ ở terminal thật: mỗi dấu nhắc trả lời một dòng, kết thúc bằng phím Enter (\r) */
function runAtTerminal(args, answers) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', fakeTty, entry, ...args], {
      cwd: os.tmpdir(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, MONGODB_URI: uri, ADMIN_MFA_KEY: mfaKey },
    });
    const pending = [...answers];
    let output = '';
    // Lệnh treo thì test hỏng chứ không được kẹt cả lượt npm test
    const guard = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (!pending.length || !/: $/.test(output)) return;
      // stdin ở đây là pipe, để mở thì tiến trình con không thoát được; terminal thật không có vấn đề này
      const answer = `${pending.shift()}\r`;
      if (pending.length) child.stdin.write(answer);
      else child.stdin.end(answer);
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => {
      clearTimeout(guard);
      resolve({ code, output });
    });
  });
}

before(async () => {
  setEnv({ ADMIN_MFA_KEY: mfaKey });
  mem = await MongoMemoryServer.create();
  uri = mem.getUri('greencanteen-cli');
  await mongoose.connect(uri);
});
after(async () => {
  await mongoose.disconnect();
  await mem.stop();
});

test('thiếu khóa MFA, thiếu email, lệnh lạ: thoát với mã lỗi, không tạo gì', async () => {
  const noKey = await runCli(['bootstrap', '--email', email, '--name', 'Quản Trị'], { input: `${password}\n`, env: { ADMIN_MFA_KEY: '' } });
  assert.equal(noKey.code, 1);
  assert.match(noKey.output, /ADMIN_MFA_KEY/);
  assert.equal((await runCli(['bootstrap'], { input: `${password}\n` })).code, 1);
  assert.equal((await runCli(['xoa-het'])).code, 1);
  assert.equal(await User.countDocuments(), 0);
});

test('tham số dòng lệnh không nhận mật khẩu', async () => {
  const res = await runCli(['bootstrap', '--email', email, '--password', password]);
  assert.equal(res.code, 1);
  assert.equal(await User.countDocuments(), 0);
});

test('bootstrap tạo admin, in mã đăng ký một lần, không in mật khẩu; mật khẩu chỉ lưu dạng băm', async () => {
  const res = await runCli(['bootstrap', '--email', email, '--name', 'Cán Bộ Căn Tin'], { input: `${password}\n` });
  assert.equal(res.code, 0, res.output);
  assert.match(res.output, /Mã đăng ký MFA \(chỉ hiện một lần\): [A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  assert.ok(!res.output.includes(password));

  const user = await User.findOne({ email }).select('+passwordHash').lean();
  assert.equal(user.role, 'admin');
  assert.match(user.passwordHash, /^scrypt\$/);
  assert.ok(await AdminMfa.exists({ userId: user._id, enrollCodeHash: { $ne: null } }));
  assert.equal((await AuditLog.findOne({ action: 'admin.bootstrap' }).lean()).actorType, 'cli');
});

test('chạy lại bị từ chối: lệnh chỉ dùng được một lần', async () => {
  const res = await runCli(['bootstrap', '--email', 'nguoi-khac@example.edu.vn', '--name', 'Người Khác'], { input: `${password}\n` });
  assert.equal(res.code, 1);
  assert.match(res.output, /Đã có quản trị viên/);
  assert.equal(await User.countDocuments({ role: 'admin' }), 1);
});

test('reset-mfa in mã mới; email lạ báo lỗi', async () => {
  const res = await runCli(['reset-mfa', '--email', email]);
  assert.equal(res.code, 0, res.output);
  assert.match(res.output, /Đã xóa MFA cũ/);
  assert.match(res.output, /Mã đăng ký MFA/);
  assert.equal((await runCli(['reset-mfa', '--email', 'khong-co@example.edu.vn'])).code, 1);
});

test('ở terminal phải nhập lại mật khẩu: không khớp thì dừng, không đổi gì', async () => {
  const count = await User.countDocuments();
  const res = await runAtTerminal(['bootstrap', '--email', 'go-nham@example.edu.vn', '--name', 'Gõ Nhầm'], ['duong-dan-khoi-phuc-lenh-2026', 'duong-dan-khoi-phuc-lenh-2062']);
  assert.equal(res.code, 1);
  assert.match(res.output, /Hai lần nhập không khớp/);
  assert.equal(await User.countDocuments(), count);
});

test('reset-password ở terminal: nhập hai lần, đổi email, thu hồi phiên, in mã đăng ký khi chưa gắn MFA', async () => {
  const newPassword = 'duong-dan-khoi-phuc-lenh-2026';
  const newEmail = 'can-bo-moi@example.edu.vn';
  const before = await User.findOne({ email }).select('+passwordHash').lean();
  await Session.create({ tokenHash: 'phien-cu', userId: before._id, expiresAt: new Date(Date.now() + 60000) });

  const res = await runAtTerminal(['reset-password', '--email', email, '--new-email', newEmail], [newPassword, newPassword]);
  assert.equal(res.code, 0, res.output);
  assert.ok(!res.output.includes(newPassword));
  assert.match(res.output, /Mã đăng ký MFA \(chỉ hiện một lần\)/);

  const user = await User.findOne({ email: newEmail }).select('+passwordHash').lean();
  assert.equal(user._id.toString(), before._id.toString());
  assert.ok(await verifyPassword(newPassword, user.passwordHash));
  assert.equal(await verifyPassword(password, user.passwordHash), false);
  assert.equal(await Session.countDocuments({ userId: user._id }), 0);
  assert.equal(await User.countDocuments({ email }), 0);
  const audit = await AuditLog.findOne({ action: 'admin.password_reset' }).lean();
  assert.equal(audit.actorType, 'cli');
});

test('reset-password giữ MFA đã gắn: không in mã đăng ký, không xóa secret', async () => {
  const user = await User.findOne({ email: 'can-bo-moi@example.edu.vn' }).lean();
  await AdminMfa.updateOne({ userId: user._id }, { $set: { secretEnc: 'da-ma-hoa', enabledAt: new Date() } });

  const res = await runCli(['reset-password', '--email', user.email], { input: 'mot-duong-dan-khac-cho-quan-tri\n' });
  assert.equal(res.code, 0, res.output);
  assert.doesNotMatch(res.output, /Mã đăng ký MFA/);
  assert.equal((await AdminMfa.findOne({ userId: user._id }).lean()).secretEnc, 'da-ma-hoa');
});

test('reset-password từ chối mật khẩu ngắn, email đã có người dùng, tài khoản không phải admin; không đổi gì', async () => {
  const adminEmail = 'can-bo-moi@example.edu.vn';
  const takenEmail = 'sinh-vien@example.edu.vn';
  await User.create({ name: 'Sinh Viên', studentId: 'SV-CLI-01', email: takenEmail });
  const before = await User.findOne({ email: adminEmail }).select('+passwordHash').lean();
  const longPassword = 'mot-duong-dan-thu-ba-cho-quan-tri\n';

  assert.equal((await runCli(['reset-password', '--email', adminEmail], { input: 'ngan-qua\n' })).code, 1);
  const taken = await runCli(['reset-password', '--email', adminEmail, '--new-email', takenEmail], { input: longPassword });
  assert.equal(taken.code, 1);
  assert.match(taken.output, /đã có tài khoản/);
  assert.equal((await runCli(['reset-password', '--email', takenEmail], { input: longPassword })).code, 1);
  assert.equal((await runCli(['reset-password'], { input: longPassword })).code, 1);

  const after = await User.findOne({ email: adminEmail }).select('+passwordHash').lean();
  assert.equal(after.passwordHash, before.passwordHash);
});

/** Một bản ghi thật trong mỗi collection gắn với tài khoản */
function seedAccountData(user, tag) {
  const userId = user._id;
  const expiresAt = new Date(Date.now() + 600000);
  return Promise.all([
    Session.create({ tokenHash: `phien-${tag}`, userId, expiresAt }),
    AdminSession.create({ tokenHash: `quan-tri-${tag}`, userId, stage: 'mfa', lastSeenAt: new Date(), expiresAt }),
    PendingMfaLogin.create({ tokenHash: `mfa-${tag}`, userId, expiresAt }),
    PasswordReset.create({ tokenHash: `dat-lai-${tag}`, userId, expiresAt }),
    QrLogin.create({ challengeHash: `qr-${tag}`, pollTokenHash: `hoi-${tag}`, userId, expiresAt }),
    WebauthnChallenge.create({ tokenHash: `thu-thach-${tag}`, purpose: 'register', challenge: 'gia-tri', userId, expiresAt }),
    Passkey.create({ userId, credentialId: `passkey-${tag}`, publicKey: Buffer.from('khoa-cong-khai') }),
    UserMfa.create({ userId }),
    AdminMfa.create({ userId }),
    UserAvatar.create({ _id: `anh-${tag}`, userId, data: Buffer.from('anh') }),
    CheckIn.create({ userId, studentId: user.studentId, valid: true }),
    GachaReward.create({ userId, studentId: user.studentId, amountVnd: 10000, topUpCode: `ma-${tag}` }),
    RewardedImage.create({ _id: `bam-${tag}`, userId }),
  ]);
}

const countAll = (userId) => Promise.all(USER_DATA_MODELS.map((model) => model.countDocuments({ userId })));

test('delete-user: mọi model có userId đều nằm trong danh sách xóa, kể cả model thêm sau này', async () => {
  const models = path.resolve(path.dirname(entry), 'models');
  await Promise.all(fs.readdirSync(models).map((file) => import(pathToFileURL(path.join(models, file)).href)));
  const withUserId = mongoose.modelNames().filter((name) => mongoose.model(name).schema.path('userId'));
  assert.deepEqual(USER_DATA_MODELS.map((model) => model.modelName).sort(), withUserId.sort());
});

test('delete-user: gõ sai mã sinh viên, không gõ gì, thiếu hoặc thừa tham số, không tìm thấy: không xóa gì', async () => {
  const user = await User.create({ name: 'Giữ Lại', studentId: 'SV-XOA-01', email: 'giu-lai@example.edu.vn' });
  await seedAccountData(user, 'giu-lai');

  for (const input of ['SV-XOA-99\n', '']) {
    const res = await runCli(['delete-user', '--student-id', user.studentId], { input });
    assert.equal(res.code, 1, res.output);
    assert.match(res.output, /Mã không khớp, chưa xóa gì/);
  }
  assert.equal((await runCli(['delete-user'], { input: `${user.studentId}\n` })).code, 1);
  assert.equal((await runCli(['delete-user', '--student-id', user.studentId, '--email', user.email], { input: `${user.studentId}\n` })).code, 1);
  assert.match((await runCli(['delete-user', '--student-id', 'KHONG-CO'], { input: 'KHONG-CO\n' })).output, /Không tìm thấy/);

  assert.ok(await User.exists({ _id: user._id, status: 'active' }));
  assert.deepEqual(await countAll(user._id), USER_DATA_MODELS.map(() => 1));
});

test('delete-user từ chối tài khoản quản trị: admin cuối cùng không thể bị xóa nhầm', async () => {
  const admin = await User.findOne({ role: 'admin' }).lean();
  const res = await runCli(['delete-user', '--email', admin.email], { input: `${admin.studentId}\n` });
  assert.equal(res.code, 1);
  assert.match(res.output, /Gỡ quyền quản trị trước/);
  assert.ok(await User.exists({ _id: admin._id, role: 'admin' }));
});

test('delete-user: tài khoản chỉ có Facebook xóa được theo mã SV; mất hết dữ liệu của người đó, tài khoản khác nguyên vẹn, nhật ký có dấu vết', async () => {
  const kept = await User.findOne({ studentId: 'SV-XOA-01' }).lean();
  const target = await User.create({ name: 'Người Dùng Facebook', studentId: 'SV-XOA-02', facebookId: 'facebook-xoa-02', ecoPoints: 40 });
  await seedAccountData(target, 'xoa');

  const res = await runCli(['delete-user', '--student-id', target.studentId.toLowerCase()], { input: `${target.studentId}\n` });
  assert.equal(res.code, 0, res.output);
  assert.match(res.output, /1 lượt check-in, 1 mã nạp/);
  assert.match(res.output, /email \(không có\)/);

  assert.equal(await User.exists({ _id: target._id }), null);
  assert.deepEqual(await countAll(target._id), USER_DATA_MODELS.map(() => 0));
  assert.deepEqual(await countAll(kept._id), USER_DATA_MODELS.map(() => 1));
  const audit = await AuditLog.findOne({ action: 'account.deleted' }).lean();
  assert.equal(audit.actorType, 'cli');
  assert.equal(audit.targetId, target._id.toString());
});

test('delete-user: đăng ký chờ của cùng email cũng bị xóa; email trong nhật ký đã được che', async () => {
  const mail = 'co-email@example.edu.vn';
  const target = await User.create({ name: 'Có Email', studentId: 'SV-XOA-03', email: mail });
  await EmailVerification.create({ tokenHash: 'cho-xoa', email: mail, name: 'Có Email', studentId: 'SV-XOA-03', passwordHash: 'scrypt$gia', expiresAt: new Date(Date.now() + 600000) });

  const res = await runCli(['delete-user', '--email', mail.toUpperCase()], { input: `${target.studentId}\n` });
  assert.equal(res.code, 0, res.output);
  assert.ok(!res.output.includes(mail), 'màn hình chỉ hiện email đã che');
  assert.equal(await EmailVerification.countDocuments({ email: mail }), 0);
  const audit = await AuditLog.findOne({ action: 'account.deleted', targetId: target._id.toString() }).lean();
  assert.equal(audit.targetLabel, 'co***@example.edu.vn');
});
