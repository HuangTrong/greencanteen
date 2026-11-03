// Kiểm thử hệ thống: 2FA, CAPTCHA, passkey và quét mã độc trên trình duyệt thật → Vite → API → MongoDB in-memory.
// Passkey dùng trình xác thực ảo của Chromium qua CDP: có ký thật nhưng không có sinh trắc hay TPM thật. clamd là bản giả nói đúng giao thức.
import { expect, test } from '@playwright/test';
import { MALWARE_MARKER } from '../../server/test/fakes/clamd.js';
import { portrait } from '../../server/test/fakes/portrait.js';
import { totpCode, totpStep } from '../../server/src/services/totp.js';
import { MAILBOX, addPasskey, adminLogin, login, logout, nav, openLogin, pngFile, reauthenticate, register, virtualAuthenticator, waitForResetLink } from './helpers';

/** Mỗi mã chỉ dùng được một lần và máy chủ chấp nhận lệch một bước: lấy từ bước cũ nhất còn hiệu lực để không phải chờ, hết bước thì chờ bước mới */
function codesFor(secret) {
  let last = totpStep() - 2;
  return async () => {
    while (Math.max(totpStep() - 1, last + 1) > totpStep() + 1) await new Promise((resolve) => setTimeout(resolve, 500));
    last = Math.max(totpStep() - 1, last + 1);
    return totpCode(secret, last);
  };
}

async function enableMfa(page, account) {
  await page.getByRole('button', { name: 'Bật', exact: true }).click();
  await reauthenticate(page, account.password);
  await expect(page.getByRole('img', { name: 'Mã QR thiết lập ứng dụng xác thực' })).toBeVisible();
  const nextCode = codesFor((await page.getByTestId('mfa-secret').textContent()).trim());
  await page.getByLabel('Mã 6 chữ số').fill(await nextCode());
  await page.getByRole('button', { name: 'Bật', exact: true }).click();
  const items = page.getByRole('list', { name: 'Mã khôi phục' }).getByRole('listitem');
  await expect(items).toHaveCount(8);
  const recoveryCodes = await items.allTextContents();
  await page.getByLabel('Tôi đã lưu các mã này').check();
  await page.getByRole('button', { name: 'Xong' }).click();
  await expect(page.getByRole('list', { name: 'Mã khôi phục' })).toBeHidden();
  await expect(page.getByText(/Còn 8 mã khôi phục/)).toBeVisible();
  return { nextCode, recoveryCodes };
}

/** Trên màn hình hẹp menu quản trị được thu gọn */
async function adminLogout(page) {
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.getByRole('heading', { name: 'Đăng nhập quản trị' })).toBeVisible();
}

async function submitCode(page, code) {
  const step = page.getByRole('dialog', { name: 'Xác thực hai lớp' });
  await step.getByLabel('Mã xác thực *').fill(code);
  await step.getByRole('button', { name: 'Xác nhận' }).click();
  return step;
}

