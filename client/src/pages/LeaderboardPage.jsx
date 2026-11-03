import { useEffect, useState } from 'react';
import Avatar from '../components/Avatar';
import { api } from '../lib/api';
import { usePageMeta } from '../lib/usePageMeta';

const PODIUM = {
  1: {
    frame: 'gold',
    ring: 'from-yellow-200 via-amber-400 to-yellow-600',
    crown: { fill: '#fbbf24', edge: '#b45309' },
    number: 'bg-amber-400 text-amber-950',
  },
  2: {
    frame: 'silver',
    ring: 'from-slate-100 via-slate-400 to-slate-200',
    crown: { fill: '#e2e8f0', edge: '#64748b' },
    number: 'bg-slate-300 text-slate-900',
  },
  3: {
    frame: 'bronze',
    ring: 'from-amber-600 via-amber-800 to-orange-950',
    crown: { fill: '#b4692a', edge: '#5c2e0e' },
    number: 'bg-amber-800 text-white',
  },
};

function Crown({ fill, edge }) {
  return (
    <svg data-testid="rank-crown" viewBox="0 0 28 20" aria-hidden="true" className="absolute -top-3.5 left-1/2 h-5 w-7 -translate-x-1/2 drop-shadow-sm">
      <path d="M3 17 1.5 6l7 5L14 2l5.5 9 7-5L25 17z" fill={fill} stroke={edge} strokeWidth="1.5" strokeLinejoin="round" />
      <circle cx="14" cy="12.5" r="1.6" fill={edge} />
    </svg>
  );
}

/** Top 3 có khung kim loại, vương miện và số hạng; các hạng sau chỉ có khung viền xanh. Mọi hàng cùng độ rộng để tên thẳng cột. */
function RankedAvatar({ row }) {
  const avatar = <Avatar src={row.avatarUrl} name={row.name} className="h-11 w-11 text-base" />;
  const podium = PODIUM[row.rank];
  if (!podium) {
    return (
      <span data-rank-frame="green" className="flex w-14 shrink-0 justify-center">
        <span className="rounded-full border-2 border-leaf-500 p-0.5">{avatar}</span>
      </span>
    );
  }
  return (
    <span data-rank-frame={podium.frame} className="relative mb-1.5 mt-3 flex w-14 shrink-0 justify-center">
      <span className={`rounded-full bg-gradient-to-br p-[3px] shadow-sm ${podium.ring}`}>
        <span className="block rounded-full bg-white p-0.5">{avatar}</span>
      </span>
      <Crown {...podium.crown} />
      <span
        data-testid="rank-number"
        className={`absolute -bottom-1.5 left-1/2 flex h-5 w-5 -translate-x-1/2 items-center justify-center rounded-full border-2 border-white text-[11px] font-extrabold leading-none ${podium.number}`}
      >
        {row.rank}
      </span>
    </span>
  );
}

export default function LeaderboardPage() {
  usePageMeta({ title: 'Bảng xếp hạng', description: 'Bảng xếp hạng check-in ly, bình cá nhân theo tuần và tháng tại căn tin GreenCanteen.', path: '/leaderboard' });
  const [period, setPeriod] = useState('week');
  const [data, setData] = useState({ personal: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    // Bỏ qua response lỗi thời khi người dùng chuyển kỳ nhanh (tránh dữ liệu cũ ghi đè mới)
    let stale = false;
    setLoading(true);
    setError('');
    api
      .leaderboard(period)
      .then((d) => {
        if (!stale) setData({ personal: Array.isArray(d.personal) ? d.personal : [] });
      })
      .catch((err) => {
        if (!stale) {
          setData({ personal: [] });
          setError(err.message || 'Không tải được bảng xếp hạng.');
        }
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [period, reloadKey]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-extrabold text-leaf-800">Bảng xếp hạng</h2>
        <div className="flex rounded-xl bg-leaf-100 p-1 text-xs font-bold">
          <button
            type="button"
            aria-pressed={period === 'week'}
            onClick={() => setPeriod('week')}
            className={`rounded-lg px-3 py-1.5 ${period === 'week' ? 'bg-white text-leaf-800 shadow-sm' : 'text-leaf-700'}`}
          >
            Tuần
          </button>
          <button
            type="button"
            aria-pressed={period === 'month'}
            onClick={() => setPeriod('month')}
            className={`rounded-lg px-3 py-1.5 ${period === 'month' ? 'bg-white text-leaf-800 shadow-sm' : 'text-leaf-700'}`}
          >
            Tháng
          </button>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-stone-500">Đang tải xếp hạng...</p>
      ) : error ? (
        <div role="alert" className="flex items-center gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
          <span className="flex-1">{error}</span>
          <button type="button" onClick={() => setReloadKey((k) => k + 1)} className="shrink-0 text-xs font-bold underline">
            Thử lại
          </button>
        </div>
      ) : (
        <section>
          <h3 className="mb-2 text-sm font-extrabold text-stone-700">Top cá nhân</h3>
          {data.personal.length === 0 ? (
            <p className="text-sm text-stone-500">Chưa có dữ liệu trong kỳ này.</p>
          ) : (
            <ol className="space-y-2">
              {data.personal.map((row) => (
                <li
                  key={row.rank}
                  className="flex items-center gap-3 rounded-xl border border-leaf-50 bg-white px-3 py-2 shadow-sm"
                >
                  {row.rank > 3 && <span className="sr-only">Hạng {row.rank}</span>}
                  <RankedAvatar row={row} />
                  <p className="min-w-0 flex-1 truncate font-bold text-stone-800">{row.name}</p>
                  <div className="text-right text-xs font-bold text-leaf-700">
                    <div>{row.checkIns} lượt</div>
                    <div className="text-stone-400">{row.points} pts</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
    </div>
  );
}
