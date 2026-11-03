// `npm run coverage`: chạy test unit + UI hai lần — istanbul (C0/C1) rồi bộ đếm điều kiện (C2) — và ghi báo cáo vào coverage/
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildC2Report, formatC2Report, listSourceFiles } from '../../../tools/coverage/c2.mjs';
import { clientRoot, parseJsx } from './c2-plugin.js';

const outDir = path.join(clientRoot, 'coverage');
const rawDir = path.join(outDir, '.raw-c2');
const vitest = path.join(clientRoot, 'node_modules/vitest/vitest.mjs');

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [vitest, 'run', ...args], { cwd: clientRoot, stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    console.error(`Test thất bại (mã ${result.status}) — số liệu độ phủ không được tính.`);
    process.exit(result.status || 1);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });

console.log('\n▶ C0/C1 — istanbul');
run(['--coverage']);

const final = JSON.parse(fs.readFileSync(path.join(outDir, 'coverage-final.json'), 'utf8'));
const uncovered = {};
for (const [file, fc] of Object.entries(final)) {
  const statements = Object.entries(fc.s)
    .filter(([, n]) => n === 0)
    .map(([id]) => fc.statementMap[id].start.line);
  const branches = [];
  for (const [id, counts] of Object.entries(fc.b)) {
    counts.forEach((n, i) => {
      if (n === 0) branches.push({ line: (fc.branchMap[id].locations[i] || fc.branchMap[id].loc).start.line, type: fc.branchMap[id].type, path: i });
    });
  }
  uncovered[path.relative(clientRoot, file).split(path.sep).join('/')] = { statements: [...new Set(statements)].sort((a, b) => a - b), branches };
}
fs.writeFileSync(path.join(outDir, 'uncovered.json'), JSON.stringify(uncovered, null, 2));

console.log('\n▶ C2 — điều kiện');
run(['--reporter=dot'], { C2_COVERAGE: '1', C2_RAW_DIR: rawDir });
const files = listSourceFiles(path.join(clientRoot, 'src'), ['.js', '.jsx']);
const c2 = buildC2Report({ rawDir, files, rootDir: clientRoot, parse: parseJsx });
fs.writeFileSync(path.join(outDir, 'c2-summary.json'), JSON.stringify(c2, null, 2));
fs.writeFileSync(path.join(outDir, 'c2.md'), formatC2Report(c2, 'client/src'));

const total = JSON.parse(fs.readFileSync(path.join(outDir, 'coverage-summary.json'), 'utf8')).total;
const pct = (n, d) => (d ? ((100 * n) / d).toFixed(2) : '—');
console.log('\n================ Tổng hợp độ phủ client/src ================');
console.log(`C0 câu lệnh : ${total.statements.covered}/${total.statements.total} = ${total.statements.pct}%`);
console.log(`C1 nhánh    : ${total.branches.covered}/${total.branches.total} = ${total.branches.pct}%`);
console.log(`C2 điều kiện: ${c2.total.covered}/${c2.total.conditions} = ${pct(c2.total.covered, c2.total.conditions)}%`);
console.log(`(Dòng: ${total.lines.pct}% · Hàm: ${total.functions.pct}%) — chi tiết: coverage/c0-c1.txt, coverage/c2.md, coverage/index.html`);
