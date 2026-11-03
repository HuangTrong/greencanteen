// Kiểm thử hệ thống khu quản trị trên trình duyệt thật: truy cập trái phép, đăng nhập MFA, các màn hình, hiển thị, bàn phím
import { expect, test } from '@playwright/test';
import { portrait } from '../../server/test/fakes/portrait.js';
import { adminLogin, confirmReauth, expireReauth, pngFile, register, revokeAdminSessions, studentApi, unique } from './helpers';

const ADMIN_PAGES = [
  ['/admin', 'Tổng quan'],
  ['/admin/users', 'Tài khoản'],
  ['/admin/stories', 'Câu chuyện'],
  ['/admin/stories/new', 'Thêm câu chuyện'],
  ['/admin/gacha', 'Gacha'],
  ['/admin/settings', 'Thiết lập website'],
  ['/admin/audit', 'Nhật ký kiểm toán'],
];
const ADMIN_APIS = ['/api/admin/overview', '/api/admin/users', '/api/admin/stories', '/api/admin/gacha/configs', '/api/admin/site-settings', '/api/admin/audit-logs'];

const baseUrl = (testInfo) => testInfo.project.use.baseURL;

/** Trên màn hình hẹp menu được thu gọn: mở menu rồi mới chọn mục */
async function openMenu(page) {
  const toggle = page.getByRole('button', { name: 'Menu' });
  if (await toggle.isVisible()) await toggle.click();
}

async function goToSection(page, name) {
  await openMenu(page);
  await page.getByRole('navigation', { name: 'Khu quản trị' }).getByRole('link', { name, exact: true }).click();
}

test('khách vào thẳng URL hoặc gọi API thủ công: không thấy dữ liệu nào', async ({ page, request }) => {
  for (const [path] of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/admin\/login$/);
    await expect(page.getByRole('heading', { name: 'Đăng nhập quản trị' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Khu quản trị' })).toHaveCount(0);
  }
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  for (const path of ADMIN_APIS) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(401);
    expect(res.headers()['cache-control']).toContain('no-store');
    expect(res.headers()['x-robots-tag']).toContain('noindex');
  }
});

test('sinh viên đang đăng nhập: URL quản trị về màn đăng nhập, gọi API từ chính phiên đó bị 401', async ({ page }) => {
  await register(page);
  await page.goto('/admin/users');
  await expect(page).toHaveURL(/\/admin\/login$/);
  const statuses = await page.evaluate(async (paths) => {
    const results = [];
    for (const path of paths) results.push((await fetch(path, { credentials: 'include' })).status);
    const write = await fetch('/api/admin/stories', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'GreenCanteen' },
      body: JSON.stringify({ slug: 'tu-sinh-vien', title: 'Không được ghi' }),
    });
    return [...results, write.status];
  }, ADMIN_APIS);
  expect(statuses).toEqual(Array(ADMIN_APIS.length + 1).fill(401));
  await expect(page.getByRole('heading', { name: 'Đăng nhập quản trị' })).toBeVisible();
});

test('mật khẩu đúng của sinh viên không mở được khu quản trị; thông báo giống hệt sai mật khẩu', async ({ page }) => {
  const account = await register(page);
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(account.email);
  await page.getByLabel('Mật khẩu').fill(account.password);
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toHaveText('Email hoặc mật khẩu không đúng.');
  await page.getByLabel('Mật khẩu').fill('sai-mat-khau-hoan-toan');
  await page.getByRole('button', { name: 'Tiếp tục' }).click();
  await expect(alert).toHaveText('Email hoặc mật khẩu không đúng.');
});

