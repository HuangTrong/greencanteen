// Đo C2 — condition coverage: mỗi điều kiện Boolean nguyên tử đã được đánh giá cả ĐÚNG lẫn SAI.
// Không công cụ phổ biến nào cho JavaScript đo được C2 (istanbul/V8 chỉ đếm câu lệnh và nhánh), nên mỗi
// điều kiện được bọc thành __c2$(id, (expr)) để ghi lại kết quả khi chạy test. Module này không import thư
// viện nào: server/client truyền hàm parse của acorn (client kèm acorn-jsx) vào.
//
// Quy tắc xác định điều kiện:
// - Điểm quyết định: phần test của if, ?:, while, do-while, for. Biểu thức test được tách theo &&, || và !
//   thành các điều kiện nguyên tử; mỗi điều kiện nguyên tử được đếm.
// - && / || dùng như giá trị (vd. `a || 'mặc định'`, `{cond && <X/>}`): toán hạng trái quyết định có đánh
//   giá vế phải hay không nên là điều kiện; vế phải chỉ là giá trị (trừ khi chính nó là && / ||).
// - Không tính: case của switch, ??, ?. và giá trị mặc định của tham số (đã nằm trong C1 — branch coverage).
import fs from 'node:fs';
import path from 'node:path';

const DECISION_TESTS = {
  IfStatement: 'if',
  ConditionalExpression: 'ternary',
  WhileStatement: 'while',
  DoWhileStatement: 'do-while',
  ForStatement: 'for',
};

const isShortCircuit = (node) => node?.type === 'LogicalExpression' && (node.operator === '&&' || node.operator === '||');

function childNodes(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === 'loc') continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const item of value) if (item && typeof item.type === 'string') out.push(item);
    } else if (value && typeof value.type === 'string') {
      out.push(value);
    }
  }
  return out;
}

/** Danh sách điều kiện nguyên tử theo thứ tự xuất hiện — id là chỉ số trong danh sách (ổn định giữa các lần parse) */
export function findConditions(ast) {
  const conditions = [];
  const consumed = new Set();

  const addLeaves = (expr, kind) => {
    if (isShortCircuit(expr)) {
      consumed.add(expr);
      addLeaves(expr.left, kind);
      addLeaves(expr.right, kind);
    } else if (expr.type === 'UnaryExpression' && expr.operator === '!') {
      consumed.add(expr);
      addLeaves(expr.argument, kind);
    } else {
      conditions.push({ start: expr.start, end: expr.end, line: expr.loc.start.line, column: expr.loc.start.column, kind });
    }
  };

  const visit = (node) => {
    const decision = DECISION_TESTS[node.type];
    if (decision && node.test) addLeaves(node.test, decision);
    else if (isShortCircuit(node) && !consumed.has(node)) {
      consumed.add(node);
      addLeaves(node.left, `${node.operator} (giá trị)`);
    }
    for (const child of childNodes(node)) visit(child);
  };

  visit(ast);
  return conditions.sort((a, b) => a.start - b.start || b.end - a.end);
}

const PARSE_OPTIONS = { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true };

/** Trả về mã đã bọc điều kiện. Dòng của mã gốc giữ nguyên (khai báo bộ đếm nằm chung dòng 1). */
export function instrumentConditions(code, { parse, fileKey }) {
  const conditions = findConditions(parse(code, PARSE_OPTIONS));
  const edits = [];
  conditions.forEach((c, id) => {
    edits.push({ pos: c.start, open: true, len: c.end - c.start, text: `__c2$(${id},(` });
    edits.push({ pos: c.end, open: false, len: c.end - c.start, text: '))' });
  });
  // Cùng vị trí: đóng trước mở; đóng phạm vi nhỏ trước, mở phạm vi lớn trước → các lớp bọc lồng nhau đúng
  edits.sort((a, b) => a.pos - b.pos || (a.open === b.open ? (a.open ? b.len - a.len : a.len - b.len) : a.open ? 1 : -1));

  let out = '';
  let last = 0;
  for (const edit of edits) {
    out += code.slice(last, edit.pos) + edit.text;
    last = edit.pos;
  }
  out += code.slice(last);

  const prelude = `const __c2$ = globalThis.__c2rt.counter(${JSON.stringify(fileKey)});`;
  const hashBang = out.startsWith('#!') ? out.slice(0, out.indexOf('\n') + 1) : '';
  return { code: hashBang + prelude + out.slice(hashBang.length), count: conditions.length };
}

