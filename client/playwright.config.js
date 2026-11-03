import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Kiểm thử hệ thống trên trình duyệt đã cài sẵn trong máy (Edge, Chrome) — không tải trình duyệt về.
// API thử nghiệm: DB in-memory riêng, AI mô phỏng, email giả (server/test/e2e/server.mjs), cổng riêng để không
// đụng server dev đang chạy ở 3001/5173.
const API = 'http://127.0.0.1:3101';
// Trình duyệt không phân giải được tên miền nào ngoài máy này: kiểm thử không gọi ra Internet (font Google, ảnh câu chuyện...)
const LOOPBACK_ONLY = '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1';

/**
 * Camera giả (không dùng camera thật): video y4m riêng cho mỗi cấu hình. Hình mặc định của Chromium lặp theo chu kỳ nên
 * ảnh chụp ở hai cấu hình có thể trùng từng byte và bị server chặn "ảnh đã dùng" (đúng thiết kế) — mỗi tệp có màu riêng.
 */
function fakeCameraArgs(seed) {
  const [w, h] = [160, 120];
  const file = path.join(os.tmpdir(), `greencanteen-fake-camera-${seed}.y4m`);
  const frames = Array.from({ length: 30 }, (_, i) => [
    Buffer.from('FRAME\n'),
    Buffer.alloc(w * h, (seed * 40 + i * 5) % 256),
    Buffer.alloc((w / 2) * (h / 2) * 2, 100 + seed * 25),
  ]).flat();
  fs.writeFileSync(file, Buffer.concat([Buffer.from(`YUV4MPEG2 W${w} H${h} F30:1 Ip A1:1 C420jpeg\n`), ...frames]));
  return {
    launchOptions: {
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${file}`, LOOPBACK_ONLY],
    },
  };
}

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: [['list'], ['json', { outputFile: 'test-results/e2e-results.json' }]],
  use: {
    baseURL: 'http://localhost:5174',
    locale: 'vi-VN',
    timezoneId: 'Asia/Ho_Chi_Minh',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'edge-desktop', use: { channel: 'msedge', viewport: { width: 1366, height: 768 }, ...fakeCameraArgs(0) } },
    { name: 'edge-tablet', use: { channel: 'msedge', viewport: { width: 768, height: 1024 }, hasTouch: true, ...fakeCameraArgs(1) } },
    { name: 'chrome-mobile', use: { ...devices['Pixel 7'], channel: 'chrome', ...fakeCameraArgs(2) } },
  ],
  webServer: [
    {
      command: 'node ../server/test/e2e/server.mjs',
      url: `${API}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'node node_modules/vite/bin/vite.js --port 5174 --strictPort',
      url: 'http://localhost:5174',
      env: { API_PROXY_TARGET: API },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
