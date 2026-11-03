// Chạy trước mỗi tệp test khi đo C2: cài bộ đếm, ghi số liệu thô sau tệp test rồi đặt lại về 0
// (bộ đếm có thể dùng chung giữa các tệp chạy trên cùng một worker)
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';
import { installRuntime } from '../../../tools/coverage/c2.mjs';

const runtime = installRuntime();

afterAll(() => {
  const dir = process.env.C2_RAW_DIR;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${randomUUID()}.json`), JSON.stringify(runtime.files));
  for (const counts of Object.values(runtime.files)) {
    for (const pair of Object.values(counts)) pair.fill(0);
  }
});