test('quản trị viên đăng ký MFA, mọi màn hình kể cả trang chi tiết hiển thị được, không cuộn ngang; ảnh chụp làm bằng chứng', async ({ page, request }, testInfo) => {
  test.setTimeout(120_000);
  const checkLayout = async (name) => {
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${name} cuộn ngang ${overflow}px`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}_${name}.png`), fullPage: true });
  };

  await adminLogin(page, request);
  for (const [path, heading] of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await checkLayout(path.slice(1).replace(/\//g, '_'));
  }

  // Trang chi tiết: bảng rộng và ô nhập nằm ở đây, cuộn ngang thường xuất hiện ở các trang này
  for (const [path, region] of [
    ['/admin/users', 'Danh sách tài khoản'],
    ['/admin/stories', 'Danh sách câu chuyện'],
    ['/admin/gacha', 'Các phiên bản cấu hình Gacha'],
  ]) {
    await page.goto(path);
    await page.getByRole('region', { name: region }).getByRole('link').first().click();
    await expect(page).toHaveURL(/\/[a-f0-9]{24}$/);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await checkLayout(`admin_chi_tiet${path.replace('/admin/', '_')}`);
  }
  await page.goto('/admin/gacha');
  await page.getByRole('button', { name: 'Tạo bản nháp mới' }).click();
  await expect(page.getByRole('region', { name: 'Danh mục giải của bản nháp' })).toBeVisible();
  await checkLayout('admin_ban_nhap_gacha');
});

test('trợ năng: mọi nút có tên, ô nhập có nhãn, ảnh có alt, lang="vi"; liên kết bỏ qua điều hướng hoạt động', async ({ page, request }) => {
  await adminLogin(page, request);
  for (const [path, heading] of ADMIN_PAGES) {
    await page.goto(path);
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(await page.getAttribute('html', 'lang')).toBe('vi');
    const unnamed = await page.locator('button').evaluateAll((els) => els.filter((b) => !(b.innerText.trim() || b.getAttribute('aria-label'))).map((b) => b.outerHTML));
    expect(unnamed, path).toEqual([]);
    const unlabeled = await page.locator('input, select, textarea').evaluateAll((els) => els.filter((i) => !(i.getAttribute('aria-label') || i.labels?.length)).map((i) => i.outerHTML));
    expect(unlabeled, path).toEqual([]);
    expect(await page.locator('img:not([alt])').count(), path).toBe(0);
  }
  await page.goto('/admin/users');
  await expect(page.getByRole('heading', { name: 'Tài khoản', level: 1 })).toBeVisible();
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Bỏ qua điều hướng' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#admin-main')).toBeFocused();
});

