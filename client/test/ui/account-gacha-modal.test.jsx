// Quản lý tài khoản (thông tin, phương thức đăng nhập, mật khẩu, phiên), quay thưởng tri ân ở trang Cá nhân,
// khung Modal dùng chung (bàn phím, bẫy focus, bộ gõ tiếng Việt), hộp xác nhận QR
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PROVIDERS, SECURITY, USER, json, mockApi } from '../helpers';
import Modal from '../../src/components/Modal';

const providers = (patch = {}) => json({ providers: { ...PROVIDERS.providers, ...patch } });

async function renderAccount(user, routes = {}) {
  vi.resetModules();
  const api = mockApi({ 'GET /api/auth/providers': providers(), 'GET /api/auth/security': json(SECURITY), ...routes });
  const { default: AccountSection } = await import('../../src/components/AccountSection');
  const onUserChange = vi.fn();
  const onLogout = vi.fn().mockResolvedValue();
  render(<AccountSection user={user} onUserChange={onUserChange} onLogout={onLogout} />);
  return { api, onUserChange, onLogout };
}

describe('thông tin & phương thức đăng nhập', () => {
  test('hiển thị họ tên, mã SV, email ("Chưa có" khi trống), ngày tham gia', async () => {
    await renderAccount({ ...USER, email: '', createdAt: undefined });
    const info = screen.getByText('Họ và tên').closest('dl');
    expect(info).toHaveTextContent('Mã sinh viênSV001');
    expect(info).toHaveTextContent('EmailChưa có');
    expect(info).toHaveTextContent('Tham gia từ—');
  });

  test('đã liên kết / chưa cấu hình / "Liên kết" hỏi lại mật khẩu rồi mới tới OAuth mode=link', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    const { api } = await renderAccount(
      { ...USER, authMethods: { password: true, google: false, facebook: true } },
      { 'GET /api/auth/providers': providers({ google: { enabled: true } }), 'POST /api/auth/reauth': json({ ok: true }) }
    );
    const rows = screen.getByText('Phương thức đăng nhập').nextElementSibling;
    expect(within(rows).getByText(`Email · ${USER.email}`).nextElementSibling).toHaveTextContent('✓ Đã liên kết');
    expect(within(rows).getByText('Facebook').nextElementSibling).toHaveTextContent('✓ Đã liên kết');
    await userEvent.click(await within(rows).findByRole('button', { name: 'Liên kết' }));
    expect(assign).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('Nhập lại mật khẩu để tiếp tục'), 'mat-khau-hien-tai');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/auth/google/start?mode=link'));
    expect(JSON.parse(api.callsTo('POST', '/api/auth/reauth')[0].init.body)).toEqual({ password: 'mat-khau-hien-tai' });
  });

  test('nhập sai mật khẩu: báo lỗi của server, không chuyển trang; Hủy đóng biểu mẫu', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    await renderAccount(USER, {
      'GET /api/auth/providers': providers({ google: { enabled: true } }),
      'POST /api/auth/reauth': json({ error: 'Mật khẩu không đúng.', code: 'invalid_current_password' }, 400),
    });
    await userEvent.click(await screen.findAllByRole('button', { name: 'Liên kết' }).then(([first]) => first));
    await userEvent.type(screen.getByLabelText('Nhập lại mật khẩu để tiếp tục'), 'sai-mat-khau');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mật khẩu không đúng.');
    expect(assign).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    expect(screen.queryByLabelText('Nhập lại mật khẩu để tiếp tục')).not.toBeInTheDocument();
  });

  test('tài khoản không có mật khẩu: tới thẳng nhà cung cấp, máy chủ dựa vào phiên vừa đăng nhập', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    await renderAccount(
      { ...USER, authMethods: { password: false, google: true, facebook: false } },
      { 'GET /api/auth/providers': providers({ facebook: { enabled: true } }) }
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Liên kết' }));
    expect(assign).toHaveBeenCalledWith('/api/auth/facebook/start?mode=link');
  });

  test('hủy liên kết: xác thực lại, cập nhật hồ sơ, báo đã đăng xuất thiết bị khác', async () => {
    const after = { ...USER, authMethods: { password: true, google: false, facebook: false } };
    const { api, onUserChange } = await renderAccount(
      { ...USER, authMethods: { password: true, google: true, facebook: false } },
      { 'POST /api/auth/reauth': json({ ok: true }), 'DELETE /api/auth/providers/google': json({ ok: true, user: after }) }
    );
    await userEvent.click(screen.getByRole('button', { name: 'Hủy liên kết Google' }));
    await userEvent.type(screen.getByLabelText('Nhập lại mật khẩu để tiếp tục'), 'mat-khau-hien-tai');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Đã hủy liên kết Google');
    expect(onUserChange).toHaveBeenCalledWith(after);
    expect(api.callsTo('DELETE', '/api/auth/providers/google')).toHaveLength(1);
  });

  test('tài khoản đã bật 2FA: máy chủ đòi mã thì hiện thêm ô mã, không báo lỗi; mã sai mới báo lỗi', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign });
    let attempts = 0;
    const { api } = await renderAccount(USER, {
      'GET /api/auth/providers': providers({ google: { enabled: true } }),
      'POST /api/auth/reauth': () => {
        attempts += 1;
        return attempts < 3 ? json({ error: 'Cần mã xác thực hai lớp đúng.', code: 'invalid_mfa_code' }, 400) : json({ ok: true });
      },
    });
    await userEvent.click(await screen.findAllByRole('button', { name: 'Liên kết' }).then(([first]) => first));
    await userEvent.type(screen.getByLabelText('Nhập lại mật khẩu để tiếp tục'), 'mat-khau-hien-tai');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));

    const codeField = await screen.findByLabelText('Mã xác thực hai lớp');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.type(codeField, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Cần mã xác thực hai lớp đúng.');
    expect(codeField).toHaveValue('');
    expect(assign).not.toHaveBeenCalled();

    await userEvent.type(codeField, ' 123456 ');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/api/auth/google/start?mode=link'));
    expect(JSON.parse(api.callsTo('POST', '/api/auth/reauth').at(-1).init.body)).toEqual({ password: 'mat-khau-hien-tai', code: '123456' });
  });

  test('phương thức đăng nhập cuối cùng không có nút hủy liên kết', async () => {
    await renderAccount({ ...USER, authMethods: { password: false, google: true, facebook: false } });
    expect(screen.getByText('Google / Gmail').nextElementSibling).toHaveTextContent('✓ Đã liên kết');
    expect(screen.queryByRole('button', { name: /Hủy liên kết/ })).not.toBeInTheDocument();
  });

  test('tài khoản không có mật khẩu, phiên đã cũ: hủy liên kết bị từ chối và được hướng dẫn đăng nhập lại', async () => {
    await renderAccount(
      { ...USER, authMethods: { password: false, google: true, facebook: true } },
      { 'DELETE /api/auth/providers/google': json({ error: 'Cần xác thực lại trước khi hủy liên kết.', code: 'reauth_required' }, 403) }
    );
    await userEvent.click(screen.getByRole('button', { name: 'Hủy liên kết Google' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('đăng nhập lại');
  });
});

describe('mật khẩu', () => {
  test('đổi mật khẩu: nhập lại không khớp → lỗi tại chỗ; thành công → báo số phiên bị đăng xuất', async () => {
    const { api, onUserChange } = await renderAccount(USER, {
      'POST /api/auth/password/change': json({ ok: true, revokedSessions: 2, user: USER }),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Đổi mật khẩu' }));
    await userEvent.type(screen.getByLabelText('Mật khẩu hiện tại'), 'cu-mat-khau');
    await userEvent.type(screen.getByLabelText('Mật khẩu mới (ít nhất 8 ký tự)'), 'mat-khau-moi-1');
    await userEvent.type(screen.getByLabelText('Nhập lại mật khẩu mới'), 'mat-khau-moi-2');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Hai mật khẩu mới chưa khớp nhau.');
    expect(api.callsTo('POST', '/api/auth/password/change')).toHaveLength(0);

    await userEvent.clear(screen.getByLabelText('Nhập lại mật khẩu mới'));
    await userEvent.type(screen.getByLabelText('Nhập lại mật khẩu mới'), 'mat-khau-moi-1');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Đã đổi mật khẩu và đăng xuất 2 phiên trên thiết bị khác.');
    expect(onUserChange).toHaveBeenCalledWith(USER);
    expect(screen.queryByLabelText('Mật khẩu hiện tại')).not.toBeInTheDocument();
  });

  test('đổi mật khẩu sai mật khẩu hiện tại → lỗi của server; Hủy đóng biểu mẫu', async () => {
    await renderAccount(USER, {
      'POST /api/auth/password/change': json({ error: 'Mật khẩu hiện tại không đúng.', code: 'invalid_current_password' }, 400),
    });
    await userEvent.click(screen.getByRole('button', { name: 'Đổi mật khẩu' }));
    await userEvent.type(screen.getByLabelText('Mật khẩu hiện tại'), 'sai-mat-khau');
    await userEvent.type(screen.getByLabelText('Mật khẩu mới (ít nhất 8 ký tự)'), 'mat-khau-moi-1');
    await userEvent.type(screen.getByLabelText('Nhập lại mật khẩu mới'), 'mat-khau-moi-1');
    await userEvent.click(screen.getByRole('button', { name: 'Lưu' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mật khẩu hiện tại không đúng.');
    await userEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  test('tài khoản chưa có mật khẩu: bảng quyết định email × cấu hình gửi thư', async () => {
    const noPassword = { ...USER, authMethods: { password: false, google: true, facebook: false } };
    await renderAccount({ ...noPassword, email: '' });
    expect(screen.getByText(/chưa có email nên không đặt được mật khẩu/)).toBeInTheDocument();
  });

  test('chưa có mật khẩu + email + gửi thư được → gửi liên kết đặt mật khẩu', async () => {
    const noPassword = { ...USER, authMethods: { password: false, google: true, facebook: false } };
    const { api } = await renderAccount(noPassword, {
      'GET /api/auth/providers': providers({ passwordReset: { enabled: true, devConsole: true } }),
      'POST /api/auth/password/forgot': json({ ok: true, message: 'Nếu email này thuộc một tài khoản, liên kết sẽ được gửi.', devConsole: true }, 202),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Gửi email đặt mật khẩu' }));
    expect(await screen.findByRole('status')).toHaveTextContent('(Chế độ phát triển: email chỉ được ghi vào log máy chủ.)');
    expect(JSON.parse(api.callsTo('POST', '/api/auth/password/forgot')[0].init.body)).toEqual({ email: USER.email });
  });

  test('chưa có mật khẩu + server chưa cấu hình email → báo chưa cấu hình', async () => {
    await renderAccount(
      { ...USER, authMethods: { password: false, google: true, facebook: false } },
      { 'GET /api/auth/providers': providers({ passwordReset: { enabled: false } }) }
    );
    expect(await screen.findByText('Đặt mật khẩu qua email chưa được cấu hình trên máy chủ.')).toBeInTheDocument();
  });
});

describe('phiên đăng nhập', () => {
  test('đăng xuất thiết bị khác: có / không có phiên khác / lỗi', async () => {
    let attempt = 0;
    await renderAccount(USER, {
      'POST /api/auth/sessions/revoke-others': () =>
        [json({ ok: true, revokedSessions: 3 }), json({ ok: true, revokedSessions: 0 }), json({ error: 'Lỗi máy chủ.', code: 'server_error' }, 500)][attempt++],
    });
    const button = screen.getByRole('button', { name: 'Đăng xuất khỏi các thiết bị khác' });
    await userEvent.click(button);
    expect(await screen.findByText('Đã đăng xuất 3 phiên trên thiết bị khác.')).toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByText('Không có thiết bị nào khác đang đăng nhập.')).toBeInTheDocument();
    await userEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Lỗi máy chủ.');
  });
});

describe('quay thưởng tri ân ở trang Cá nhân', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  const KEYCHAIN = { id: 'r1', type: 'keychain', label: 'Lá xanh', imageUrl: '/api/gacha/media/abc', claimCode: 'TA-BEEF2-34567', deliveryStatus: 'pending', deliveredAt: null, claimInstructions: 'Nhận ở quầy căn tin, mang thẻ SV', createdAt: '2026-10-28T03:00:00.000Z' };
  const WIN = {
    outcome: 'win',
    prize: { type: 'keychain', label: 'Lá xanh', description: 'Móc khóa hình lá', imageUrl: '/api/gacha/media/abc', claimCode: 'TA-BEEF2-34567' },
    claimInstructions: 'Nhận ở quầy căn tin, mang thẻ SV',
    sticker: { url: '/api/gacha/media/sticker', name: 'Pháo hoa' },
  };

  async function renderGacha(routes, pendingSpins) {
    vi.resetModules();
    mockApi(routes);
    const { default: ProfileGachaSection } = await import('../../src/components/ProfileGachaSection');
    const onSpinsChange = vi.fn();
    function Harness() {
      const [spins, setSpins] = useState(pendingSpins);
      return (
        <ProfileGachaSection
          pendingSpins={spins}
          onSpinsChange={(n) => {
            onSpinsChange(n);
            setSpins(n);
          }}
        />
      );
    }
    render(<Harness />);
    return { onSpinsChange };
  }

  test('0 lượt → nút khóa; số lượt đồng bộ theo server', async () => {
    const { onSpinsChange } = await renderGacha({ 'GET /api/gacha/results': json({ pendingGachaSpins: 0, stats: { spins: 0, wins: 0 }, rewards: [] }) }, 2);
    await waitFor(() => expect(onSpinsChange).toHaveBeenCalledWith(0));
    expect(screen.getByRole('button', { name: 'Quay thưởng' })).toBeDisabled();
  });

  test('trúng → sticker, ảnh móc khóa, mã nhận quà, cách nhận; giảm lượt, tải lại danh sách', async () => {
    let list = [];
    let spins = 1;
    const { onSpinsChange } = await renderGacha(
      {
        'GET /api/gacha/results': () => json({ pendingGachaSpins: spins, stats: { spins: list.length, wins: list.length }, rewards: list }),
        'POST /api/gacha/draw': () => {
          if (spins < 1) return json({ error: 'Bạn chưa có lượt quay thưởng tri ân.', code: 'no_spins' }, 400);
          spins -= 1;
          list = [KEYCHAIN];
          return json({ ...WIN, pendingGachaSpins: spins });
        },
      },
      1
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole('button', { name: 'Quay thưởng' }));
    expect(screen.getByRole('button', { name: 'Đang quay...' })).toBeDisabled();
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(await screen.findByRole('heading', { name: 'Trúng thưởng!' })).toBeInTheDocument();
    expect(await screen.findAllByText('TA-BEEF2-34567')).toHaveLength(2);
    expect(screen.getAllByRole('img', { name: 'Móc khóa Lá xanh' }).length).toBe(2);
    expect(document.querySelector('img[src="/api/gacha/media/sticker"]')).toHaveAttribute('alt', '');
    expect(screen.getAllByText('Nhận ở quầy căn tin, mang thẻ SV').length).toBeGreaterThan(0);
    expect(screen.getByText('Chờ nhận')).toBeInTheDocument();
    expect(onSpinsChange).toHaveBeenLastCalledWith(0);
    expect(screen.getByRole('button', { name: 'Quay thưởng' })).toBeDisabled();
  });

  test('không trúng → lời động viên, không có mã; đếm lượt đã quay', async () => {
    let spins = 1;
    await renderGacha(
      {
        'GET /api/gacha/results': () => json({ pendingGachaSpins: spins, stats: { spins: 1 - spins, wins: 0 }, rewards: [] }),
        'POST /api/gacha/draw': () => {
          spins -= 1;
          return json({ outcome: 'lose', prize: null, claimInstructions: '', sticker: null, pendingGachaSpins: spins });
        },
      },
      1
    );
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(await screen.findByRole('button', { name: 'Quay thưởng' }));
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(await screen.findByRole('heading', { name: 'Chưa trúng lần này' })).toBeInTheDocument();
    expect(await screen.findByText('Đã quay 1 lượt · trúng 0 móc khóa')).toBeInTheDocument();
    expect(screen.queryByText(/^TA-/)).not.toBeInTheDocument();
  });

  test('móc khóa đã trao hiện "Đã nhận", không còn nút sao chép; mã nạp demo cũ gom riêng', async () => {
    const delivered = { ...KEYCHAIN, deliveryStatus: 'delivered', deliveredAt: '2026-10-29T03:00:00.000Z' };
    const legacy = { id: 'r0', type: 'phone_topup', carrier: 'Viettel', amountVnd: 10000, topUpCode: 'GC-10K-CU', createdAt: '2026-10-01T03:00:00.000Z' };
    await renderGacha({ 'GET /api/gacha/results': json({ pendingGachaSpins: 0, stats: { spins: 5, wins: 1 }, rewards: [delivered, legacy] }) }, 0);
    expect(await screen.findByText(/^Đã nhận/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sao chép mã' })).not.toBeInTheDocument();
    expect(screen.getByText('Mã nạp demo cũ (1)')).toBeInTheDocument();
  });

  test('hết móc khóa (409) → báo lỗi, lượt đồng bộ lại; lỗi tải danh sách → "Thử lại"', async () => {
    let attempt = 0;
    await renderGacha(
      {
        'GET /api/gacha/results': () => ((attempt += 1) === 1 ? json({ error: 'Lỗi máy chủ.', code: 'server_error' }, 500) : json({ pendingGachaSpins: 1, stats: { spins: 0, wins: 0 }, rewards: [] })),
        'POST /api/gacha/draw': json({ error: 'Móc khóa đợt này đã được trao hết. Lượt quay của bạn vẫn được giữ.', code: 'gacha_out_of_stock' }, 409),
      },
      1
    );
    const alert = await screen.findByRole('alert');
    await userEvent.click(within(alert).getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Chưa trúng móc khóa nào.')).toBeInTheDocument();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Quay thưởng' }));
    await act(() => vi.advanceTimersByTimeAsync(1200));
    expect(await screen.findByText('Móc khóa đợt này đã được trao hết. Lượt quay của bạn vẫn được giữ.')).toBeInTheDocument();
  });
});

describe('Modal — bàn phím và trợ năng', () => {
  function Host({ onClose }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Mở
        </button>
        {open && (
          <Modal
            title="Tiêu đề"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          >
            <input aria-label="Ô đầu" />
            <button type="button">Nút cuối</button>
          </Modal>
        )}
      </>
    );
  }

  test('role dialog có tên; khóa cuộn nền; Escape đóng và trả focus về nút mở', async () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Mở' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Tiêu đề' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(document.body.style.overflow).toBe('hidden');
    expect(dialog).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.body.style.overflow).toBe('');
    expect(opener).toHaveFocus();
  });

  test('Tab / Shift+Tab xoay vòng trong popup (bẫy focus)', async () => {
    render(<Host onClose={() => {}} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mở' }));
    const close = screen.getByRole('button', { name: 'Đóng' });
    const last = screen.getByRole('button', { name: 'Nút cuối' });
    await userEvent.tab({ shift: true });
    expect(last).toHaveFocus();
    await userEvent.tab();
    expect(close).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText('Ô đầu')).toHaveFocus();
  });

  test('Escape trong lúc bộ gõ tiếng Việt đang soạn chữ (IME) không đóng popup', async () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: 'Mở' }));
    const input = screen.getByLabelText('Ô đầu');
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('hộp xác nhận QR trên thiết bị đã đăng nhập', () => {
  async function renderApprove(routes) {
    vi.resetModules();
    mockApi({ 'GET /api/auth/me': json({ user: USER }), 'GET /api/auth/security': json(SECURITY), ...routes });
    const [{ UserProvider }, { default: QrApproveDialog }] = await Promise.all([
      import('../../src/context/UserContext'),
      import('../../src/components/QrApproveDialog'),
    ]);
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <UserProvider>
          <QrApproveDialog challengeId="CH_ABCDEFGHIJKLMNOPQRSTUVWX" onClose={onClose} />
        </UserProvider>
      </MemoryRouter>
    );
    return { onClose, dialog: await screen.findByRole('dialog') };
  }

  test('mã QR không hợp lệ / hết hạn → báo lỗi + nút Đóng', async () => {
    const { dialog, onClose } = await renderApprove({
      'GET /api/auth/qr/challenge/CH_ABCDEFGHIJKLMNOPQRSTUVWX': json({ error: 'Mã QR không tồn tại, đã hết hạn hoặc đã được sử dụng.', code: 'qr_invalid' }, 404),
    });
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Mã QR không tồn tại');
    // Nút × ở tiêu đề và nút "Đóng" cuối hộp thoại cùng tên, cùng tác dụng — bấm nút cuối
    const closeButtons = within(dialog).getAllByRole('button', { name: 'Đóng' });
    expect(closeButtons).toHaveLength(2);
    await userEvent.click(closeButtons.at(-1));
    expect(onClose).toHaveBeenCalled();
  });

  test('từ chối → "Đã từ chối"; xác nhận khi mã vừa hết hạn → lỗi 410', async () => {
    const { dialog } = await renderApprove({
      'GET /api/auth/qr/challenge/CH_ABCDEFGHIJKLMNOPQRSTUVWX': json({ device: 'Safari trên iOS', createdAt: '2026-10-28T03:00:00.000Z' }),
      'POST /api/auth/qr/challenge/CH_ABCDEFGHIJKLMNOPQRSTUVWX/reject': json({ ok: true }),
    });
    expect(await within(dialog).findByText('Safari trên iOS')).toBeInTheDocument();
    expect(within(dialog).getByText(/Nếu ai đó gửi mã QR cho bạn, hãy bấm Từ chối/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Từ chối' }));
    expect(await within(dialog).findByText('Đã từ chối yêu cầu đăng nhập.')).toBeInTheDocument();
  });

  test('xác nhận thất bại (410) → thông báo lỗi', async () => {
    const { dialog } = await renderApprove({
      'GET /api/auth/qr/challenge/CH_ABCDEFGHIJKLMNOPQRSTUVWX': json({ device: 'Chrome trên Android', createdAt: '2026-10-28T03:00:00.000Z' }),
      'POST /api/auth/qr/challenge/CH_ABCDEFGHIJKLMNOPQRSTUVWX/approve': json({ error: 'Mã QR không tồn tại, đã hết hạn hoặc đã được sử dụng.', code: 'qr_invalid' }, 410),
    });
    await userEvent.type(await within(dialog).findByLabelText('Mã đối chiếu trên thiết bị kia'), '1234');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đăng nhập' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('đã hết hạn');
  });

  test('chưa đủ 4 chữ số thì không xác nhận được; chữ cái bị bỏ qua; mã gửi kèm yêu cầu', async () => {
    const { dialog } = await renderApprove({
      'GET /api/auth/qr/challenge/CH_ABCDEFGHIJKLMNOPQRSTUVWX': json({ device: 'Chrome trên Android', createdAt: '2026-10-28T03:00:00.000Z' }),
      'POST /api/auth/qr/challenge/CH_ABCDEFGHIJKLMNOPQRSTUVWX/approve': json({ ok: true }),
    });
    const input = await within(dialog).findByLabelText('Mã đối chiếu trên thiết bị kia');
    const confirm = within(dialog).getByRole('button', { name: 'Xác nhận đăng nhập' });
    expect(confirm).toBeDisabled();
    await userEvent.type(input, '12a3');
    expect(input).toHaveValue('123');
    expect(confirm).toBeDisabled();
    await userEvent.type(input, '4');
    await userEvent.click(confirm);
    expect(await within(dialog).findByText(/Đã xác nhận/)).toBeInTheDocument();
    const [call] = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/approve'));
    expect(JSON.parse(call[1].body)).toEqual({ matchCode: '1234' });
  });

  test('sai mã đối chiếu: nhập lại được ngay, thông báo nhắc từ chối nếu mã QR do người khác gửi', async () => {
    let attempts = 0;
    const { dialog } = await renderApprove({
      'GET /api/auth/qr/challenge/CH_ABCDEFGHIJKLMNOPQRSTUVWX': json({ device: 'Chrome trên Android', createdAt: '2026-10-28T03:00:00.000Z' }),
      'POST /api/auth/qr/challenge/CH_ABCDEFGHIJKLMNOPQRSTUVWX/approve': () =>
        (attempts += 1) === 1 ? json({ error: 'Mã đối chiếu không đúng.', code: 'qr_match_invalid' }, 400) : json({ ok: true }),
    });
    const input = await within(dialog).findByLabelText('Mã đối chiếu trên thiết bị kia');
    await userEvent.type(input, '0000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đăng nhập' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Mã đối chiếu không đúng.');
    await userEvent.clear(input);
    await userEvent.type(input, '1234');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận đăng nhập' }));
    expect(await within(dialog).findByText(/Đã xác nhận/)).toBeInTheDocument();
  });
});
