// Các màn hình quản trị: tải / rỗng / lỗi, che dữ liệu, thao tác nguy hiểm có xác nhận, số liệu chưa có nguồn, trợ năng
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { setCsrfToken } from '../../src/admin/adminApi';
import { deferred, json, mockApi } from '../helpers';
import { GACHA_DRAFT, LOGGED_IN, MEDIA, OVERVIEW, PRIZE, REAUTH_REQUIRED, STORY, USER_DETAIL, USER_ROW, renderAdmin } from './helpers';

beforeEach(() => setCsrfToken(''));

describe('Tổng quan', () => {
  test('hiển thị số liệu, đơn vị, múi giờ và định nghĩa; ô tóm tắt định dạng tiếng Việt', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json(OVERVIEW) });
    renderAdmin('/');
    expect(await screen.findByText('Lượt trúng móc khóa', { selector: 'p, span, dt, h3, div' })).toBeInTheDocument();
    expect(screen.getByText('Lượt quay thưởng tri ân', { selector: 'p, span, dt, h3, div' }).parentElement).toHaveTextContent('30');
    expect(screen.getByText('Tổng tài khoản').parentElement).toHaveTextContent('120');
    expect(screen.getByText('Tổng tài khoản').parentElement).toHaveTextContent('5 mới trong kỳ, 2 đang khóa');
    expect(screen.getByText(/giờ Việt Nam \(UTC\+7\)/)).toBeInTheDocument();
    expect(screen.getByText('Định nghĩa số liệu, đơn vị, nguồn dữ liệu')).toBeInTheDocument();
    expect(screen.getByText(/Múi giờ Asia\/Ho_Chi_Minh/)).toBeInTheDocument();
  });

  test('doanh thu, chi phí, lợi nhuận: "Chưa có nguồn dữ liệu", không có con số; quà quay thưởng không được tính là doanh thu', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json(OVERVIEW) });
    renderAdmin('/');
    const heading = await screen.findByRole('heading', { name: 'Tài chính' });
    const section = heading.closest('section');
    for (const label of ['Doanh thu', 'Chi phí', 'Lợi nhuận']) {
      expect(within(section).getByText(label).parentElement).toHaveTextContent(`${label}Chưa có nguồn dữ liệu`);
    }
    expect(section).not.toHaveTextContent('₫');
    expect(section).toHaveTextContent('không được tính là doanh thu hay chi phí');
  });

  test('truy cập chưa có nguồn: nêu rõ, không suy ra từ check-in; ô chưa có dữ liệu là "—", ô bằng 0 vẫn là 0', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json(OVERVIEW) });
    renderAdmin('/');
    const heading = await screen.findByRole('heading', { name: 'Truy cập' });
    expect(heading.closest('section')).toHaveTextContent('không suy ra từ số check-in');

    const table = screen.getByRole('region', { name: 'Số liệu theo từng kỳ' });
    const rows = within(table).getAllByRole('row');
    const lastCells = (row) => within(row).getAllByRole('cell').slice(-3).map((cell) => cell.textContent);
    expect(lastCells(rows[1])).toEqual(['—', '—', '—']);
    expect(lastCells(rows[2])).toEqual(['0', '0', '0']);
    expect(lastCells(rows[3])).toEqual(['15', '6', '3']);
  });

  test('có dữ liệu truy cập: hiện ba chỉ số riêng và tỉ lệ nhấp; thiếu khóa băm thì người dùng hoạt động báo chưa có nguồn', async () => {
    const traffic = {
      status: 'ok',
      enabled: true,
      totals: { pageViews: 40, visits: 12, activeUsers: null },
      activeUsersAvailable: false,
      retentionDays: 90,
      collectingSince: '2026-10-01T00:00:00.000Z',
      clickThrough: [
        { target: 'home_primary_cta', label: 'Nút chính ở trang chủ', impressions: 40, clicks: 10, ratePercent: 25 },
        { target: 'story_source_link', label: 'Liên kết nguồn nghiên cứu', impressions: 0, clicks: 0, ratePercent: null },
      ],
    };
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json({ ...OVERVIEW, traffic }) });
    renderAdmin('/');
    const heading = await screen.findByRole('heading', { name: 'Truy cập' });
    const section = heading.closest('section');
    expect(within(section).getByText('Lượt xem trang').parentElement).toHaveTextContent('40');
    expect(within(section).getByText('Lượt truy cập').parentElement).toHaveTextContent('12');
    expect(within(section).getByText('Người dùng hoạt động').parentElement).toHaveTextContent('Chưa có nguồn dữ liệu');
    expect(within(section).getByText('25%')).toBeInTheDocument();
    expect(section).toHaveTextContent('giữ 90 ngày rồi tự xóa');
  });

  test('khoảng vắt qua hai tháng: người dùng hoạt động nêu rõ không có tổng, bảng từng kỳ vẫn có số', async () => {
    const traffic = {
      status: 'ok',
      enabled: true,
      totals: { pageViews: 40, visits: 12, activeUsers: null },
      activeUsersAvailable: true,
      activeUsersSpansMonths: true,
      retentionDays: 90,
      collectingSince: '2026-10-01T00:00:00.000Z',
      clickThrough: [],
    };
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json({ ...OVERVIEW, traffic }) });
    renderAdmin('/');
    const heading = await screen.findByRole('heading', { name: 'Truy cập' });
    const tile = within(heading.closest('section')).getByText('Người dùng hoạt động').parentElement;
    expect(tile).toHaveTextContent('Không có tổng');
    expect(tile).toHaveTextContent('đổi theo tháng');
    expect(tile).not.toHaveTextContent('—');
    const rows = within(screen.getByRole('region', { name: 'Số liệu theo từng kỳ' })).getAllByRole('row');
    expect(within(rows[3]).getAllByRole('cell').at(-1)).toHaveTextContent('3');
  });

  test('khoảng trong một tháng: người dùng hoạt động hiện đúng số', async () => {
    const traffic = {
      status: 'ok',
      enabled: true,
      totals: { pageViews: 40, visits: 12, activeUsers: 7 },
      activeUsersAvailable: true,
      activeUsersSpansMonths: false,
      retentionDays: 90,
      collectingSince: '2026-10-01T00:00:00.000Z',
      clickThrough: [],
    };
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json({ ...OVERVIEW, traffic }) });
    renderAdmin('/');
    const heading = await screen.findByRole('heading', { name: 'Truy cập' });
    expect(within(heading.closest('section')).getByText('Người dùng hoạt động').parentElement).toHaveTextContent(/^Người dùng hoạt động7$/);
  });

  test('đổi bộ lọc gọi lại API với đúng tham số; gộp theo tháng', async () => {
    const api = mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json(OVERVIEW) });
    renderAdmin('/');
    await screen.findByText('300.000 ₫');
    await userEvent.selectOptions(screen.getByLabelText('Gộp theo'), 'month');
    await waitFor(() => expect(api.callsTo('GET', '/api/admin/overview').at(-1).path).toContain('granularity=month'));
    await userEvent.click(screen.getByRole('button', { name: '7 ngày' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '7 ngày' })).toHaveAttribute('aria-pressed', 'true'));
    expect(api.callsTo('GET', '/api/admin/overview').at(-1).path).toContain('granularity=day');
  });

  test('lỗi tải: hiện thông báo và nút thử lại; khoảng ngày sai do server báo', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json({ error: 'Xem theo ngày tối đa 366 ngày.', code: 'invalid_input' }, 400) });
    renderAdmin('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('tối đa 366 ngày');
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
  });

  test('tải lại giữ khung cũ, không nhảy về màn hình trống', async () => {
    const second = deferred();
    let calls = 0;
    mockApi({
      ...LOGGED_IN,
      'GET /api/admin/overview': () => {
        calls += 1;
        return calls === 1 ? json(OVERVIEW) : second.promise;
      },
    });
    renderAdmin('/');
    await screen.findByText('300.000 ₫');
    await userEvent.click(screen.getByRole('button', { name: 'Tải lại số liệu' }));
    expect(screen.getByText('300.000 ₫')).toBeInTheDocument();
    second.resolve(json(OVERVIEW));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Tải lại số liệu' })).toBeEnabled());
  });

  test('biểu đồ dùng được bằng bàn phím: mũi tên đọc từng kỳ, Home/End nhảy về hai đầu', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json(OVERVIEW) });
    renderAdmin('/');
    await screen.findByText('300.000 ₫');
    const chart = screen.getByRole('img', { name: /Check-in/ });
    const status = chart.closest('figure').querySelector('[role="status"]');
    expect(status).toHaveTextContent('Cao nhất 27 lượt vào 02/10.');
    chart.focus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(status).toHaveTextContent('03/10');
    expect(status).toHaveTextContent('5 hợp lệ');
    expect(status).toHaveTextContent('4 không hợp lệ');
    await userEvent.keyboard('{Home}');
    expect(status).toHaveTextContent('01/10');
    await userEvent.keyboard('{End}');
    expect(status).toHaveTextContent('03/10');
    fireEvent.blur(chart);
    expect(status).toHaveTextContent('Cao nhất');
  });

  test('kỳ không có dữ liệu: biểu đồ báo rõ, không có cột, trục số đếm không có nửa đơn vị', async () => {
    const series = OVERVIEW.series.map((row) => ({ ...row, checkInsValid: 0, checkInsInvalid: 0 }));
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json({ ...OVERVIEW, series }) });
    renderAdmin('/');
    await screen.findByText('300.000 ₫');
    const figure = screen.getByRole('img', { name: /Check-in/ }).closest('figure');
    expect(figure).toHaveTextContent('Không có dữ liệu trong kỳ này.');
    expect(figure).not.toHaveTextContent('0.5');
  });

  test('nhiều kỳ (366 ngày): mọi cột vẫn có chiều rộng để hiển thị', async () => {
    const series = Array.from({ length: 366 }, (_, day) => ({ ...OVERVIEW.series[2], period: `2026-${String(day).padStart(5, '0')}` }));
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json({ ...OVERVIEW, series }) });
    renderAdmin('/');
    await screen.findByText('300.000 ₫');
    const plot = screen.getByRole('img', { name: /Tài khoản mới/ });
    expect(plot.children).toHaveLength(366);
    expect(plot.querySelector('.px-px')).toBeNull();
  });
});

