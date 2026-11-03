import { useEffect, useRef, useState } from 'react';
import { NavLink, Navigate, Outlet, Route, Routes, useLocation } from 'react-router';
import { AdminSessionProvider, ReauthProvider, useAdminSession } from './session';
import { Button, ErrorState, LoadingState, NoticeProvider } from './ui';
import LoginPage from './pages/LoginPage';
import OverviewPage from './pages/OverviewPage';
import UsersPage from './pages/UsersPage';
import UserDetailPage from './pages/UserDetailPage';
import StoriesPage from './pages/StoriesPage';
import StoryEditorPage from './pages/StoryEditorPage';
import GachaPage from './pages/GachaPage';
import GachaConfigPage from './pages/GachaConfigPage';
import SettingsPage from './pages/SettingsPage';
import AuditPage from './pages/AuditPage';

const NAV = [
  ['/', 'Tổng quan'],
  ['/users', 'Tài khoản'],
  ['/stories', 'Câu chuyện'],
  ['/gacha', 'Gacha'],
  ['/settings', 'Thiết lập website'],
  ['/audit', 'Nhật ký kiểm toán'],
];

const navClass = ({ isActive }) =>
  `block rounded-xl px-3 py-2 text-sm font-semibold outline-none ring-leaf-400 transition focus-visible:ring-2 ${
    isActive ? 'bg-leaf-700 text-white' : 'text-stone-700 hover:bg-leaf-100'
  }`;

function AdminLayout() {
  const { session, logout } = useAdminSession();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const mainRef = useRef(null);
  const lastPathname = useRef(pathname);

  // Chuyển màn hình: đóng menu và đưa focus về nội dung để người dùng bàn phím không phải đi lại từ đầu.
  // So sánh đường dẫn thay vì đếm lần chạy: tải trang lần đầu thì focus phải ở đầu trang, kể cả dưới StrictMode
  useEffect(() => {
    setMenuOpen(false);
    if (lastPathname.current !== pathname) mainRef.current?.focus();
    lastPathname.current = pathname;
  }, [pathname]);

  return (
    <div className="min-h-dvh lg:flex">
      <a href="#admin-main" className="sr-only rounded-lg bg-white px-3 py-2 text-sm font-bold text-leaf-800 focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50">
        Bỏ qua điều hướng
      </a>
      <aside className="border-b border-stone-200 bg-white lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <p className="flex items-center gap-2 font-extrabold text-leaf-800">
            <span aria-hidden="true">🌿</span> Quản trị
          </p>
          <Button
            tone="secondary"
            className="px-3 py-1 lg:hidden"
            aria-expanded={menuOpen}
            aria-controls="admin-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            Menu
          </Button>
        </div>
        <nav id="admin-nav" aria-label="Khu quản trị" className={`${menuOpen ? 'block' : 'hidden'} space-y-1 px-3 pb-3 lg:block`}>
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === '/'} className={navClass}>
              {label}
            </NavLink>
          ))}
          <div className="border-t border-stone-200 pt-3 text-xs text-stone-500">
            <p className="truncate px-3">{session.admin?.email}</p>
            <button
              type="button"
              onClick={logout}
              className="mt-1 w-full rounded-xl px-3 py-2 text-left text-sm font-semibold text-red-700 outline-none ring-leaf-400 hover:bg-red-50 focus-visible:ring-2"
            >
              Đăng xuất
            </button>
          </div>
        </nav>
      </aside>
      <main id="admin-main" ref={mainRef} tabIndex={-1} className="min-w-0 flex-1 p-4 outline-none lg:p-6">
        <Outlet />
      </main>
    </div>
  );
}

/** Chỉ là điều hướng giao diện: dữ liệu quản trị luôn do server kiểm tra quyền trước khi trả về */
function RequireAdmin() {
  const { session, refresh } = useAdminSession();
  if (session.status === 'loading') return <LoadingState text="Đang kiểm tra phiên đăng nhập..." />;
  if (session.status === 'error') {
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorState message={session.error || 'Không kiểm tra được phiên đăng nhập.'} onRetry={refresh} />
      </div>
    );
  }
  if (session.status !== 'active') return <Navigate to="/login" replace />;
  return <AdminLayout />;
}

export default function AdminApp() {
  return (
    <NoticeProvider>
      <AdminSessionProvider>
        <ReauthProvider>
          <Routes>
            <Route path="login" element={<LoginPage />} />
            <Route element={<RequireAdmin />}>
              <Route index element={<OverviewPage />} />
              <Route path="users" element={<UsersPage />} />
              <Route path="users/:id" element={<UserDetailPage />} />
              <Route path="stories" element={<StoriesPage />} />
              <Route path="stories/new" element={<StoryEditorPage />} />
              <Route path="stories/:id" element={<StoryEditorPage />} />
              <Route path="gacha" element={<GachaPage />} />
              <Route path="gacha/:id" element={<GachaConfigPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="audit" element={<AuditPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </ReauthProvider>
      </AdminSessionProvider>
    </NoticeProvider>
  );
}
