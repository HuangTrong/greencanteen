import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { c2Plugin } from './test/coverage/c2-plugin.js';

// Cấu hình riêng cho test (không nạp PWA plugin của vite.config.js).
// C2_COVERAGE=1 (test/coverage/run.mjs đặt) → bọc điều kiện để đo C2.
const measureC2 = Boolean(process.env.C2_COVERAGE);

export default defineConfig({
  plugins: [measureC2 && c2Plugin(), react()].filter(Boolean),
  test: {
    environment: 'jsdom',
    include: ['test/unit/**/*.test.{js,jsx}', 'test/ui/**/*.test.{js,jsx}', 'test/admin/**/*.test.{js,jsx}'],
    setupFiles: ['test/setup.js', ...(measureC2 ? ['test/coverage/c2-setup.js'] : [])],
    restoreMocks: true,
    coverage: {
      provider: 'istanbul',
      // Mọi tệp khớp include đều được tính, kể cả tệp không test nào nạp (0%)
      include: ['src/**/*.{js,jsx}'],
      reporter: [['text', { file: 'c0-c1.txt', maxCols: 120 }], ['text', { maxCols: 120 }], 'json-summary', 'json', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