describe('Tài khoản', () => {
  const LIST = { items: [USER_ROW], page: 1, pageSize: 20, total: 1 };

  test('hiển thị dữ liệu đã che, có trạng thái; không có nút xóa tài khoản', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/users': json(LIST) });
    renderAdmin('/users');
    expect(await screen.findByRole('link', { name: 'Nguyễn An' })).toBeInTheDocument();
    const table = screen.getByRole('region', { name: 'Danh sách tài khoản' });
    expect(within(table).getByText('SV***01')).toBeInTheDocument();
    expect(within(table).getByText('ng***@example.edu.vn')).toBeInTheDocument();
    expect(within(table).getByText('Đang hoạt động')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /xóa/i })).not.toBeInTheDocument();
  });

  test('tìm kiếm và lọc gọi API phía server; đổi bộ lọc về trang 1', async () => {
    const api = mockApi({ ...LOGGED_IN, 'GET /api/admin/users': json({ ...LIST, total: 45 }) });
    renderAdmin('/users');
    await screen.findByRole('link', { name: 'Nguyễn An' });
    await userEvent.click(screen.getByRole('button', { name: 'Sau' }));
    await waitFor(() => expect(api.callsTo('GET', '/api/admin/users').at(-1).path).toContain('page=2'));
    await userEvent.type(screen.getByLabelText('Tìm kiếm'), 'SV001');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));
    await waitFor(() => expect(api.callsTo('GET', '/api/admin/users').at(-1).path).toContain('q=SV001'));
    expect(api.callsTo('GET', '/api/admin/users').at(-1).path).toContain('page=1');
    await userEvent.selectOptions(screen.getByLabelText('Trạng thái'), 'locked');
    await waitFor(() => expect(api.callsTo('GET', '/api/admin/users').at(-1).path).toContain('status=locked'));
  });

  test('rỗng và lỗi', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/users': json({ items: [], page: 1, pageSize: 20, total: 0 }) });
    const { unmount } = renderAdmin('/users');
    expect(await screen.findByText('Không có tài khoản phù hợp.')).toBeInTheDocument();
    unmount();
    mockApi({ ...LOGGED_IN, 'GET /api/admin/users': json({ error: 'Lỗi máy chủ.', code: 'server_error' }, 500) });
    renderAdmin('/users');
    expect(await screen.findByRole('alert')).toHaveTextContent('Lỗi máy chủ.');
  });

  test('hàng loạt: phải chọn, xác nhận và nhập lý do; báo tài khoản không xử lý được', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      'GET /api/admin/users': json(LIST),
      'POST /api/admin/users/bulk-status': json({ results: [{ id: USER_ROW.id, ok: false, code: 'self_action_forbidden', error: 'Không thể tự khóa.' }] }),
    });
    renderAdmin('/users');
    await screen.findByRole('link', { name: 'Nguyễn An' });
    expect(screen.queryByRole('button', { name: 'Khóa đã chọn' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Chọn Nguyễn An' }));
    await userEvent.click(screen.getByRole('button', { name: 'Khóa đã chọn' }));
    const dialog = await screen.findByRole('dialog', { name: 'Khóa các tài khoản đã chọn' });
    await userEvent.type(within(dialog).getByLabelText('Lý do'), 'Gian lận điểm');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Khóa tài khoản' }));
    expect(await screen.findByText(/thất bại 1: Không thể tự khóa/)).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', '/api/admin/users/bulk-status')[0].init.body)).toEqual({ ids: [USER_ROW.id], status: 'locked', reason: 'Gian lận điểm' });
  });
});

