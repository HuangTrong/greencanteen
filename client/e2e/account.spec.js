// Kiểm thử hệ thống: tài khoản — đăng ký có xác minh email, đăng nhập, quên/đặt lại mật khẩu (hộp thư giả), đổi mật khẩu, nhiều thiết bị, QR
import { expect, test } from '@playwright/test';
import { activate, login, logout, openLogin, register, submitRegistration, waitForResetLink, waitForVerifyLink } from './helpers';

test('đăng ký: chờ xác minh, đăng nhập trước khi xác minh bị từ chối, token bị xóa khỏi URL, liên kết dùng lại bị từ chối', async ({ page, request, browser }) => {
  const sentAt = Date.now() - 1000;
  const account = await submitRegistration(page);
  const pending = page.getByRole('dialog', { name: 'Kiểm tra email của bạn' });
  await expect(pending.getByRole('status')).toContainText('Chúng tôi đã gửi một email');
  await expect(pending.getByText(/Tài khoản chỉ hoạt động sau khi bạn mở liên kết/)).toBeVisible();

  await page.reload();
  const early = await login(page, account.email, account.password);
  await expect(early.getByRole('alert')).toContainText('Email hoặc mật khẩu không đúng');
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeHidden();

  const link = await waitForVerifyLink(request, account.email, { after: sentAt });
  const wrong = await activate(page, link, 'sai-mat-khau-e2e');
  await expect(wrong.getByRole('alert')).toContainText('Mật khẩu chưa đúng');
  await expect(page).toHaveURL(/\/profile$/);
  await wrong.getByLabel('Mật khẩu đã đặt khi đăng ký *').fill(account.password);
  await wrong.getByRole('button', { name: 'Kích hoạt tài khoản' }).click();
  await expect(page.getByRole('dialog').getByText('Tạo tài khoản thành công')).toBeVisible();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  const again = await activate(otherPage, link, account.password);
  await expect(again.getByRole('alert')).toContainText('không hợp lệ, đã hết hạn hoặc đã được sử dụng');
  await expect(again.getByRole('button', { name: 'Gửi lại email xác minh' })).toBeVisible();
  await other.close();
});

test('đăng ký trùng email: giao diện giống hệt đăng ký mới; mật khẩu phổ biến bị từ chối ngay, không sang màn chờ', async ({ page }) => {
  const account = await register(page);
  await logout(page);
  const weak = await submitRegistration(page, { password: '12345678' });
  const dialog = page.getByRole('dialog', { name: 'Đăng nhập / Đăng ký' });
  await expect(dialog.getByRole('alert')).toContainText('quá phổ biến');
  await expect(dialog.getByLabel('Email *')).toHaveValue(weak.email);

  await submitRegistration(page, { email: account.email });
  await expect(page.getByRole('dialog', { name: 'Kiểm tra email của bạn' }).getByRole('status')).toContainText('Chúng tôi đã gửi một email');
});

test('đăng nhập: sai mật khẩu và email không tồn tại cho cùng một thông báo; đúng thì vào hồ sơ', async ({ page }) => {
  const account = await register(page);
  await logout(page);
  const wrong = await login(page, account.email, 'sai-mat-khau-1');
  const wrongText = await wrong.getByRole('alert').textContent();
  await page.reload();
  const unknown = await login(page, `khong-co-${Date.now()}@example.edu.vn`, 'sai-mat-khau-1');
  await expect(unknown.getByRole('alert')).toHaveText(wrongText);

  await page.reload();
  const ok = await login(page, account.email, account.password);
  await expect(ok.getByText('Đăng nhập thành công')).toBeVisible();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();
});

