import { render } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { vi } from 'vitest';
import App from '../src/App';

export const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

export const USER = {
  id: 'u1',
  studentId: 'SV001',
  name: 'Nguyễn An',
  email: 'an@example.edu.vn',
  createdAt: '2026-09-01T08:00:00.000Z',
  authMethods: { password: true, google: false, facebook: false },
  ecoPoints: 30,
  totalCheckIns: 3,
  plasticSavedGrams: 36,
  co2SavedGrams: 24,
  badges: ['first_sip'],
  pendingGachaSpins: 1,
};

export const PROVIDERS = {
  providers: {
    email: { enabled: true },
    google: { enabled: false },
    facebook: { enabled: false },
    qr: { enabled: true },
    passwordReset: { enabled: true, devConsole: false },
    emailVerification: { enabled: true, devConsole: false },
  },
};

export const SECURITY = { mfa: { available: true, enabled: false, recoveryCodesLeft: 0 }, passkeys: [] };

/**
 * Thay fetch bằng API giả: routes = { 'GET /api/auth/me': handler }, handler là Response, hàm trả Response
 * hoặc Promise<Response>. URL không khai báo → lỗi mạng (TypeError) như khi không kết nối được.
 */
export function mockApi(routes) {
  const calls = [];
  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const fullPath = String(url).replace(/^https?:\/\/[^/]+/, '');
    const path = fullPath.split('?')[0];
    calls.push({ method, path: fullPath, init });
    const key = [`${method} ${fullPath}`, `${method} ${path}`].find((k) => k in routes);
    if (!key) throw new TypeError(`Failed to fetch (chưa giả lập ${method} ${fullPath})`);
    const handler = routes[key];
    const result = typeof handler === 'function' ? await handler({ method, path: fullPath, init, calls }) : handler;
    return result instanceof Response ? result.clone() : result;
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, fetchMock, callsTo: (method, prefix) => calls.filter((c) => c.method === method && c.path.startsWith(prefix)) };
}

/** Promise điều khiển được từ test — để kiểm tra trạng thái "đang tải" và phản hồi đến trễ */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function LocationProbe() {
  const location = useLocation();
  return <span data-testid="location">{`${location.pathname}${location.search}${location.hash}`}</span>;
}

export function renderApp(route = '/') {
  return render(
    <MemoryRouter initialEntries={[route]}>
      <App />
      <LocationProbe />
    </MemoryRouter>
  );
}