describe('Chi tiết tài khoản', () => {
  const route = `GET /api/admin/users/${USER_DETAIL.id}`;
  const open = () => renderAdmin(`/users/${USER_DETAIL.id}`);

  test('khóa tài khoản: có hộp thoại xác nhận, nêu hậu quả, cần lý do; lỗi hiện ngay trong hộp thoại', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      [route]: json(USER_DETAIL),
      [`PATCH /api/admin/users/${USER_DETAIL.id}/status`]: json({ error: 'Không thực hiện được.', code: 'last_admin' }, 409),
    });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Khóa tài khoản' }));
    const dialog = await screen.findByRole('dialog', { name: 'Khóa tài khoản' });
    expect(dialog).toHaveTextContent('đăng xuất khỏi mọi thiết bị');
    expect(within(dialog).getByLabelText('Lý do')).toBeRequired();
    await userEvent.type(within(dialog).getByLabelText('Lý do'), 'Vi phạm');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Khóa tài khoản' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Không thực hiện được.');
    expect(api.callsTo('PATCH', `/api/admin/users/${USER_DETAIL.id}/status`)).toHaveLength(1);
  });

  describe('tắt 2FA của sinh viên', () => {
    const resetRoute = `/api/admin/users/${USER_DETAIL.id}/student-mfa-reset`;
    const WITH_MFA = { ...USER_DETAIL, userMfaEnabled: true, hasPasskey: true };

    test('chưa bật: không có nút; trạng thái 2FA và passkey hiện đúng', async () => {
      mockApi({ ...LOGGED_IN, [route]: json(USER_DETAIL) });
      open();
      expect(await screen.findByText('Xác thực hai lớp')).toBeInTheDocument();
      expect(screen.getByText('Xác thực hai lớp').nextElementSibling).toHaveTextContent('Chưa bật');
      expect(screen.getByText('Passkey').nextElementSibling).toHaveTextContent('Chưa có');
      expect(screen.queryByRole('button', { name: 'Tắt xác thực hai lớp' })).not.toBeInTheDocument();
    });

    test('phải có lý do, xác thực lại rồi mới tắt; xong cập nhật trạng thái', async () => {
      let attempts = 0;
      const api = mockApi({
        ...LOGGED_IN,
        [route]: json(WITH_MFA),
        [`POST ${resetRoute}`]: () => ((attempts += 1) === 1 ? REAUTH_REQUIRED() : json({ ...WITH_MFA, userMfaEnabled: false })),
        'POST /api/admin/auth/reauth': json({ ok: true, reauthValidUntil: '2026-10-31T03:05:00.000Z' }),
      });
      open();
      await userEvent.click(await screen.findByRole('button', { name: 'Tắt xác thực hai lớp' }));
      const dialog = await screen.findByRole('dialog', { name: 'Tắt xác thực hai lớp' });
      await userEvent.click(within(dialog).getByRole('button', { name: 'Tắt xác thực hai lớp' }));
      expect(api.callsTo('POST', resetRoute)).toHaveLength(0);

      await userEvent.type(within(dialog).getByLabelText(/Lý do/), 'Mất điện thoại, đã đối chiếu thẻ sinh viên');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Tắt xác thực hai lớp' }));
      const reauth = await screen.findByRole('dialog', { name: /Xác thực lại/ });
      await userEvent.type(within(reauth).getByLabelText('Mật khẩu'), 'mat-khau');
      await userEvent.type(within(reauth).getByLabelText(/Mã/), '123456');
      await userEvent.click(within(reauth).getByRole('button', { name: /Xác nhận|Tiếp tục/ }));
      expect(await screen.findByText('Đã tắt xác thực hai lớp và đăng xuất tài khoản khỏi mọi thiết bị.')).toBeInTheDocument();
      expect(api.callsTo('POST', resetRoute)).toHaveLength(2);
      expect(JSON.parse(api.callsTo('POST', resetRoute)[1].init.body)).toEqual({ reason: 'Mất điện thoại, đã đối chiếu thẻ sinh viên' });
      expect(screen.getByText('Xác thực hai lớp').nextElementSibling).toHaveTextContent('Chưa bật');
    });
  });

  describe('gỡ ảnh đại diện', () => {
    const removeRoute = `/api/admin/users/${USER_DETAIL.id}/avatar-remove`;
    const WITH_AVATAR = { ...USER_DETAIL, avatarUrl: '/api/avatars/anh-vi-pham' };
    const image = () => screen.findByRole('img', { name: 'Ảnh đại diện của tài khoản' });
    const removeWithReason = async (reason) => {
      await userEvent.click(screen.getByRole('button', { name: 'Gỡ ảnh đại diện' }));
      const dialog = await screen.findByRole('dialog', { name: 'Gỡ ảnh đại diện' });
      await userEvent.type(within(dialog).getByLabelText('Lý do'), reason);
      await userEvent.click(within(dialog).getByRole('button', { name: 'Gỡ ảnh' }));
      return dialog;
    };

    test('admin xem được ảnh để đánh giá; hộp thoại nêu rõ hậu quả, cần lý do; chưa xác nhận thì chưa gọi API', async () => {
      const api = mockApi({ ...LOGGED_IN, [route]: json(WITH_AVATAR) });
      open();
      expect(await image()).toHaveAttribute('src', '/api/avatars/anh-vi-pham');
      await userEvent.click(screen.getByRole('button', { name: 'Gỡ ảnh đại diện' }));
      const dialog = await screen.findByRole('dialog', { name: 'Gỡ ảnh đại diện' });
      expect(dialog).toHaveTextContent('không còn hiện trên bảng xếp hạng');
      expect(dialog).toHaveTextContent('vẫn dùng bình thường');
      expect(within(dialog).getByLabelText('Lý do')).toBeRequired();
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(api.callsTo('POST', removeRoute)).toHaveLength(0);
      expect(await image()).toBeInTheDocument();
    });

    test('gỡ thành công: gửi lý do, ảnh biến mất ngay, có thông báo, không còn nút gỡ', async () => {
      const api = mockApi({ ...LOGGED_IN, [route]: json(WITH_AVATAR), [`POST ${removeRoute}`]: json({ ...USER_DETAIL, avatarUrl: null }) });
      open();
      await image();
      await removeWithReason('Ảnh phản cảm');
      expect(await screen.findByText('Đã gỡ ảnh đại diện.')).toBeInTheDocument();
      expect(JSON.parse(api.callsTo('POST', removeRoute)[0].init.body)).toEqual({ reason: 'Ảnh phản cảm' });
      expect(screen.getByTestId('avatar-initial')).toHaveTextContent('A');
      expect(screen.queryByRole('button', { name: 'Gỡ ảnh đại diện' })).not.toBeInTheDocument();
    });

    test('server đòi xác thực lại: xác thực xong tự gỡ; hủy xác thực thì ảnh còn nguyên', async () => {
      let attempts = 0;
      const api = mockApi({
        ...LOGGED_IN,
        [route]: json(WITH_AVATAR),
        [`POST ${removeRoute}`]: () => ((attempts += 1) === 1 ? REAUTH_REQUIRED() : json({ ...USER_DETAIL, avatarUrl: null })),
        'POST /api/admin/auth/reauth': json({ reauthValidUntil: '2026-10-31T03:10:00.000Z' }),
      });
      open();
      await image();
      await removeWithReason('Ảnh phản cảm');
      const reauth = await screen.findByRole('dialog', { name: 'Xác thực lại' });
      await userEvent.type(within(reauth).getByLabelText('Mật khẩu'), 'mat-khau');
      await userEvent.type(within(reauth).getByLabelText('Mã xác thực'), '123456');
      await userEvent.click(within(reauth).getByRole('button', { name: 'Xác nhận' }));
      expect(await screen.findByText('Đã gỡ ảnh đại diện.')).toBeInTheDocument();
      expect(api.callsTo('POST', removeRoute)).toHaveLength(2);
    });

    test('gỡ lỗi: hiện trong hộp thoại, ảnh còn nguyên', async () => {
      mockApi({ ...LOGGED_IN, [route]: json(WITH_AVATAR), [`POST ${removeRoute}`]: json({ error: 'Tài khoản này chưa có ảnh đại diện.', code: 'no_change' }, 409) });
      open();
      await image();
      const dialog = await removeWithReason('Ảnh phản cảm');
      expect(await within(dialog).findByRole('alert')).toHaveTextContent('chưa có ảnh đại diện');
      expect(screen.queryByText('Đã gỡ ảnh đại diện.')).not.toBeInTheDocument();
    });

    test('chưa có ảnh: hiện chữ cái đầu, nêu rõ, không có nút gỡ', async () => {
      mockApi({ ...LOGGED_IN, [route]: json({ ...USER_DETAIL, avatarUrl: null }) });
      open();
      expect(await screen.findByText('Chưa đặt ảnh đại diện.')).toBeInTheDocument();
      expect(screen.getByTestId('avatar-initial')).toHaveTextContent('A');
      expect(screen.queryByRole('button', { name: 'Gỡ ảnh đại diện' })).not.toBeInTheDocument();
    });
  });

  test('thành công: trạng thái đổi ngay, có thông báo kết quả; Escape đóng hộp thoại không gọi API', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      [route]: json(USER_DETAIL),
      [`PATCH /api/admin/users/${USER_DETAIL.id}/status`]: json({ ...USER_DETAIL, status: 'locked', lockedAt: '2026-10-31T01:00:00.000Z', lockReason: 'Vi phạm' }),
    });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Khóa tài khoản' }));
    await screen.findByRole('dialog', { name: 'Khóa tài khoản' });
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.callsTo('PATCH', '/api/admin/users')).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: 'Khóa tài khoản' }));
    const dialog = await screen.findByRole('dialog', { name: 'Khóa tài khoản' });
    await userEvent.type(within(dialog).getByLabelText('Lý do'), 'Vi phạm');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Khóa tài khoản' }));
    expect(await screen.findByText('Đã khóa tài khoản và thu hồi mọi phiên.')).toBeInTheDocument();
    expect(screen.getByText('Đang khóa')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mở khóa tài khoản' })).toBeInTheDocument();
  });

  test('cấp quyền: mã đăng ký hiện đúng một lần sau khi được server trả về', async () => {
    mockApi({
      ...LOGGED_IN,
      [route]: json(USER_DETAIL),
      [`PATCH /api/admin/users/${USER_DETAIL.id}/role`]: json({ user: { ...USER_DETAIL, role: 'admin' }, enrollCode: 'ABCD-EFGH-JKLM', enrollCodeExpiresAt: '2026-11-01T00:00:00.000Z' }),
    });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Cấp quyền quản trị' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cấp quyền quản trị' });
    await userEvent.type(within(dialog).getByLabelText('Lý do'), 'Phân công');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cấp quyền' }));
    expect(await screen.findByTestId('enroll-code')).toHaveTextContent('ABCD-EFGH-JKLM');
    await userEvent.click(screen.getByRole('button', { name: 'Đã ghi lại' }));
    await waitFor(() => expect(screen.queryByTestId('enroll-code')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Thu hồi quyền quản trị' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Đặt lại MFA' })).toBeInTheDocument();
  });

  test('đặt lại MFA của admin khác: cần xác nhận và lý do, mã đăng ký mới hiện một lần', async () => {
    const other = { ...USER_DETAIL, role: 'admin', mfaEnrolled: true };
    const resetRoute = `/api/admin/users/${other.id}/mfa-reset`;
    const api = mockApi({
      ...LOGGED_IN,
      [route]: json(other),
      [`POST ${resetRoute}`]: json({ enrollCode: 'MNPQ-RSTU-VWXY', enrollCodeExpiresAt: '2026-11-01T00:00:00.000Z' }),
    });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Đặt lại MFA' }));
    const dialog = await screen.findByRole('dialog', { name: 'Đặt lại MFA' });
    expect(api.callsTo('POST', resetRoute)).toHaveLength(0);
    await userEvent.type(within(dialog).getByLabelText('Lý do'), 'Mất điện thoại');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đặt lại MFA' }));
    expect(await screen.findByTestId('enroll-code')).toHaveTextContent('MNPQ-RSTU-VWXY');
    expect(JSON.parse(api.callsTo('POST', resetRoute)[0].init.body)).toEqual({ reason: 'Mất điện thoại' });
    await userEvent.click(screen.getByRole('button', { name: 'Đã ghi lại' }));
    await waitFor(() => expect(screen.queryByTestId('enroll-code')).not.toBeInTheDocument());
  });

  test('đổi mã sinh viên qua xác thực lại; dữ liệu đã bỏ che không còn sau khi đổi', async () => {
    let attempts = 0;
    const api = mockApi({
      ...LOGGED_IN,
      [route]: json(USER_DETAIL),
      [`PATCH /api/admin/users/${USER_DETAIL.id}/student-id`]: () => {
        attempts += 1;
        return attempts === 1 ? REAUTH_REQUIRED() : json({ ...USER_DETAIL, studentId: 'SV***99' });
      },
      'POST /api/admin/auth/reauth': json({ reauthValidUntil: '2026-10-31T03:10:00.000Z' }),
    });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Đổi mã sinh viên' }));
    const dialog = await screen.findByRole('dialog', { name: 'Đổi mã sinh viên' });
    await userEvent.type(within(dialog).getByLabelText('Mã sinh viên mới'), 'SV2023099');
    await userEvent.type(within(dialog).getByLabelText('Lý do'), 'Đã xem thẻ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đổi mã' }));
    const reauth = await screen.findByRole('dialog', { name: 'Xác thực lại' });
    await userEvent.type(within(reauth).getByLabelText('Mật khẩu'), 'mat-khau');
    await userEvent.type(within(reauth).getByLabelText('Mã xác thực'), '123456');
    await userEvent.click(within(reauth).getByRole('button', { name: 'Xác nhận' }));
    expect(await screen.findByText('SV***99')).toBeInTheDocument();
    expect(api.callsTo('PATCH', `/api/admin/users/${USER_DETAIL.id}/student-id`)).toHaveLength(2);
  });

  test('tài khoản của chính mình: không có nút khóa và đổi quyền', async () => {
    mockApi({ ...LOGGED_IN, [route]: json({ ...USER_DETAIL, id: 'admin-1', role: 'admin' }) });
    open();
    expect(await screen.findByText(/Đây là tài khoản của bạn/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Khóa tài khoản' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thu hồi quyền quản trị' })).not.toBeInTheDocument();
  });

  test('không tìm thấy: báo lỗi', async () => {
    mockApi({ ...LOGGED_IN, [route]: json({ error: 'Không tìm thấy tài khoản.', code: 'not_found' }, 404) });
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent('Không tìm thấy tài khoản.');
  });
});

