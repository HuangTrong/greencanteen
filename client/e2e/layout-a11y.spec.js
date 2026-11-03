// Kiểm thử hệ thống: hiển thị theo kích thước màn hình, thao tác bàn phím / chạm, trợ năng cơ bản
import { expect, test } from '@playwright/test';
import { nav, register } from './helpers';

const PAGES = ['/', '/checkin', '/leaderboard', '/profile'];

test('không cuộn ngang, thanh điều hướng luôn hiện và đủ lớn để chạm; ảnh chụp màn hình làm bằng chứng', async ({ page }, testInfo) => {
  await register(page);
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${path} cuộn ngang ${overflow}px`).toBeLessThanOrEqual(0);
    const links = page.getByRole('navigation').getByRole('link');
    await expect(links).toHaveCount(4);
    for (const box of await links.evaluateAll((els) => els.map((el) => el.getBoundingClientRect().toJSON()))) {
      expect(box.width).toBeGreaterThanOrEqual(24); // WCAG 2.2 — 2.5.8 kích thước vùng chạm tối thiểu (AA)
      expect(box.height).toBeGreaterThanOrEqual(24);
    }
    await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}${path.replace(/\//g, '_') || '_home'}.png`), fullPage: true });
  }
});

test('thao tác chạm / chuột: điều hướng giữa 4 trang', async ({ page, isMobile }, testInfo) => {
  await page.goto('/');
  for (const [name, url] of [
    ['Check-in', /\/checkin$/],
    ['Xếp hạng', /\/leaderboard$/],
    ['Cá nhân', /\/profile$/],
    ['Trang chủ', /\/$/],
  ]) {
    const link = nav(page, name);
    if (isMobile || testInfo.project.use.hasTouch) await link.tap();
    else await link.click();
    await expect(page).toHaveURL(url);
    await expect(link).toHaveClass(/text-leaf-700/);
  }
});

test('bàn phím: Tab tới nút đăng nhập, Enter mở popup, focus nằm trong popup, Escape đóng và trả focus', async ({ page }) => {
  await page.goto('/profile');
  const trigger = page.getByRole('button', { name: 'Đăng nhập / Đăng ký' });
  await expect(trigger).toBeVisible();
  let reached = false;
  for (let i = 0; i < 25 && !reached; i += 1) {
    await page.keyboard.press('Tab');
    reached = await trigger.evaluate((el) => el === document.activeElement);
  }
  expect(reached, 'tới được nút bằng phím Tab').toBe(true);
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Đăng nhập / Đăng ký' });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    expect(await dialog.evaluate((el) => el.contains(document.activeElement)), `Tab lần ${i + 1}`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  expect(await trigger.evaluate((el) => el === document.activeElement)).toBe(true);
});

test('trợ năng cơ bản: lang="vi", mọi nút có tên, ảnh có alt, trường nhập có nhãn', async ({ page }) => {
  await register(page);
  for (const path of PAGES) {
    await page.goto(path);
    await page.waitForLoadState('networkidle');
    expect(await page.getAttribute('html', 'lang')).toBe('vi');
    const unnamedButtons = await page.locator('button').evaluateAll((els) =>
      els.filter((b) => !(b.innerText.trim() || b.getAttribute('aria-label') || b.getAttribute('title'))).map((b) => b.outerHTML)
    );
    expect(unnamedButtons, path).toEqual([]);
    expect(await page.locator('img:not([alt])').count(), path).toBe(0);
    const unlabeled = await page.locator('input:not([type="hidden"]):not([type="file"])').evaluateAll((els) =>
      els.filter((i) => !(i.getAttribute('aria-label') || i.labels?.length)).length
    );
    expect(unlabeled, path).toBe(0);
  }
});
