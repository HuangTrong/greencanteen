// Trang Cá nhân: yêu cầu gửi tới trang qua URL (đặt lại mật khẩu, kết quả OAuth, QR), hồ sơ – huy hiệu – lịch sử –
// quay thưởng tri ân, đăng xuất. Mỗi tình huống kiểm tra cả trạng thái đã / chưa đăng nhập (bảng quyết định).
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import { PROVIDERS, SECURITY, USER, deferred, json, mockApi, renderApp } from '../helpers';

const TOKEN = 'T'.repeat(43);
const HISTORY = [
  { _id: 'h1', createdAt: '2026-10-20T03:15:00.000Z', pointsEarned: 10, aiReason: 'Bình inox', category: 'reusable_bottle', categoryLabel: 'Bình nước cá nhân có thể tái sử dụng', confidence: 0.95, verification: 'ai' },
  { _id: 'h2', createdAt: '2026-10-19T03:15:00.000Z', pointsEarned: 10, aiReason: '', category: 'reusable_cup', categoryLabel: 'Ly/cốc cá nhân có thể tái sử dụng', confidence: 0.99, verification: 'simulated' },
];
const REWARDS = [
  { id: 'r1', type: 'keychain', label: 'Lá xanh', imageUrl: '/api/gacha/media/abc', claimCode: 'TA-AAAAA-BBBBB', deliveryStatus: 'pending', deliveredAt: null, claimInstructions: 'Nhận ở quầy căn tin', createdAt: '2026-10-20T03:16:00.000Z' },
];

const loggedOut = (extra = {}) => ({
  'GET /api/auth/me': json({ error: 'Bạn cần đăng nhập để tiếp tục.', code: 'auth_required' }, 401),
  'GET /api/auth/providers': json(PROVIDERS),
  ...extra,
});
const loggedIn = (extra = {}, user = {}) => ({
  'GET /api/auth/me': json({ user: { ...USER, ...user } }),
  'GET /api/auth/providers': json(PROVIDERS),
  'GET /api/checkin/history': json({ history: HISTORY }),
  'GET /api/gacha/results': json({ pendingGachaSpins: 1, stats: { spins: 3, wins: 1 }, rewards: REWARDS }),
  'GET /api/auth/security': json(SECURITY),
  ...extra,
});
const location = () => screen.getByTestId('location').textContent;

describe('quay về từ Google/Facebook với tài khoản đã bật 2FA', () => {
  test('mở bước hai, xóa tham số khỏi URL; nhập đúng mã mới có phiên', async () => {
    mockApi(
      loggedOut({
        'POST /api/auth/mfa/verify': () => {
          mockApi(loggedIn());
          return json({ user: USER });
        },
      })
    );
    renderApp('/profile?auth=mfa_required&provider=google');
    const dialog = await screen.findByRole('dialog', { name: 'Xác thực hai lớp' });
    await waitFor(() => expect(location()).toBe('/profile'));
    await userEvent.type(within(dialog).getByLabelText('Mã xác thực *'), '123456');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận' }));
    expect(await within(dialog).findByText('Đăng nhập thành công')).toBeInTheDocument();
  });
});

