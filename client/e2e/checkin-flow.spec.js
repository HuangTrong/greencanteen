// Kiểm thử hệ thống: trình duyệt thật → Vite → API → MongoDB (in-memory). Luồng chính của sinh viên.
import { expect, test } from '@playwright/test';
import { portrait } from '../../server/test/fakes/portrait.js';
import { login, logout, nav, pngFile, register } from './helpers';

const statValue = (page, label) => page.getByText(label, { exact: true }).locator('xpath=preceding-sibling::p');

test('đăng ký → check-in bằng ảnh tải lên → câu chuyện có nguồn → Gacha → hồ sơ, lịch sử, ảnh đại diện, xếp hạng → đăng xuất → đăng nhập lại', async ({ page }, testInfo) => {
  const account = await register(page);
  expect(await page.evaluate(() => document.cookie)).not.toContain('gc_session');

  await nav(page, 'Check-in').click();
  await expect(page.getByText(/Chế độ mô phỏng/)).toBeVisible();
  const image = pngFile();
  await page.locator('input[type="file"]').setInputFiles(image);
  await expect(page.getByAltText('Xem trước ảnh check-in')).toBeVisible();
  await page.getByRole('button', { name: 'Check-in ngay' }).click();

  const story = page.getByRole('dialog', { name: 'Check-in thành công' });
  await expect(story).toBeVisible();
  await expect(story.getByText('+10 Eco-points')).toBeVisible();
  await expect(story.getByText('MÔ PHỎNG — không phải AI')).toBeVisible();
  const doi = story.getByRole('link', { name: /DOI: 10\./ });
  await expect(doi).toHaveAttribute('href', /^https:\/\/doi\.org\/10\./);
  await expect(doi).toHaveAttribute('target', '_blank');
  await expect(doi).toHaveAttribute('rel', 'noopener noreferrer');

  await story.getByRole('button', { name: /Quay Gacha/ }).click();
  const prize = page.getByRole('dialog', { name: 'Phần thưởng Gacha' });
  await expect(prize).toBeVisible();
  const code = (await prize.getByText(/^GC-\d+K-[0-9A-F]{8}$/).textContent()).trim();
  await prize.getByRole('button', { name: 'Hoàn tất' }).click();
  await expect(prize).toBeHidden();

  // Cùng ảnh gửi lại → bị chặn
  await page.locator('input[type="file"]').setInputFiles(image);
  await page.getByRole('button', { name: 'Check-in ngay' }).click();
  await expect(page.getByRole('alert')).toContainText('Ảnh này đã được dùng để check-in trước đó.');

  await nav(page, 'Cá nhân').click();
  await expect(page.getByText(code)).toBeVisible();
  await expect(page.getByText('+10 điểm')).toBeVisible();
  await expect(page.getByText('🌱 Ngụm đầu tiên xanh')).toBeVisible();
  await expect(page.getByText('Lượt quay đang có: 0')).toBeVisible();
  await page.getByLabel('Chọn ảnh đại diện').setInputFiles({ name: 'chan-dung.png', mimeType: 'image/png', buffer: await portrait(120) });
  await expect(page.getByRole('img', { name: 'Ảnh đại diện' })).toBeVisible();

  await nav(page, 'Xếp hạng').click();
  const row = page.getByRole('listitem').filter({ hasText: account.name });
  await expect(row).toBeVisible();
  await expect.poll(() => row.locator('img').evaluate((el) => el.naturalWidth)).toBe(256);
  await page.getByRole('button', { name: 'Tháng' }).click();
  await expect(page.getByRole('button', { name: 'Tháng' })).toHaveAttribute('aria-pressed', 'true');
  await expect(row).toBeVisible();

  await nav(page, 'Trang chủ').click();
  await expect(page.getByText(`Xin chào, ${account.name}`)).toBeVisible();
  await expect(statValue(page, 'Lượt check-in')).toHaveText(/^[1-9]/);

  // Đăng xuất: ô ở trang chủ về 0; dữ liệu tài khoản vẫn còn nguyên khi đăng nhập lại
  await logout(page);
  await page.goto('/');
  await expect(page.getByText('Bạn chưa đăng nhập')).toBeVisible();
  await expect(statValue(page, 'Lượt check-in')).toHaveText('0');
  await expect(statValue(page, 'Nhựa giảm')).toHaveText('0g');
  await expect(statValue(page, 'Sinh vật bảo vệ')).toHaveText('0');
  await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState === 'finished'));
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}_home-logged-out.png`), fullPage: true });

  await login(page, account.email, account.password);
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();
  await page.goto('/');
  await expect(page.getByText(/1 lần check-in · 12g nhựa đã tránh/)).toBeVisible();
  await expect(statValue(page, 'Lượt check-in')).toHaveText(/^[1-9]/);
});

test('tệp không phải ảnh bị chặn ở client; tệp đổi đuôi .png bị server từ chối theo nội dung', async ({ page }) => {
  await register(page);
  await page.goto('/checkin');
  await page.locator('input[type="file"]').setInputFiles({ name: 'ghi-chu.txt', mimeType: 'text/plain', buffer: Buffer.from('xin chao') });
  await expect(page.getByRole('alert')).toHaveText('Tệp đã chọn không phải ảnh.');
  await page.locator('input[type="file"]').setInputFiles({ name: 'gia-mao.png', mimeType: 'image/png', buffer: Buffer.from('<svg onload="alert(1)"/>') });
  await page.getByRole('button', { name: 'Check-in ngay' }).click();
  await expect(page.getByRole('alert')).toContainText('Tệp không phải ảnh JPEG, PNG hoặc WebP');
});

test('tên chứa HTML hiển thị nguyên văn trên bảng xếp hạng, không chạy script', async ({ page }) => {
  const name = `<img src=x onerror="window.__xss=1"> ${Date.now()}`;
  await register(page, { name });
  await page.goto('/checkin');
  await page.locator('input[type="file"]').setInputFiles(pngFile());
  await page.getByRole('button', { name: 'Check-in ngay' }).click();
  await page.getByRole('dialog', { name: 'Check-in thành công' }).getByRole('button', { name: /Quay sau/ }).click();
  await page.goto('/leaderboard');
  await expect(page.getByText(name)).toBeVisible();
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
});

test.describe('camera', () => {
  test('cho phép camera (thiết bị giả của trình duyệt) → chụp → check-in thành công', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['camera'], { origin: baseURL });
    await register(page);
    await page.goto('/checkin');
    await page.getByRole('button', { name: 'Mở camera' }).click();
    const video = page.locator('video');
    await expect(video).toBeVisible();
    // Mỗi cấu hình dùng video giả riêng (playwright.config.js) → ảnh chụp không trùng giữa các cấu hình
    await expect.poll(() => video.evaluate((v) => v.videoWidth), { timeout: 10_000 }).toBe(160);
    await page.getByRole('button', { name: 'Chụp ảnh' }).click();
    await expect(page.getByAltText('Xem trước ảnh check-in')).toBeVisible();
    await expect(video).toHaveCount(0);
    await page.getByRole('button', { name: 'Check-in ngay' }).click();
    await expect(page.getByRole('dialog', { name: 'Check-in thành công' })).toBeVisible();
  });

  test('từ chối quyền camera → hướng dẫn tải ảnh từ thư viện; vẫn check-in được bằng ảnh tải lên', async ({ page }) => {
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await register(page);
    await page.goto('/checkin');
    await page.getByRole('button', { name: 'Mở camera' }).click();
    await expect(page.getByRole('alert')).toHaveText('Không mở được camera. Hãy cho phép truy cập camera hoặc tải ảnh từ thư viện.');
    await page.locator('input[type="file"]').setInputFiles(pngFile());
    await page.getByRole('button', { name: 'Check-in ngay' }).click();
    await expect(page.getByRole('dialog', { name: 'Check-in thành công' })).toBeVisible();
  });
});
