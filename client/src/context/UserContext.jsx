import { createContext, useContext, useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { clearLocalData } from '../lib/storage';
import { api, onUnauthorized } from '../lib/api';

const UserContext = createContext(null);

// Báo cho các tab khác của app khi đăng nhập / đăng xuất để chúng hỏi lại server
const AUTH_CHANNEL = 'greencanteen-auth';
// Quay lại tab sau ít nhất chừng này thời gian thì kiểm tra lại phiên (có thể đã đăng xuất ở thiết bị khác)
const REVALIDATE_AFTER_MS = 15_000;

export function UserProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  // Lỗi khi hỏi phiên (mất mạng, server lỗi) — khác với "chưa đăng nhập"
  const [authError, setAuthError] = useState('');
  const channelRef = useRef(null);
  const lastCheckRef = useRef(0);

  // Phiên là cookie httpOnly → nguồn sự thật duy nhất là server
  const refresh = useCallback(async () => {
    lastCheckRef.current = Date.now();
    try {
      const r = await api.me();
      setUser(r.user);
      setAuthError('');
      return r.user;
    } catch (err) {
      if (err.status === 401) {
        setUser(null);
        setAuthError('');
        return null;
      }
      setAuthError(err.message || 'Không kiểm tra được phiên đăng nhập.');
      throw err;
    } finally {
      setAuthLoading(false);
    }
  }, []);

  useEffect(() => {
    clearLocalData();
    refresh().catch(() => {});
  }, [refresh]);

  // Phiên hết hạn / bị thu hồi giữa chừng → về trạng thái chưa đăng nhập
  useEffect(() => onUnauthorized(() => setUser(null)), []);

  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const channel = new BroadcastChannel(AUTH_CHANNEL);
    channel.onmessage = () => refresh().catch(() => {});
    channelRef.current = channel;
    return () => {
      channel.close();
      channelRef.current = null;
    };
  }, [refresh]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (Date.now() - lastCheckRef.current < REVALIDATE_AFTER_MS) return;
      refresh().catch(() => {});
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  const announce = useCallback(() => channelRef.current?.postMessage({ type: 'auth-changed' }), []);

  const login = useCallback(
    (userData) => {
      setUser(userData);
      setAuthError('');
      announce();
    },
    [announce]
  );

  // Chỉ coi là đã đăng xuất khi server đã thu hồi phiên: cookie httpOnly không xóa được từ trình duyệt, nên nếu
  // request lỗi thì báo lỗi (người gọi xử lý) thay vì giả vờ đăng xuất — máy dùng chung sẽ vẫn vào được tài khoản
  const logout = useCallback(async () => {
    await api.logout();
    clearLocalData();
    setUser(null);
    announce();
  }, [announce]);

  const updateUser = useCallback((patch) => {
    setUser((u) => (u ? { ...u, ...patch } : u));
  }, []);

  const value = useMemo(
    () => ({
      user,
      authLoading,
      authError,
      refresh,
      login,
      logout,
      updateUser,
      isLoggedIn: Boolean(user?.studentId),
    }),
    [user, authLoading, authError, refresh, login, logout, updateUser]
  );

  return <UserContext.Provider value={value}>{children}</UserContext.Provider>;
}

export function useUser() {
  const ctx = useContext(UserContext);
  if (!ctx) throw new Error('useUser must be used within UserProvider');
  return ctx;
}
