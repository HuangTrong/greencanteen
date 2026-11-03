// `npm run coverage`: chạy toàn bộ test unit + integration hai lần (istanbul cho C0/C1, bộ đếm điều kiện cho C2)
// rồi gộp số liệu của mọi tiến trình test thành báo cáo trong coverage/.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as acorn from 'acorn';
import libCoverage from 'istanbul-lib-coverage';
import libInstrument from 'istanbul-lib-instrument';
import libReport from 'istanbul-lib-report';
import reports from 'istanbul-reports';
import { buildC2Report, formatC2Report, listSourceFiles } from '../../../tools/coverage/c2.mjs';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcDir = path.join(serverRoot, 'src');
const outDir = path.join(serverRoot, 'coverage');
const hooksUrl = pathToFileURL(path.join(serverRoot, 'test/coverage/hooks.mjs')).href;
const TEST_GLOBS = ['test/unit/**/*.test.js', 'test/integration/**/*.test.js'];

fs.rmSync(outDir, { recursive: true, force: true });

function runTests(mode) {
  const rawDir = path.join(outDir, `.raw-${mode}`);
  console.log(`\n▶ Chạy test với COVERAGE_MODE=${mode}`);
  const result = spawnSync(
    process.execPath,
    ['--import', hooksUrl, '--test', '--test-concurrency=1', '--test-reporter=dot', ...TEST_GLOBS],
    { cwd: serverRoot, stdio: 'inherit', env: { ...process.env, COVERAGE_MODE: mode, COVERAGE_RAW_DIR: rawDir } }
  );
  if (result.status !== 0) {
    console.error(`Test thất bại khi đo ${mode} (mã ${result.status}) — số liệu độ phủ không được tính.`);
    process.exit(result.status || 1);
  }
  return rawDir;
}

const sourceFiles = listSourceFiles(srcDir, ['.js']);

// ---- C0 / C1 (istanbul) ----
const istanbulRaw = runTests('istanbul');
const coverageMap = libCoverage.createCoverageMap({});
for (const name of fs.readdirSync(istanbulRaw)) {
  coverageMap.merge(JSON.parse(fs.readFileSync(path.join(istanbulRaw, name), 'utf8')));
}
// Tệp không được nạp trong lần chạy nào vẫn được tính (0%) — không làm đẹp số liệu
const instrumenter = libInstrument.createInstrumenter({ esModules: true });
for (const file of sourceFiles) {
  if (coverageMap.files().includes(file)) continue;
  instrumenter.instrumentSync(fs.readFileSync(file, 'utf8'), file);
  coverageMap.addFileCoverage(instrumenter.lastFileCoverage());
}

const context = libReport.createContext({ dir: outDir, coverageMap, defaultSummarizer: 'flat' });
for (const [name, options] of [
  ['text', { file: 'c0-c1.txt', maxCols: 120 }],
  ['text', { maxCols: 120 }],
  ['json-summary', {}],
  ['json', {}],
  ['html', { subdir: 'html' }],
]) {
  reports.create(name, options).execute(context);
}

// Câu lệnh / nhánh chưa phủ theo từng tệp
const uncovered = {};
for (const file of coverageMap.files()) {
  const fc = coverageMap.fileCoverageFor(file);
  const statements = Object.entries(fc.s)
    .filter(([, n]) => n === 0)
    .map(([id]) => fc.statementMap[id].start.line);
  const branches = [];
  for (const [id, counts] of Object.entries(fc.b)) {
    const meta = fc.branchMap[id];
    counts.forEach((n, i) => {
      if (n === 0) branches.push({ line: (meta.locations[i] || meta.loc).start.line, type: meta.type, path: i });
    });
  }
  uncovered[path.relative(serverRoot, file).split(path.sep).join('/')] = {
    statements: [...new Set(statements)].sort((a, b) => a - b),
    branches,
  };
}
fs.writeFileSync(path.join(outDir, 'uncovered.json'), JSON.stringify(uncovered, null, 2));

// ---- C2 (điều kiện) ----
const c2Raw = runTests('c2');
const c2 = buildC2Report({ rawDir: c2Raw, files: sourceFiles, rootDir: serverRoot, parse: acorn.parse });
fs.writeFileSync(path.join(outDir, 'c2-summary.json'), JSON.stringify(c2, null, 2));
fs.writeFileSync(path.join(outDir, 'c2.md'), formatC2Report(c2, 'server/src'));

const summary = coverageMap.getCoverageSummary();
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(2) : '—');
console.log('\n================ Tổng hợp độ phủ server/src ================');
console.log(`C0 câu lệnh : ${summary.statements.covered}/${summary.statements.total} = ${summary.statements.pct}%`);
console.log(`C1 nhánh    : ${summary.branches.covered}/${summary.branches.total} = ${summary.branches.pct}%`);
console.log(`C2 điều kiện: ${c2.total.covered}/${c2.total.conditions} = ${pct(c2.total.covered, c2.total.conditions)}%`);
console.log(`(Dòng: ${summary.lines.pct}% · Hàm: ${summary.functions.pct}%) — chi tiết: coverage/c0-c1.txt, coverage/c2.md, coverage/html/index.html`);
