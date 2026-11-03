import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useUser } from '../context/UserContext';
import { useSiteSettings } from '../context/SiteSettingsContext';
import { trackPageView } from '../lib/analytics';

const navClass = ({ isActive }) =>
  `flex flex-col items-center gap-0.5 text-xs font-semibold transition-colors ${
    isActive ? 'text-leaf-700' : 'text-stone-500'
  }`;

const ANALYTICS_PAGES = { '/': 'home', '/checkin': 'checkin', '/leaderboard': 'leaderboard', '/profile': 'profile' };

/** Không hỏi được phiên đăng nhập (mất mạng, server lỗi) — báo rõ thay vì coi như chưa đăng nhập */
function ConnectionBanner() {
  const { authError, refresh } = useUser();
  const [retrying, setRetrying] = useState(false);
  if (!authError) return null;

  const retry = async () => {
    setRetrying(true);
    try {
      await refresh();
    } catch {
      // thông báo lỗi mới đã nằm trong authError
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div role="alert" className="mb-4 flex items-center gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
      <span className="flex-1">{authError}</span>
      <button
        type="button"
        onClick={retry}
        disabled={retrying}
        className="shrink-0 rounded-lg border border-red-200 px-3 py-1 text-xs font-bold disabled:opacity-60"
      >
        {retrying ? 'Đang thử...' : 'Thử lại'}
      </button>
    </div>
  );
}

export default function Layout() {
  const { headerTagline, announcementEnabled, announcementText, analyticsEnabled } = useSiteSettings();
  const { pathname } = useLocation();

  // Chờ biết thống kê có bật không: trang đầu tiên của lượt truy cập mở trước khi thiết lập tải xong vẫn phải được đếm
  useEffect(() => {
    const page = ANALYTICS_PAGES[pathname];
    if (page && analyticsEnabled) trackPageView(page);
  }, [pathname, analyticsEnabled]);

  return (
    <div className="mx-auto flex min-h-dvh max-w-lg flex-col bg-gradient-to-b from-leaf-50 to-white">
      <header className="sticky top-0 z-30 border-b border-leaf-100/80 bg-white/90 px-4 py-3 backdrop-blur-md">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-leaf-600 text-lg text-white shadow-sm">
            🌿
          </span>
          <div>
            <h1 className="text-lg font-extrabold tracking-tight text-leaf-800">GreenCanteen</h1>
            <p className="text-[11px] font-medium text-stone-500">{headerTagline}</p>
          </div>
        </div>
      </header>

      <main className="flex-1 px-4 pb-24 pt-4">
        <ConnectionBanner />
        {announcementEnabled && announcementText && (
          <p role="status" className="mb-4 rounded-xl bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-900">
            {announcementText}
          </p>
        )}
        <Outlet />
        <p className="mt-6 text-center text-xs text-stone-500">
          <a href="/privacy.html" className="underline underline-offset-2">
            Chính sách quyền riêng tư
          </a>
        </p>
      </main>

      <nav className="safe-bottom fixed bottom-0 left-0 right-0 z-40 border-t border-leaf-100 bg-white/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-lg justify-around px-2 py-2">
          <NavLink to="/" className={navClass} end>
            <span className="text-xl">🏠</span>
            Trang chủ
          </NavLink>
          <NavLink to="/checkin" className={navClass}>
            <span className="text-xl">📸</span>
            Check-in
          </NavLink>
          <NavLink to="/leaderboard" className={navClass}>
            <span className="text-xl">🏆</span>
            Xếp hạng
          </NavLink>
          <NavLink to="/profile" className={navClass}>
            <span className="text-xl">👤</span>
            Cá nhân
          </NavLink>
        </div>
      </nav>
    </div>
  );
}
