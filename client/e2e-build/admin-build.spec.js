// Bản build thật qua vite preview: CSP trang quản trị, service worker không giữ gì của khu quản trị, gói sinh viên không có mã quản trị
import { expect, test } from '@playwright/test';
import { portrait } from '../../server/test/fakes/portrait.js';
import { addPasskey, adminLogin, logout, nav, openLogin, pngFile, reauthenticate, register, studentApi, virtualAuthenticator } from '../e2e/helpers';

const ADMIN_PATHS = ['/admin', '/admin/users', '/admin/stories', '/admin/stories/new', '/admin/gacha', '/admin/gacha/media', '/admin/gacha/rewards', '/admin/settings', '/admin/audit'];

/** Tên mọi mục trong Cache Storage của trang */
const cachedUrls = (page) =>
  page.evaluate(async () => {
    const urls = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      urls.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
    }
    return urls;
  });

async function waitForServiceWorker(page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
  await page.waitForFunction(async () => (await caches.keys()).length > 0);
}

test('trang quản trị chạy đủ dưới CSP: không có vi phạm nào, kể cả ảnh QR, ảnh đại diện, biểu đồ, thanh cuộn', async ({ page, request, playwright, baseURL }) => {
  const violations = [];
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const collect = async () => violations.push(...(await page.evaluate(() => window.__csp)));

  await page.goto('/admin/login');
  await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute('content', /default-src 'none'/);
  // SEC-04: khu quản trị không tải ảnh từ máy khác: img-src không còn nguồn https: bất kỳ
  const adminCsp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  const imgSrc = adminCsp.split(';').map((part) => part.trim()).find((part) => part.startsWith('img-src')).split(/\s+/);
  expect(imgSrc).toContain("'self'");
  expect(imgSrc).not.toContain('https:');
  await adminLogin(page, request);
  await collect();
  for (const path of ADMIN_PATHS) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await collect();
  }

  const { context } = await studentApi(playwright, baseURL);
  const upload = await context.put('/api/avatars/me', { multipart: { image: { name: 'anh.png', mimeType: 'image/png', buffer: await portrait(90) } } });
  expect(upload.status()).toBe(200);
  await page.goto(`/admin/users/${(await upload.json()).user.id}`);
  const avatar = page.getByRole('img', { name: 'Ảnh đại diện của tài khoản' });
  await expect.poll(() => avatar.evaluate((el) => el.naturalWidth)).toBe(256);
  await collect();

  expect(violations).toEqual([]);
  // 401 khi hỏi trạng thái trước đăng nhập không phải lỗi của trang; chỉ quan tâm lỗi thực thi
  expect(consoleErrors.filter((text) => !/Failed to load resource/.test(text))).toEqual([]);
});

test('trang quản trị không đăng ký service worker, không có manifest, không tải tài nguyên bên thứ ba', async ({ page }) => {
  const external = [];
  page.on('request', (req) => {
    if (!req.url().startsWith('http://localhost:5175') && !req.url().startsWith('data:')) external.push(req.url());
  });
  await page.goto('/admin/login');
  await page.waitForLoadState('networkidle');
  expect(external).toEqual([]);
  await expect(page.locator('link[rel="manifest"]')).toHaveCount(0);
  await expect(page.locator('#vite-plugin-pwa\\:register-sw')).toHaveCount(0);
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});