describe('chưa đăng nhập', () => {
  test('hiển thị lời mời; nút mở popup đăng nhập', async () => {
    mockApi(loggedOut());
    renderApp('/profile');
    expect(await screen.findByText('Chưa có hồ sơ cá nhân')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập / Đăng ký' }));
    expect(screen.getByRole('dialog', { name: 'Đăng nhập / Đăng ký' })).toBeInTheDocument();
  });

  test('nút "Đăng nhập" từ trang khác (state.openAuth) mở popup ngay', async () => {
    mockApi(loggedOut({ 'GET /api/stats/school': json({ totalCheckIns: 0, plasticSavedGrams: 0, treesProtected: 0 }) }));
    renderApp('/');
    await userEvent.click(await screen.findByRole('link', { name: 'Đăng nhập / Đăng ký' }));
    expect(await screen.findByRole('dialog', { name: 'Đăng nhập / Đăng ký' })).toBeInTheDocument();
  });
});

describe('yêu cầu gửi tới trang qua URL', () => {
  test('liên kết xác minh email (#verify=…) mở popup kích hoạt và xóa token khỏi thanh địa chỉ', async () => {
    const api = mockApi(loggedOut({ 'POST /api/auth/email/verify': json({ user: USER, claimed: false }, 201) }));
    renderApp(`/profile#verify=${TOKEN}`);
    const dialog = await screen.findByRole('dialog', { name: 'Kích hoạt tài khoản' });
    await waitFor(() => expect(location()).toBe('/profile'));
    await userEvent.type(within(dialog).getByLabelText('Mật khẩu đã đặt khi đăng ký *'), 'mat-khau-an-toan');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Kích hoạt tài khoản' }));
    expect(await within(dialog).findByText('Tạo tài khoản thành công')).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', '/api/auth/email/verify')[0].init.body)).toEqual({ token: TOKEN, password: 'mat-khau-an-toan' });
    expect(await screen.findByText('MSSV SV001')).toBeInTheDocument();
  });

  test('liên kết đặt lại mật khẩu (#reset=…) mở popup đặt mật khẩu và xóa token khỏi thanh địa chỉ', async () => {
    const api = mockApi(loggedOut({ 'POST /api/auth/password/reset': json({ user: USER }) }));
    renderApp(`/profile#reset=${TOKEN}`);
    const dialog = await screen.findByRole('dialog', { name: 'Đặt mật khẩu mới' });
    await waitFor(() => expect(location()).toBe('/profile'));
    await userEvent.type(within(dialog).getByLabelText('Mật khẩu mới (ít nhất 8 ký tự) *'), 'mat-khau-moi-123');
    await userEvent.type(within(dialog).getByLabelText('Nhập lại mật khẩu mới *'), 'mat-khau-moi-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(await within(dialog).findByText('Đã đặt mật khẩu mới')).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', '/api/auth/password/reset')[0].init.body)).toEqual({ token: TOKEN, password: 'mat-khau-moi-123' });
    expect(await screen.findByText('MSSV SV001')).toBeInTheDocument();
  });

  test('lỗi OAuth: chưa đăng nhập → báo trong popup; đã đăng nhập → banner; URL được dọn', async () => {
    mockApi(loggedOut());
    const { unmount } = renderApp('/profile?auth_error=provider_not_configured&provider=google');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Đăng nhập bằng Google chưa được cấu hình trên máy chủ.');
    await waitFor(() => expect(location()).toBe('/profile'));
    unmount();

    mockApi(loggedIn());
    renderApp('/profile?auth_error=provider_already_linked&provider=facebook');
    expect(await screen.findByText('Tài khoản Facebook này đã liên kết với một tài khoản GreenCanteen khác.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('?auth=success không được tin khi server không có phiên (ai cũng tự gõ được URL)', async () => {
    mockApi(loggedOut());
    const { unmount } = renderApp('/profile?auth=success&provider=google');
    expect(await within(await screen.findByRole('dialog')).findByRole('alert')).toHaveTextContent('Không thể đăng nhập bằng Google. Vui lòng thử lại.');
    unmount();

    mockApi(loggedIn());
    renderApp('/profile?auth=linked&provider=google');
    const banner = await screen.findByText('Đã liên kết Google với tài khoản của bạn.');
    await userEvent.click(screen.getByRole('button', { name: 'Ẩn thông báo' }));
    expect(banner).not.toBeInTheDocument();
  });

  test('?auth=complete_signup mở bước hoàn tất đăng ký sau Google/Facebook', async () => {
    mockApi(loggedOut({ 'GET /api/auth/signup/pending': json({ provider: 'google', name: 'Bạn Google', email: 'b@gmail.com' }) }));
    renderApp('/profile?auth=complete_signup&provider=google');
    const dialog = await screen.findByRole('dialog', { name: 'Hoàn tất đăng ký' });
    expect(await within(dialog).findByText(/Đã xác minh tài khoản Google \(b@gmail\.com\)/)).toBeInTheDocument();
    expect(within(dialog).getByLabelText('Họ và tên *')).toHaveValue('Bạn Google');
  });

  test('?qr=… : chưa đăng nhập → nhắc đăng nhập trước; đã đăng nhập → hộp xác nhận thiết bị', async () => {
    mockApi(loggedOut());
    const { unmount } = renderApp('/profile?qr=CHALLENGE_ID_1234567890');
    expect(await within(await screen.findByRole('dialog')).findByText(/Có yêu cầu đăng nhập bằng mã QR/)).toBeInTheDocument();
    unmount();

    mockApi(
      loggedIn({
        'GET /api/auth/qr/challenge/CHALLENGE_ID_1234567890': json({ device: 'Chrome trên Windows', createdAt: '2026-10-28T03:00:00.000Z' }),
        'POST /api/auth/qr/challenge/CHALLENGE_ID_1234567890/approve': json({ ok: true }),
      })
    );
    renderApp('/profile?qr=CHALLENGE_ID_1234567890');
    const dialog = await screen.findByRole('dialog', { name: 'Xác nhận đăng nhập bằng mã QR' });
    expect(await within(dialog).findByText('Chrome trên Windows')).toBeInTheDocument();
    expect(within(dialog).getByText('Nguyễn An (SV001)')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Mã đối chiếu trên thiết bị kia'), '1234');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đăng nhập' }));
    expect(await within(dialog).findByText(/Đã xác nhận/)).toBeInTheDocument();
  });
});

