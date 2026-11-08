// Bản build thật qua vite preview: Meta và công cụ tìm kiếm đọc các trang thông tin, chính sách bằng trình thu thập, nên nội dung phải nằm
// sẵn trong HTML trả về. Danh sách trang ở src/legal/pages.js
import { expect, test } from '@playwright/test';
import { openLogin } from '../e2e/helpers';
import { FOOTER_PAGES, LEGAL_PAGES } from '../src/legal/pages.js';

const PRIVACY_TITLE = 'Chính sách bảo mật và xử lý dữ liệu cá nhân';
const DEFAULT_CONTACT = 'quản trị viên GreenCanteen';
const PAGES = [
  ['/privacy.html', PRIVACY_TITLE, 'Dữ liệu được thu thập'],
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
      await expect(page.locator('[data-support-contact]').first()).toHaveText(DEFAULT_CONTACT);
      // Có CSS của ứng dụng: chữ tiêu đề màu lá, không phải màu mặc định của trình duyệt
      await expect(page.getByRole('heading', { level: 1 })).toHaveCSS('color', 'rgb(22, 101, 52)');
    });
  }

  test('mọi trang thông tin, chính sách: 200, có tiêu đề và chân trang chung đã chèn sẵn trong HTML', async ({ page, request }) => {
    for (const { path, title } of LEGAL_PAGES) {
      const response = await request.get(path, { maxRedirects: 0 });
      expect(response.status(), path).toBe(200);
      expect(await response.text(), path).not.toContain('<!--legal-footer-->');

      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      const footer = page.getByRole('navigation', { name: 'Thông tin và chính sách' });
      await expect(footer.getByRole('link')).toHaveCount(FOOTER_PAGES.filter((p) => p.path !== path).length);
    }
  });
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
  }
  for (const { path } of LEGAL_PAGES) {
    await page.goto(path);
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    await page.waitForLoadState('networkidle');
    expect(await page.evaluate(() => window.__csp), path).toEqual([]);
  }
  expect(requested.filter((url) => !url.startsWith('http://localhost:5175'))).toEqual([]);
});

test('trang thể lệ quay thưởng hiện mẫu móc khóa, ảnh, xác suất và hướng dẫn nhận quà theo cấu hình đang hiệu lực', async ({ page }) => {
  await page.goto('/gacha-rules.html');
  const table = page.locator('[data-gacha-config] table');
  await expect(table).toBeVisible();
  await expect(page.locator('[data-gacha-status]')).toContainText(/^Phiên bản \d+/);
  await expect(page.locator('[data-gacha-summary]')).toContainText(/Cơ hội trúng của mỗi lượt lúc này/);
  const row = table.locator('tbody tr').first();
  await expect(row).toContainText('Lá xanh');
  await expect(row.getByRole('img', { name: 'Móc khóa Lá xanh' })).toBeVisible();
  await expect(page.locator('[data-gacha-claim]')).toContainText('Nhận tại quầy căn tin');
});

test('máy đã có service worker: mở các trang tĩnh vẫn ra đúng trang, không rơi về ứng dụng React', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  for (const { path, title } of LEGAL_PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    expect(new URL(page.url()).pathname).toBe(path);
    await expect(page.locator('#root')).toHaveCount(0);
  }
});

test('trang chủ và popup đăng nhập có liên kết tới chính sách; hai trang liên kết qua lại', async ({ page }) => {
  await page.goto('/');
  const footerLink = page.locator('main').getByRole('link', { name: PRIVACY_TITLE, exact: true });
  await expect(footerLink).toHaveAttribute('href', '/privacy.html');
  await expect(page.locator('main').getByRole('link', { name: 'Thể lệ quay thưởng', exact: true })).toHaveAttribute('href', '/gacha-rules.html');

  const dialog = await openLogin(page);
  await expect(dialog.getByRole('link', { name: PRIVACY_TITLE })).toHaveAttribute('href', '/privacy.html');
  await expect(dialog.getByRole('link', { name: 'Điều khoản sử dụng' })).toHaveAttribute('href', '/terms.html');

  await page.goto('/');
  await footerLink.click();
  await expect(page).toHaveURL(/\/privacy\.html$/);
  await page.locator('main').getByRole('link', { name: 'Hướng dẫn xóa dữ liệu' }).click();
  await expect(page).toHaveURL(/\/data-deletion\.html$/);
  await page.locator('main').getByRole('link', { name: PRIVACY_TITLE }).click();
  await expect(page).toHaveURL(/\/privacy\.html$/);
});
