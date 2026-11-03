// Bản build thật qua vite preview: Meta yêu cầu trình thu thập đọc được hai trang này, nên nội dung phải nằm sẵn trong HTML trả về
import { expect, test } from '@playwright/test';
import { openLogin } from '../e2e/helpers';

const PAGES = [
  ['/privacy.html', 'Chính sách quyền riêng tư', 'Dữ liệu được thu thập'],
  ['/data-deletion.html', 'Hướng dẫn xóa dữ liệu', 'Xóa toàn bộ tài khoản'],
];

test.describe('không chạy JavaScript, như trình thu thập', () => {
  test.use({ javaScriptEnabled: false });

  for (const [path, heading, section] of PAGES) {
    test(`${path}: trả 200 không chuyển hướng, HTML đã có đủ nội dung và định dạng`, async ({ page, request }) => {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status()).toBe(200);
      expect(response.headers()['content-type']).toContain('text/html');
      const html = await response.text();
      expect(html).toContain(heading);
      expect(html).toContain(section);

      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
      await expect(page.getByRole('heading', { level: 2, name: section })).toBeVisible();
      await expect(page.locator('[data-support-contact]').first()).toHaveText('quản trị viên GreenCanteen của trường');
      // Có CSS của ứng dụng: chữ tiêu đề màu lá, không phải màu mặc định của trình duyệt
      await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('color', 'rgb(22, 101, 52)');
    });
  }
});

test('bật JavaScript: hiện liên hệ do admin đặt dưới dạng chữ, có CSP, không vi phạm, không gọi ra bên thứ ba', async ({ page }) => {
  const contact = '<b>ctsv@truong.edu.vn</b>';
  await page.route('**/api/site/settings', (route) => route.fulfill({ json: { supportContact: contact } }));
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const requested = [];
  page.on('request', (req) => requested.push(req.url()));

  for (const [path] of PAGES) {
    await page.goto(path);
    await expect(page.locator('[data-support-contact]').first()).toHaveText(contact);
    await expect(page.locator('[data-support-contact] b')).toHaveCount(0);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => window.__csp)).toEqual([]);
  }
  expect(requested.filter((url) => !url.startsWith('http://localhost:5175'))).toEqual([]);
});

test('máy đã có service worker: mở hai trang vẫn ra đúng trang, không rơi về ứng dụng React', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  for (const [path, heading] of PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(page.locator('#root')).toHaveCount(0);
  }
});

test('trang chủ và popup đăng nhập có liên kết tới chính sách; hai trang liên kết qua lại', async ({ page }) => {
  await page.goto('/');
  const footerLink = page.locator('main').getByRole('link', { name: 'Chính sách quyền riêng tư', exact: true });
  await expect(footerLink).toHaveAttribute('href', '/privacy.html');

  const dialog = await openLogin(page);
  await expect(dialog.getByRole('link', { name: 'Chính sách quyền riêng tư' })).toHaveAttribute('href', '/privacy.html');

  await page.goto('/');
  await footerLink.click();
  await expect(page).toHaveURL(/\/privacy\.html$/);
  await page.getByRole('link', { name: 'Hướng dẫn xóa dữ liệu' }).click();
  await expect(page).toHaveURL(/\/data-deletion\.html$/);
  await page.getByRole('link', { name: 'Chính sách quyền riêng tư' }).click();
  await expect(page).toHaveURL(/\/privacy\.html$/);
});
