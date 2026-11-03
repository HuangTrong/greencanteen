// Thông báo OAuth, dọn dữ liệu cũ trong localStorage, hook hỏi cấu hình đăng nhập (có bộ nhớ đệm)
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import { oauthErrorMessage, oauthSuccessMessage } from '../../src/lib/authMessages';
import { clearLocalData } from '../../src/lib/storage';
import { BADGE_META } from '../../src/data/badges';
import { PROVIDERS, deferred, json, mockApi } from '../helpers';

describe('oauthErrorMessage — bảng mã lỗi × nhà cung cấp', () => {
  const cases = [
    ['provider_not_configured', 'google', 'Đăng nhập bằng Google chưa được cấu hình trên máy chủ.'],
    ['oauth_cancelled', 'facebook', 'Bạn đã hủy đăng nhập bằng Facebook.'],
    ['invalid_state', 'google', 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.'],
    ['provider_already_linked', 'facebook', 'Tài khoản Facebook này đã liên kết với một tài khoản GreenCanteen khác.'],
    ['different_account_linked', 'google', 'Tài khoản của bạn đã liên kết với một tài khoản Google khác.'],
    ['login_required', 'google', 'Bạn cần đăng nhập trước khi liên kết Google.'],
    ['oauth_failed', 'github', 'Không thể đăng nhập bằng nhà cung cấp. Vui lòng thử lại.'],
    ['<script>', undefined, 'Không thể đăng nhập bằng nhà cung cấp. Vui lòng thử lại.'],
  ];
  for (const [code, provider, message] of cases) {
    test(`${code} / ${provider}`, () => expect(oauthErrorMessage(code, provider)).toBe(message));
  }

  test('email_in_use gợi ý đăng nhập bằng phương thức cũ rồi liên kết', () => {
    expect(oauthErrorMessage('email_in_use', 'google')).toMatch(/đăng nhập bằng phương thức đã dùng trước đây, rồi liên kết Google/);
  });

  test('thông báo thành công', () => {
    expect(oauthSuccessMessage('linked', 'google')).toBe('Đã liên kết Google với tài khoản của bạn.');
    expect(oauthSuccessMessage('success', 'facebook')).toBe('Đăng nhập bằng Facebook thành công.');
  });
});

describe('clearLocalData', () => {
  test('xóa hồ sơ / lịch sử cũ, giữ khóa khác', () => {
    localStorage.setItem('greencanteen_session', '{"studentId":"SV1"}');
    localStorage.setItem('greencanteen_local_history', '[]');
    localStorage.setItem('khac', '1');
    clearLocalData();
    expect(localStorage.getItem('greencanteen_session')).toBeNull();
    expect(localStorage.getItem('greencanteen_local_history')).toBeNull();
    expect(localStorage.getItem('khac')).toBe('1');
  });

  test('localStorage bị chặn (ném lỗi) → không làm hỏng ứng dụng', () => {
    const spy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError');
    });
    expect(() => clearLocalData()).not.toThrow();
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('useAuthProviders', () => {
  test('hỏi server một lần cho cả phiên dùng app; lỗi thì lần sau hỏi lại', async () => {
    vi.resetModules();
    const { useAuthProviders } = await import('../../src/lib/useAuthProviders');
    const { fetchMock } = mockApi({ 'GET /api/auth/providers': () => Promise.reject(new TypeError('offline')) });

    const first = renderHook(() => useAuthProviders());
    await waitFor(() => expect(first.result.current.loading).toBe(false));
    expect(first.result.current.error).toBe('Không kết nối được máy chủ');

    mockApi({ 'GET /api/auth/providers': json(PROVIDERS) });
    const second = renderHook(() => useAuthProviders());
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(second.result.current.providers.qr.enabled).toBe(true);

    const { fetchMock: third } = mockApi({ 'GET /api/auth/providers': json(PROVIDERS) });
    const cached = renderHook(() => useAuthProviders());
    await waitFor(() => expect(cached.result.current.loading).toBe(false));
    expect(third).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('component bị gỡ trước khi có phản hồi (thành công hoặc lỗi) → không cập nhật state', async () => {
    for (const settle of ['resolve', 'reject']) {
      vi.resetModules();
      const { useAuthProviders } = await import('../../src/lib/useAuthProviders');
      const pending = deferred();
      mockApi({ 'GET /api/auth/providers': () => pending.promise });
      const hook = renderHook(() => useAuthProviders());
      hook.unmount();
      if (settle === 'resolve') pending.resolve(json(PROVIDERS));
      else pending.reject(new TypeError('offline'));
      await new Promise((r) => setTimeout(r, 0));
      expect(hook.result.current).toEqual({ loading: true, error: '', providers: {} });
    }
  });
});

test('mọi huy hiệu có nhãn và biểu tượng', () => {
  for (const meta of Object.values(BADGE_META)) {
    expect(meta.label).toBeTruthy();
    expect(meta.emoji).toBeTruthy();
  }
});