test('quên mật khẩu → liên kết trong email → đặt mật khẩu mới; token bị xóa khỏi URL; liên kết dùng lại bị từ chối', async ({ page, request, browser }) => {
  const account = await register(page);
  await logout(page);
  const dialog = await openLogin(page);
  await dialog.getByRole('button', { name: 'Quên mật khẩu?' }).click();
  const forgot = page.getByRole('dialog', { name: 'Quên mật khẩu' });
  await forgot.getByLabel('Email *').fill(account.email);
  const sentAt = Date.now() - 1000;
  await forgot.getByRole('button', { name: 'Gửi liên kết đặt lại' }).click();
  await expect(forgot.getByText(/Nếu email này thuộc một tài khoản GreenCanteen/)).toBeVisible();

  const link = await waitForResetLink(request, account.email, { after: sentAt });
  await page.goto(link);
  const reset = page.getByRole('dialog', { name: 'Đặt mật khẩu mới' });
  await expect(reset).toBeVisible();
  await expect(page).toHaveURL(/\/profile$/);
  await reset.getByLabel('Mật khẩu mới (ít nhất 8 ký tự) *').fill('mat-khau-moi-e2e-1');
  await reset.getByLabel('Nhập lại mật khẩu mới *').fill('mat-khau-moi-e2e-1');
  await reset.getByRole('button', { name: 'Lưu mật khẩu mới' }).click();
  // Màn thành công đổi tiêu đề popup về "Đăng nhập / Đăng ký" (ghi nhận O-03) → tìm theo nội dung
  await expect(page.getByRole('dialog').getByText('Đã đặt mật khẩu mới')).toBeVisible();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();

  const other = await browser.newContext();
  const otherPage = await other.newPage();
  await otherPage.goto(link);
  const again = otherPage.getByRole('dialog', { name: 'Đặt mật khẩu mới' });
  await again.getByLabel('Mật khẩu mới (ít nhất 8 ký tự) *').fill('mat-khau-thu-ba-1');
  await again.getByLabel('Nhập lại mật khẩu mới *').fill('mat-khau-thu-ba-1');
  await again.getByRole('button', { name: 'Lưu mật khẩu mới' }).click();
  await expect(again.getByRole('alert')).toContainText('không hợp lệ, đã hết hạn hoặc đã được sử dụng');
  await other.close();
});

test('đổi mật khẩu đăng xuất thiết bị khác, giữ thiết bị hiện tại', async ({ page, browser }) => {
  const account = await register(page);
  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await login(secondPage, account.email, account.password);
  await expect(secondPage.getByText(`MSSV ${account.studentId}`)).toBeVisible();

  await page.getByRole('button', { name: 'Đổi mật khẩu' }).click();
  await page.getByLabel('Mật khẩu hiện tại').fill(account.password);
  await page.getByLabel('Mật khẩu mới (ít nhất 8 ký tự)').fill('mat-khau-doi-e2e-1');
  await page.getByLabel('Nhập lại mật khẩu mới').fill('mat-khau-doi-e2e-1');
  await page.getByRole('button', { name: 'Lưu', exact: true }).click();
  await expect(page.getByText('Đã đổi mật khẩu và đăng xuất 1 phiên trên thiết bị khác.')).toBeVisible();

  await secondPage.reload();
  await expect(secondPage.getByText('Chưa có hồ sơ cá nhân')).toBeVisible();
  await page.reload();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();
  await second.close();
});

test('đăng nhập bằng QR: thiết bị đã đăng nhập xác nhận, máy kia nhận phiên', async ({ page, browser }) => {
  const account = await register(page);
  const laptop = await browser.newContext();
  const laptopPage = await laptop.newPage();
  const dialog = await openLogin(laptopPage);
  // Chế độ dev (React StrictMode) chạy effect hai lần → có thể có 2 thử thách; lấy thử thách mà trang đang chờ
  const starts = [];
  laptopPage.on('response', async (r) => {
    if (r.url().endsWith('/api/auth/qr/start')) starts.push(await r.json());
  });
  const firstPoll = laptopPage.waitForRequest((r) => r.url().endsWith('/api/auth/qr/poll'));
  await dialog.getByRole('button', { name: /Đăng nhập bằng mã QR/ }).click();
  await expect(laptopPage.getByAltText('Mã QR đăng nhập GreenCanteen')).toBeVisible();
  const { pollToken } = (await firstPoll).postDataJSON();
  await expect.poll(() => starts.some((s) => s.pollToken === pollToken)).toBe(true);
  const { challengeId, matchCode } = starts.find((s) => s.pollToken === pollToken);
  expect(challengeId).not.toEqual(pollToken);
  await expect(laptopPage.getByText(matchCode, { exact: true })).toBeVisible();

  await page.goto(`/profile?qr=${encodeURIComponent(challengeId)}`);
  const approve = page.getByRole('dialog', { name: 'Xác nhận đăng nhập bằng mã QR' });
  await expect(approve.getByText(/trên (Windows|Android|macOS|Linux|iOS)/)).toBeVisible();
  await expect(approve.getByText(`${account.name} (${account.studentId})`)).toBeVisible();
  await expect(approve.getByRole('button', { name: 'Xác nhận đăng nhập' })).toBeDisabled();
  await approve.getByLabel('Mã đối chiếu trên thiết bị kia').fill(matchCode);
  await approve.getByRole('button', { name: 'Xác nhận đăng nhập' }).click();
  await expect(approve.getByText(/Đã xác nhận/)).toBeVisible();

  await expect(laptopPage.getByText('Đăng nhập bằng mã QR thành công')).toBeVisible({ timeout: 15_000 });
  await expect(laptopPage.getByText(`MSSV ${account.studentId}`)).toBeVisible();
  await laptop.close();
});
