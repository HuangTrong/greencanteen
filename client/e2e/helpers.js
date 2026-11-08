import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { expect } from '@playwright/test';
import { totpCode, totpStep } from '../../server/src/services/totp.js';

export const MAILBOX = process.env.E2E_MAILBOX_URL || 'http://127.0.0.1:3102';

let counter = 0;
export const unique = () => `${Date.now().toString(36)}${(counter += 1)}${Math.random().toString(36).slice(2, 5)}`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** PNG 1×1 hợp lệ, mỗi lần một màu ngẫu nhiên: server nhận dạng ảnh theo điểm ảnh nên nối thêm byte vào tệp không tạo được ảnh mới */
function uniquePng() {
  const pixel = Buffer.concat([Buffer.from([0]), crypto.randomBytes(3)]);
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])), pngChunk('IDAT', zlib.deflateSync(pixel)), pngChunk('IEND', Buffer.alloc(0))]);
}

export const pngFile = (buffer = uniquePng()) => ({ name: 'binh-nuoc.png', mimeType: 'image/png', buffer });

export function nav(page, name) {
  return page.getByRole('navigation').getByRole('link', { name: new RegExp(name) });
}

/** Điền form đăng ký và gửi; chưa xác minh email. Trả về thông tin tài khoản */
export async function submitRegistration(page, overrides = {}) {
  const id = unique();
  const account = {
    name: `E2E ${id}`,
    studentId: `E2E${id}`.toUpperCase(),
    email: `e2e-${id}@example.edu.vn`,
    password: 'mat-khau-e2e-123',
    ...overrides,
  };
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Đăng nhập / Đăng ký' }).click();
  const dialog = page.getByRole('dialog', { name: 'Đăng nhập / Đăng ký' });
  await dialog.getByRole('tab', { name: 'Tạo tài khoản' }).click();
  await dialog.getByLabel('Họ và tên *').fill(account.name);
  await dialog.getByLabel('Mã sinh viên *').fill(account.studentId);
  await dialog.getByLabel('Email *').fill(account.email);
  await dialog.getByLabel('Mật khẩu (ít nhất 8 ký tự) *').fill(account.password);
  await dialog.getByRole('button', { name: 'Tạo tài khoản' }).click();
  return account;
}

/** Mở liên kết trong email và nhập mật khẩu đã đặt để kích hoạt */
export async function activate(page, link, password) {
  await page.goto(link);
  const dialog = page.getByRole('dialog', { name: 'Kích hoạt tài khoản' });
  await dialog.getByLabel('Mật khẩu đã đặt khi đăng ký *').fill(password);
  await dialog.getByRole('button', { name: 'Kích hoạt tài khoản' }).click();
  return dialog;
}

/** Tài khoản đã kích hoạt qua giao diện: đăng ký → email → xác minh. Trả về thông tin đăng nhập */
export async function register(page, overrides = {}) {
  const sentAt = Date.now() - 1000;
  const account = await submitRegistration(page, overrides);
  await expect(page.getByRole('dialog', { name: 'Kiểm tra email của bạn' })).toBeVisible();
  const link = await waitForVerifyLink(page.request, account.email, { after: sentAt });
  await activate(page, link, account.password);
  await expect(page.getByRole('dialog').getByText('Tạo tài khoản thành công')).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();
  return account;
}

export async function openLogin(page) {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Đăng nhập / Đăng ký' }).click();
  return page.getByRole('dialog', { name: 'Đăng nhập / Đăng ký' });
}

export async function login(page, email, password) {
  const dialog = await openLogin(page);
  await dialog.getByLabel('Email *').fill(email);
  await dialog.getByLabel('Mật khẩu *').fill(password);
  await dialog.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  return dialog;
}

export async function logout(page) {
  await page.goto('/profile');
  await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
  await expect(page.getByText('Chưa có hồ sơ cá nhân')).toBeVisible();
}

export async function reauthenticate(page, password) {
  await page.getByLabel('Nhập lại mật khẩu để tiếp tục').fill(password);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
}

/** Trình xác thực ảo của Chromium qua CDP: ký thật, nhưng không có sinh trắc hay TPM thật */
export async function virtualAuthenticator(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  return { cdp, authenticatorId };
}

export async function addPasskey(page, password, name) {
  await page.getByLabel('Tên passkey').fill(name);
  await page.getByRole('button', { name: 'Thêm passkey' }).click();
  await reauthenticate(page, password);
  await expect(page.getByRole('list', { name: 'Passkey đã thêm' })).toContainText(name);
}

