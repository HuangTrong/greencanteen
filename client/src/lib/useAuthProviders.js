import { useEffect, useState } from 'react';
import { api } from './api';

// Cấu hình nhà cung cấp chỉ đổi khi server khởi động lại → hỏi một lần cho cả phiên dùng app
let providersRequest = null;

/** Phương thức đăng nhập nào đã được cấu hình trên server: { loading, error, providers } */
export function useAuthProviders() {
  const [state, setState] = useState({ loading: true, error: '', providers: {} });

  useEffect(() => {
    let cancelled = false;
    providersRequest ||= api.authProviders().catch((err) => {
      providersRequest = null;
      throw err;
    });
    providersRequest
      .then((r) => {
        if (!cancelled) setState({ loading: false, error: '', providers: r.providers || {} });
      })
      .catch(() => {
        if (!cancelled) setState({ loading: false, error: 'Không kết nối được máy chủ', providers: {} });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}