describe('hồ sơ đã đăng nhập', () => {
  test('số liệu, huy hiệu (kể cả mã lạ), lịch sử có nhãn mô phỏng, quay thưởng tri ân', async () => {
    mockApi(loggedIn({}, { badges: ['first_sip', 'huy_hieu_moi'] }));
    renderApp('/profile');
    expect(await screen.findByText('MSSV SV001')).toBeInTheDocument();
    expect(screen.getByText('36g')).toBeInTheDocument();
    expect(screen.getByText('🌱 Ngụm đầu tiên xanh')).toBeInTheDocument();
    expect(screen.getByText('🏅 huy_hieu_moi')).toBeInTheDocument();
    const items = await screen.findAllByText('+10 điểm');
    expect(items).toHaveLength(2);
    expect(screen.getByText(/Bình nước cá nhân có thể tái sử dụng · 95%/)).toBeInTheDocument();
    expect(screen.getByText('Mô phỏng')).toBeInTheDocument();
    expect(screen.getByText('Check-in hợp lệ')).toBeInTheDocument();
    expect(await screen.findByText('TA-AAAAA-BBBBB')).toBeInTheDocument();
    expect(screen.getByText('Đã quay 3 lượt · trúng 1 móc khóa')).toBeInTheDocument();
    expect(screen.getByText('Lượt quay đang có:').parentElement).toHaveTextContent('Lượt quay đang có: 1');
  });

  test('lịch sử rỗng / lỗi tải → "Thử lại" tải lại', async () => {
    let attempt = 0;
    mockApi(
      loggedIn({
        'GET /api/checkin/history': () => ((attempt += 1) === 1 ? json({ error: 'Lỗi máy chủ.', code: 'server_error' }, 500) : json({ history: [] })),
        'GET /api/gacha/results': json({ pendingGachaSpins: 0, stats: { spins: 0, wins: 0 }, rewards: [] }),
      })
    );
    renderApp('/profile');
    const alert = await screen.findByText('Lỗi máy chủ.');
    await userEvent.click(within(alert.parentElement).getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Chưa có lịch sử. Hãy check-in tại căn tin!')).toBeInTheDocument();
    expect(screen.getByText('Chưa trúng móc khóa nào.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Quay thưởng' })).toBeDisabled();
  });

  test('đăng xuất thành công → về trạng thái chưa đăng nhập', async () => {
    const api = mockApi(loggedIn({ 'POST /api/auth/logout': json({ ok: true }) }));
    renderApp('/profile');
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
    expect(await screen.findByText('Chưa có hồ sơ cá nhân')).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/auth/logout')).toHaveLength(1);
  });

  test('đăng xuất thất bại (mất mạng) → báo lỗi, KHÔNG giả vờ đã đăng xuất vì phiên ở server vẫn còn', async () => {
    let online = false;
    mockApi(loggedIn({ 'POST /api/auth/logout': () => (online ? json({ ok: true }) : Promise.reject(new TypeError('offline'))) }));
    renderApp('/profile');
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
    expect(await screen.findByText(/Không đăng xuất được/)).toBeInTheDocument();
    expect(screen.getByText('MSSV SV001')).toBeInTheDocument();
    online = true;
    await userEvent.click(screen.getByRole('button', { name: 'Đăng xuất' }));
    expect(await screen.findByText('Chưa có hồ sơ cá nhân')).toBeInTheDocument();
  });
});