/** Bộ đếm chạy trong tiến trình test: counts[fileKey][id] = [số lần ĐÚNG, số lần SAI] */
export function installRuntime(target = globalThis) {
  if (target.__c2rt) return target.__c2rt;
  const files = {};
  target.__c2rt = {
    files,
    counter(fileKey) {
      const counts = (files[fileKey] ||= {});
      return (id, value) => {
        const c = (counts[id] ||= [0, 0]);
        c[value ? 0 : 1] += 1;
        return value;
      };
    },
  };
  return target.__c2rt;
}

export function listSourceFiles(dir, extensions) {
  const result = [];
  for (const name of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, String(name));
    if (extensions.includes(path.extname(file)) && fs.statSync(file).isFile()) result.push(file);
  }
  return result.sort();
}

/** Gộp các tệp đếm thô, đối chiếu với toàn bộ điều kiện trong mã nguồn → số liệu C2 theo từng tệp */
export function buildC2Report({ rawDir, files, rootDir, parse }) {
  const merged = {};
  for (const name of fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : []) {
    if (!name.endsWith('.json')) continue;
    const data = JSON.parse(fs.readFileSync(path.join(rawDir, name), 'utf8'));
    for (const [fileKey, counts] of Object.entries(data)) {
      const target = (merged[fileKey] ||= {});
      for (const [id, [t, f]] of Object.entries(counts)) {
        const c = (target[id] ||= [0, 0]);
        c[0] += t;
        c[1] += f;
      }
    }
  }

  const rows = [];
  for (const file of files) {
    const fileKey = path.relative(rootDir, file).split(path.sep).join('/');
    const code = fs.readFileSync(file, 'utf8');
    const conditions = findConditions(parse(code, PARSE_OPTIONS));
    const counts = merged[fileKey] || {};
    const missing = [];
    let both = 0;
    let outcomes = 0;
    conditions.forEach((c, id) => {
      const [t, f] = counts[id] || [0, 0];
      outcomes += (t > 0) + (f > 0);
      if (t > 0 && f > 0) {
        both += 1;
        return;
      }
      const text = code.slice(c.start, c.end).replace(/\s+/g, ' ');
      missing.push({
        line: c.line,
        column: c.column + 1,
        kind: c.kind,
        condition: text.length > 80 ? `${text.slice(0, 77)}...` : text,
        missing: t === 0 && f === 0 ? 'chưa đánh giá' : t === 0 ? 'chưa ĐÚNG' : 'chưa SAI',
      });
    });
    rows.push({ file: fileKey, conditions: conditions.length, covered: both, outcomes, missing });
  }

  const total = rows.reduce(
    (acc, r) => ({ conditions: acc.conditions + r.conditions, covered: acc.covered + r.covered, outcomes: acc.outcomes + r.outcomes }),
    { conditions: 0, covered: 0, outcomes: 0 }
  );
  return { total, rows };
}

const pct = (n, d) => (d === 0 ? '—' : `${((100 * n) / d).toFixed(2)}%`);

export function formatC2Report({ total, rows }, title) {
  const lines = [
    `# C2 — Condition coverage: ${title}`,
    '',
    `Tổng: **${total.covered}/${total.conditions}** điều kiện nguyên tử đạt cả ĐÚNG và SAI = **${pct(total.covered, total.conditions)}**; ` +
      `kết quả (ĐÚNG/SAI) đã quan sát: ${total.outcomes}/${total.conditions * 2} = ${pct(total.outcomes, total.conditions * 2)}`,
    '',
    '| Tệp | Điều kiện | Đủ ĐÚNG+SAI | C2 | Kết quả đã quan sát |',
    '|---|---:|---:|---:|---:|',
    ...rows.map(
      (r) => `| ${r.file} | ${r.conditions} | ${r.covered} | ${pct(r.covered, r.conditions)} | ${pct(r.outcomes, r.conditions * 2)} |`
    ),
    '',
    '## Điều kiện chưa phủ đủ',
    '',
  ];
  for (const r of rows) {
    if (!r.missing.length) continue;
    lines.push(`### ${r.file}`, '', '| Dòng:cột | Ngữ cảnh | Điều kiện | Thiếu |', '|---|---|---|---|');
    for (const m of r.missing) {
      lines.push(`| ${m.line}:${m.column} | ${m.kind} | \`${m.condition.replace(/\|/g, '\\|').replace(/`/g, "'")}\` | ${m.missing} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
