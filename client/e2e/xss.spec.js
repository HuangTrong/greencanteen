// XSS trên trình duyệt thật, chạy ở dev server (chưa có CSP) nên kiểm đúng lớp escape của giao diện, không dựa vào CSP.
// Payload chỉ đặt cờ window.__xss, không có mã độc. Trình duyệt không phân giải được tên miền ngoài máy này.
import { expect, test } from '@playwright/test';
import { adminLogin, login, register, unique } from './helpers';

const MARK = (tag) => `<img src=x onerror="window.__xss='${tag}'">`;
const SCRIPT = (tag) => `<script>window.__xss='${tag}'</script>`;

async function trap(page) {
  const dialogs = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss();
  });
  return dialogs;
}

async function expectClean(page, dialogs, where) {
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => window.__xss), where).toBeUndefined();
  expect(dialogs, where).toEqual([]);
  expect(await page.locator('script:not([src]):not([type="module"])').evaluateAll((els) => els.filter((el) => el.textContent.includes('__xss')).length), where).toBe(0);
}

test('đối chứng: payload thật sự chạy nếu bị chèn dạng HTML, nên kết quả sạch ở các test sau là có nghĩa', async ({ page }) => {
  await page.goto('/profile');
  await page.evaluate((html) => document.body.insertAdjacentHTML('beforeend', html), MARK('doi-chung'));
  await expect.poll(() => page.evaluate(() => window.__xss)).toBe('doi-chung');
});

test('XSS phản chiếu: payload trên URL không chạy ở trang sinh viên và trang quản trị', async ({ page }) => {
  const dialogs = await trap(page);
  const payload = encodeURIComponent(MARK('url'));
  for (const url of [
    `/profile?auth_error=${payload}&provider=${payload}`,
    `/profile?auth=${payload}&provider=${payload}`,
    `/profile?auth=linked&provider=${encodeURIComponent(SCRIPT('provider'))}`,
    `/profile?qr=${payload}`,
    `/profile#reset=${payload}`,
    `/profile#verify=${payload}`,
    `/leaderboard?period=${payload}`,
    `/${payload}`,
    `/admin/login?next=${encodeURIComponent('javascript:window.__xss=1')}`,
    `/admin/users/${payload}`,
  ]) {
    await page.goto(url);
    await expectClean(page, dialogs, url);
  }
});

test('XSS lưu trữ: tên, mã sinh viên, câu chuyện, thông báo hiển thị dạng văn bản ở cả hai khu vực', async ({ page, request, context, browser }) => {
  const dialogs = await trap(page);
  const name = `An ${MARK('ten')}`.slice(0, 80);
  const id = unique();
  const account = await register(page, { name, studentId: `${SCRIPT('msv')}${id}`.slice(0, 40) });
  await expect(page.getByText(name).first()).toBeVisible();
  await expectClean(page, dialogs, 'trang cá nhân');

  await context.clearCookies();
  await adminLogin(page, request);
  const result = await page.evaluate(
    async ({ slug, title, payload }) => {
      const { csrfToken } = await (await fetch('/api/admin/auth/session')).json();
      const headers = { 'Content-Type': 'application/json', 'X-Requested-With': 'GreenCanteen', 'X-CSRF-Token': csrfToken };
      const send = (method, url, body) => fetch(url, { method, headers, body: JSON.stringify(body) }).then(async (res) => ({ status: res.status, data: await res.json() }));
      const source = { title: payload, authors: [payload], journal: payload, year: 2024, url: 'https://example.org/bai-bao', doi: '10.1234/abc' };
      const story = { slug, title, species: payload, icon: '🌊', imageUrl: '', summary: payload, caveat: payload, message: payload, source };
      const badUrl = await send('POST', '/api/admin/stories', { ...story, slug: `${slug}-x`, imageUrl: 'javascript:window.__xss=1', source: { ...source, url: 'javascript:window.__xss=1' } });
      const created = await send('POST', '/api/admin/stories', story);
      const settings = (await (await fetch('/api/admin/site-settings')).json());
      const { revision, updatedAt: _a, updatedByLabel: _b, ...fields } = settings;
      const saved = await send('PUT', '/api/admin/site-settings', { ...fields, revision, announcementEnabled: true, announcementText: payload, supportContact: payload });
      return { badUrl: badUrl.status, created: created.status, id: created.data.id, saved: saved.status };
    },
    { slug: `xss-${id}`.toLowerCase().replace(/[^a-z0-9-]/g, ''), title: `Tiêu đề ${MARK('tieude')}`, payload: `${MARK('truong')} ${SCRIPT('truong')}` }
  );
  expect(result.badUrl, 'URL javascript: bị từ chối').toBe(400);
  expect(result.created).toBe(201);
  expect(result.saved).toBe(200);

  for (const url of ['/admin', '/admin/users', '/admin/stories', `/admin/stories/${result.id}`, '/admin/settings', '/admin/audit']) {
    await page.goto(url);
    await page.waitForLoadState('networkidle');
    await expectClean(page, dialogs, url);
  }

  // Trình duyệt cache /api/site/settings 60 giây: context mới mới đọc được thiết lập vừa lưu
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  const visitorDialogs = await trap(visitor);
  await login(visitor, account.email, account.password);
  await expect(visitor.getByText(`MSSV ${account.studentId}`)).toBeVisible();
  for (const url of ['/', '/leaderboard', '/stories', '/profile']) {
    await visitor.goto(url);
    await visitor.waitForLoadState('networkidle');
    await expectClean(visitor, visitorDialogs, url);
  }
  // Nội dung do admin nhập hiện nguyên văn, không thành thẻ HTML
  await expect(visitor.getByText('Liên hệ: <img src=x').first()).toBeVisible();
  await visitor.goto('/');
  await expect(visitor.getByRole('status').or(visitor.getByRole('alert')).filter({ hasText: 'onerror=' }).first()).toBeVisible();
  await expect(visitor.locator('img[src="x"]')).toHaveCount(0);
  await visitorContext.close();

  // Trả lại thiết lập mặc định cho các test sau
  await page.goto('/admin/settings');
  await page.evaluate(async () => {
    const { csrfToken } = await (await fetch('/api/admin/auth/session')).json();
    const settings = await (await fetch('/api/admin/site-settings')).json();
    const { revision, updatedAt: _a, updatedByLabel: _b, ...fields } = settings;
    await fetch('/api/admin/site-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'GreenCanteen', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ ...fields, revision, announcementEnabled: false, announcementText: '', supportContact: '' }),
    });
  });
});
