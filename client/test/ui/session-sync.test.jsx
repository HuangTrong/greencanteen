// Đồng bộ trạng thái đăng nhập (chuyển trạng thái phiên): tab khác đăng nhập / đăng xuất, quay lại tab sau một lúc,
// phiên bị thu hồi ở thiết bị khác
import { act, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { USER, json, mockApi, renderApp } from '../helpers';

const LOGGED_OUT = json({ error: 'Bạn cần đăng nhập để tiếp tục.', code: 'auth_required' }, 401);
const STATS = { 'GET /api/stats/school': json({ totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 }) };

function mutableSession(initial) {
  const state = { current: initial };
  const api = mockApi({ 'GET /api/auth/me': () => (state.current ? json({ user: state.current }) : LOGGED_OUT), ...STATS });
  return { state, api, meCalls: () => api.callsTo('GET', '/api/auth/me').length };
}

describe('đồng bộ giữa các tab (BroadcastChannel)', () => {
  test('tab khác báo đăng nhập → tab này hỏi lại server và hiện hồ sơ; báo đăng xuất → về chưa đăng nhập', async () => {
    const { state, meCalls } = mutableSession(null);
    renderApp('/');
    expect(await screen.findByText('Bạn chưa đăng nhập')).toBeInTheDocument();
    expect(meCalls()).toBe(1);

    const otherTab = new BroadcastChannel('greencanteen-auth');
    try {
      state.current = USER;
      otherTab.postMessage({ type: 'auth-changed' });
      expect(await screen.findByText('Nguyễn An')).toBeInTheDocument();
      expect(meCalls()).toBe(2);

      state.current = null;
      otherTab.postMessage({ type: 'auth-changed' });
      expect(await screen.findByText('Bạn chưa đăng nhập')).toBeInTheDocument();
    } finally {
      otherTab.close();
    }
  });
});

describe('quay lại tab (visibilitychange)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => {
    delete document.visibilityState;
  });

  const showTab = () => act(async () => document.dispatchEvent(new Event('visibilitychange')));

  test('dưới 15 giây không hỏi lại; sau 15 giây hỏi lại — phiên đã bị thu hồi ở thiết bị khác → về chưa đăng nhập', async () => {
    const { state, meCalls } = mutableSession(USER);
    renderApp('/');
    expect(await screen.findByText('Nguyễn An')).toBeInTheDocument();
    expect(meCalls()).toBe(1);

    vi.setSystemTime(Date.now() + 10_000);
    await showTab();
    expect(meCalls()).toBe(1);

    state.current = null;
    vi.setSystemTime(Date.now() + 6_000);
    await showTab();
    expect(await screen.findByText('Bạn chưa đăng nhập')).toBeInTheDocument();
    expect(meCalls()).toBe(2);
  });

  test('tab bị ẩn thì không hỏi server', async () => {
    const { meCalls } = mutableSession(USER);
    renderApp('/');
    await screen.findByText('Nguyễn An');
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    vi.setSystemTime(Date.now() + 60_000);
    await showTab();
    expect(meCalls()).toBe(1);
  });
});