test('bàn phím: đi hết menu bằng Tab, Enter chuyển trang, focus về nội dung; hộp thoại giữ focus, Escape đóng', async ({ page, request, isMobile }) => {
  test.skip(isMobile, 'Kịch bản bàn phím dành cho màn hình có bàn phím');
  await adminLogin(page, request);
  await openMenu(page);
  const link = page.getByRole('navigation', { name: 'Khu quản trị' }).getByRole('link', { name: 'Tài khoản', exact: true });
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Tài khoản', level: 1 })).toBeVisible();
  await expect(page.locator('#admin-main')).toBeFocused();

  await page.getByRole('link', { name: /^Quản trị E2E/ }).first().focus();
  await page.keyboard.press('Enter');
  const trigger = page.getByRole('button', { name: 'Đổi mã sinh viên' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Đổi mã sinh viên' });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement)), `Tab lần ${i + 1}`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('biểu đồ dùng phím mũi tên; đổi khoảng thời gian cập nhật số liệu; tài chính báo chưa có nguồn', async ({ page, request, playwright }, testInfo) => {
  const { context } = await studentApi(playwright, baseUrl(testInfo));
  const checkIn = await context.post('/api/checkin', { multipart: { image: pngFile() } });
  expect(checkIn.status()).toBe(200);
  expect((await context.post('/api/gacha/spin')).status()).toBe(200);

  await adminLogin(page, request);
  await expect(page.getByText('Doanh thu', { exact: true }).locator('..')).toContainText('Chưa có nguồn dữ liệu');
  await expect(page.getByText('Lợi nhuận', { exact: true }).locator('..')).toContainText('Chưa có nguồn dữ liệu');
  await expect(page.getByText('Không phải doanh thu hay chi phí', { exact: true })).toBeVisible();

  const chart = page.getByRole('img', { name: /Check-in/ });
  await chart.focus();
  await page.keyboard.press('End');
  await expect(page.locator('figure', { has: chart }).getByRole('status')).toContainText('hợp lệ');

  await page.getByRole('button', { name: '7 ngày' }).click();
  await expect(page.getByRole('button', { name: '7 ngày' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('region', { name: 'Số liệu theo từng kỳ' }).getByRole('row')).toHaveCount(8);
  await page.getByLabel('Gộp theo').selectOption('month');
  await expect(page.getByRole('region', { name: 'Số liệu theo từng kỳ' }).getByRole('row').nth(1)).toBeVisible();
  await context.dispose();
});

test('thống kê truy cập xuyên suốt: khách mở trang và nhấp nút chính, số liệu hiện ở tổng quan, không có dữ liệu định danh', async ({ page, request, browser }, testInfo) => {
  const visitor = await browser.newContext({ baseURL: baseUrl(testInfo) });
  const publicPage = await visitor.newPage();
  const events = [];
  publicPage.on('request', (req) => {
    if (req.url().includes('/api/analytics/events')) events.push(req.postDataJSON());
  });
  await publicPage.goto('/');
  await publicPage.getByRole('link', { name: 'Đăng nhập / Đăng ký' }).click();
  await expect(publicPage).toHaveURL(/\/profile$/);
  await expect.poll(() => events.map((event) => `${event.type}:${event.page || event.target}`)).toEqual(
    expect.arrayContaining(['page_view:home', 'impression:home_primary_cta', 'click:home_primary_cta', 'page_view:profile'])
  );
  for (const event of events) expect(Object.keys(event).sort().join()).toMatch(/^(page|target),type,visitId$/);
  await visitor.close();

  await adminLogin(page, request);
  const section = page.getByRole('heading', { name: 'Truy cập' }).locator('..');
  await expect(section.getByText('Lượt xem trang', { exact: true }).locator('..')).not.toContainText('Chưa có nguồn dữ liệu');
  await expect(section.getByRole('region', { name: 'Tỉ lệ nhấp theo mục' }).getByRole('row', { name: /Nút chính ở trang chủ/ })).toBeVisible();
  await expect(section).toContainText('giữ 90 ngày rồi tự xóa');
});

test('câu chuyện: lưu nháp thiếu nguồn, nguồn HTTP bị từ chối, xem trước, xuất bản, sinh viên thấy, gỡ', async ({ page, request }) => {
  await adminLogin(page, request);
  await goToSection(page, 'Câu chuyện');
  await page.getByRole('button', { name: 'Thêm câu chuyện' }).click();
  await expect(page.getByRole('heading', { name: 'Thêm câu chuyện', level: 1 })).toBeVisible();

  const title = `Câu chuyện thử ${unique()}`;
  await page.getByLabel('Tiêu đề', { exact: true }).fill(title);
  await expect(page.getByLabel('Slug')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Lưu nháp' }).click();
  await expect(page.getByText('Đã lưu.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/stories\/[a-f0-9]{24}$/);

  await page.getByRole('button', { name: 'Xuất bản' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Tóm tắt')).toHaveAttribute('aria-invalid', 'true');

  await page.getByLabel('Loài được đề cập').fill('Rùa biển');
  await page.getByLabel('Tóm tắt').fill('Tóm tắt thử nghiệm.');
  await page.getByLabel('Thông điệp').fill('Thông điệp thử nghiệm.');
  await page.getByLabel('Tên bài báo').fill('Bài báo thử');
  await page.getByLabel('Tác giả (mỗi dòng một người)').fill('Tác giả A');
  await page.getByLabel('Tạp chí').fill('Tạp chí thử');
  await page.getByLabel('Năm').fill('2020');
  await page.getByLabel('URL nguồn (HTTPS)').fill('http://example.org/bai-bao');
  await page.getByRole('button', { name: 'Xuất bản' }).click();
  await expect(page.getByText('URL nguồn phải dùng https://.')).toBeVisible();

  await page.getByLabel('URL nguồn (HTTPS)').fill('https://example.org/bai-bao');
  const preview = page.getByRole('complementary', { name: 'Xem trước' });
  await expect(preview.getByRole('heading', { name: title })).toBeVisible();
  await expect(preview.getByRole('link', { name: /Mở bài báo/ })).toHaveAttribute('href', 'https://example.org/bai-bao');
  await page.getByRole('button', { name: 'Xuất bản' }).click();
  await expect(page.getByText('Đã xuất bản câu chuyện.')).toBeVisible();

  await page.getByRole('button', { name: 'Gỡ câu chuyện' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gỡ câu chuyện' });
  await dialog.getByRole('button', { name: 'Gỡ câu chuyện' }).click();
  await expect(page.getByText('Đã gỡ câu chuyện.')).toBeVisible();
});

test('Gacha: nháp phải đủ 100%, xuất bản cần xác thực lại, phần thưởng của sinh viên theo cấu hình mới', async ({ page, request, playwright }, testInfo) => {
  // Có hai lần xác thực lại, lần sau phải chờ mã TOTP mới; trên cấu hình di động mỗi thao tác trong bảng cũng chậm hơn
  test.setTimeout(150_000);
  const admin = await adminLogin(page, request);
  await goToSection(page, 'Gacha');
  await page.getByRole('button', { name: 'Tạo bản nháp mới' }).click();
  await expect(page.getByRole('heading', { name: /^Phiên bản \d+$/ })).toBeVisible();
  const version = Number((await page.getByRole('heading', { name: /^Phiên bản \d+$/ }).textContent()).replace(/\D/g, ''));

  // Tắt mọi giải trừ giải đầu, đặt 90%: chưa đủ điều kiện
  const toggles = page.getByRole('checkbox', { name: /^Bật giải/ });
  for (let i = 1; i < (await toggles.count()); i += 1) await toggles.nth(i).uncheck();
  await page.getByLabel('Mệnh giá giải 1', { exact: true }).fill('30000');
  await page.getByLabel('Xác suất giải 1', { exact: true }).fill('90');
  await expect(page.getByText(/phải bằng đúng 100%/)).toBeVisible();
  await page.getByRole('button', { name: 'Xuất bản' }).click();
  await page.getByRole('dialog', { name: `Xuất bản phiên bản ${version}` }).getByRole('button', { name: 'Xuất bản' }).click();
  await expect(page.getByText(/Tổng xác suất các giải đang bật phải bằng 100%/)).toBeVisible();

  await page.getByLabel('Xác suất giải 1', { exact: true }).fill('100');
  await expect(page.getByText(/100% — hợp lệ/)).toBeVisible();
  await expireReauth(request, admin);
  await page.getByRole('button', { name: 'Xuất bản' }).click();
  await page.getByRole('dialog', { name: `Xuất bản phiên bản ${version}` }).getByRole('button', { name: 'Xuất bản' }).click();
  await confirmReauth(page, admin);
  await expect(page.getByText(`Đã xuất bản phiên bản ${version}.`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ngừng hiệu lực' })).toBeVisible();

  const { context } = await studentApi(playwright, baseUrl(testInfo));
  expect((await context.post('/api/checkin', { multipart: { image: pngFile() } })).status()).toBe(200);
  const spin = await (await context.post('/api/gacha/spin')).json();
  expect(spin.prize.amountVnd).toBe(30_000);
  await context.dispose();

  await page.reload();
  const row = page.getByRole('region', { name: 'Danh mục giải của phiên bản đã xuất bản' }).getByRole('row').nth(1);
  await expect(row).toContainText('30.000 ₫');
  await expect(row).toContainText('100%');

  // Trả lại cấu hình để các kịch bản khác không phụ thuộc mệnh giá vừa đặt
  await expireReauth(request, admin);
  await page.getByRole('button', { name: 'Ngừng hiệu lực' }).click();
  await page.getByRole('dialog', { name: `Ngừng phiên bản ${version}` }).getByRole('button', { name: 'Ngừng hiệu lực' }).click();
  await confirmReauth(page, admin);
  await expect(page.getByText('Đã ngừng hiệu lực.')).toBeVisible();
});

test('tài khoản: dữ liệu được che, xem đầy đủ cần xác thực lại; khóa đẩy sinh viên ra ngay; có nhật ký', async ({ page, request, playwright }, testInfo) => {
  const { context, account } = await studentApi(playwright, baseUrl(testInfo));
  expect((await context.get('/api/auth/me')).status()).toBe(200);

  const admin = await adminLogin(page, request);
  await goToSection(page, 'Tài khoản');
  await page.getByLabel('Tìm kiếm').fill(account.email);
  await page.getByRole('button', { name: 'Tìm', exact: true }).click();
  const link = page.getByRole('link', { name: account.name });
  await expect(link).toBeVisible();
  await expect(page.getByRole('region', { name: 'Danh sách tài khoản' })).not.toContainText(account.email);
  await link.click();

  await expect(page.getByRole('main')).not.toContainText(account.email);
  await expireReauth(request, admin);
  await page.getByRole('button', { name: 'Hiện dữ liệu đầy đủ' }).click();
  await confirmReauth(page, admin);
  await expect(page.getByRole('main')).toContainText(account.email);

  await page.getByRole('button', { name: 'Khóa tài khoản' }).click();
  const dialog = page.getByRole('dialog', { name: 'Khóa tài khoản' });
  await dialog.getByLabel('Lý do').fill('Kiểm thử hệ thống');
  await dialog.getByRole('button', { name: 'Khóa tài khoản' }).click();
  await expect(page.getByText('Đã khóa tài khoản và thu hồi mọi phiên.')).toBeVisible();

  expect((await context.get('/api/auth/me')).status()).toBe(401);
  const relogin = await context.post('/api/auth/login', { data: { email: account.email, password: account.password } });
  expect(relogin.status()).toBe(403);
  expect((await relogin.json()).code).toBe('account_locked');
  await context.dispose();

  await goToSection(page, 'Nhật ký kiểm toán');
  await page.getByLabel('Thao tác').selectOption({ label: 'Đổi trạng thái tài khoản' });
  const log = page.getByRole('region', { name: 'Nhật ký kiểm toán' });
  await expect(log.getByRole('row').nth(1)).toContainText('Thành công');
  await expect(log).not.toContainText(account.email);
  await expect(log.getByRole('button')).toHaveCount(0);
});

test('gỡ ảnh đại diện: admin xem được ảnh, gỡ cần xác thực lại; ảnh mất hẳn, sinh viên vẫn dùng bình thường; có nhật ký', async ({ page, request, playwright }, testInfo) => {
  const { context, account } = await studentApi(playwright, baseUrl(testInfo));
  const upload = await context.put('/api/avatars/me', { multipart: { image: { name: 'anh.png', mimeType: 'image/png', buffer: await portrait(300) } } });
  expect(upload.status()).toBe(200);
  const { avatarUrl } = (await upload.json()).user;

  const admin = await adminLogin(page, request);
  await goToSection(page, 'Tài khoản');
  await page.getByLabel('Tìm kiếm').fill(account.email);
  await page.getByRole('button', { name: 'Tìm', exact: true }).click();
  await page.getByRole('link', { name: account.name }).click();
  const image = page.getByRole('img', { name: 'Ảnh đại diện của tài khoản' });
  await expect.poll(() => image.evaluate((el) => el.naturalWidth)).toBe(256);
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}_admin_go_anh.png`) });

  await expireReauth(request, admin);
  await page.getByRole('button', { name: 'Gỡ ảnh đại diện' }).click();
  const dialog = page.getByRole('dialog', { name: 'Gỡ ảnh đại diện' });
  await dialog.getByLabel('Lý do').fill('Ảnh vi phạm quy định');
  await dialog.getByRole('button', { name: 'Gỡ ảnh' }).click();
  await confirmReauth(page, admin);
  await expect(page.getByText('Đã gỡ ảnh đại diện.')).toBeVisible();
  await expect(image).toHaveCount(0);

  expect((await context.get(avatarUrl)).status()).toBe(404);
  const me = await context.get('/api/auth/me');
  expect(me.status()).toBe(200);
  expect((await me.json()).user.avatarUrl).toBeNull();
  await context.dispose();

  await goToSection(page, 'Nhật ký kiểm toán');
  await page.getByLabel('Thao tác').selectOption({ label: 'Gỡ ảnh đại diện' });
  const log = page.getByRole('region', { name: 'Nhật ký kiểm toán' });
  await expect(log.getByRole('row').nth(1)).toContainText('Thành công');
  await expect(log).not.toContainText(account.email);
});

test('thiết lập website: thay đổi xuất hiện ở trang công khai; nội dung được hiển thị dạng văn bản', async ({ page, request, browser }, testInfo) => {
  await adminLogin(page, request);
  await goToSection(page, 'Thiết lập website');
  const tagline = page.getByLabel('Khẩu hiệu đầu trang');
  const original = await tagline.inputValue();
  const marker = `<b>Khẩu hiệu ${unique()}</b>`;
  await tagline.fill(marker);
  await page.getByRole('button', { name: 'Lưu thiết lập' }).click();
  await expect(page.getByText(/Đã lưu thiết lập/)).toBeVisible();

  const visitor = await browser.newContext({ baseURL: baseUrl(testInfo) });
  const publicPage = await visitor.newPage();
  await publicPage.goto('/');
  await expect(publicPage.getByText(marker)).toBeVisible();
  await visitor.close();

  await tagline.fill(original);
  await page.getByRole('button', { name: 'Lưu thiết lập' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Đã lưu thiết lập' })).toBeVisible();
});

test('phiên hết hạn phía server: thao tác tiếp theo về màn đăng nhập, dữ liệu không còn hiển thị', async ({ page, request }) => {
  const admin = await adminLogin(page, request);
  // Chờ tổng quan tải xong: request còn đang chạy mà gặp phiên đã thu hồi sẽ đưa về đăng nhập trước khi test kịp thao tác
  await expect(page.getByText('Tổng tài khoản')).toBeVisible();
  await revokeAdminSessions(request, admin);
  await goToSection(page, 'Tài khoản');
  await expect(page.getByText('Phiên làm việc đã hết hạn. Hãy đăng nhập lại.')).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await expect(page.getByRole('navigation', { name: 'Khu quản trị' })).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('đăng xuất thu hồi phiên ở server: dùng lại cookie cũ bị 401; tải lại trang cần đăng nhập lại', async ({ page, request, context }) => {
  await adminLogin(page, request);
  const cookie = (await context.cookies()).find((item) => item.name === 'gc_admin');
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Strict');
  expect(cookie.path).toBe('/api/admin');
  expect(await page.evaluate(() => document.cookie)).not.toContain('gc_admin');

  const toggle = page.getByRole('button', { name: 'Menu' });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page.getByRole('heading', { name: 'Đăng nhập quản trị' })).toBeVisible();

  const replay = await request.get('/api/admin/users', { headers: { cookie: `gc_admin=${cookie.value}` } });
  expect(replay.status()).toBe(401);
  await page.goto('/admin');
  await expect(page).toHaveURL(/\/admin\/login$/);
});

test('trang công khai không còn liên kết nào tới khu quản trị và không tải mã quản trị', async ({ page }) => {
  const scripts = [];
  page.on('request', (req) => {
    if (req.resourceType() === 'script') scripts.push(req.url());
  });
  for (const path of ['/', '/checkin', '/leaderboard', '/profile']) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await page.locator('a[href*="admin"]').count(), path).toBe(0);
  }
  expect(scripts.filter((url) => /\/src\/admin\//.test(url))).toEqual([]);
});

test('SEO trang công khai: tiêu đề và mô tả theo từng trang; trang cá nhân noindex', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/GreenCanteen/);
  await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /.{20,}/);
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
  await page.goto('/leaderboard');
  await expect(page).toHaveTitle('Bảng xếp hạng · GreenCanteen');
  await page.goto('/profile');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
});