test('2FA: bật bằng ứng dụng xác thực, đăng nhập phải qua bước hai, mã dùng lại bị từ chối, đặt lại mật khẩu vẫn phải qua bước hai, mã khôi phục dùng một lần, tắt xong đăng nhập một bước', async ({ page, request }) => {
  test.setTimeout(150_000);
  const account = await register(page);
  const { nextCode, recoveryCodes } = await enableMfa(page, account);
  await logout(page);

  await login(page, account.email, account.password);
  let step = page.getByRole('dialog', { name: 'Xác thực hai lớp' });
  await expect(step.getByLabel('Mã xác thực *')).toBeVisible();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeHidden();
  await submitCode(page, '000000');
  await expect(step.getByRole('alert')).toContainText('Mã xác thực không đúng');
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeHidden();

  const code = await nextCode();
  await submitCode(page, code);
  await expect(page.getByRole('dialog').getByText('Đăng nhập thành công')).toBeVisible();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();
  await logout(page);

  await login(page, account.email, account.password);
  step = await submitCode(page, code);
  await expect(step.getByRole('alert')).toContainText('đã được dùng');
  await page.reload();

  const sentAt = Date.now() - 1000;
  const dialog = await openLogin(page);
  await dialog.getByRole('button', { name: 'Quên mật khẩu?' }).click();
  await page.getByRole('dialog', { name: 'Quên mật khẩu' }).getByLabel('Email *').fill(account.email);
  await page.getByRole('button', { name: 'Gửi liên kết đặt lại' }).click();
  await expect(page.getByRole('dialog', { name: 'Quên mật khẩu' }).getByRole('status')).toBeVisible();
  const link = await waitForResetLink(request, account.email, { after: sentAt });
  await page.goto(link);
  const reset = page.getByRole('dialog', { name: 'Đặt mật khẩu mới' });
  const newPassword = 'mat-khau-moi-e2e-2fa';
  await reset.getByLabel('Mật khẩu mới (ít nhất 8 ký tự) *').fill(newPassword);
  await reset.getByLabel('Nhập lại mật khẩu mới *').fill(newPassword);
  await reset.getByRole('button', { name: 'Lưu mật khẩu mới' }).click();
  step = page.getByRole('dialog', { name: 'Xác thực hai lớp' });
  await expect(step.getByLabel('Mã xác thực *')).toBeVisible();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeHidden();

  await submitCode(page, recoveryCodes[0]);
  await expect(page.getByRole('dialog').getByText('Đăng nhập thành công')).toBeVisible();
  await expect(page.getByText(/Còn 7 mã khôi phục/)).toBeVisible();
  await logout(page);

  await login(page, account.email, newPassword);
  await submitCode(page, recoveryCodes[0]);
  await expect(step.getByRole('alert')).toBeVisible();
  await submitCode(page, await nextCode());
  await expect(page.getByRole('dialog').getByText('Đăng nhập thành công')).toBeVisible();
  await expect(page.getByRole('dialog')).toBeHidden();

  await page.getByRole('button', { name: 'Tắt', exact: true }).click();
  await page.getByLabel('Mật khẩu hiện tại').fill(newPassword);
  await page.getByLabel('Mã xác thực').fill(await nextCode());
  await page.getByRole('button', { name: 'Tắt', exact: true }).click();
  await expect(page.getByText('Đã tắt xác thực hai lớp.')).toBeVisible();
  await logout(page);

  const plain = await login(page, account.email, newPassword);
  await expect(plain.getByText('Đăng nhập thành công')).toBeVisible();
});

test('CAPTCHA: sai 3 lần với một email thì trình duyệt tự giải ở lần sau; người dùng không phải thao tác thêm, đúng mật khẩu vẫn vào được', async ({ page }) => {
  const account = await register(page);
  await logout(page);
  const solved = [];
  page.on('request', (req) => {
    if (req.url().endsWith('/api/auth/login')) solved.push(Boolean(req.postDataJSON().captcha));
  });
  const dialog = await openLogin(page);
  await dialog.getByLabel('Email *').fill(account.email);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dialog.getByLabel('Mật khẩu *').fill(`sai-mat-khau-${attempt}`);
    const answered = page.waitForResponse((res) => res.url().endsWith('/api/auth/login'));
    await dialog.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    expect((await answered).status()).toBe(401);
    await expect(dialog.getByRole('button', { name: 'Đăng nhập', exact: true })).toBeEnabled();
  }
  expect(solved).toEqual([false, false, false]);

  await dialog.getByLabel('Mật khẩu *').fill(account.password);
  await dialog.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await expect(page.getByRole('dialog').getByText('Đăng nhập thành công')).toBeVisible();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();
  expect(solved).toEqual([false, false, false, false, true]);
});

test('passkey: thêm sau khi xác thực lại, đăng nhập không cần mật khẩu, thiết bị không xác minh được người dùng thì không vào được, xóa xong không dùng được nữa', async ({ page }) => {
  const { cdp, authenticatorId } = await virtualAuthenticator(page);
  const account = await register(page);
  await addPasskey(page, account.password, 'Thiết bị E2E');
  const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
  expect(credentials).toHaveLength(1);
  expect(credentials[0].isResidentCredential).toBe(true);
  expect(credentials[0].rpId).toBe('localhost');
  await logout(page);

  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
  let dialog = await openLogin(page);
  await dialog.getByRole('button', { name: /Đăng nhập bằng passkey/ }).click();
  await expect(dialog.getByRole('alert')).toContainText('Bạn đã hủy, hoặc thiết bị chưa xác nhận được passkey.');
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeHidden();
  await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });

  await dialog.getByRole('button', { name: /Đăng nhập bằng passkey/ }).click();
  await expect(dialog.getByText('Đăng nhập bằng passkey thành công')).toBeVisible();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Passkey đã thêm' })).toContainText('Dùng gần nhất');

  await page.getByRole('button', { name: 'Xóa passkey Thiết bị E2E' }).click();
  await expect(page.getByText('Đã xóa passkey Thiết bị E2E.')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Passkey đã thêm' })).toBeHidden();
  await logout(page);

  dialog = await openLogin(page);
  await dialog.getByRole('button', { name: /Đăng nhập bằng passkey/ }).click();
  await expect(dialog.getByRole('alert')).toContainText('Không xác minh được passkey');
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeHidden();
});

