// Phần end-user mới: thiết lập công khai, SEO theo trang, sự kiện truy cập tối thiểu, ghi chú mã demo
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { setAnalyticsEnabled, trackClick, trackPageView } from '../../src/lib/analytics';
import CheckInSuccessModal from '../../src/components/CheckInSuccessModal';
import { oauthErrorMessage } from '../../src/lib/authMessages';
import { USER, deferred, json, mockApi, renderApp } from '../helpers';

const LOGGED_OUT = { 'GET /api/auth/me': json({ error: 'Bạn cần đăng nhập', code: 'auth_required' }, 401) };
const STATS = { 'GET /api/stats/school': json({ totalCheckIns: 1, plasticSavedGrams: 12, treesProtected: 0 }) };
const SETTINGS = {
  headerTagline: 'Khẩu hiệu từ quản trị',
  heroTitle: 'Tiêu đề từ quản trị',
  seoDescription: 'Mô tả từ quản trị',
  announcementEnabled: true,
  announcementText: 'Căn tin nghỉ thứ Bảy',
  supportContact: 'Phòng Công tác sinh viên',
  analyticsEnabled: false,
};
const settingsRoute = (patch = {}) => ({ 'GET /api/site/settings': json({ ...SETTINGS, ...patch }) });

beforeEach(() => {
  sessionStorage.clear();
  setAnalyticsEnabled(false);
});
afterEach(() => {
  vi.restoreAllMocks();
  delete navigator.doNotTrack;
  delete navigator.globalPrivacyControl;
});

