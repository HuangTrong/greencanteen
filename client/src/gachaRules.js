import { api, assetUrl } from './lib/api';

// Mục mẫu móc khóa của trang /gacha-rules.html lấy từ cấu hình đang hiệu lực trên máy chủ, không viết cứng: quản trị viên có thể xuất
// bản phiên bản mới bất cứ lúc nào. Chỉ dùng textContent: tên, mô tả, hướng dẫn do quản trị viên nhập không được thành thẻ HTML.
const TIMEZONE = 'Asia/Ho_Chi_Minh';
const TOTAL_PPM = 1_000_000;

export const formatPercent = (ratio) =>
  `${(ratio * 100).toLocaleString('vi-VN', { minimumFractionDigits: 0, maximumFractionDigits: 4 })}%`;

/** Cách nói tỉ lệ quen thuộc: "khoảng 1 trên 10.000 lượt" */
export function formatOdds(ppm) {
  if (!(ppm > 0)) return 'không có cơ hội trúng';
  const n = Math.round(TOTAL_PPM / ppm);
  return n <= 1 ? 'mọi lượt' : `khoảng 1 trên ${n.toLocaleString('vi-VN')} lượt`;
}

const formatTime = (iso) =>
  new Date(iso).toLocaleString('vi-VN', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });

/** Câu mô tả phiên bản đang áp dụng */
export function describeRules(rules) {
  if (!rules.active) return 'Hiện không có phiên bản nào đang hiệu lực: quay thưởng tri ân tạm dừng, lượt quay của bạn được giữ nguyên.';
  const from = `từ ${formatTime(rules.effectiveFrom)}`;
  const period = rules.effectiveTo ? `hiệu lực ${from} đến ${formatTime(rules.effectiveTo)}` : `hiệu lực ${from}, chưa đặt thời điểm kết thúc`;
  const exhausted = rules.prizes.some((prize) => prize.available)
    ? ''
    : ' Tất cả móc khóa của phiên bản này đã được trao hết: tạm dừng quay, lượt của bạn được giữ nguyên.';
  return `Phiên bản ${rules.version}, ${period}.${exhausted}`;
}

/** Tổng cơ hội trúng của một lượt lúc này: mẫu đã hết không còn được tính, phần còn lại là không trúng */
export function winSummary(rules) {
  const current = rules.prizes.filter((prize) => prize.available).reduce((sum, prize) => sum + prize.probabilityPpm, 0);
  return `Cơ hội trúng của mỗi lượt lúc này: ${formatPercent(current / TOTAL_PPM)} (${formatOdds(current)}). Không trúng: ${formatPercent(
    (TOTAL_PPM - current) / TOTAL_PPM
  )}.`;
}

/** Các dòng của bảng (3 cột để đọc được trên điện thoại) */
export function prizeRows(rules) {
  return rules.prizes.map((prize) => ({
    name: prize.label,
    description: prize.description || '',
    imageUrl: prize.imageUrl || null,
    probability: formatPercent(prize.probabilityPpm / TOTAL_PPM),
    odds: prize.available ? formatOdds(prize.probabilityPpm) : 'Đã hết: tính là không trúng',
    remaining: `${prize.remaining}/${prize.maxQuantity}`,
  }));
}

function textCell(...lines) {
  const cell = document.createElement('td');
  lines.forEach(([text, className], index) => {
    const line = document.createElement('span');
    line.className = className || (index === 0 ? 'block' : 'block text-xs text-stone-500');
    line.textContent = text;
    cell.append(line);
  });
  return cell;
}

function prizeCell({ name, description, imageUrl }) {
  const cell = document.createElement('td');
  if (imageUrl) {
    const img = document.createElement('img');
    img.src = assetUrl(imageUrl);
    img.alt = `Móc khóa ${name}`;
    img.loading = 'lazy';
    img.width = 64;
    img.height = 64;
    img.className = 'mb-1 h-16 w-16 rounded-lg bg-white object-contain';
    img.addEventListener('error', () => img.remove());
    cell.append(img);
  }
  const title = document.createElement('span');
  title.className = 'block font-semibold text-stone-800';
  title.textContent = name;
  cell.append(title);
  if (description) {
    const sub = document.createElement('span');
    sub.className = 'block text-xs text-stone-500';
    sub.textContent = description;
    cell.append(sub);
  }
  return cell;
}

export async function showGachaRules(root = document.querySelector('[data-gacha-config]'), claim = document.querySelector('[data-gacha-claim]')) {
  if (!root) return;
  const status = root.querySelector('[data-gacha-status]');
  const summary = root.querySelector('[data-gacha-summary]');
  const table = root.querySelector('table');
  status.textContent = 'Đang tải cấu hình đang áp dụng...';
  try {
    const rules = await api.gachaRules();
    status.textContent = describeRules(rules);
    if (claim) claim.textContent = rules.active && rules.claimInstructions ? rules.claimInstructions : 'Chưa có phiên bản nào đang hiệu lực nên chưa có hướng dẫn nhận quà.';
    if (!rules.active) return;
    summary.textContent = winSummary(rules);
    summary.hidden = false;
    table.querySelector('tbody').replaceChildren(
      ...prizeRows(rules).map((prize) => {
        const row = document.createElement('tr');
        row.append(prizeCell(prize), textCell([prize.probability], [prize.odds]), textCell([prize.remaining]));
        return row;
      })
    );
    table.hidden = false;
  } catch {
    status.textContent = 'Không tải được cấu hình đang áp dụng. Vui lòng tải lại trang sau ít phút.';
    if (claim) claim.textContent = 'Không tải được hướng dẫn nhận quà. Vui lòng tải lại trang sau ít phút.';
  }
}

showGachaRules();