test('sinh viên: service worker chỉ precache gói công khai, không tải và không giữ mã quản trị', async ({ page }) => {
  const scripts = [];
  page.on('request', (req) => {
    if (req.resourceType() === 'script') scripts.push(new URL(req.url()).pathname);
  });
  await page.goto('/');
  await waitForServiceWorker(page);
  const urls = await cachedUrls(page);
  expect(urls.length).toBeGreaterThan(3);
  expect(urls.filter((url) => /admin|\/api\//.test(url))).toEqual([]);
  expect(scripts.filter((url) => /admin/.test(url))).toEqual([]);
});

test('máy đã có service worker: mở /admin đi thẳng ra mạng; dữ liệu quản trị không vào cache nào', async ({ page, request }) => {
  await page.goto('/');
  await waitForServiceWorker(page);
  await page.reload();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  const adminDocument = await page.goto('/admin/login');
  expect(adminDocument.fromServiceWorker()).toBe(false);
  await expect(page.getByRole('heading', { name: 'Đăng nhập quản trị' })).toBeVisible();

  await adminLogin(page, request);
  const api = page.waitForResponse((res) => res.url().includes('/api/admin/users'));
  await page.goto('/admin/users');
  const response = await api;
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  await page.waitForLoadState('networkidle');

  const urls = await cachedUrls(page);
  expect(urls.filter((url) => /\/api\/|admin/.test(url))).toEqual([]);
});

test('F-14: trang sinh viên có CSP; đăng ký, xem trước ảnh, check-in, câu chuyện, bảng xếp hạng chạy đủ, không có vi phạm nào', async ({ page }) => {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const violations = [];
  const collect = async () => violations.push(...(await page.evaluate(() => window.__csp)));

  await page.goto('/');
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("script-src 'self'");
  expect(csp).not.toContain('unsafe-inline');
  expect(csp).not.toContain('unsafe-eval');
  await collect();

  await register(page);
  await collect();
  await nav(page, 'Check-in').click();
  await page.locator('input[type="file"]').setInputFiles(pngFile());
  await expect(page.getByAltText('Xem trước ảnh check-in')).toBeVisible();
  await page.getByRole('button', { name: 'Check-in ngay' }).click();
  await expect(page.getByRole('dialog', { name: 'Check-in thành công' })).toBeVisible();
  await collect();
  await page.goto('/leaderboard');
  await page.waitForLoadState('networkidle');
  await collect();

  // Chữ chèn vào trang không chạy được: tức là CSP chặn script nội tuyến thật, không chỉ có thẻ meta
  const inlineRan = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__chayDuoc = true';
    document.head.append(script);
    return window.__chayDuoc === true;
  });
  expect(inlineRan).toBe(false);
  expect(violations).toEqual([]);
});

test('trang sinh viên dưới CSP: QR của 2FA, CAPTCHA và passkey chạy đủ, không có vi phạm nào', async ({ page }) => {
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener('securitypolicyviolation', (event) => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
  });
  const violations = [];
  const collect = async () => violations.push(...(await page.evaluate(() => window.__csp)));

  await virtualAuthenticator(page);
  const account = await register(page);
  await page.getByRole('button', { name: 'Bật', exact: true }).click();
  await reauthenticate(page, account.password);
  const qr = page.getByRole('img', { name: 'Mã QR thiết lập ứng dụng xác thực' });
  await expect.poll(() => qr.evaluate((el) => el.naturalWidth)).toBeGreaterThan(0);
  await collect();
  await page.getByRole('button', { name: 'Hủy', exact: true }).click();

  await page.getByLabel('Tên passkey').fill('Khóa bản build');
  await page.getByRole('button', { name: 'Thêm passkey' }).click();
  await expect(page.getByRole('list', { name: 'Passkey đã thêm' })).toContainText('Khóa bản build');
  await collect();
  await logout(page);

  const dialog = await openLogin(page);
  await dialog.getByLabel('Email *').fill(account.email);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dialog.getByLabel('Mật khẩu *').fill(`sai-mat-khau-${attempt}`);
    const answered = page.waitForResponse((res) => res.url().endsWith('/api/auth/login'));
    await dialog.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
    await answered;
    await expect(dialog.getByRole('button', { name: 'Đăng nhập', exact: true })).toBeEnabled();
  }
  const solved = page.waitForResponse((res) => res.url().endsWith('/api/auth/captcha'));
  await dialog.getByLabel('Mật khẩu *').fill(account.password);
  await dialog.getByRole('button', { name: 'Đăng nhập', exact: true }).click();
  await solved;
  await expect(page.getByRole('dialog').getByText('Đăng nhập thành công')).toBeVisible();
  await expect(page.getByText(`MSSV ${account.studentId}`)).toBeVisible();
  await collect();
  await logout(page);

  const again = await openLogin(page);
  await again.getByRole('button', { name: /Đăng nhập bằng passkey/ }).click();
  await expect(again.getByText('Đăng nhập bằng passkey thành công')).toBeVisible();
  await collect();
  expect(violations).toEqual([]);
});

test('robots.txt phục vụ được; đường dẫn con của khu quản trị trả đúng trang quản trị', async ({ request, page }) => {
  const robots = await request.get('/robots.txt');
  expect(robots.status()).toBe(200);
  expect(await robots.text()).toContain('Disallow: /api/');
  await page.goto('/admin/gacha');
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page).toHaveTitle(/Quản trị GreenCanteen/);
});