describe('ảnh đại diện', () => {
  const photo = ({ name = 'chan-dung.png', type = 'image/png', size = 2048 } = {}) => new File([new Uint8Array(size)], name, { type });
  const picker = () => screen.findByLabelText('Chọn ảnh đại diện');
  const currentImage = () => screen.findByRole('img', { name: 'Ảnh đại diện' });

  test('chưa có ảnh: hiện chữ cái đầu, không có nút gỡ; chỉ cho chọn JPEG, PNG, WebP; nêu rõ ảnh công khai', async () => {
    mockApi(loggedIn());
    renderApp('/profile');
    expect(await screen.findByTestId('avatar-initial')).toHaveTextContent('A');
    expect(screen.getByRole('button', { name: 'Đổi ảnh đại diện' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Gỡ ảnh' })).not.toBeInTheDocument();
    expect(await picker()).toHaveAttribute('accept', 'image/jpeg,image/png,image/webp');
    expect(screen.getByText(/công khai trên bảng xếp hạng/)).toBeInTheDocument();
  });

  test('nút "Đổi ảnh đại diện" mở đúng hộp chọn tệp', async () => {
    mockApi(loggedIn());
    renderApp('/profile');
    const input = await picker();
    const opened = vi.spyOn(input, 'click');
    await userEvent.click(screen.getByRole('button', { name: 'Đổi ảnh đại diện' }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  test('chọn ảnh: gửi đúng tệp trong trường image, ảnh mới hiện ngay, có nút gỡ', async () => {
    const api = mockApi(loggedIn({ 'PUT /api/avatars/me': json({ user: { ...USER, avatarUrl: '/api/avatars/anh-moi' } }) }));
    renderApp('/profile');
    await userEvent.upload(await picker(), photo());
    expect(await currentImage()).toHaveAttribute('src', '/api/avatars/anh-moi');
    expect(screen.getByRole('button', { name: 'Gỡ ảnh' })).toBeInTheDocument();
    const [call] = api.callsTo('PUT', '/api/avatars/me');
    expect(call.init.body.get('image').name).toBe('chan-dung.png');
    expect(call.init.headers['Content-Type']).toBeUndefined();
    expect(call.init.headers['X-Requested-With']).toBe('GreenCanteen');
  });

  test('tệp sai loại hoặc quá 8MB bị chặn ngay, không gửi lên server', async () => {
    const api = mockApi(loggedIn());
    renderApp('/profile');
    const user = userEvent.setup({ applyAccept: false });
    await user.upload(await picker(), photo({ name: 'anh.svg', type: 'image/svg+xml' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Chỉ nhận ảnh JPEG, PNG hoặc WebP.');
    await user.upload(await picker(), photo({ size: 8 * 1024 * 1024 + 1 }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ảnh quá lớn (tối đa 8MB)');
    expect(api.callsTo('PUT', '/api/avatars/me')).toHaveLength(0);
  });

  test('tệp đúng 8MB vẫn được gửi', async () => {
    const api = mockApi(loggedIn({ 'PUT /api/avatars/me': json({ user: { ...USER, avatarUrl: '/api/avatars/anh-moi' } }) }));
    renderApp('/profile');
    await userEvent.upload(await picker(), photo({ size: 8 * 1024 * 1024 }));
    await currentImage();
    expect(api.callsTo('PUT', '/api/avatars/me')).toHaveLength(1);
  });

  test('server từ chối: hiện lỗi của server, giữ ảnh cũ; lần sau chọn lại cùng tệp được, lỗi biến mất', async () => {
    let attempt = 0;
    mockApi(
      loggedIn(
        {
          'PUT /api/avatars/me': () =>
            (attempt += 1) === 1
              ? json({ error: 'Ảnh bị hỏng hoặc có kích thước quá lớn. Vui lòng chọn ảnh khác.', code: 'image_unreadable' }, 400)
              : json({ user: { ...USER, avatarUrl: '/api/avatars/anh-moi' } }),
        },
        { avatarUrl: '/api/avatars/anh-cu' }
      )
    );
    renderApp('/profile');
    const input = await picker();
    await userEvent.upload(input, photo());
    expect(await screen.findByRole('alert')).toHaveTextContent('Ảnh bị hỏng');
    expect(await currentImage()).toHaveAttribute('src', '/api/avatars/anh-cu');
    expect(input.value).toBe('');

    await userEvent.upload(input, photo());
    await waitFor(async () => expect(await currentImage()).toHaveAttribute('src', '/api/avatars/anh-moi'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('đang tải lên: các nút bị khóa, báo trạng thái, không gửi hai lần', async () => {
    const pending = deferred();
    const api = mockApi(loggedIn({ 'PUT /api/avatars/me': () => pending.promise }, { avatarUrl: '/api/avatars/anh-cu' }));
    renderApp('/profile');
    await userEvent.upload(await picker(), photo());
    const busy = await screen.findByRole('button', { name: 'Đang tải ảnh...' });
    expect(busy).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Gỡ ảnh' })).toBeDisabled();
    expect(api.callsTo('PUT', '/api/avatars/me')).toHaveLength(1);
    pending.resolve(json({ user: { ...USER, avatarUrl: '/api/avatars/anh-moi' } }));
    expect(await screen.findByRole('button', { name: 'Đổi ảnh đại diện' })).toBeEnabled();
  });

  test('gỡ ảnh: về chữ cái đầu; gỡ lỗi thì giữ ảnh và báo lỗi', async () => {
    let attempt = 0;
    mockApi(
      loggedIn(
        {
          'DELETE /api/avatars/me': () =>
            (attempt += 1) === 1 ? json({ error: 'Lỗi máy chủ.', code: 'server_error' }, 500) : json({ user: { ...USER, avatarUrl: null } }),
        },
        { avatarUrl: '/api/avatars/anh-cu' }
      )
    );
    renderApp('/profile');
    await currentImage();
    await userEvent.click(screen.getByRole('button', { name: 'Gỡ ảnh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Lỗi máy chủ.');
    expect(await currentImage()).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Gỡ ảnh' }));
    expect(await screen.findByTestId('avatar-initial')).toHaveTextContent('A');
    expect(screen.queryByRole('button', { name: 'Gỡ ảnh' })).not.toBeInTheDocument();
  });

  test('ảnh lưu trên server không tải được: về chữ cái đầu; đổi sang ảnh khác thì hiện lại ảnh', async () => {
    mockApi(loggedIn({ 'PUT /api/avatars/me': json({ user: { ...USER, avatarUrl: '/api/avatars/anh-moi' } }) }, { avatarUrl: '/api/avatars/anh-hong' }));
    renderApp('/profile');
    fireEvent.error(await currentImage());
    expect(await screen.findByTestId('avatar-initial')).toHaveTextContent('A');
    await userEvent.upload(await picker(), photo());
    expect(await currentImage()).toHaveAttribute('src', '/api/avatars/anh-moi');
  });
});
