// Nạp bằng `node --import` (test/coverage/run.mjs truyền vào từng tiến trình test của node --test):
// chèn bộ đếm vào mã trong src/ ngay lúc module được nạp, rồi ghi số liệu thô ra đĩa khi tiến trình kết thúc.
//   COVERAGE_MODE=istanbul → C0 (câu lệnh) / C1 (nhánh) bằng istanbul-lib-instrument
//   COVERAGE_MODE=c2       → C2 (điều kiện) bằng tools/coverage/c2.mjs
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import libInstrument from 'istanbul-lib-instrument';
import { installRuntime, instrumentConditions } from '../../../tools/coverage/c2.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcUrl = pathToFileURL(path.join(serverRoot, 'src') + path.sep).href;
const mode = process.env.COVERAGE_MODE;
const outDir = process.env.COVERAGE_RAW_DIR;

if (!['istanbul', 'c2'].includes(mode) || !outDir) {
  throw new Error('hooks.mjs cần COVERAGE_MODE (istanbul | c2) và COVERAGE_RAW_DIR');
}

const instrumenter =
  mode === 'istanbul'
    ? libInstrument.createInstrumenter({ esModules: true, coverageGlobalScope: 'globalThis', coverageGlobalScopeFunc: false })
    : null;
const c2 = mode === 'c2' ? installRuntime() : null;

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith(srcUrl) || !url.endsWith('.js')) return result;
    const file = fileURLToPath(url);
    const code = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8');
    const source =
      mode === 'istanbul'
        ? instrumenter.instrumentSync(code, file)
        : instrumentConditions(code, { parse: acorn.parse, fileKey: path.relative(serverRoot, file).split(path.sep).join('/') }).code;
    return { ...result, source, shortCircuit: true };
  },
});

process.on('exit', () => {
  const data = mode === 'istanbul' ? globalThis.__coverage__ : c2.files;
  if (!data || Object.keys(data).length === 0) return;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${randomUUID()}.json`), JSON.stringify(data));
});
