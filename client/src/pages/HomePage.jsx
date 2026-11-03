import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { useUser } from '../context/UserContext';
import { useSiteSettings } from '../context/SiteSettingsContext';
import { trackClick, trackImpression } from '../lib/analytics';
import { usePageMeta } from '../lib/usePageMeta';
import StatCard from '../components/StatCard';

const PRIMARY_CTA = 'home_primary_cta';
const ZERO_STATS = { totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 };

export default function HomePage() {
  const { user, isLoggedIn, authLoading, authError } = useUser();
  const { heroTitle, analyticsEnabled } = useSiteSettings();
  usePageMeta({ path: '/' });
  const [stats, setStats] = useState(ZERO_STATS);
  const [loading, setLoading] = useState(true);
  const [statsError, setStatsError] = useState('');

  useEffect(() => {
    if (authLoading) return undefined;
    // Chưa đăng nhập thì các ô về 0. Đây chỉ là hiển thị: dữ liệu của tài khoản vẫn nguyên ở server
    if (!isLoggedIn) {
      setStats(ZERO_STATS);
      setStatsError('');
      setLoading(false);
      return undefined;
    }
    let stale = false;
    setLoading(true);
    setStatsError('');
    api
      .schoolStats()
      .then((next) => {
        if (!stale) setStats(next);
      })
      .catch((err) => {
        if (!stale) setStatsError(err.message || 'Không tải được thống kê.');
      })
      .finally(() => {
        if (!stale) setLoading(false);
      });
    return () => {
      stale = true;
    };
  }, [authLoading, isLoggedIn]);

  // Nút chính là "Check-in ngay" hoặc "Đăng nhập / Đăng ký" tùy trạng thái; đếm một lượt hiển thị khi nút đã xuất hiện
  useEffect(() => {
    if (!authLoading && analyticsEnabled) trackImpression(PRIMARY_CTA);
  }, [authLoading, analyticsEnabled]);

  // Lỗi tải hoặc thiếu số liệu → hiện "—" thay vì số 0 dễ gây hiểu nhầm (và không làm sập trang)
  const show = (n) => (loading ? '…' : statsError || authError || !Number.isFinite(n) ? '—' : n.toLocaleString('vi-VN'));

  return (
    <div className="space-y-5">
      <section className="animate-fade-up overflow-hidden rounded-3xl bg-gradient-to-br from-leaf-600 to-leaf-800 p-5 text-white shadow-lg">
        <h2 className="text-balance text-2xl font-extrabold leading-tight">{heroTitle}</h2>
        {isLoggedIn && (
          <Link
            to="/checkin"
            onClick={() => trackClick(PRIMARY_CTA)}
            className="mt-4 inline-flex w-full items-center justify-center rounded-xl bg-white py-3 text-sm font-extrabold text-leaf-700 shadow-md"
          >
            Check-in ngay 📸
          </Link>
        )}
      </section>

      <section className="grid grid-cols-3 gap-2">
        <StatCard icon="✅" label="Lượt check-in" value={show(stats.totalCheckIns)} />
        <StatCard icon="♻️" label="Nhựa giảm" value={show(stats.plasticSavedGrams)} suffix="g" accent="sky" />
        <StatCard icon="🌳" label="Sinh vật bảo vệ" value={show(stats.treesProtected)} accent="amber" />
      </section>
      {statsError && <p className="-mt-3 text-xs text-stone-500">{statsError}</p>}

      {authLoading ? null : isLoggedIn ? (
        <div className="rounded-2xl border border-leaf-100 bg-white p-4 shadow-sm">
          <p className="text-sm text-stone-600">
            Xin chào, <span className="font-bold text-leaf-800">{user.name}</span> ({user.studentId})
          </p>
          <p className="mt-1 text-xs text-stone-500">
            {user.ecoPoints} điểm · {user.totalCheckIns} lần check-in · {user.plasticSavedGrams}g nhựa đã tránh
          </p>
        </div>
      ) : (
        <div className="animate-fade-up rounded-2xl border border-leaf-100 bg-white p-4 shadow-sm">
          <p className="text-sm font-bold text-leaf-800">Bạn chưa đăng nhập</p>
          <p className="mt-1 text-xs text-stone-500">
            Đăng nhập hoặc tạo tài khoản tại trang Cá nhân để check-in và tích Eco-points.
          </p>
          <Link
            to="/profile"
            state={{ openAuth: true }}
            onClick={() => trackClick(PRIMARY_CTA)}
            className="mt-3 inline-flex w-full items-center justify-center rounded-xl bg-leaf-600 py-3 text-sm font-bold text-white shadow-md transition hover:bg-leaf-700"
          >
            Đăng nhập / Đăng ký
          </Link>
        </div>
      )}
    </div>
  );
}
