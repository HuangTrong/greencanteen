// Trang chủ (thống kê) và bảng xếp hạng: trạng thái tải, thành công, rỗng, lỗi, phản hồi thiếu trường, phản hồi đến trễ
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';
import { PROVIDERS, USER, deferred, json, mockApi, renderApp } from '../helpers';

const LOGGED_OUT = { 'GET /api/auth/me': json({ error: 'Bạn cần đăng nhập', code: 'auth_required' }, 401) };
const LOGGED_IN = { 'GET /api/auth/me': json({ user: USER }) };
const SCHOOL = { totalCheckIns: 1234, plasticSavedGrams: 14808, treesProtected: 24 };

describe('Trang chủ — thống kê toàn trường', () => {
  test('đang tải hiển thị "…", sau đó số định dạng tiếng Việt', async () => {
    const stats = deferred();
    mockApi({ ...LOGGED_IN, 'GET /api/stats/school': () => stats.promise });
    renderApp('/');
    expect(screen.getAllByText('…')).toHaveLength(3);
    await screen.findByText('Nguyễn An');
    expect(screen.getAllByText('…')).toHaveLength(3);
    stats.resolve(json(SCHOOL));
    expect(await screen.findByText('1.234')).toBeInTheDocument();
    expect(screen.getByText('14.808')).toBeInTheDocument();
    expect(screen.getByText('24')).toBeInTheDocument();
  });

  test('chưa đăng nhập: cả ba ô là 0, không hỏi số liệu từ server', async () => {
    const api = mockApi({ ...LOGGED_OUT, 'GET /api/stats/school': json(SCHOOL) });
    renderApp('/');
    expect(await screen.findByText('Bạn chưa đăng nhập')).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText('0')).toHaveLength(3));
    expect(screen.queryByText('1.234')).not.toBeInTheDocument();
    expect(api.callsTo('GET', '/api/stats/school')).toHaveLength(0);
  });

  test('đăng xuất rồi về trang chủ: ô trở về 0; đăng nhập lại vẫn thấy số liệu như cũ', async () => {
    const session = { user: USER };
    mockApi({
      'GET /api/auth/me': () => (session.user ? json({ user: session.user }) : LOGGED_OUT['GET /api/auth/me']),
      'GET /api/auth/providers': json(PROVIDERS),
      'GET /api/checkin/history': json({ history: [] }),
      'GET /api/gacha/rewards': json({ pendingGachaSpins: 0, rewards: [] }),
      'GET /api/stats/school': json(SCHOOL),
      'POST /api/auth/logout': () => {
        session.user = null;
        return json({ ok: true });
      },
    });
    const { unmount } = renderApp('/');
    expect(await screen.findByText('1.234')).toBeInTheDocument();
    const nav = screen.getByRole('navigation');
    await userEvent.click(within(nav).getByRole('link', { name: /Cá nhân/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
    expect(await screen.findByText('Chưa có hồ sơ cá nhân')).toBeInTheDocument();
    await userEvent.click(within(nav).getByRole('link', { name: /Trang chủ/ }));
    await waitFor(() => expect(screen.getAllByText('0')).toHaveLength(3));
    expect(screen.queryByText('1.234')).not.toBeInTheDocument();
    unmount();

    session.user = USER;
    renderApp('/');
    expect(await screen.findByText('1.234')).toBeInTheDocument();
  });

  test('đăng xuất ở tab khác khi số liệu đang tải: ô về 0, phản hồi đến sau không ghi đè', async () => {
    const stats = deferred();
    const session = { user: USER };
    mockApi({
      'GET /api/auth/me': () => (session.user ? json({ user: session.user }) : LOGGED_OUT['GET /api/auth/me']),
      'GET /api/stats/school': () => stats.promise,
    });
    renderApp('/');
    await screen.findByText('Nguyễn An');
    const otherTab = new BroadcastChannel('greencanteen-auth');
    try {
      session.user = null;
      otherTab.postMessage({ type: 'auth-changed' });
      expect(await screen.findByText('Bạn chưa đăng nhập')).toBeInTheDocument();
      await waitFor(() => expect(screen.getAllByText('0')).toHaveLength(3));
      stats.resolve(json(SCHOOL));
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.queryByText('1.234')).not.toBeInTheDocument();
    } finally {
      otherTab.close();
    }
  });

  test('không xác định được phiên (mất mạng): hiện "—", không hiện số 0 gây hiểu nhầm', async () => {
    mockApi({ 'GET /api/auth/me': () => Promise.reject(new TypeError('offline')) });
    renderApp('/');
    expect(await screen.findByText(/Không kết nối được máy chủ/)).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  test('chưa đăng nhập: mời đăng nhập; đã đăng nhập: chào theo tên và có nút check-in', async () => {
    mockApi({ ...LOGGED_OUT, 'GET /api/stats/school': json({ totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 }) });
    const { unmount } = renderApp('/');
    expect(await screen.findByText('Bạn chưa đăng nhập')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Đăng nhập / Đăng ký' })).toHaveAttribute('href', '/profile');
    unmount();

    mockApi({ 'GET /api/auth/me': json({ user: USER }), 'GET /api/stats/school': json({ totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 }) });
    renderApp('/');
    expect(await screen.findByText('Nguyễn An')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Check-in ngay/ })).toHaveAttribute('href', '/checkin');
  });

  test('API lỗi: hiển thị "—" (không phải số 0 gây hiểu nhầm) và thông báo', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/stats/school': json({ error: 'Lỗi máy chủ.', code: 'server_error' }, 500) });
    renderApp('/');
    expect(await screen.findByText('Lỗi máy chủ.')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(3);
  });

  test('phản hồi JSON thiếu trường: trang không bị sập, trường thiếu hiển thị "—"', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/stats/school': json({ totalCheckIns: 5 }) });
    renderApp('/');
    expect(await screen.findByText('5')).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  test('phản hồi không phải JSON (trang HTML từ proxy) → báo lỗi thay vì số liệu rỗng', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/stats/school': new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }) });
    renderApp('/');
    expect(await screen.findByText(/Phản hồi từ máy chủ không hợp lệ/)).toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(3);
  });
});

describe('Bảng xếp hạng', () => {
  const rows = (n, prefix = 'Người') =>
    Array.from({ length: n }, (_, i) => ({ rank: i + 1, name: `${prefix} ${i + 1}`, checkIns: 10 - i, points: (10 - i) * 10 }));

  test('mặc định tuần; chuyển sang tháng gọi API với period=month; trạng thái nút được công bố cho trình đọc màn hình', async () => {
    const api = mockApi({
      ...LOGGED_OUT,
      'GET /api/stats/leaderboard?period=week': json({ period: 'week', personal: rows(2, 'Tuần') }),
      'GET /api/stats/leaderboard?period=month': json({ period: 'month', personal: rows(3, 'Tháng') }),
    });
    renderApp('/leaderboard');
    expect(await screen.findByText('Tuần 1')).toBeInTheDocument();
    const week = screen.getByRole('button', { name: 'Tuần' });
    const month = screen.getByRole('button', { name: 'Tháng' });
    expect(week).toHaveAttribute('aria-pressed', 'true');
    expect(month).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(month);
    expect(await screen.findByText('Tháng 3')).toBeInTheDocument();
    expect(month).toHaveAttribute('aria-pressed', 'true');
    expect(api.callsTo('GET', '/api/stats/leaderboard').map((c) => c.path)).toEqual([
      '/api/stats/leaderboard?period=week',
      '/api/stats/leaderboard?period=month',
    ]);
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Tháng 110 lượt100 pts');
  });

  test('không có dữ liệu trong kỳ; phản hồi thiếu "personal" cũng coi là rỗng', async () => {
    mockApi({
      ...LOGGED_OUT,
      'GET /api/stats/leaderboard?period=week': json({ period: 'week' }),
    });
    renderApp('/leaderboard');
    expect(await screen.findByText('Chưa có dữ liệu trong kỳ này.')).toBeInTheDocument();
  });

  test('lỗi API → thông báo + "Thử lại" tải lại thành công', async () => {
    let attempt = 0;
    mockApi({
      ...LOGGED_OUT,
      'GET /api/stats/leaderboard?period=week': () =>
        (attempt += 1) === 1 ? json({ error: 'Lỗi máy chủ.', code: 'server_error' }, 500) : json({ period: 'week', personal: rows(1) }),
    });
    renderApp('/leaderboard');
    expect(await screen.findByRole('alert')).toHaveTextContent('Lỗi máy chủ.');
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Người 1')).toBeInTheDocument();
  });

  test('phản hồi của kỳ cũ đến trễ không ghi đè kỳ mới', async () => {
    const week = deferred();
    mockApi({
      ...LOGGED_OUT,
      'GET /api/stats/leaderboard?period=week': () => week.promise,
      'GET /api/stats/leaderboard?period=month': json({ period: 'month', personal: rows(1, 'Tháng') }),
    });
    renderApp('/leaderboard');
    await userEvent.click(screen.getByRole('button', { name: 'Tháng' }));
    expect(await screen.findByText('Tháng 1')).toBeInTheDocument();
    week.resolve(json({ period: 'week', personal: rows(1, 'Tuần') }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Tuần 1')).not.toBeInTheDocument();
    expect(screen.getByText('Tháng 1')).toBeInTheDocument();
  });

  describe('ảnh đại diện và khung hạng', () => {
    const framed = (n) => rows(n).map((row) => ({ ...row, avatarUrl: `/api/avatars/anh-${row.rank}` }));
    const showRows = async (n) => {
      mockApi({ ...LOGGED_OUT, 'GET /api/stats/leaderboard?period=week': json({ period: 'week', personal: framed(n) }) });
      const { container } = renderApp('/leaderboard');
      await screen.findByText('Người 1');
      return { container, items: within(screen.getByRole('list')).getAllByRole('listitem') };
    };
    const frameOf = (item) => item.querySelector('[data-rank-frame]').getAttribute('data-rank-frame');

    test('top 3: ảnh tròn, vương miện, số hạng, khung vàng / bạc / đồng', async () => {
      const { items } = await showRows(3);
      expect(items.map(frameOf)).toEqual(['gold', 'silver', 'bronze']);
      items.forEach((item, index) => {
        const rank = index + 1;
        expect(within(item).getByTestId('rank-crown')).toBeInTheDocument();
        expect(within(item).getByTestId('rank-number')).toHaveTextContent(String(rank));
        const image = item.querySelector('img');
        expect(image).toHaveAttribute('src', `/api/avatars/anh-${rank}`);
        expect(image).toHaveClass('rounded-full');
      });
    });

    test('từ hạng 4: chỉ có khung viền xanh, không vương miện, không số hạng; trình đọc màn hình vẫn đọc được hạng', async () => {
      const { items } = await showRows(5);
      for (const item of items.slice(3)) {
        expect(frameOf(item)).toBe('green');
        expect(within(item).queryByTestId('rank-crown')).not.toBeInTheDocument();
        expect(within(item).queryByTestId('rank-number')).not.toBeInTheDocument();
        expect(item.querySelector('img')).toHaveClass('rounded-full');
      }
      const hidden = within(items[4]).getByText('Hạng 5');
      expect(hidden).toHaveClass('sr-only');
    });

    test('chưa có ảnh: chữ cái đầu của tên, vẫn giữ khung', async () => {
      mockApi({
        ...LOGGED_OUT,
        'GET /api/stats/leaderboard?period=week': json({
          period: 'week',
          personal: [
            { rank: 1, name: 'Nguyễn Ánh', avatarUrl: null, checkIns: 3, points: 30 },
            { rank: 4, name: '  ', avatarUrl: null, checkIns: 1, points: 10 },
          ],
        }),
      });
      const { container } = renderApp('/leaderboard');
      await screen.findByText('Nguyễn Ánh');
      expect(container.querySelector('img')).toBeNull();
      const [first, fourth] = within(screen.getByRole('list')).getAllByRole('listitem');
      expect(frameOf(first)).toBe('gold');
      expect(within(first).getByTestId('avatar-initial')).toHaveTextContent('Á');
      expect(within(fourth).getByTestId('avatar-initial')).toHaveTextContent('?');
    });

    test('ảnh tải lỗi: tự về chữ cái đầu, không để biểu tượng ảnh vỡ', async () => {
      const { items } = await showRows(1);
      fireEvent.error(items[0].querySelector('img'));
      expect(items[0].querySelector('img')).toBeNull();
      expect(within(items[0]).getByTestId('avatar-initial')).toHaveTextContent('1');
    });
  });

  test('tên chứa thẻ HTML hiển thị nguyên văn, không tạo phần tử (chống XSS)', async () => {
    mockApi({
      ...LOGGED_OUT,
      'GET /api/stats/leaderboard?period=week': json({ period: 'week', personal: [{ rank: 1, name: '<img src=x onerror=alert(1)>', checkIns: 1, points: 10 }] }),
    });
    const { container } = renderApp('/leaderboard');
    expect(await screen.findByText('<img src=x onerror=alert(1)>')).toBeInTheDocument();
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('Bố cục, điều hướng, phiên đăng nhập', () => {
  test('đường dẫn lạ chuyển về trang chủ; thanh điều hướng có 4 mục', async () => {
    mockApi({ ...LOGGED_OUT, 'GET /api/stats/school': json({ totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 }) });
    renderApp('/khong-ton-tai');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/$/));
    const nav = screen.getByRole('navigation');
    expect(within(nav).getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['/', '/checkin', '/leaderboard', '/profile']);
  });

  test('không hỏi được phiên (mất mạng) → banner lỗi + "Thử lại" khôi phục', async () => {
    let online = false;
    mockApi({
      'GET /api/auth/me': () => (online ? json({ user: USER }) : Promise.reject(new TypeError('offline'))),
      'GET /api/stats/school': json({ totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 }),
    });
    renderApp('/');
    expect(await screen.findByText(/Không kết nối được máy chủ/)).toBeInTheDocument();
    online = true;
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Nguyễn An')).toBeInTheDocument();
    expect(screen.queryByText(/Không kết nối được máy chủ/)).not.toBeInTheDocument();
  });
});
