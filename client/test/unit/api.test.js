// Lớp gọi API: header chống CSRF, cookie phiên, ánh xạ lỗi, phản hồi sai định dạng
import { describe, expect, test, vi } from 'vitest';
import { api, onUnauthorized } from '../../src/lib/api';
import { json, mockApi } from '../helpers';

describe('request', () => {
  test('gửi kèm cookie (credentials) và header X-Requested-With; JSON có Content-Type', async () => {
    const { calls } = mockApi({ 'POST /api/auth/login': json({ user: { id: 'u' } }) });
    await api.login({ email: 'a@b.vn', password: 'x' });
    const { init } = calls[0];
    expect(init.credentials).toBe('include');
    expect(init.headers).toEqual({ 'X-Requested-With': 'GreenCanteen', 'Content-Type': 'application/json' });
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.vn', password: 'x' });
  });

  test('upload ảnh dùng FormData trường "image" và để trình duyệt tự đặt Content-Type (boundary)', async () => {
    const { calls } = mockApi({ 'POST /api/checkin': json({ success: true }) });
    const file = new File(['abc'], 'a.png', { type: 'image/png' });
    await api.checkIn(file);
    const { init } = calls[0];
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('image')).toBeInstanceOf(File);
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  test('đường dẫn: mã hóa challengeId, period, URL OAuth', async () => {
    const { calls } = mockApi({
      'GET /api/auth/qr/challenge/a%2Fb%3Fc': json({}),
      'GET /api/stats/leaderboard?period=month': json({ personal: [] }),
    });
    await api.qrChallenge('a/b?c');
    await api.leaderboard('month');
    expect(calls.map((c) => c.path)).toEqual(['/api/auth/qr/challenge/a%2Fb%3Fc', '/api/stats/leaderboard?period=month']);
    expect(api.oauthStartUrl('google')).toBe('/api/auth/google/start?mode=login');
    expect(api.oauthStartUrl('facebook', 'link')).toBe('/api/auth/facebook/start?mode=link');
  });
});

describe('ánh xạ lỗi', () => {
  const failWith = async (response) => {
    mockApi({ 'GET /api/stats/school': response });
    return api.schoolStats().then(
      () => {
        throw new Error('phải thất bại');
      },
      (err) => err
    );
  };

  test('lỗi JSON của server: dùng error, giữ status / code / payload', async () => {
    const err = await failWith(json({ error: 'Email không hợp lệ.', code: 'invalid_input', extra: 1 }, 400));
    expect(err.message).toBe('Email không hợp lệ.');
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_input');
    expect(err.payload.extra).toBe(1);
  });

  test('không có error thì dùng reason (check-in bị từ chối)', async () => {
    expect((await failWith(json({ reason: 'Ly nhựa dùng một lần' }, 422))).message).toBe('Ly nhựa dùng một lần');
  });

  test('bảng thông báo dự phòng theo mã trạng thái', async () => {
    const cases = [
      [new Response('Bad Gateway', { status: 502 }), /Không kết nối được máy chủ API/],
      [json({}, 500), /Máy chủ đang gặp sự cố/],
      [json({}, 413), /quá lớn/],
      [json({}, 429), /quá nhiều lần/],
      [new Response('', { status: 404 }), /^Yêu cầu thất bại\.$/],
    ];
    for (const [response, message] of cases) {
      expect((await failWith(response)).message).toMatch(message);
    }
  });

  test('mất mạng → network_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(api.schoolStats()).rejects.toMatchObject({ code: 'network_error', message: expect.stringMatching(/Kiểm tra mạng/) });
  });

  test('phản hồi 200 nhưng không phải JSON (vd. trang HTML) → lỗi invalid_response, không coi là thành công', async () => {
    const err = await failWith(new Response('<!doctype html><title>GreenCanteen</title>', { status: 200, headers: { 'Content-Type': 'text/html' } }));
    expect(err.code).toBe('invalid_response');
    expect(err.message).toMatch(/không hợp lệ/);
  });
});

describe('onUnauthorized', () => {
  test('chỉ báo khi 401 auth_required; hủy đăng ký được', async () => {
    const listener = vi.fn();
    const unsubscribe = onUnauthorized(listener);
    mockApi({
      'GET /api/auth/me': json({ error: 'Bạn cần đăng nhập', code: 'auth_required' }, 401),
      'POST /api/auth/login': json({ error: 'Sai', code: 'invalid_credentials' }, 401),
    });
    await expect(api.me()).rejects.toMatchObject({ status: 401 });
    await expect(api.login({})).rejects.toMatchObject({ code: 'invalid_credentials' });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    await expect(api.me()).rejects.toBeTruthy();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
