import { useId, useRef, useState } from 'react';
import { formatPeriod } from '../format';

// Bảng màu đã kiểm bằng công cụ validate_palette trên nền trắng: một chuỗi dùng màu thương hiệu;
// hai chuỗi dùng cặp xanh dương / cam (cặp xanh lá / cam nằm ở vùng cảnh báo mù màu đỏ-lục)
export const SERIES_COLORS = { single: '#16a34a', first: '#2a78d6', second: '#eb6834' };

const HEIGHT_PX = 160;
// Từ mức này cột hẹp tới mức không còn chỗ cho khoảng hở hai bên
const DENSE_ROWS = 60;

/** Trục tròn số: 0, 1, 2, 5, 10, 20, 50... để vạch chia dễ đọc */
export function niceMax(value) {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 5, 10].find((candidate) => candidate * magnitude >= value);
  return step * magnitude;
}

function compact(value) {
  if (value >= 1_000_000) return `${value / 1_000_000}tr`;
  if (value >= 1_000) return `${value / 1_000}k`;
  return String(value);
}

/**
 * Biểu đồ cột một chuỗi hoặc xếp chồng. Một biểu đồ là một đơn vị đo, không có trục kép. Rê chuột, chạm hoặc dùng phím mũi
 * tên để xem số liệu; mọi giá trị đều có trong bảng số liệu bên dưới nên không phụ thuộc vào tooltip.
 */
export default function BarChart({ title, unit, rows, series, formatValue = (value) => value.toLocaleString('vi-VN') }) {
  const titleId = useId();
  const [active, setActive] = useState(null);
  const plotRef = useRef(null);

  const totals = rows.map((row) => series.reduce((sum, { key }) => sum + (row[key] ?? 0), 0));
  const top = niceMax(Math.max(...totals, 0));
  const peakIndex = totals.indexOf(Math.max(...totals));
  const hasData = totals.some((total) => total > 0);
  const focused = active === null ? null : rows[active];

  const pick = (event) => {
    const box = plotRef.current.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * rows.length);
    setActive(Math.min(Math.max(index, 0), rows.length - 1));
  };

  const onKeyDown = (event) => {
    const moves = { ArrowLeft: -1, ArrowRight: 1 };
    if (event.key === 'Home') setActive(0);
    else if (event.key === 'End') setActive(rows.length - 1);
    else if (moves[event.key]) setActive((current) => Math.min(Math.max((current ?? rows.length) + moves[event.key], 0), rows.length - 1));
    else return;
    event.preventDefault();
  };

  const summary = hasData
    ? `Cao nhất ${formatValue(totals[peakIndex])} ${unit} vào ${formatPeriod(rows[peakIndex].period)}.`
    : 'Không có dữ liệu trong kỳ này.';

  return (
    <figure className="min-w-0 rounded-2xl border border-stone-200 bg-white p-4">
      <figcaption id={titleId} className="text-sm font-extrabold text-stone-800">
        {title}
        <span className="ml-1 font-semibold text-stone-500">({unit})</span>
      </figcaption>

      {series.length > 1 && (
        <ul className="mt-1 flex flex-wrap gap-3 text-xs text-stone-600">
          {series.map(({ key, label, color }) => (
            <li key={key} className="flex items-center gap-1">
              <span aria-hidden="true" className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: color }} />
              {label}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-2 min-h-[2.5rem] text-xs text-stone-600" role="status">
        {focused ? (
          <>
            <span className="font-bold text-stone-800">{formatPeriod(focused.period)}</span>
            {series.map(({ key, label }) => (
              <span key={key} className="ml-2">
                <span className="font-bold text-stone-900 [font-variant-numeric:tabular-nums]">{formatValue(focused[key] ?? 0)}</span> {label}
              </span>
            ))}
          </>
        ) : (
          summary
        )}
      </p>

      <div className="mt-1 flex">
        <div aria-hidden="true" className="flex w-10 shrink-0 flex-col justify-between pr-1 text-right text-[10px] text-stone-500 [font-variant-numeric:tabular-nums]" style={{ height: HEIGHT_PX }}>
          <span>{compact(top)}</span>
          {/* Số đếm không có nửa đơn vị: vạch giữa chỉ ghi số khi là số nguyên */}
          <span>{Number.isInteger(top / 2) ? compact(top / 2) : ''}</span>
          <span>0</span>
        </div>
        <div className="relative min-w-0 flex-1" style={{ height: HEIGHT_PX }}>
          <div aria-hidden="true" className="absolute inset-0 flex flex-col justify-between">
            <span className="border-t border-stone-200" />
            <span className="border-t border-stone-200" />
            <span className="border-t border-stone-300" />
          </div>
          <div
            ref={plotRef}
            role="img"
            aria-labelledby={titleId}
            aria-description={`${summary} Dùng phím mũi tên trái phải để xem từng kỳ.`}
            tabIndex={0}
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={() => setActive(null)}
            onKeyDown={onKeyDown}
            onBlur={() => setActive(null)}
            className="absolute inset-0 flex touch-pan-y items-end rounded outline-none ring-leaf-400 focus-visible:ring-2"
          >
            {rows.map((row, index) => (
              <div key={row.period} className={`flex h-full min-w-0 flex-1 items-end justify-center ${active === index ? 'bg-stone-100' : ''}`}>
                <div
                  className={`flex w-full max-w-6 flex-col-reverse gap-0.5 ${rows.length < DENSE_ROWS ? 'px-px' : ''}`}
                  style={{ height: `${(totals[index] / top) * 100}%` }}
                >
                  {series.map(({ key, color }, position) => {
                    const value = row[key] ?? 0;
                    if (value <= 0) return null;
                    const isTop = series.slice(position + 1).every((next) => (row[next.key] ?? 0) <= 0);
                    return (
                      <div
                        key={key}
                        className={isTop ? 'rounded-t' : ''}
                        style={{ backgroundColor: color, flexGrow: value, flexBasis: 0 }}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <div aria-hidden="true" className="ml-10 mt-1 flex justify-between text-[10px] text-stone-500">
        <span>{formatPeriod(rows[0].period)}</span>
        {rows.length > 1 && <span>{formatPeriod(rows[rows.length - 1].period)}</span>}
      </div>
    </figure>
  );
}