/** Đăng nhập khu quản trị lần đầu qua giao diện: mật khẩu → mã đăng ký → gắn ứng dụng xác thực → mã khôi phục */
export async function adminLogin(page, request) {
  const fixture = await (await request.post(`${MAILBOX}/admin-fixture`)).json();
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(fixture.email);
  await page.getByLabel('Mật khẩu').fill(fixture.password);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await page.getByLabel('Mã đăng ký').fill(fixture.enrollCode);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(page.getByRole('img', { name: 'Mã QR đăng ký ứng dụng xác thực' })).toBeVisible();
  const secret = (await page.getByTestId('mfa-secret').textContent()).trim();
  await page.getByLabel('Mã 6 chữ số').fill(totpCode(secret, totpStep()));
  await page.getByRole('button', { name: 'Hoàn tất' }).click();
  await expect(page.getByRole('list', { name: 'Mã khôi phục' }).getByRole('listitem')).toHaveCount(8);
  await page.getByLabel('Tôi đã lưu các mã này').check();
  await page.getByRole('button', { name: 'Vào khu quản trị' }).click();
  await expect(page.getByRole('heading', { name: 'Tổng quan' })).toBeVisible();
  return { ...fixture, secret, lastStep: totpStep() };
}

/** Mỗi mã TOTP chỉ dùng được một lần: lấy mã của bước kế tiếp (server chấp nhận lệch một bước), hết bước thì chờ bước mới */
async function freshCode(admin) {
  while (totpStep() + 1 <= admin.lastStep) await new Promise((resolve) => setTimeout(resolve, 1000));
  admin.lastStep = totpStep() + 1;
  return totpCode(admin.secret, admin.lastStep);
}

export async function confirmReauth(page, admin) {
  const dialog = page.getByRole('dialog', { name: 'Xác thực lại' });
  await dialog.getByLabel('Mật khẩu').fill(admin.password);
  await dialog.getByLabel('Mã xác thực').fill(await freshCode(admin));
  await dialog.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(dialog).toBeHidden();
}

export const expireReauth = (request, admin) => request.post(`${MAILBOX}/expire-reauth?email=${encodeURIComponent(admin.email)}`);
export const revokeAdminSessions = (request, admin) => request.post(`${MAILBOX}/revoke-admin-sessions?email=${encodeURIComponent(admin.email)}`);

/** Sinh viên qua API, không cần giao diện: một context request riêng có cookie riêng */
export async function studentApi(playwright, baseURL, overrides = {}) {
  const context = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { 'X-Requested-With': 'GreenCanteen' } });
  const id = unique();
  const account = { name: `SV ${id}`, studentId: `SV${id}`.toUpperCase(), email: `sv-${id}@example.edu.vn`, password: 'mat-khau-sinh-vien-1', ...overrides };
  const res = await context.post('/api/auth/register', { data: account });
  expect(res.status()).toBe(202);
  const link = await waitForVerifyLink(context, account.email);
  const verified = await context.post('/api/auth/email/verify', { data: { token: link.split('#verify=')[1], password: account.password } });
  expect(verified.status()).toBe(201);
  return { context, account };
}

async function waitForMailLink(request, email, pattern, after) {
  for (let i = 0; i < 50; i += 1) {
    const messages = await (await request.get(`${MAILBOX}/?to=${encodeURIComponent(email)}`)).json();
    const latest = messages.filter((m) => m.at > after).at(-1);
    const link = latest?.text.match(pattern)?.[0];
    if (link) return link;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Không thấy thư có liên kết cho ${email}`);
}

/** Đọc liên kết đặt lại mật khẩu từ hộp thư giả của server E2E */
export const waitForResetLink = (request, email, { after = 0 } = {}) =>
  waitForMailLink(request, email, /https?:\/\/\S+#reset=[A-Za-z0-9_-]{43}/, after);

/** Đọc mã 6 số trong thư đặt lại mật khẩu (cùng thư với liên kết) */
export const waitForResetCode = async (request, email, { after = 0 } = {}) =>
  (await waitForMailLink(request, email, /Mã đặt lại mật khẩu \(hiệu lực 30 phút\): \d{6}/, after)).slice(-6);

/** Đọc liên kết xác minh email từ hộp thư giả của server E2E */
export const waitForVerifyLink = (request, email, { after = 0 } = {}) =>
  waitForMailLink(request, email, /https?:\/\/\S+#verify=[A-Za-z0-9_-]{43}/, after);