describe('Câu chuyện', () => {
  const NEW_DRAFT = { ...STORY, id: 'aaaaaaaaaaaaaaaaaaaaaaaa', revision: 0, status: 'draft', origin: 'admin', slug: 'cau-chuyen-moi', title: 'Câu chuyện mới' };

  test('danh sách có trạng thái và nguồn gốc; lọc theo trạng thái', async () => {
    const api = mockApi({ ...LOGGED_IN, 'GET /api/admin/stories': json({ items: [STORY], page: 1, pageSize: 20, total: 1 }) });
    renderAdmin('/stories');
    expect(await screen.findByRole('link', { name: 'Rùa biển và nhựa' })).toBeInTheDocument();
    expect(screen.getByText('Dữ liệu ban đầu')).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Trạng thái'), 'draft');
    await waitFor(() => expect(api.callsTo('GET', '/api/admin/stories').at(-1).path).toContain('status=draft'));
  });

  test('tạo mới: slug tự sinh từ tiêu đề tiếng Việt; lưu nháp gọi đúng API; lỗi từng trường hiện đúng chỗ', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      'POST /api/admin/stories': json({ error: 'Dữ liệu chưa hợp lệ.', code: 'invalid_input', fields: { 'source.url': 'URL nguồn phải dùng https://.' } }, 400),
    });
    renderAdmin('/stories/new');
    await userEvent.type(await screen.findByLabelText('Tiêu đề'), 'Đại dương & Rùa biển');
    expect(screen.getByLabelText('Slug')).toHaveValue('dai-duong-rua-bien');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    const url = screen.getByLabelText('URL nguồn (HTTPS)');
    await waitFor(() => expect(url).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('URL nguồn phải dùng https://.')).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', '/api/admin/stories')[0].init.body).slug).toBe('dai-duong-rua-bien');
  });

  test('xem trước cập nhật theo nội dung đang gõ; liên kết nguồn không an toàn không hiển thị', async () => {
    mockApi(LOGGED_IN);
    renderAdmin('/stories/new');
    const preview = await screen.findByRole('complementary', { name: 'Xem trước' });
    await userEvent.type(screen.getByLabelText('Tiêu đề'), 'Tiêu đề thử');
    await userEvent.type(screen.getByLabelText('Thông điệp'), 'Thông điệp thử');
    expect(within(preview).getByRole('heading', { name: 'Tiêu đề thử' })).toBeInTheDocument();
    expect(within(preview).getByText('Thông điệp thử')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('URL nguồn (HTTPS)'), { target: { value: 'javascript:alert(1)' } });
    expect(within(preview).queryByRole('link')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('URL nguồn (HTTPS)'), { target: { value: 'https://doi.org/10.1/x' } });
    expect(within(preview).getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
  });

  // SEC-04: khu quản trị không tải tài nguyên bên thứ ba (CSP img-src chỉ còn cùng nguồn, API và data:); ảnh ngoài chỉ hiện dạng liên kết để mở tab mới
  test('SEC-04: xem trước không tải ảnh từ máy khác, chỉ hiện tên máy và liên kết mở ảnh', async () => {
    mockApi(LOGGED_IN);
    renderAdmin('/stories/new');
    const preview = await screen.findByRole('complementary', { name: 'Xem trước' });
    fireEvent.change(screen.getByLabelText('URL ảnh (HTTPS, tùy chọn)'), { target: { value: 'https://cdn.example/rua.jpg' } });
    await waitFor(() => expect(within(preview).getByText(/cdn\.example/)).toBeInTheDocument());
    expect(preview.querySelector('img')).toBeNull();
    const open = within(preview).getByRole('link', { name: /Mở ảnh/ });
    expect(open).toHaveAttribute('href', 'https://cdn.example/rua.jpg');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
  });

  test('sửa: gửi kèm revision, slug bị khóa; xung đột phiên bản hiện thông báo tải lại', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      [`GET /api/admin/stories/${STORY.id}`]: json(STORY),
      [`PUT /api/admin/stories/${STORY.id}`]: json({ error: 'Dữ liệu vừa được người khác cập nhật. Tải lại trang rồi thử lại.', code: 'version_conflict' }, 409),
    });
    renderAdmin(`/stories/${STORY.id}`);
    expect(await screen.findByLabelText('Slug')).toBeDisabled();
    expect(screen.getByLabelText('Tác giả (mỗi dòng một người)')).toHaveValue('Wilcox C\nHardesty BD');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thay đổi' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tải lại trang');
    const body = JSON.parse(api.callsTo('PUT', `/api/admin/stories/${STORY.id}`)[0].init.body);
    expect(body.revision).toBe(2);
    expect(body.source.authors).toEqual(['Wilcox C', 'Hardesty BD']);
    expect(body.source.year).toBe(2018);
  });

  test('xuất bản: lưu nội dung đang thấy trước, rồi mới xuất bản với revision mới', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      [`GET /api/admin/stories/${NEW_DRAFT.id}`]: json(NEW_DRAFT),
      [`PUT /api/admin/stories/${NEW_DRAFT.id}`]: json({ ...NEW_DRAFT, revision: 1 }),
      [`POST /api/admin/stories/${NEW_DRAFT.id}/publish`]: json({ ...NEW_DRAFT, revision: 2, status: 'published' }),
    });
    renderAdmin(`/stories/${NEW_DRAFT.id}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Xuất bản' }));
    expect(await screen.findByText('Đã xuất bản câu chuyện.')).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', `/api/admin/stories/${NEW_DRAFT.id}/publish`)[0].init.body)).toEqual({ revision: 1 });
    expect(screen.getByRole('button', { name: 'Gỡ câu chuyện' })).toBeInTheDocument();
  });

  test('gỡ có xác nhận; sau khi gỡ có thể xuất bản lại', async () => {
    mockApi({
      ...LOGGED_IN,
      [`GET /api/admin/stories/${STORY.id}`]: json(STORY),
      [`POST /api/admin/stories/${STORY.id}/unpublish`]: json({ ...STORY, revision: 3, status: 'archived' }),
    });
    renderAdmin(`/stories/${STORY.id}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Gỡ câu chuyện' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gỡ câu chuyện' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gỡ câu chuyện' }));
    expect(await screen.findByText('Đã gỡ câu chuyện.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Xuất bản' })).toBeInTheDocument();
  });
});