test('quản trị: thêm passkey ở trang Cá nhân rồi dùng thay mã ở bước hai; tài khoản khác không thấy nút', async ({ page, request }) => {
  await virtualAuthenticator(page);
  const admin = await adminLogin(page, request);
  await adminLogout(page);

  const dialog = await login(page, admin.email, admin.password);
  await expect(dialog.getByText('Đăng nhập thành công')).toBeVisible();
  await expect(dialog).toBeHidden();
  await addPasskey(page, admin.password, 'Khóa quản trị');

  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(admin.email);
  await page.getByLabel('Mật khẩu').fill(admin.password);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await page.getByRole('button', { name: 'Dùng passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Tổng quan' })).toBeVisible();
  await adminLogout(page);

  const other = await (await request.post(`${MAILBOX}/admin-fixture`)).json();
  await page.getByLabel('Email').fill(other.email);
  await page.getByLabel('Mật khẩu').fill(other.password);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(page.getByLabel('Mã đăng ký')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dùng passkey' })).toBeHidden();
});

test('khu bảo vệ đăng nhập vừa màn hình ở cả ba cấu hình, nút đủ lớn để chạm, kể cả khi đang thiết lập 2FA', async ({ page }, testInfo) => {
  await virtualAuthenticator(page);
  const account = await register(page);
  const check = async (label) => {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${label} cuộn ngang ${overflow}px`).toBeLessThanOrEqual(0);
    const panel = page.getByText('Bảo vệ đăng nhập', { exact: true }).locator('..');
    for (const box of await panel.getByRole('button').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
      expect(box.height, label).toBeGreaterThanOrEqual(24);
      expect(box.width, label).toBeGreaterThanOrEqual(24);
    }
    // Che khóa TOTP và mã QR: ảnh này được lưu làm bằng chứng
    await panel.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}-${label}.png`), mask: [page.getByTestId('mfa-secret'), page.getByRole('img', { name: 'Mã QR thiết lập ứng dụng xác thực' })] });
  };

  await addPasskey(page, account.password, 'Tên thiết bị dài đúng sáu mươi ký tự để thử cho màn hình hẹp');
  await check('da-co-passkey');
  await page.getByRole('button', { name: 'Bật', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Mã QR thiết lập ứng dụng xác thực' })).toBeVisible();
  await check('thiet-lap-2fa');
});

test('quét mã độc: check-in và ảnh đại diện nhiễm bị chặn với thông báo rõ, không cộng điểm; ảnh sạch vẫn đi qua clamd bình thường', async ({ page }) => {
  await register(page);
  await page.getByLabel('Chọn ảnh đại diện').setInputFiles({ name: 'chan-dung.png', mimeType: 'image/png', buffer: Buffer.concat([await portrait(120), MALWARE_MARKER]) });
  await expect(page.getByRole('alert')).toContainText('Tệp này bị từ chối vì không an toàn');
  await expect(page.getByRole('img', { name: 'Ảnh đại diện' })).toBeHidden();

  await nav(page, 'Check-in').click();
  await page.locator('input[type="file"]').setInputFiles(pngFile(Buffer.concat([pngFile().buffer, MALWARE_MARKER])));
  await page.getByRole('button', { name: 'Check-in ngay' }).click();
  await expect(page.getByRole('alert')).toContainText('Tệp này bị từ chối vì không an toàn');
  await expect(page.getByRole('dialog', { name: 'Check-in thành công' })).toBeHidden();

  await page.locator('input[type="file"]').setInputFiles(pngFile());
  await page.getByRole('button', { name: 'Check-in ngay' }).click();
  await expect(page.getByRole('dialog', { name: 'Check-in thành công' })).toBeVisible();
});
