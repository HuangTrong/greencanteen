// Ảnh đại diện và khung xếp hạng trên trình duyệt thật. Không tạo lượt check-in ở đây: DB dùng chung cho mọi test mà bảng xếp
// hạng chỉ có top 20, thêm người sẽ đẩy tài khoản của test khác ra ngoài. Luồng đầu-cuối nằm ở checkin-flow.spec.js.
import { expect, test } from '@playwright/test';
import { portrait } from '../../server/test/fakes/portrait.js';
import { register, studentApi } from './helpers';

const imageFile = async (hue) => ({ name: 'chan-dung.png', mimeType: 'image/png', buffer: await portrait(hue) });

/** Tải một ảnh thật lên server bằng tài khoản riêng, trả về URL ảnh */
async function uploadedAvatar(playwright, baseURL, hue) {
  const { context } = await studentApi(playwright, baseURL);
  const res = await context.put('/api/avatars/me', { multipart: { image: await imageFile(hue) } });
  expect(res.status()).toBe(200);
  return (await res.json()).user.avatarUrl;
}

test('đổi ảnh đại diện: ảnh thật qua server, giữ sau khi tải lại, gỡ được; tệp sai báo lỗi', async ({ page }, testInfo) => {
  await register(page);
  await expect(page.getByTestId('avatar-initial')).toBeVisible();

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Đổi ảnh đại diện' }).click()]);
  await chooser.setFiles(await imageFile(200));
  const image = page.getByRole('img', { name: 'Ảnh đại diện' });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el) => el.naturalWidth)).toBe(256);
  expect(await image.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('9999px');
  const box = await image.boundingBox();
  expect(Math.round(box.width)).toBe(Math.round(box.height));
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}_profile.png`) });

  await page.reload();
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((el) => el.naturalWidth)).toBe(256);

  await page.getByLabel('Chọn ảnh đại diện').setInputFiles({ name: 'gia.png', mimeType: 'image/png', buffer: Buffer.from('khong phai anh') });
  await expect(page.getByRole('alert')).toHaveText('Chỉ nhận ảnh JPEG, PNG hoặc WebP.');
  await expect(image).toBeVisible();

  await page.getByRole('button', { name: 'Gỡ ảnh' }).click();
  await expect(page.getByTestId('avatar-initial')).toBeVisible();
  await page.reload();
  await expect(page.getByTestId('avatar-initial')).toBeVisible();
});

test('bảng xếp hạng: top 3 có ảnh tròn, vương miện, số hạng, khung riêng; các hạng sau chỉ có viền xanh', async ({ page, playwright, baseURL }, testInfo) => {
  const avatars = [];
  for (const hue of [45, 210, 15, 150]) avatars.push(await uploadedAvatar(playwright, baseURL, hue));
  const personal = ['Nguyễn Thị Vàng', 'Trần Văn Bạc', 'Lê Hoàng Đồng', 'Phạm Xanh', 'Võ Chưa Có Ảnh'].map((name, index) => ({
    rank: index + 1,
    name,
    avatarUrl: avatars[index] ?? null,
    checkIns: 7 - index,
    points: (7 - index) * 10,
  }));
  // Danh sách cố định để luôn đúng 5 hàng, đúng thứ tự, không phụ thuộc test khác; ảnh vẫn do server thật phục vụ
  await page.route('**/api/stats/leaderboard*', (route) => route.fulfill({ json: { period: 'week', personal, byDepartment: [] } }));

  await page.goto('/leaderboard');
  const rows = page.getByRole('main').getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await page.waitForLoadState('networkidle');

  for (const [index, frame] of ['gold', 'silver', 'bronze'].entries()) {
    const row = rows.nth(index);
    await expect(row.locator(`[data-rank-frame="${frame}"]`)).toBeVisible();
    await expect(row.getByTestId('rank-crown')).toBeVisible();
    await expect(row.getByTestId('rank-number')).toHaveText(String(index + 1));
    const image = row.locator('img');
    await expect.poll(() => image.evaluate((el) => el.naturalWidth)).toBe(256);
    expect(await image.evaluate((el) => getComputedStyle(el).borderTopLeftRadius)).toBe('9999px');
    const frameBox = await row.locator('[data-rank-frame]').boundingBox();
    const crownBox = await row.getByTestId('rank-crown').boundingBox();
    const rowBox = await row.boundingBox();
    expect(crownBox.y, 'vương miện nằm trọn trong hàng').toBeGreaterThanOrEqual(rowBox.y);
    expect(crownBox.y + crownBox.height / 2, 'vương miện đội trên ảnh').toBeLessThan(frameBox.y + frameBox.height / 2);
  }

  for (const index of [3, 4]) {
    const row = rows.nth(index);
    const frame = row.locator('[data-rank-frame="green"]');
    await expect(frame).toBeVisible();
    await expect(row.getByTestId('rank-crown')).toHaveCount(0);
    await expect(row.getByTestId('rank-number')).toHaveCount(0);
    const border = await frame.locator('> span').evaluate((el) => getComputedStyle(el).borderTopColor);
    expect(border).toBe('rgb(34, 197, 94)');
  }
  await expect.poll(() => rows.nth(3).locator('img').evaluate((el) => el.naturalWidth)).toBe(256);
  await expect(rows.nth(4).getByTestId('avatar-initial')).toHaveText('Ả');

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, `cuộn ngang ${overflow}px`).toBeLessThanOrEqual(0);
  await page.screenshot({ path: testInfo.outputPath(`${testInfo.project.name}_leaderboard.png`), fullPage: true });
});