describe('Quay thưởng tri ân', () => {
  const route = `GET /api/admin/gacha/configs/${GACHA_DRAFT.id}`;
  const SECOND = { ...MEDIA, id: 'b'.repeat(24), name: 'Lá vàng', url: `/api/gacha/media/${'b'.repeat(24)}` };
  const LIBRARY = { 'GET /api/admin/gacha/media': json({ items: [MEDIA, SECOND] }) };
  const open = () => renderAdmin(`/gacha/${GACHA_DRAFT.id}`);
  const PUBLISHED = {
    ...GACHA_DRAFT,
    status: 'published',
    isCurrent: true,
    revision: 2,
    effectiveFrom: '2026-10-01T00:00:00.000Z',
    publishedByLabel: 'ad***@example.edu.vn',
    publishedAt: '2026-10-01T00:00:00.000Z',
    issued: [{ prizeId: 'la-xanh', count: 3, faceValueVnd: 0 }],
    spins: { total: 120, wins: 3, losses: 117 },
    usage: [{ prizeId: 'la-xanh', used: 7 }],
  };
  const LEGACY = {
    ...PUBLISHED,
    legacy: true,
    prizes: [{ prizeId: 'topup-10k', label: 'Mã nạp điện thoại', prizeType: 'phone_topup', legacy: true, carrier: 'Viettel', amountVnd: 10_000, probabilityPpm: 1_000_000, enabled: true, maxQuantity: null }],
    budgetVnd: 500_000,
    budgetUsedVnd: 30_000,
    issued: [{ prizeId: 'topup-10k', count: 3, faceValueVnd: 30_000 }],
  };

  test('danh sách phân biệt đang hiệu lực, nháp, hẹn giờ, đã kết thúc; có tổng xác suất trúng và lời nhắc quà thật', async () => {
    const items = [
      GACHA_DRAFT,
      { ...PUBLISHED, version: 2, id: '2'.repeat(24) },
      { ...PUBLISHED, version: 4, id: '4'.repeat(24), isCurrent: false, effectiveFrom: '2099-01-01T00:00:00.000Z' },
      { ...LEGACY, version: 1, id: '1'.repeat(24), isCurrent: false, effectiveTo: '2026-10-02T00:00:00.000Z' },
    ];
    mockApi({ ...LOGGED_IN, 'GET /api/admin/gacha/configs': json({ items, page: 1, pageSize: 20, total: 4, currentId: '2'.repeat(24) }) });
    renderAdmin('/gacha');
    expect(await screen.findByText('Đang hiệu lực')).toBeInTheDocument();
    expect(screen.getByText('Đã hẹn giờ')).toBeInTheDocument();
    expect(screen.getByText('Đã kết thúc')).toBeInTheDocument();
    expect(screen.getByText('(mã nạp demo, đã ngừng)')).toBeInTheDocument();
    expect(screen.getAllByText('0.1% (≈ 1 trên 1.000 lượt)').length).toBeGreaterThan(0);
    expect(screen.getByText(/Móc khóa là quà thật/)).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Mục quay thưởng tri ân' })).toBeInTheDocument();
  });

  test('tổng xác suất trúng và phần không trúng cập nhật khi gõ; "1 trên N" theo từng mẫu; không dính sai số số thực', async () => {
    mockApi({ ...LOGGED_IN, ...LIBRARY, [route]: json({ ...GACHA_DRAFT, prizes: [{ ...PRIZE, probabilityPpm: 100_000 }, { ...PRIZE, prizeId: 'b', probabilityPpm: 200_000 }] }) });
    open();
    expect(await screen.findByText(/Tổng xác suất trúng của các mẫu đang bật: 30% \(≈ 1 trên 3 lượt\)\. Không trúng: 70%/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Xác suất trúng mẫu 1'), { target: { value: '33.3333' } });
    fireEvent.change(screen.getByLabelText('Xác suất trúng mẫu 2'), { target: { value: '0.0001' } });
    expect(screen.getByText('≈ 1 trên 1.000.000 lượt')).toBeInTheDocument();
    expect(screen.getByText(/Tổng xác suất trúng của các mẫu đang bật: 33.3334%/)).toBeInTheDocument();
    expect(screen.getByText(/Không trúng: 66.6666%/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Xác suất trúng mẫu 2'), { target: { value: '70' } });
    expect(screen.getByText(/Vượt 100% nên chưa xuất bản được/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Bật mẫu 2' }));
    expect(screen.getByText(/các mẫu đang bật: 33.3333%/)).toBeInTheDocument();
  });

  test('chọn ảnh từ thư viện; lưu nháp gửi số nguyên phần triệu, số lượng, ảnh, hướng dẫn nhận quà; lỗi từng ô hiện đúng chỗ', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      ...LIBRARY,
      [route]: json(GACHA_DRAFT),
      [`PUT /api/admin/gacha/configs/${GACHA_DRAFT.id}`]: json({ error: 'Dữ liệu chưa hợp lệ.', code: 'invalid_input', fields: { 'prizes.0.maxQuantity': 'Nhập tổng số móc khóa của mẫu này (số nguyên dương).' } }, 400),
    });
    open();
    expect(await screen.findByText('Đã trúng: 4')).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'Ảnh Lá xanh' })).toHaveAttribute('src', MEDIA.url);
    await userEvent.selectOptions(screen.getByLabelText('Ảnh móc khóa mẫu 1'), 'Lá vàng');
    expect(screen.getByRole('img', { name: 'Ảnh Lá vàng' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Tên móc khóa mẫu 1'), { target: { value: 'Lá vàng' } });
    fireEvent.change(screen.getByLabelText('Xác suất trúng mẫu 1'), { target: { value: '8.3334' } });
    fireEvent.change(screen.getByLabelText('Tổng số lượng mẫu 1'), { target: { value: '50' } });
    fireEvent.change(screen.getByLabelText('Hướng dẫn nhận quà'), { target: { value: 'Quầy 2, thứ 2-6' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    expect(await screen.findByText('Nhập tổng số móc khóa của mẫu này (số nguyên dương).')).toBeInTheDocument();
    const body = JSON.parse(api.callsTo('PUT', `/api/admin/gacha/configs/${GACHA_DRAFT.id}`)[0].init.body);
    expect(body.prizes[0]).toEqual({ prizeId: 'la-xanh', label: 'Lá vàng', description: 'Móc khóa hình lá', imageId: SECOND.id, enabled: true, probabilityPpm: 83_334, maxQuantity: 50 });
    expect(body.claimInstructions).toBe('Quầy 2, thứ 2-6');
    expect(body).not.toHaveProperty('budgetVnd');
    expect(body.revision).toBe(0);
  });

  test('giá trị sai định dạng được gửi nguyên để server từ chối, không tự làm tròn', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      ...LIBRARY,
      [route]: json(GACHA_DRAFT),
      [`PUT /api/admin/gacha/configs/${GACHA_DRAFT.id}`]: json({ error: 'Dữ liệu chưa hợp lệ.', code: 'invalid_input', fields: {} }, 400),
    });
    open();
    fireEvent.change(await screen.findByLabelText('Tổng số lượng mẫu 1'), { target: { value: '10.5' } });
    fireEvent.change(screen.getByLabelText('Xác suất trúng mẫu 1'), { target: { value: '1.23456' } });
    expect(screen.getByText('Sai định dạng')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await screen.findByRole('alert');
    const body = JSON.parse(api.callsTo('PUT', `/api/admin/gacha/configs/${GACHA_DRAFT.id}`)[0].init.body);
    expect(body.prizes[0].maxQuantity).toBe('10.5');
    expect(body.prizes[0].probabilityPpm).toBe('1.23456');
  });

  test('bản nháp cũ còn giải mã nạp: báo trước, các dòng đó không được gửi khi lưu', async () => {
    const api = mockApi({ ...LOGGED_IN, ...LIBRARY, [route]: json({ ...GACHA_DRAFT, prizes: [...LEGACY.prizes, PRIZE] }), [`PUT /api/admin/gacha/configs/${GACHA_DRAFT.id}`]: json({ ...GACHA_DRAFT, revision: 1 }) });
    open();
    expect(await screen.findByText(/có 1 giải mã nạp điện thoại cũ/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await screen.findByText('Đã lưu bản nháp.');
    expect(JSON.parse(api.callsTo('PUT', `/api/admin/gacha/configs/${GACHA_DRAFT.id}`)[0].init.body).prizes.map((p) => p.prizeId)).toEqual(['la-xanh']);
  });

  test('thời điểm hiệu lực nhập theo giờ Việt Nam, gửi đúng mốc UTC', async () => {
    const api = mockApi({ ...LOGGED_IN, ...LIBRARY, [route]: json(GACHA_DRAFT), [`PUT /api/admin/gacha/configs/${GACHA_DRAFT.id}`]: json({ ...GACHA_DRAFT, revision: 1 }) });
    open();
    fireEvent.change(await screen.findByLabelText('Hiệu lực từ (giờ Việt Nam)'), { target: { value: '2026-11-01T08:30' } });
    await userEvent.click(screen.getByRole('button', { name: 'Lưu nháp' }));
    await screen.findByText('Đã lưu bản nháp.');
    expect(JSON.parse(api.callsTo('PUT', `/api/admin/gacha/configs/${GACHA_DRAFT.id}`)[0].init.body).effectiveFrom).toBe('2026-11-01T01:30:00.000Z');
  });

  test('xuất bản: xác nhận, lưu trước, xác thực lại rồi xuất bản; hiện danh mục chỉ đọc', async () => {
    let publishCalls = 0;
    const api = mockApi({
      ...LOGGED_IN,
      ...LIBRARY,
      [route]: (() => {
        let reads = 0;
        return () => {
          reads += 1;
          return json(reads === 1 ? GACHA_DRAFT : PUBLISHED);
        };
      })(),
      [`PUT /api/admin/gacha/configs/${GACHA_DRAFT.id}`]: json({ ...GACHA_DRAFT, revision: 1 }),
      [`POST /api/admin/gacha/configs/${GACHA_DRAFT.id}/publish`]: () => {
        publishCalls += 1;
        return publishCalls === 1 ? REAUTH_REQUIRED() : json(PUBLISHED);
      },
      'POST /api/admin/auth/reauth': json({ reauthValidUntil: '2026-10-31T03:10:00.000Z' }),
    });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Xuất bản' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xuất bản phiên bản 3' });
    expect(dialog).toHaveTextContent('không sửa được nữa');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xuất bản' }));
    const reauth = await screen.findByRole('dialog', { name: 'Xác thực lại' });
    await userEvent.type(within(reauth).getByLabelText('Mật khẩu'), 'mat-khau');
    await userEvent.type(within(reauth).getByLabelText('Mã xác thực'), '123456');
    await userEvent.click(within(reauth).getByRole('button', { name: 'Xác nhận' }));
    expect(await screen.findByText('Đã xuất bản phiên bản 3.')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Ngừng hiệu lực' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Xác suất trúng mẫu 1')).not.toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', `/api/admin/gacha/configs/${GACHA_DRAFT.id}/publish`)[0].init.body)).toEqual({ revision: 1 });
  });

  test('hộp thoại xác nhận không nằm trong <form>: form lồng nhau làm trình duyệt tự gửi và tải lại trang', async () => {
    const errors = vi.spyOn(console, 'error');
    mockApi({ ...LOGGED_IN, ...LIBRARY, [route]: json(GACHA_DRAFT) });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Xuất bản' }));
    const publish = await screen.findByRole('dialog', { name: 'Xuất bản phiên bản 3' });
    expect(publish.parentElement.closest('form')).toBeNull();
    await userEvent.click(within(publish).getByRole('button', { name: 'Hủy' }));
    await userEvent.click(screen.getByRole('button', { name: 'Hủy bản nháp' }));
    const discard = await screen.findByRole('dialog', { name: 'Hủy bản nháp' });
    expect(discard.parentElement.closest('form')).toBeNull();
    expect(errors.mock.calls.flat().join(' ')).not.toContain('validateDOMNesting');
  });

  test('xuất bản bị từ chối: lỗi hiện trên biểu mẫu (tổng xác suất, hướng dẫn nhận quà), bản nháp giữ nguyên', async () => {
    mockApi({
      ...LOGGED_IN,
      ...LIBRARY,
      [route]: json(GACHA_DRAFT),
      [`PUT /api/admin/gacha/configs/${GACHA_DRAFT.id}`]: json({ ...GACHA_DRAFT, revision: 1 }),
      [`POST /api/admin/gacha/configs/${GACHA_DRAFT.id}/publish`]: json(
        {
          error: 'Cấu hình chưa đủ điều kiện xuất bản.',
          code: 'invalid_input',
          fields: { probabilityTotal: 'Tổng xác suất trúng của các mẫu đang bật tối đa 100% (hiện tại 120%).', claimInstructions: 'Nhập hướng dẫn nhận quà: nơi nhận, thời gian, cần mang gì, hạn nhận.' },
        },
        400
      ),
    });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Xuất bản' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xuất bản phiên bản 3' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xuất bản' }));
    expect(await screen.findByText(/hiện tại 120%/)).toBeInTheDocument();
    expect(screen.getByText(/Nhập hướng dẫn nhận quà: nơi nhận/)).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('chưa đủ điều kiện');
    expect(screen.getByLabelText('Xác suất trúng mẫu 1')).toBeInTheDocument();
  });

  test('bản đã xuất bản chỉ đọc: ảnh, xác suất kèm "1 trên N", trúng ở phiên bản này, đã trúng / tổng, lượt quay, hướng dẫn nhận quà', async () => {
    mockApi({ ...LOGGED_IN, [route]: json(PUBLISHED) });
    open();
    const table = await screen.findByRole('region', { name: 'Mẫu móc khóa của phiên bản đã xuất bản' });
    const row = within(table).getAllByRole('row')[1];
    expect(within(row).getByRole('img', { name: 'Ảnh Lá xanh' })).toHaveAttribute('src', MEDIA.url);
    expect(row).toHaveTextContent('0.1%');
    expect(row).toHaveTextContent('≈ 1 trên 1.000 lượt');
    expect(row).toHaveTextContent('7 / 100');
    expect(screen.getByText('Lượt quay ở phiên bản này').parentElement).toHaveTextContent('120 lượt: 3 trúng, 117 không trúng');
    expect(screen.getByText('Hướng dẫn nhận quà').parentElement).toHaveTextContent('Nhận tại quầy căn tin tầng 1.');
    expect(screen.getByText('Người xuất bản').parentElement).toHaveTextContent('ad***@example.edu.vn');
    expect(screen.queryByRole('button', { name: 'Lưu nháp' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tạo bản nháp từ phiên bản này' })).toBeInTheDocument();
  });

  test('phiên bản mã nạp cũ vẫn xem được: nhà mạng, mệnh giá, ngân sách đã dùng', async () => {
    mockApi({ ...LOGGED_IN, [route]: json(LEGACY) });
    open();
    expect(await screen.findByText(/Phiên bản mã nạp điện thoại demo trước khi đổi sang móc khóa/)).toBeInTheDocument();
    expect(screen.getByText('30.000 ₫ / 500.000 ₫ đã dùng')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Danh mục giải mã nạp cũ' })).toHaveTextContent('Viettel');
  });

  test('tạo bản nháp từ phiên bản đã xuất bản: gửi đúng phiên bản gốc; lỗi từ server hiện thông báo', async () => {
    const DRAFT_ID = 'fedcbafedcbafedcbafedcba';
    let attempts = 0;
    const api = mockApi({
      ...LOGGED_IN,
      ...LIBRARY,
      [route]: json(PUBLISHED),
      'POST /api/admin/gacha/configs': () => {
        attempts += 1;
        return attempts === 1 ? json({ error: 'Không tìm thấy phiên bản.', code: 'not_found' }, 404) : json({ ...GACHA_DRAFT, id: DRAFT_ID });
      },
      [`GET /api/admin/gacha/configs/${DRAFT_ID}`]: json({ ...GACHA_DRAFT, id: DRAFT_ID }),
    });
    open();
    const clone = await screen.findByRole('button', { name: 'Tạo bản nháp từ phiên bản này' });
    await userEvent.click(clone);
    expect(await screen.findByText('Không tìm thấy phiên bản.')).toBeInTheDocument();
    await userEvent.click(clone);
    expect(await screen.findByRole('button', { name: 'Lưu nháp' })).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', '/api/admin/gacha/configs')[1].init.body)).toEqual({ basedOnId: PUBLISHED.id });
  });

  test('thêm và xóa mẫu; hủy bản nháp có xác nhận', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      ...LIBRARY,
      [route]: json(GACHA_DRAFT),
      'GET /api/admin/gacha/configs': json({ items: [], page: 1, pageSize: 20, total: 0, currentId: null }),
      [`POST /api/admin/gacha/configs/${GACHA_DRAFT.id}/discard`]: json({ ok: true }),
    });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm mẫu móc khóa' }));
    expect(screen.getByLabelText('Tên móc khóa mẫu 2')).toHaveValue('');
    expect(screen.getByLabelText('Ảnh móc khóa mẫu 2')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Xóa mẫu 2' }));
    expect(screen.queryByLabelText('Tên móc khóa mẫu 2')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Hủy bản nháp' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hủy bản nháp' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hủy bản nháp' }));
    expect(await screen.findByText(/Chưa có phiên bản nào/)).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/admin/gacha/configs/${GACHA_DRAFT.id}/discard`)).toHaveLength(1);
  });

  test('ngừng hiệu lực có xác nhận, nêu rõ hậu quả', async () => {
    const api = mockApi({ ...LOGGED_IN, [route]: json(PUBLISHED), [`POST /api/admin/gacha/configs/${GACHA_DRAFT.id}/end`]: json({ ...PUBLISHED, isCurrent: false }) });
    open();
    await userEvent.click(await screen.findByRole('button', { name: 'Ngừng hiệu lực' }));
    const dialog = await screen.findByRole('dialog', { name: 'Ngừng phiên bản 3' });
    expect(dialog).toHaveTextContent('giữ nguyên lượt quay');
    expect(dialog).toHaveTextContent('Móc khóa đã trúng vẫn được trao');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Ngừng hiệu lực' }));
    expect(await screen.findByText('Đã ngừng hiệu lực.')).toBeInTheDocument();
    expect(api.callsTo('POST', `/api/admin/gacha/configs/${GACHA_DRAFT.id}/end`)).toHaveLength(1);
  });
});

describe('Ảnh & sticker', () => {
  const STICKER = { ...MEDIA, id: 'c'.repeat(24), kind: 'win', name: 'Pháo hoa', animated: true, url: `/api/gacha/media/${'c'.repeat(24)}` };

  test('tải ảnh: gửi loại, tên, tệp; ảnh mới hiện đầu danh sách; lỗi từ server hiện đúng ô', async () => {
    let uploads = 0;
    const api = mockApi({
      ...LOGGED_IN,
      'GET /api/admin/gacha/media': json({ items: [MEDIA] }),
      'POST /api/admin/gacha/media': () => {
        uploads += 1;
        return uploads === 1 ? json({ error: 'Dữ liệu chưa hợp lệ.', code: 'invalid_input', fields: { name: 'Tên ảnh cần từ 1 đến 80 ký tự.' } }, 400) : json(STICKER, 201);
      },
    });
    renderAdmin('/gacha/media');
    expect(await screen.findByRole('img', { name: 'Lá xanh' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('Loại ảnh'), 'win');
    await userEvent.type(screen.getByLabelText('Tên sticker'), 'Pháo hoa');
    const file = new File([new Uint8Array([71, 73, 70, 56, 57, 97])], 'phao-hoa.gif', { type: 'image/gif' });
    await userEvent.upload(screen.getByLabelText('Tệp ảnh'), file);
    await userEvent.click(screen.getByRole('button', { name: 'Tải lên' }));
    expect(await screen.findByText('Tên ảnh cần từ 1 đến 80 ký tự.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Tải lên' }));
    expect(await screen.findByText('Đã tải lên «Pháo hoa».')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Thư viện ảnh quay thưởng' });
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Pháo hoa');
    expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('Ảnh động');
    const form = api.callsTo('POST', '/api/admin/gacha/media')[1].init.body;
    expect([form.get('kind'), form.get('name'), form.get('image').name]).toEqual(['win', 'Pháo hoa', 'phao-hoa.gif']);
  });

  test('chưa chọn tệp hoặc tệp quá 8 MB: báo ngay, không gửi', async () => {
    const api = mockApi({ ...LOGGED_IN, 'GET /api/admin/gacha/media': json({ items: [] }) });
    renderAdmin('/gacha/media');
    await userEvent.type(await screen.findByLabelText(/Tên móc khóa/), 'Lá xanh');
    await userEvent.click(screen.getByRole('button', { name: 'Tải lên' }));
    expect(await screen.findByText('Chọn tệp ảnh.')).toBeInTheDocument();
    const big = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'to.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Tệp ảnh'), big);
    await userEvent.click(screen.getByRole('button', { name: 'Tải lên' }));
    expect(await screen.findByText('Ảnh quá lớn (tối đa 8 MB).')).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/admin/gacha/media')).toHaveLength(0);
  });

  test('đổi tên, tắt sticker; xóa có xác nhận và báo lỗi khi ảnh đang được dùng', async () => {
    let deletes = 0;
    const api = mockApi({
      ...LOGGED_IN,
      'GET /api/admin/gacha/media': json({ items: [MEDIA, STICKER] }),
      [`PATCH /api/admin/gacha/media/${STICKER.id}`]: ({ init }) => json({ ...STICKER, ...JSON.parse(init.body) }),
      [`DELETE /api/admin/gacha/media/${MEDIA.id}`]: () => {
        deletes += 1;
        return deletes === 1 ? json({ error: 'Ảnh đang được dùng ở phiên bản 3 đang hoặc sắp hiệu lực.', code: 'media_in_use' }, 409) : json({ ok: true });
      },
    });
    renderAdmin('/gacha/media');
    await userEvent.click(await screen.findByRole('button', { name: 'Tắt Pháo hoa' }));
    expect(await screen.findByText('Đã tắt sticker.')).toBeInTheDocument();
    expect(screen.getByText('Đang tắt')).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('PATCH', `/api/admin/gacha/media/${STICKER.id}`)[0].init.body)).toEqual({ active: false });
    expect(screen.queryByRole('button', { name: 'Tắt Lá xanh' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Đổi tên Pháo hoa' }));
    const input = screen.getByLabelText('Tên mới cho Pháo hoa');
    await userEvent.clear(input);
    await userEvent.type(input, 'Pháo hoa vàng');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByText('Pháo hoa vàng')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Xóa Lá xanh' }));
    let dialog = await screen.findByRole('dialog', { name: 'Xóa «Lá xanh»' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xóa ảnh' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('đang được dùng');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xóa ảnh' }));
    expect(await screen.findByText('Đã xóa ảnh.')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Lá xanh' })).not.toBeInTheDocument();
  });
});

describe('Trao quà', () => {
  const ROW = {
    id: 'd'.repeat(24),
    claimCode: 'TA-23456-789AB',
    prizeLabel: 'Lá xanh',
    imageUrl: MEDIA.url,
    configVersion: 3,
    deliveryStatus: 'pending',
    deliveredAt: null,
    deliveredByLabel: '',
    deliveryNote: '',
    createdAt: '2026-11-01T03:00:00.000Z',
    winner: { id: USER_ROW.id, name: 'Nguyễn An', studentId: 'SV***01' },
  };

  test('mặc định lọc chờ trao; tìm theo mã gửi đúng nguyên mã; người trúng đã che, liên kết tới tài khoản', async () => {
    const api = mockApi({ ...LOGGED_IN, 'GET /api/admin/gacha/rewards': json({ items: [ROW], page: 1, pageSize: 20, total: 1, pending: 1 }) });
    renderAdmin('/gacha/rewards');
    const table = await screen.findByRole('region', { name: 'Lượt trúng móc khóa' });
    expect(table).toHaveTextContent('TA-23456-789AB');
    expect(within(table).getByRole('link', { name: 'Nguyễn An · SV***01' })).toHaveAttribute('href', `/users/${USER_ROW.id}`);
    expect(screen.getByText('Đang chờ trao: 1 móc khóa.')).toBeInTheDocument();
    expect(api.callsTo('GET', '/api/admin/gacha/rewards')[0].path).toContain('status=pending');
    await userEvent.type(screen.getByLabelText('Mã nhận quà (đúng nguyên mã)'), ' ta-23456-789ab ');
    await userEvent.click(screen.getByRole('button', { name: 'Tìm' }));
    await waitFor(() => expect(api.callsTo('GET', '/api/admin/gacha/rewards').at(-1).path).toContain('q=ta-23456-789ab'));
  });

  test('xác nhận đã trao kèm ghi chú; hoàn tác cần lý do', async () => {
    let state = ROW;
    const api = mockApi({
      ...LOGGED_IN,
      'GET /api/admin/gacha/rewards': () => json({ items: [state], page: 1, pageSize: 20, total: 1, pending: state.deliveryStatus === 'pending' ? 1 : 0 }),
      [`POST /api/admin/gacha/rewards/${ROW.id}/deliver`]: () => {
        state = { ...ROW, deliveryStatus: 'delivered', deliveredAt: '2026-11-02T03:00:00.000Z', deliveredByLabel: 'ad***@example.edu.vn', deliveryNote: 'Đã xem thẻ SV' };
        return json(state);
      },
      [`POST /api/admin/gacha/rewards/${ROW.id}/undeliver`]: () => {
        state = ROW;
        return json(state);
      },
    });
    renderAdmin('/gacha/rewards');
    await userEvent.click(await screen.findByRole('button', { name: 'Xác nhận đã trao TA-23456-789AB' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xác nhận đã trao TA-23456-789AB' });
    expect(dialog).toHaveTextContent('Nguyễn An');
    await userEvent.type(within(dialog).getByLabelText('Ghi chú (không bắt buộc)'), 'Đã xem thẻ SV');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đã trao' }));
    expect(await screen.findByText('Đã xác nhận trao quà.')).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', `/api/admin/gacha/rewards/${ROW.id}/deliver`)[0].init.body)).toEqual({ note: 'Đã xem thẻ SV' });

    await userEvent.selectOptions(screen.getByLabelText('Trạng thái'), '');
    await userEvent.click(await screen.findByRole('button', { name: 'Hoàn tác trao quà TA-23456-789AB' }));
    const undo = await screen.findByRole('dialog', { name: 'Hoàn tác trao quà TA-23456-789AB' });
    await userEvent.type(within(undo).getByLabelText('Lý do hoàn tác'), 'Bấm nhầm');
    await userEvent.click(within(undo).getByRole('button', { name: 'Hoàn tác' }));
    expect(await screen.findByText('Đã chuyển về chờ trao.')).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', `/api/admin/gacha/rewards/${ROW.id}/undeliver`)[0].init.body)).toEqual({ reason: 'Bấm nhầm' });
  });
});

describe('Thiết lập website', () => {
  const SETTINGS = {
    headerTagline: 'Khẩu hiệu',
    heroTitle: 'Tiêu đề',
    seoDescription: 'Mô tả',
    announcementEnabled: false,
    announcementText: '',
    supportContact: '',
    revision: 4,
    updatedAt: null,
    updatedByLabel: '',
  };

  test('chỉ có các ô nội dung công khai; không có ô nào cho bí mật hay hạ tầng', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/site-settings': json(SETTINGS) });
    renderAdmin('/settings');
    await screen.findByLabelText('Khẩu hiệu đầu trang');
    const labels = screen.getAllByRole('textbox').map((input) => input.labels[0].textContent);
    expect(labels).toEqual(['Khẩu hiệu đầu trang', 'Tiêu đề trang chủ', 'Mô tả cho công cụ tìm kiếm', 'Thông tin liên hệ hỗ trợ', 'Nội dung thông báo']);
    expect(document.body).not.toHaveTextContent(/MONGODB|OAUTH_|SECRET|SMTP/i);
  });

  test('lưu chỉ gửi đúng các khóa cho phép kèm revision; lỗi từng trường hiện đúng chỗ', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      'GET /api/admin/site-settings': json(SETTINGS),
      'PUT /api/admin/site-settings': json({ error: 'Dữ liệu chưa hợp lệ.', code: 'invalid_input', fields: { announcementText: 'Cần nhập nội dung thông báo khi bật.' } }, 400),
    });
    renderAdmin('/settings');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Hiển thị thông báo trên mọi trang' }));
    await userEvent.click(screen.getByRole('button', { name: 'Lưu thiết lập' }));
    expect(await screen.findByText('Cần nhập nội dung thông báo khi bật.')).toBeInTheDocument();
    const body = JSON.parse(api.callsTo('PUT', '/api/admin/site-settings')[0].init.body);
    expect(Object.keys(body).sort()).toEqual(['announcementEnabled', 'announcementText', 'headerTagline', 'heroTitle', 'revision', 'seoDescription', 'supportContact']);
    expect(body.revision).toBe(4);
  });

  test('lưu thành công: báo kết quả và dùng revision mới', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/site-settings': json(SETTINGS), 'PUT /api/admin/site-settings': json({ ...SETTINGS, revision: 5, updatedAt: '2026-10-31T01:00:00.000Z', updatedByLabel: 'ad***@x.vn' }) });
    renderAdmin('/settings');
    await userEvent.click(await screen.findByRole('button', { name: 'Lưu thiết lập' }));
    expect(await screen.findByText(/Đã lưu thiết lập/)).toBeInTheDocument();
    expect(screen.getByText(/Sửa lần cuối .* bởi ad\*\*\*@x\.vn/)).toBeInTheDocument();
  });
});

describe('Nhật ký kiểm toán', () => {
  const ENTRY = {
    id: 'log-1',
    at: '2026-10-31T01:00:00.000Z',
    action: 'user.status_change',
    result: 'denied',
    reason: 'self_action_forbidden',
    actorType: 'admin',
    actorLabel: 'ad***@x.vn',
    targetType: 'user',
    targetId: 'u1',
    targetLabel: 'ng***@x.vn',
    meta: { status: 'locked', reason: 'Vi phạm' },
    ip: '127.0.0.1',
  };

  test('hiện ai, làm gì, đối tượng nào, khi nào, kết quả; không có thao tác sửa hay xóa', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/audit-logs': json({ items: [ENTRY], page: 1, pageSize: 20, total: 1, actions: ['user.status_change', 'hanh.dong.moi'] }) });
    renderAdmin('/audit');
    const table = await screen.findByRole('region', { name: 'Nhật ký kiểm toán' });
    const row = within(table).getAllByRole('row')[1];
    expect(row).toHaveTextContent('Đổi trạng thái tài khoản');
    expect(row).toHaveTextContent('ad***@x.vn');
    expect(row).toHaveTextContent('ng***@x.vn');
    expect(row).toHaveTextContent('Bị từ chối');
    expect(row).toHaveTextContent('self_action_forbidden');
    expect(within(table).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'hanh.dong.moi' })).toBeInTheDocument();
  });

  test('lọc theo thao tác, kết quả, ngày gọi API phía server', async () => {
    const api = mockApi({ ...LOGGED_IN, 'GET /api/admin/audit-logs': json({ items: [ENTRY], page: 1, pageSize: 20, total: 1, actions: ['user.status_change'] }) });
    renderAdmin('/audit');
    await screen.findByRole('region', { name: 'Nhật ký kiểm toán' });
    await userEvent.selectOptions(screen.getByLabelText('Thao tác'), 'user.status_change');
    await userEvent.selectOptions(screen.getByLabelText('Kết quả'), 'denied');
    fireEvent.change(screen.getByLabelText('Từ ngày'), { target: { value: '2026-10-01' } });
    await waitFor(() => {
      const { path } = api.callsTo('GET', '/api/admin/audit-logs').at(-1);
      expect(path).toContain('action=user.status_change');
      expect(path).toContain('result=denied');
      expect(path).toContain('from=2026-10-01');
    });
  });
});

describe('khung quản trị', () => {
  test('điều hướng đủ 6 mục, có liên kết bỏ qua điều hướng, focus chuyển vào nội dung khi đổi trang', async () => {
    mockApi({ ...LOGGED_IN, 'GET /api/admin/overview': json(OVERVIEW), 'GET /api/admin/users': json({ items: [], page: 1, pageSize: 20, total: 0 }) });
    renderAdmin('/');
    const nav = await screen.findByRole('navigation', { name: 'Khu quản trị' });
    expect(within(nav).getAllByRole('link').map((link) => link.textContent)).toEqual(['Tổng quan', 'Tài khoản', 'Câu chuyện', 'Quay thưởng tri ân', 'Thiết lập website', 'Nhật ký kiểm toán']);
    expect(screen.getByRole('link', { name: 'Bỏ qua điều hướng' })).toHaveAttribute('href', '#admin-main');
    await userEvent.click(within(nav).getByRole('link', { name: 'Tài khoản' }));
    await screen.findByRole('heading', { name: 'Tài khoản' });
    expect(document.activeElement).toBe(screen.getByRole('main'));
  });
});