describe('thiết lập công khai', () => {
  test('API lỗi: dùng đúng nội dung mặc định hiện có, trang vẫn hoạt động', async () => {
    mockApi({ ...LOGGED_OUT, ...STATS });
    renderApp('/');
    expect(await screen.findByText('Bạn chưa đăng nhập')).toBeInTheDocument();
    expect(screen.getByText('Căn tin xanh — Ly cá nhân, Trái đất vui')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Một ly nhựa ít hơn, một đại dương sạch hơn' })).toBeInTheDocument();
  });

  test('nội dung từ quản trị hiển thị dạng văn bản, kể cả khi chứa thẻ HTML', async () => {
    mockApi({ ...LOGGED_OUT, ...STATS, ...settingsRoute({ heroTitle: '<img src=x onerror=alert(1)>' }) });
    renderApp('/');
    expect(await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeInTheDocument();
    expect(screen.getByText('Khẩu hiệu từ quản trị')).toBeInTheDocument();
    expect(document.querySelector('main img')).toBeNull();
  });

  test('thông báo chỉ hiện khi đang bật và có nội dung', async () => {
    mockApi({ ...LOGGED_OUT, ...STATS, ...settingsRoute() });
    const { unmount } = renderApp('/');
    expect(await screen.findByText('Căn tin nghỉ thứ Bảy')).toBeInTheDocument();
    unmount();
    mockApi({ ...LOGGED_OUT, ...STATS, ...settingsRoute({ announcementEnabled: false }) });
    renderApp('/');
    await screen.findByText('Khẩu hiệu từ quản trị');
    expect(screen.queryByText('Căn tin nghỉ thứ Bảy')).not.toBeInTheDocument();
  });

  test('thông tin liên hệ hiện ở trang Cá nhân khi có', async () => {
    mockApi({ 'GET /api/auth/me': json({ user: USER }), ...settingsRoute(), 'GET /api/gacha/rewards': json({ rewards: [], pendingGachaSpins: 0 }), 'GET /api/checkin/history': json({ history: [] }), 'GET /api/auth/providers': json({ providers: {} }) });
    renderApp('/profile');
    expect(await screen.findByText('Liên hệ: Phòng Công tác sinh viên')).toBeInTheDocument();
  });
});

describe('SEO theo trang', () => {
  const meta = (name) => document.head.querySelector(`meta[name="${name}"]`)?.getAttribute('content');

  test('trang công khai có tiêu đề, mô tả, không noindex', async () => {
    mockApi({ ...LOGGED_OUT, ...STATS, ...settingsRoute(), 'GET /api/stats/leaderboard?period=week': json({ personal: [] }) });
    const { unmount } = renderApp('/');
    await waitFor(() => expect(meta('description')).toBe('Mô tả từ quản trị'));
    expect(document.title).toContain('GreenCanteen');
    expect(meta('robots')).toBeUndefined();
    unmount();

    renderApp('/leaderboard');
    await waitFor(() => expect(document.title).toBe('Bảng xếp hạng · GreenCanteen'));
    expect(meta('description')).toContain('Bảng xếp hạng');
  });

  test('trang cá nhân và check-in có noindex; quay về trang công khai thì gỡ', async () => {
    mockApi({ ...LOGGED_OUT, ...STATS, ...settingsRoute(), 'GET /api/checkin/status': json({ mode: 'local' }) });
    for (const route of ['/profile', '/checkin']) {
      const { unmount } = renderApp(route);
      await waitFor(() => expect(meta('robots')).toBe('noindex'));
      unmount();
    }
    renderApp('/');
    await waitFor(() => expect(meta('robots')).toBeUndefined());
  });
});

describe('sự kiện truy cập', () => {
  const events = (api) => api.callsTo('POST', '/api/analytics/events').map((call) => JSON.parse(call.init.body));
  const ANALYTICS_ON = { 'POST /api/analytics/events': json({ ok: true }, 202) };

  test('tắt ở server: không gửi gì', async () => {
    const api = mockApi({ ...LOGGED_OUT, ...STATS, ...settingsRoute(), ...ANALYTICS_ON });
    renderApp('/');
    await screen.findByText('Khẩu hiệu từ quản trị');
    trackPageView('home');
    expect(events(api)).toEqual([]);
  });

  test('chỉ gửi tên cố định và mã lượt truy cập, không có URL hay dữ liệu tài khoản', async () => {
    setAnalyticsEnabled(true);
    const api = mockApi(ANALYTICS_ON);
    trackPageView('profile');
    trackClick('home_primary_cta');
    const [view, click] = events(api);
    expect(Object.keys(view).sort()).toEqual(['page', 'type', 'visitId']);
    expect(Object.keys(click).sort()).toEqual(['target', 'type', 'visitId']);
    expect(view.visitId).toBe(click.visitId);
  });

  test('tôn trọng Do Not Track và Global Privacy Control', () => {
    setAnalyticsEnabled(true);
    const api = mockApi(ANALYTICS_ON);
    Object.defineProperty(navigator, 'doNotTrack', { value: '1', configurable: true });
    trackPageView('home');
    delete navigator.doNotTrack;
    Object.defineProperty(navigator, 'globalPrivacyControl', { value: true, configurable: true });
    trackPageView('home');
    expect(events(api)).toEqual([]);
    delete navigator.globalPrivacyControl;
    trackPageView('home');
    expect(events(api)).toHaveLength(1);
  });

  test('sau 30 phút không hoạt động là lượt truy cập mới; lỗi gửi không ảnh hưởng người dùng', async () => {
    setAnalyticsEnabled(true);
    const api = mockApi({ 'POST /api/analytics/events': () => { throw new TypeError('Failed to fetch'); } });
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    trackPageView('home');
    now.mockReturnValue(1_000_000 + 29 * 60 * 1000);
    trackPageView('home');
    now.mockReturnValue(1_000_000 + 60 * 60 * 1000);
    trackPageView('home');
    await waitFor(() => expect(api.calls).toHaveLength(3));
    const ids = api.calls.map((call) => JSON.parse(call.init.body).visitId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[1]);
  });

  test('trang mở qua HTTP / IP LAN (không có crypto.randomUUID): vẫn tạo được mã lượt truy cập đúng định dạng', () => {
    setAnalyticsEnabled(true);
    const api = mockApi(ANALYTICS_ON);
    const webCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: (array) => webCrypto.getRandomValues(array) });
    expect(() => trackPageView('home')).not.toThrow();
    expect(events(api).map((event) => event.visitId)).toEqual([expect.stringMatching(/^[a-z0-9-]{16,40}$/)]);
  });

  test('không tạo được mã lượt truy cập: bỏ qua sự kiện, không ném lỗi ra giao diện', () => {
    setAnalyticsEnabled(true);
    const api = mockApi(ANALYTICS_ON);
    // Lượt truy cập của test trước còn trong bộ nhớ: cho hết hạn để buộc phải tạo mã mới
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2 * 60 * 60 * 1000);
    vi.stubGlobal('crypto', undefined);
    expect(() => trackPageView('home')).not.toThrow();
    expect(events(api)).toEqual([]);
  });

  test('trình duyệt chặn sessionStorage: vẫn hoạt động, mã lượt truy cập giữ trong bộ nhớ', () => {
    setAnalyticsEnabled(true);
    const api = mockApi(ANALYTICS_ON);
    const blocked = () => {
      throw new Error('blocked');
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked);
    trackPageView('home');
    trackPageView('home');
    const ids = events(api).map((event) => event.visitId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  test('trang đầu tiên của lượt truy cập được đếm dù mở trước khi thiết lập tải xong, và chỉ đếm một lần', async () => {
    const settings = deferred();
    const api = mockApi({ ...LOGGED_OUT, ...STATS, 'GET /api/site/settings': () => settings.promise, ...ANALYTICS_ON });
    renderApp('/');
    await screen.findByText('Bạn chưa đăng nhập');
    expect(events(api)).toEqual([]);
    settings.resolve(json({ ...SETTINGS, analyticsEnabled: true }));
    await waitFor(() => expect(events(api).filter((event) => event.type === 'page_view').map((event) => event.page)).toEqual(['home']));
  });

  test('bật: mở trang gửi page_view đúng tên, nhấp nút chính gửi click', async () => {
    const api = mockApi({ ...LOGGED_OUT, ...STATS, ...settingsRoute({ analyticsEnabled: true }), ...ANALYTICS_ON });
    renderApp('/');
    await waitFor(() => expect(events(api).some((event) => event.type === 'impression' && event.target === 'home_primary_cta')).toBe(true));
    await userEvent.click(screen.getByRole('link', { name: 'Đăng nhập / Đăng ký' }));
    await waitFor(() => expect(events(api).some((event) => event.type === 'click' && event.target === 'home_primary_cta')).toBe(true));
    await waitFor(() => expect(events(api).some((event) => event.type === 'page_view' && event.page === 'profile')).toBe(true));
  });

  test('nhấp liên kết nguồn nghiên cứu được đếm; lượt hiển thị tính khi có liên kết', async () => {
    setAnalyticsEnabled(true);
    const api = mockApi(ANALYTICS_ON);
    const story = { slug: 's', title: 'T', species: 'S', summary: 'Tóm tắt', message: 'M', source: { title: 'Bài', authors: ['A'], journal: 'J', year: 2020, url: 'https://doi.org/10.1/x' } };
    render(<CheckInSuccessModal open onClose={() => {}} story={story} pointsEarned={10} />);
    await userEvent.click(screen.getByRole('link', { name: /Mở bài báo/ }));
    expect(events(api).map((event) => [event.type, event.target])).toEqual([
      ['impression', 'story_source_link'],
      ['click', 'story_source_link'],
    ]);
  });
});

describe('không khẳng định mã đổi được', () => {
  test('danh sách phần thưởng ở trang Cá nhân ghi rõ mã demo', async () => {
    mockApi({ 'GET /api/auth/me': json({ user: USER }), 'GET /api/gacha/rewards': json({ rewards: [], pendingGachaSpins: 0 }), 'GET /api/checkin/history': json({ history: [] }), 'GET /api/auth/providers': json({ providers: {} }) });
    renderApp('/profile');
    expect(await screen.findByText(/Mã demo cho môi trường thử nghiệm, chưa đổi được tại nhà mạng/)).toBeInTheDocument();
  });
});

test('thông báo khi đăng nhập Google/Facebook vào tài khoản bị khóa', () => {
  expect(oauthErrorMessage('account_locked', 'google')).toMatch(/đang bị khóa/);
});
