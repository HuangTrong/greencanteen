import { defineConfig } from '@playwright/test';

// Kiểm thử trên BẢN BUILD thật (vite preview): CSP, service worker, robots chỉ có tác dụng ở bản build nên dev server
// không kiểm được. Chạy API thử nghiệm riêng ở cổng khác để không đụng cấu hình E2E chính.
const API = 'http://127.0.0.1:3103';
const WEB = 'http://localhost:5175';
// Đặt ở đây vì e2e/helpers.js đọc biến này ngay khi được nạp
process.env.E2E_MAILBOX_URL = 'http://127.0.0.1:3104';

export default defineConfig({
  testDir: 'e2e-build',
  outputDir: 'test-results/build',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: WEB,
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    channel: 'msedge',
    viewport: { width: 1366, height: 768 },
    // Trình duyệt không phân giải được tên miền nào ngoài máy này: kiểm thử không gọi ra Internet (font Google, ảnh câu chuyện...)
    launchOptions: { args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'] },
  },
  webServer: [
    {
      command: 'node ../server/test/e2e/server.mjs',
      url: `${API}/api/health`,
      env: { E2E_API_PORT: '3103', E2E_MAILBOX_PORT: '3104', E2E_CLIENT_ORIGIN: WEB },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node node_modules/vite/bin/vite.js preview --port 5175 --strictPort',
      url: WEB,
      env: { API_PROXY_TARGET: API },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
