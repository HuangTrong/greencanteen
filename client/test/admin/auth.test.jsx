// Đăng nhập quản trị, điều hướng theo phiên, đăng ký MFA, xác thực lại, token CSRF
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { setCsrfToken } from '../../src/admin/adminApi';
import { deferred, json, mockApi } from '../helpers';
import { ADMIN_SESSION, LOGGED_IN, NO_SESSION, OVERVIEW, REAUTH_REQUIRED, SESSION_LOST, USER_DETAIL, renderAdmin } from './helpers';

const webauthn = vi.hoisted(() => ({ browserSupportsWebAuthn: vi.fn(), startAuthentication: vi.fn(), startRegistration: vi.fn() }));

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));
vi.mock('@simplewebauthn/browser', () => webauthn);

const OVERVIEW_ROUTE = { 'GET /api/admin/overview': json(OVERVIEW) };

beforeEach(() => {
  setCsrfToken('');
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.startAuthentication.mockReset();
});

describe('passkey ở bước hai', () => {
  const AT_MFA = { stage: 'mfa', mfaEnrolled: true, passkeyAvailable: true, csrfToken: 't' };
  const atMfa = (session = AT_MFA) => ({ 'GET /api/admin/auth/session': json(session), ...OVERVIEW_ROUTE });

  test('tài khoản chưa có passkey hoặc trình duyệt không hỗ trợ: không có nút', async () => {
    mockApi(atMfa({ ...AT_MFA, passkeyAvailable: false }));
    const first = renderAdmin('/');
    await screen.findByRole('heading', { name: 'Xác thực hai lớp' });
    expect(screen.queryByRole('button', { name: 'Dùng passkey' })).not.toBeInTheDocument();
    first.unmount();

    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    mockApi(atMfa());
    renderAdmin('/');
    await screen.findByRole('heading', { name: 'Xác thực hai lớp' });
    expect(screen.queryByRole('button', { name: 'Dùng passkey' })).not.toBeInTheDocument();
  });

  test('chữ ký hợp lệ: vào khu quản trị bằng token CSRF mới, không cần nhập mã', async () => {
    webauthn.startAuthentication.mockResolvedValue({ id: 'khoa-1' });
    const api = mockApi({
      ...atMfa(),
      'POST /api/admin/auth/passkey/options': json({ challenge: 'thu-thach' }),
      'POST /api/admin/auth/passkey/verify': json(ADMIN_SESSION),
    });
    renderAdmin('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Dùng passkey' }));
    expect(await screen.findByRole('navigation', { name: 'Khu quản trị' })).toBeInTheDocument();
    const verify = api.callsTo('POST', '/api/admin/auth/passkey/verify')[0];
    expect(JSON.parse(verify.init.body)).toEqual({ response: { id: 'khoa-1' } });
    expect(new Headers(verify.init.headers).get('X-CSRF-Token')).toBe('t');
  });

  test('hủy trên thiết bị hoặc máy chủ từ chối: báo lỗi, vẫn dùng được mã', async () => {
    webauthn.startAuthentication.mockRejectedValueOnce(Object.assign(new Error('not allowed'), { name: 'NotAllowedError' })).mockResolvedValueOnce({ id: 'khoa-1' });
    mockApi({
      ...atMfa(),
      'POST /api/admin/auth/passkey/options': json({ challenge: 'thu-thach' }),
      'POST /api/admin/auth/passkey/verify': json({ error: 'Không xác minh được passkey.', code: 'passkey_invalid' }, 401),
    });
    renderAdmin('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Dùng passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bạn đã hủy');
    await userEvent.click(screen.getByRole('button', { name: 'Dùng passkey' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Không xác minh được passkey.'));
    expect(screen.getByLabelText(/Mã xác thực/)).toBeEnabled();
    expect(screen.queryByRole('navigation', { name: 'Khu quản trị' })).not.toBeInTheDocument();
  });
});

describe('điều hướng theo phiên', () => {
  test('khách vào thẳng URL quản trị: về màn đăng nhập, không gọi API dữ liệu nào', async () => {
    const api = mockApi(NO_SESSION);
    for (const route of ['/', '/users', '/users/abc', '/stories/new', '/gacha', '/settings', '/audit']) {
      const { unmount } = renderAdmin(route);
      expect(await screen.findByRole('heading', { name: 'Đăng nhập quản trị' })).toBeInTheDocument();
      expect(screen.getByTestId('location')).toHaveTextContent('/login');
      expect(screen.queryByRole('navigation', { name: 'Khu quản trị' })).not.toBeInTheDocument();
      unmount();
    }
    expect(api.calls.every((call) => call.path === '/api/admin/auth/session')).toBe(true);
  });

  test('đang kiểm tra phiên: không hiển thị khung quản trị', async () => {
    const session = deferred();
    mockApi({ 'GET /api/admin/auth/session': () => session.promise, ...OVERVIEW_ROUTE });
    renderAdmin('/');
    expect(screen.getByText('Đang kiểm tra phiên đăng nhập...')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Khu quản trị' })).not.toBeInTheDocument();
    session.resolve(json(ADMIN_SESSION));
    expect(await screen.findByRole('navigation', { name: 'Khu quản trị' })).toBeInTheDocument();
  });

  test('máy chủ chưa cấu hình: báo rõ, không có biểu mẫu đăng nhập', async () => {
    mockApi({ 'GET /api/admin/auth/session': json({ error: 'Khu quản trị chưa được cấu hình trên máy chủ.', code: 'admin_not_configured' }, 503) });
    renderAdmin('/');
    expect(await screen.findByRole('heading', { name: 'Khu quản trị chưa sẵn sàng' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Mật khẩu')).not.toBeInTheDocument();
  });

  test('mất kết nối khi kiểm tra phiên: báo lỗi và cho thử lại, không coi như đã đăng nhập', async () => {
    mockApi({});
    renderAdmin('/');
    expect(await screen.findByRole('alert')).toHaveTextContent('Không kết nối được máy chủ');
    expect(screen.queryByRole('navigation', { name: 'Khu quản trị' })).not.toBeInTheDocument();
    mockApi({ ...LOGGED_IN, ...OVERVIEW_ROUTE });
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByRole('navigation', { name: 'Khu quản trị' })).toBeInTheDocument();
  });

  test('phiên hết hạn giữa chừng: về màn đăng nhập kèm thông báo, không còn hiển thị dữ liệu', async () => {
    mockApi({ ...LOGGED_IN, ...OVERVIEW_ROUTE, 'GET /api/admin/users': SESSION_LOST });
    renderAdmin('/');
    await screen.findByRole('heading', { name: 'Tổng quan' });
    await userEvent.click(screen.getByRole('link', { name: 'Tài khoản' }));
    expect(await screen.findByText('Phiên làm việc đã hết hạn. Hãy đăng nhập lại.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Khu quản trị' })).not.toBeInTheDocument();
  });

  test('phiên chờ MFA khi tải lại trang: tiếp tục đúng bước, không vào được khu quản trị', async () => {
    mockApi({ 'GET /api/admin/auth/session': json({ stage: 'mfa', mfaEnrolled: true, csrfToken: 't' }) });
    renderAdmin('/users');
    expect(await screen.findByRole('heading', { name: 'Xác thực hai lớp' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Khu quản trị' })).not.toBeInTheDocument();
  });

  test('đăng xuất gọi server rồi về màn đăng nhập', async () => {
    const api = mockApi({ ...LOGGED_IN, ...OVERVIEW_ROUTE, 'POST /api/admin/auth/logout': json({ ok: true }) });
    renderAdmin('/');
    await userEvent.click(await screen.findByRole('button', { name: 'Đăng xuất' }));
    expect(await screen.findByRole('heading', { name: 'Đăng nhập quản trị' })).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/admin/auth/logout')).toHaveLength(1);
  });
});

describe('đăng nhập', () => {
  const fillPassword = async () => {
    await userEvent.type(await screen.findByLabelText('Email'), 'admin@example.edu.vn');
    await userEvent.type(screen.getByLabelText('Mật khẩu'), 'mat-khau-dai-123');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
  };

  test('mật khẩu → mã xác thực → vào tổng quan; token CSRF lấy từ phản hồi được gửi kèm các request sau', async () => {
    const api = mockApi({
      ...NO_SESSION,
      ...OVERVIEW_ROUTE,
      'POST /api/admin/auth/login': json({ stage: 'mfa', mfaEnrolled: true, csrfToken: 'csrf-buoc-cho' }),
      'POST /api/admin/auth/mfa/verify': json({ ...ADMIN_SESSION, csrfToken: 'csrf-day-du' }),
      'POST /api/admin/auth/logout': json({ ok: true }),
    });
    renderAdmin('/login');
    await fillPassword();
    await userEvent.type(await screen.findByLabelText('Mã xác thực'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(await screen.findByRole('heading', { name: 'Tổng quan' })).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/admin/auth/mfa/verify')[0].init.headers['X-CSRF-Token']).toBe('csrf-buoc-cho');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng xuất' }));
    await screen.findByRole('heading', { name: 'Đăng nhập quản trị' });
    expect(api.callsTo('POST', '/api/admin/auth/logout')[0].init.headers['X-CSRF-Token']).toBe('csrf-day-du');
  });

  test('sai mật khẩu hoặc sai mã: hiện lỗi của server, ở lại bước hiện tại, ô mã được xóa', async () => {
    mockApi({
      ...NO_SESSION,
      'POST /api/admin/auth/login': (() => {
        let calls = 0;
        return () => {
          calls += 1;
          return calls === 1 ? json({ error: 'Email hoặc mật khẩu không đúng.', code: 'invalid_credentials' }, 401) : json({ stage: 'mfa', mfaEnrolled: true, csrfToken: 't' });
        };
      })(),
      'POST /api/admin/auth/mfa/verify': json({ error: 'Mã xác thực không đúng hoặc đã được dùng.', code: 'invalid_mfa_code' }, 401),
    });
    renderAdmin('/login');
    await fillPassword();
    expect(await screen.findByRole('alert')).toHaveTextContent('Email hoặc mật khẩu không đúng.');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));

    const code = await screen.findByLabelText('Mã xác thực');
    await userEvent.type(code, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mã xác thực không đúng');
    expect(code).toHaveValue('');
  });

  test('đăng ký MFA: mã đăng ký → QR + khóa thủ công → mã 6 số → mã khôi phục phải xác nhận đã lưu', async () => {
    const api = mockApi({
      ...NO_SESSION,
      ...OVERVIEW_ROUTE,
      'POST /api/admin/auth/login': json({ stage: 'mfa', mfaEnrolled: false, csrfToken: 't' }),
      'POST /api/admin/auth/mfa/setup': json({ secret: 'KHOABIMATBASE32', otpauthUri: 'otpauth://totp/x' }),
      'POST /api/admin/auth/mfa/verify': json({ ...ADMIN_SESSION, recoveryCodes: ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'] }),
    });
    renderAdmin('/login');
    await fillPassword();
    await userEvent.type(await screen.findByLabelText('Mã đăng ký'), 'ABCD-EFGH-JKLM');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));

    expect(await screen.findByAltText('Mã QR đăng ký ứng dụng xác thực')).toBeInTheDocument();
    expect(screen.getByTestId('mfa-secret')).toHaveTextContent('KHOABIMATBASE32');
    await userEvent.type(screen.getByLabelText('Mã 6 chữ số'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Hoàn tất' }));

    const list = await screen.findByRole('list', { name: 'Mã khôi phục' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    const enter = screen.getByRole('button', { name: 'Vào khu quản trị' });
    expect(enter).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tôi đã lưu các mã này' }));
    await userEvent.click(enter);
    expect(await screen.findByRole('heading', { name: 'Tổng quan' })).toBeInTheDocument();
    expect(JSON.parse(api.callsTo('POST', '/api/admin/auth/mfa/setup')[0].init.body)).toEqual({ enrollCode: 'ABCD-EFGH-JKLM' });
  });

  test('mã đăng ký sai: hiện lỗi, không sang bước sau', async () => {
    mockApi({
      'GET /api/admin/auth/session': json({ stage: 'mfa', mfaEnrolled: false, csrfToken: 't' }),
      'POST /api/admin/auth/mfa/setup': json({ error: 'Mã đăng ký không đúng hoặc đã hết hạn.', code: 'invalid_enroll_code' }, 400),
    });
    renderAdmin('/login');
    await userEvent.type(await screen.findByLabelText('Mã đăng ký'), 'SAI');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mã đăng ký không đúng');
    expect(screen.queryByTestId('mfa-secret')).not.toBeInTheDocument();
  });

  test('đang đăng nhập rồi mà mở /login: về tổng quan', async () => {
    mockApi({ ...LOGGED_IN, ...OVERVIEW_ROUTE });
    renderAdmin('/login');
    expect(await screen.findByRole('heading', { name: 'Tổng quan' })).toBeInTheDocument();
  });
});

describe('xác thực lại', () => {
  const USER_ROUTE = { [`GET /api/admin/users/${USER_DETAIL.id}`]: json(USER_DETAIL) };
  const REVEAL = `POST /api/admin/users/${USER_DETAIL.id}/reveal`;

  const scripted = (...replies) => {
    let index = 0;
    return () => replies[Math.min(index++, replies.length - 1)]();
  };

  test('server đòi xác thực lại: hỏi mật khẩu + mã, thành công thì tự thực hiện lại thao tác', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      ...USER_ROUTE,
      [REVEAL]: scripted(REAUTH_REQUIRED, () => json({ studentId: 'SV2023001', email: 'an@example.edu.vn' })),
      'POST /api/admin/auth/reauth': json({ reauthValidUntil: '2026-10-31T03:10:00.000Z' }),
    });
    renderAdmin(`/users/${USER_DETAIL.id}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Hiện dữ liệu đầy đủ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xác thực lại' });
    await userEvent.type(within(dialog).getByLabelText('Mật khẩu'), 'mat-khau');
    await userEvent.type(within(dialog).getByLabelText('Mã xác thực'), '123456');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận' }));
    expect(await screen.findByText('SV2023001')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.callsTo('POST', REVEAL.slice(5))).toHaveLength(2);
    expect(JSON.parse(api.callsTo('POST', '/api/admin/auth/reauth')[0].init.body)).toEqual({ password: 'mat-khau', code: '123456' });
  });

  test('sai mật khẩu: giữ hộp thoại, báo lỗi, không thực hiện thao tác', async () => {
    const api = mockApi({
      ...LOGGED_IN,
      ...USER_ROUTE,
      [REVEAL]: REAUTH_REQUIRED,
      'POST /api/admin/auth/reauth': json({ error: 'Mật khẩu hoặc mã xác thực không đúng.', code: 'reauth_failed' }, 401),
    });
    renderAdmin(`/users/${USER_DETAIL.id}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Hiện dữ liệu đầy đủ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xác thực lại' });
    await userEvent.type(within(dialog).getByLabelText('Mật khẩu'), 'sai');
    await userEvent.type(within(dialog).getByLabelText('Mã xác thực'), '000000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('không đúng');
    expect(api.callsTo('POST', REVEAL.slice(5))).toHaveLength(1);
  });

  test('hủy xác thực lại: thao tác không xảy ra, không hiện thông báo lỗi', async () => {
    mockApi({ ...LOGGED_IN, ...USER_ROUTE, [REVEAL]: REAUTH_REQUIRED });
    renderAdmin(`/users/${USER_DETAIL.id}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Hiện dữ liệu đầy đủ' }));
    const dialog = await screen.findByRole('dialog', { name: 'Xác thực lại' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Hủy' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('SV***01')).toBeInTheDocument();
    expect(screen.queryByText(/Đã hủy/)).not.toBeInTheDocument();
  });
});
