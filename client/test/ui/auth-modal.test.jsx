// Popup đăng nhập / đăng ký: cấu hình nhà cung cấp (bảng quyết định), email + mật khẩu, mã kích hoạt tài khoản cũ,
// quên / đặt lại mật khẩu, hoàn tất đăng ký sau OAuth, đăng nhập QR (mã QR giả lập, đồng hồ giả)
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { PROVIDERS, USER, json, mockApi } from '../helpers';

const webauthn = vi.hoisted(() => ({ browserSupportsWebAuthn: vi.fn(), startAuthentication: vi.fn(), startRegistration: vi.fn() }));

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async (text) => `data:image/png;base64,${btoa(text)}`) } }));
vi.mock('@simplewebauthn/browser', () => webauthn);

beforeEach(() => {
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.startAuthentication.mockReset();
});

const NOT_LOGGED_IN = { 'GET /api/auth/me': json({ error: 'x', code: 'auth_required' }, 401) };
const providers = (patch = {}) => json({ providers: { ...PROVIDERS.providers, ...patch } });

/** Nạp lại module mỗi lần để bộ nhớ đệm cấu hình nhà cung cấp (useAuthProviders) không dùng chung giữa các test */
async function renderModal(routes, props = {}) {
  vi.resetModules();
  const api = mockApi({ ...NOT_LOGGED_IN, 'GET /api/auth/providers': providers(), ...routes });
  const [{ UserProvider, useUser }, { default: AuthModal }] = await Promise.all([
    import('../../src/context/UserContext'),
    import('../../src/components/AuthModal'),
  ]);
  const onClose = vi.fn();
  let current;
  function Probe() {
    current = useUser();
    return null;
  }
  render(
    <MemoryRouter>
      <UserProvider>
        <Probe />
        <AuthModal onClose={onClose} {...props} />
      </UserProvider>
    </MemoryRouter>
  );
  const dialog = await screen.findByRole('dialog');
  return { api, onClose, dialog, user: () => current };
}

const field = (dialog, label) => within(dialog).getByLabelText(label);
const body = (api, method, path) => JSON.parse(api.callsTo(method, path).at(-1).init.body);

describe('phương thức đăng nhập theo cấu hình server', () => {
  test('Google/Facebook chưa cấu hình → nút bị khóa, ghi "Chưa cấu hình"; QR bật', async () => {
    const { dialog } = await renderModal({});
    const google = await within(dialog).findByRole('button', { name: /Tiếp tục với Google/ });
    await waitFor(() => expect(google).toHaveTextContent('Chưa cấu hình'));
    expect(google).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Tiếp tục với Facebook/ })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Đăng nhập bằng mã QR/ })).toBeEnabled();
  });

  test('không hỏi được server → mọi phương thức ngoài email báo "Không kết nối được máy chủ"', async () => {
    const { dialog } = await renderModal({ 'GET /api/auth/providers': () => Promise.reject(new TypeError('offline')) });
    await waitFor(() => expect(within(dialog).getAllByText('Không kết nối được máy chủ')).toHaveLength(3));
    expect(within(dialog).getByRole('button', { name: 'Đăng nhập' })).toBeEnabled();
  });

  test('Google đã cấu hình → chuyển cả trang tới /api/auth/google/start, khóa các nút khác', async () => {
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, origin: 'http://localhost:5173' });
    const { dialog } = await renderModal({ 'GET /api/auth/providers': providers({ google: { enabled: true } }) });
    const google = await within(dialog).findByRole('button', { name: /Tiếp tục với Google/ });
    await waitFor(() => expect(google).toBeEnabled());
    await userEvent.click(google);
    expect(assign).toHaveBeenCalledWith('/api/auth/google/start?mode=login');
    expect(google).toHaveTextContent('Đang chuyển tới Google...');
    expect(within(dialog).getByRole('button', { name: /Đăng nhập bằng mã QR/ })).toBeDisabled();
  });
});

describe('tài khoản đã bật 2FA', () => {
  const MFA_REQUIRED = json({ mfaRequired: true });
  const loginWithPassword = async (dialog) => {
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.type(field(dialog, 'Mật khẩu *'), 'mat-khau-an-toan');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đăng nhập' }));
  };

  test('mật khẩu đúng chưa đăng nhập: hỏi mã, mã sai báo lỗi và xóa ô nhập, mã đúng mới có phiên', async () => {
    let attempts = 0;
    const { api, dialog, user } = await renderModal({
      'POST /api/auth/login': MFA_REQUIRED,
      'POST /api/auth/mfa/verify': () =>
        (attempts += 1) === 1 ? json({ error: 'Mã xác thực không đúng hoặc đã được dùng.', code: 'invalid_mfa_code' }, 401) : json({ user: USER }),
    });
    await loginWithPassword(dialog);
    const code = await within(dialog).findByLabelText('Mã xác thực *');
    expect(screen.getByRole('dialog', { name: 'Xác thực hai lớp' })).toBeInTheDocument();
    expect(user().isLoggedIn).toBe(false);

    await userEvent.type(code, '000000');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Mã xác thực không đúng hoặc đã được dùng.');
    expect(code).toHaveValue('');
    expect(user().isLoggedIn).toBe(false);

    await userEvent.type(code, ' 123456 ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận' }));
    expect(await within(dialog).findByText('Đăng nhập thành công')).toBeInTheDocument();
    expect(user().isLoggedIn).toBe(true);
    expect(body(api, 'POST', '/api/auth/mfa/verify')).toEqual({ code: '123456' });
  });

  test('lượt đăng nhập hết hạn: báo lỗi, quay lại được màn đăng nhập', async () => {
    const { dialog } = await renderModal({
      'POST /api/auth/login': MFA_REQUIRED,
      'POST /api/auth/mfa/verify': json({ error: 'Lượt đăng nhập đã hết hạn. Hãy đăng nhập lại.', code: 'mfa_expired' }, 401),
    });
    await loginWithPassword(dialog);
    await userEvent.type(await within(dialog).findByLabelText('Mã xác thực *'), '123456');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Xác nhận' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Lượt đăng nhập đã hết hạn');
    await userEvent.click(within(dialog).getByRole('button', { name: '← Quay lại đăng nhập' }));
    expect(field(dialog, 'Mật khẩu *')).toBeInTheDocument();
  });

  test('đặt lại mật khẩu xong vẫn phải qua bước hai, không báo đã đăng nhập', async () => {
    const { dialog, user } = await renderModal({ 'POST /api/auth/password/reset': MFA_REQUIRED }, { initialView: 'reset', resetToken: 'T'.repeat(43) });
    await userEvent.type(field(dialog, 'Mật khẩu mới (ít nhất 8 ký tự) *'), 'mat-khau-moi-123');
    await userEvent.type(field(dialog, 'Nhập lại mật khẩu mới *'), 'mat-khau-moi-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(await within(dialog).findByLabelText('Mã xác thực *')).toBeInTheDocument();
    expect(user().isLoggedIn).toBe(false);
  });
});

describe('CAPTCHA', () => {
  const CAPTCHA = { challenge: 'c'.repeat(43), iterations: 1, bits: 0, expiresAt: '2999-01-01T00:00:00.000Z' };
  const REQUIRED = json({ error: 'Cần xác minh bạn không phải chương trình tự động. Vui lòng thử lại.', code: 'captcha_required' }, 403);

  test('máy chủ đòi CAPTCHA: trình duyệt tự giải rồi gửi lại, người dùng không thấy lỗi', async () => {
    let attempts = 0;
    const { api, dialog } = await renderModal({
      'POST /api/auth/captcha': json(CAPTCHA),
      'POST /api/auth/login': () => ((attempts += 1) === 1 ? REQUIRED : json({ user: USER })),
    });
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.type(field(dialog, 'Mật khẩu *'), 'mat-khau-an-toan');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đăng nhập' }));
    expect(await within(dialog).findByText('Đăng nhập thành công')).toBeInTheDocument();
    expect(body(api, 'POST', '/api/auth/login')).toEqual({ email: 'an@example.edu.vn', password: 'mat-khau-an-toan', captcha: { challenge: CAPTCHA.challenge, nonce: '0' } });
  });

  test('giải xong vẫn bị từ chối: chỉ gửi lại một lần rồi báo lỗi', async () => {
    const { api, dialog } = await renderModal({ 'POST /api/auth/captcha': json(CAPTCHA), 'POST /api/auth/login': REQUIRED });
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.type(field(dialog, 'Mật khẩu *'), 'mat-khau-an-toan');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đăng nhập' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Cần xác minh bạn không phải chương trình tự động.');
    expect(api.callsTo('POST', '/api/auth/login')).toHaveLength(2);
    expect(api.callsTo('POST', '/api/auth/captcha')).toHaveLength(1);
  });

  test('quên mật khẩu và gửi lại thư xác minh cũng tự giải', async () => {
    let forgot = 0;
    let resend = 0;
    const routes = {
      'POST /api/auth/captcha': json(CAPTCHA),
      'POST /api/auth/password/forgot': () => ((forgot += 1) === 1 ? REQUIRED : json({ message: 'Đã gửi nếu email tồn tại.' })),
      'POST /api/auth/email/resend': () => ((resend += 1) === 1 ? REQUIRED : json({ message: 'Đã gửi lại.' })),
    };
    const { api, dialog } = await renderModal(routes, { initialView: 'forgot' });
    await userEvent.type(await within(dialog).findByLabelText('Email *'), 'an@example.edu.vn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi email đặt lại' }));
    expect(await within(dialog).findByText(/Đã gửi nếu email tồn tại/)).toBeInTheDocument();
    expect(body(api, 'POST', '/api/auth/password/forgot').captcha.nonce).toBe('0');

    await userEvent.click(within(dialog).getByRole('button', { name: '← Quay lại đăng nhập' }));
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Chưa nhận được email xác minh?' }));
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi lại email xác minh' }));
    expect(await within(dialog).findByText(/Đã gửi lại/)).toBeInTheDocument();
    expect(body(api, 'POST', '/api/auth/email/resend').captcha.nonce).toBe('0');
  });
});

describe('passkey', () => {
  const passkeyButton = (dialog) => within(dialog).findByRole('button', { name: /Đăng nhập bằng passkey/ });
  const ASSERTION = { id: 'khoa-1', type: 'public-key', response: {} };

  test('trình duyệt không hỗ trợ: nút bị khóa, nói rõ lý do', async () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    const { dialog } = await renderModal({});
    const button = await passkeyButton(dialog);
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Trình duyệt chưa hỗ trợ');
  });

  test('thành công: gửi đúng phản hồi của thiết bị lên máy chủ, có phiên', async () => {
    webauthn.startAuthentication.mockResolvedValue(ASSERTION);
    const { api, dialog, user } = await renderModal({
      'POST /api/auth/passkeys/login/options': json({ challenge: 'thu-thach' }),
      'POST /api/auth/passkeys/login/verify': json({ user: USER }),
    });
    await userEvent.click(await passkeyButton(dialog));
    expect(await within(dialog).findByText('Đăng nhập bằng passkey thành công')).toBeInTheDocument();
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: 'thu-thach' } });
    expect(body(api, 'POST', '/api/auth/passkeys/login/verify')).toEqual({ response: ASSERTION });
    expect(user().isLoggedIn).toBe(true);
  });

  test('người dùng hủy trên thiết bị: báo tiếng Việt, không gửi gì lên máy chủ, thử lại được', async () => {
    webauthn.startAuthentication.mockRejectedValue(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
    const { api, dialog } = await renderModal({ 'POST /api/auth/passkeys/login/options': json({ challenge: 'thu-thach' }) });
    await userEvent.click(await passkeyButton(dialog));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Bạn đã hủy, hoặc thiết bị chưa xác nhận được passkey.');
    expect(api.callsTo('POST', '/api/auth/passkeys/login/verify')).toHaveLength(0);
    expect(await passkeyButton(dialog)).toBeEnabled();
  });

  test('máy chủ từ chối: hiện thông báo của máy chủ', async () => {
    webauthn.startAuthentication.mockResolvedValue(ASSERTION);
    const { dialog } = await renderModal({
      'POST /api/auth/passkeys/login/options': json({ challenge: 'thu-thach' }),
      'POST /api/auth/passkeys/login/verify': json({ error: 'Không xác minh được passkey. Vui lòng thử lại.', code: 'passkey_invalid' }, 400),
    });
    await userEvent.click(await passkeyButton(dialog));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Không xác minh được passkey.');
  });
});

describe('email + mật khẩu', () => {
  test('đăng nhập thành công → cập nhật phiên, báo thành công rồi tự đóng', async () => {
    const { api, dialog, onClose, user } = await renderModal({ 'POST /api/auth/login': json({ user: USER }) });
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.type(field(dialog, 'Mật khẩu *'), 'mat-khau-an-toan');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Đăng nhập' }));
    expect(await within(dialog).findByText('Đăng nhập thành công')).toBeInTheDocument();
    expect(within(dialog).getByText('Xin chào, Nguyễn An!')).toBeInTheDocument();
    expect(body(api, 'POST', '/api/auth/login')).toEqual({ email: 'an@example.edu.vn', password: 'mat-khau-an-toan' });
    expect(user().isLoggedIn).toBe(true);
    await waitFor(() => expect(onClose).toHaveBeenCalled(), { timeout: 2500 });
  });

  test('sai mật khẩu / bị khóa tạm → hiển thị thông báo của server, nút trở lại dùng được', async () => {
    let attempt = 0;
    const { dialog } = await renderModal({
      'POST /api/auth/login': () =>
        (attempt += 1) === 1
          ? json({ error: 'Email hoặc mật khẩu không đúng.', code: 'invalid_credentials' }, 401)
          : json({ error: 'Bạn đã đăng nhập sai quá nhiều lần.', code: 'too_many_attempts' }, 429),
    });
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.type(field(dialog, 'Mật khẩu *'), 'sai');
    const submit = within(dialog).getByRole('button', { name: 'Đăng nhập' });
    await userEvent.click(submit);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Email hoặc mật khẩu không đúng.');
    await userEvent.click(submit);
    expect(await within(dialog).findByText('Bạn đã đăng nhập sai quá nhiều lần.')).toBeInTheDocument();
    expect(submit).toBeEnabled();
  });

  /** Điền form đăng ký và gửi */
  async function submitRegistration(dialog) {
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Tạo tài khoản' }));
    await userEvent.type(field(dialog, 'Họ và tên *'), 'Nguyễn An');
    await userEvent.type(field(dialog, 'Mã sinh viên *'), 'SV001');
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.type(field(dialog, 'Mật khẩu (ít nhất 8 ký tự) *'), 'mat-khau-an-toan');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo tài khoản' }));
  }

  const SENT = { ok: true, message: 'Chúng tôi đã gửi một email tới địa chỉ bạn vừa nhập.', devConsole: false };

  test('đăng ký: chỉ gửi họ tên, mã SV, email, mật khẩu; sang màn chờ xác minh, chưa đăng nhập, không còn mật khẩu trên màn hình', async () => {
    const { api, dialog, user } = await renderModal({ 'POST /api/auth/register': json(SENT, 202) });
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Tạo tài khoản' }));
    expect(within(dialog).getByRole('tab', { name: 'Tạo tài khoản' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Đăng nhập' }));
    await submitRegistration(dialog);
    expect(body(api, 'POST', '/api/auth/register')).toEqual({ name: 'Nguyễn An', studentId: 'SV001', email: 'an@example.edu.vn', password: 'mat-khau-an-toan' });
    expect(await screen.findByRole('dialog', { name: 'Kiểm tra email của bạn' })).toBeInTheDocument();
    expect(within(dialog).getByRole('status')).toHaveTextContent('Chúng tôi đã gửi một email');
    expect(within(dialog).getByText(/Tài khoản chỉ hoạt động sau khi bạn mở liên kết/)).toBeInTheDocument();
    expect(user().isLoggedIn).toBe(false);
    expect(within(dialog).queryByLabelText('Mật khẩu (ít nhất 8 ký tự) *')).not.toBeInTheDocument();
  });

  test('màn chờ xác minh: gửi lại đúng email, khóa nút trong lúc đếm ngược; lỗi 429 hiển thị; quay lại đăng nhập được', async () => {
    let attempt = 0;
    const { api, dialog } = await renderModal({
      'POST /api/auth/register': json(SENT, 202),
      'POST /api/auth/email/resend': () =>
        (attempt += 1) === 1
          ? json({ error: 'Bạn đã yêu cầu gửi email xác minh quá nhiều lần.', code: 'too_many_attempts' }, 429)
          : json({ ok: true, message: 'Nếu email này đang chờ xác minh, một liên kết mới sẽ được gửi.', devConsole: false }, 202),
    });
    await submitRegistration(dialog);
    const resend = await within(dialog).findByRole('button', { name: 'Gửi lại email xác minh' });
    await userEvent.click(resend);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('quá nhiều lần');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi lại email xác minh' }));
    expect(await within(dialog).findByText(/một liên kết mới sẽ được gửi/)).toBeInTheDocument();
    expect(body(api, 'POST', '/api/auth/email/resend')).toEqual({ email: 'an@example.edu.vn' });
    expect(await within(dialog).findByRole('button', { name: /Gửi lại sau \d+ giây/ })).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('button', { name: /Quay lại đăng nhập/ }));
    expect(await within(dialog).findByRole('tab', { name: 'Đăng nhập' })).toBeInTheDocument();
  });

  test('chế độ phát triển được ghi rõ trên màn chờ xác minh', async () => {
    const { dialog } = await renderModal({ 'POST /api/auth/register': json({ ...SENT, devConsole: true }, 202) });
    await submitRegistration(dialog);
    expect(await within(dialog).findByText(/Chế độ phát triển: email được ghi vào log máy chủ/)).toBeInTheDocument();
  });

  test('máy chủ chưa cấu hình email: tab đăng ký báo "Chưa cấu hình", không có form, không gọi API; tab đăng nhập vẫn dùng được', async () => {
    const { api, dialog } = await renderModal({ 'GET /api/auth/providers': providers({ emailVerification: { enabled: false } }) });
    await waitFor(() => expect(api.callsTo('GET', '/api/auth/providers')).toHaveLength(1));
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Tạo tài khoản' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Đăng ký bằng email chưa sẵn sàng');
    expect(within(dialog).getByText('Chưa cấu hình', { selector: 'span.rounded-full.bg-stone-200' })).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Họ và tên *')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('tab', { name: 'Đăng nhập' }));
    expect(within(dialog).getByLabelText('Mật khẩu *')).toBeEnabled();
  });

  test('server báo lỗi khi đăng ký (chưa cấu hình, SMTP lỗi, mật khẩu phổ biến, 429): ở lại form, không báo đã gửi', async () => {
    const errors = [
      json({ error: 'Máy chủ chưa cấu hình gửi email.', code: 'email_not_configured' }, 503),
      json({ error: 'Chưa gửi được email xác minh nên tài khoản chưa được tạo.', code: 'email_send_failed' }, 502),
      json({ error: 'Mật khẩu này quá phổ biến nên dễ bị đoán.', code: 'invalid_input' }, 400),
      json({ error: 'Mạng của bạn đã gửi quá nhiều yêu cầu đăng ký.', code: 'too_many_attempts' }, 429),
    ];
    let attempt = 0;
    const { dialog } = await renderModal({ 'POST /api/auth/register': () => errors[attempt++] });
    await submitRegistration(dialog);
    for (const text of ['chưa cấu hình gửi email', 'Chưa gửi được email xác minh', 'quá phổ biến', 'quá nhiều yêu cầu đăng ký']) {
      await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent(text));
      expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
      if (attempt < errors.length) await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo tài khoản' }));
    }
  });
});

describe('xác minh email', () => {
  const TOKEN = 'V'.repeat(43);
  const open = (routes) => renderModal(routes, { initialView: 'verify-email', verifyToken: TOKEN });
  const activate = async (dialog) => {
    await userEvent.click(within(dialog).getByRole('button', { name: 'Kích hoạt tài khoản' }));
  };

  test('nhập đúng mật khẩu: gửi token trong body, đăng nhập, báo thành công', async () => {
    const { api, dialog, user } = await open({ 'POST /api/auth/email/verify': json({ user: USER, claimed: false }, 201) });
    await userEvent.type(field(dialog, 'Mật khẩu đã đặt khi đăng ký *'), 'mat-khau-an-toan');
    await activate(dialog);
    expect(await within(dialog).findByText('Tạo tài khoản thành công')).toBeInTheDocument();
    expect(body(api, 'POST', '/api/auth/email/verify')).toEqual({ token: TOKEN, password: 'mat-khau-an-toan' });
    expect(api.callsTo('POST', '/api/auth/email/verify')[0].path).toBe('/api/auth/email/verify');
    expect(user().isLoggedIn).toBe(true);
  });

  test('sai mật khẩu: giữ form để nhập lại, thông báo của server hiển thị', async () => {
    let attempt = 0;
    const { dialog } = await open({
      'POST /api/auth/email/verify': () =>
        (attempt += 1) === 1
          ? json({ error: 'Mật khẩu chưa đúng với mật khẩu đã đặt khi đăng ký.', code: 'invalid_password' }, 400)
          : json({ user: USER, claimed: false }, 201),
    });
    await userEvent.type(field(dialog, 'Mật khẩu đã đặt khi đăng ký *'), 'sai-mat-khau');
    await activate(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Mật khẩu chưa đúng');
    await activate(dialog);
    expect(await within(dialog).findByText('Tạo tài khoản thành công')).toBeInTheDocument();
  });

  test('liên kết hết hạn hoặc đã dùng: chuyển sang màn gửi lại, nhập email rồi gửi', async () => {
    const { api, dialog } = await open({
      'POST /api/auth/email/verify': json({ error: 'Liên kết xác minh không hợp lệ, đã hết hạn hoặc đã được sử dụng.', code: 'verification_token_invalid' }, 400),
      'POST /api/auth/email/resend': json({ ok: true, message: 'Nếu email này đang chờ xác minh, một liên kết mới sẽ được gửi.', devConsole: true }, 202),
    });
    await userEvent.type(field(dialog, 'Mật khẩu đã đặt khi đăng ký *'), 'mat-khau-an-toan');
    await activate(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('đã hết hạn hoặc đã được sử dụng');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi lại email xác minh' }));
    await userEvent.type(await within(dialog).findByLabelText('Email *'), 'an@example.edu.vn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi lại email xác minh' }));
    expect(await within(dialog).findByText(/một liên kết mới sẽ được gửi/)).toBeInTheDocument();
    expect(body(api, 'POST', '/api/auth/email/resend')).toEqual({ email: 'an@example.edu.vn' });
  });

  test('thiếu token: báo liên kết không hợp lệ ngay, không gọi API', async () => {
    const { api, dialog } = await renderModal({}, { initialView: 'verify-email' });
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Liên kết xác minh không hợp lệ');
    expect(api.callsTo('POST', '/api/auth/email/verify')).toHaveLength(0);
  });

  test('thông tin trùng tài khoản đang có: thông báo chung, không mời gửi lại, quay về đăng nhập được', async () => {
    const { dialog } = await open({
      'POST /api/auth/email/verify': json({ error: 'Không thể hoàn tất đăng ký vì thông tin đã nhập trùng với một tài khoản đang có.', code: 'registration_conflict' }, 409),
    });
    await userEvent.type(field(dialog, 'Mật khẩu đã đặt khi đăng ký *'), 'mat-khau-an-toan');
    await activate(dialog);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('trùng với một tài khoản đang có');
    expect(within(dialog).queryByRole('button', { name: 'Gửi lại email xác minh' })).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /Quay lại đăng nhập/ }));
    expect(await within(dialog).findByRole('tab', { name: 'Đăng nhập' })).toBeInTheDocument();
  });

  test('tài khoản cũ: bước xác minh mới hiện ô mã kích hoạt, gửi kèm mã rồi nhận lại tài khoản', async () => {
    let attempt = 0;
    const { api, dialog } = await open({
      'POST /api/auth/email/verify': () =>
        (attempt += 1) === 1
          ? json({ error: 'Mã sinh viên này thuộc một tài khoản tạo trước khi có đăng nhập bảo mật.', code: 'legacy_claim_required' }, 409)
          : json({ user: USER, claimed: true }, 201),
    });
    await userEvent.type(field(dialog, 'Mật khẩu đã đặt khi đăng ký *'), 'mat-khau-an-toan');
    await activate(dialog);
    expect(await within(dialog).findByText(/thuộc một tài khoản tạo trước/)).toBeInTheDocument();
    await userEvent.type(field(dialog, 'Mã kích hoạt tài khoản cũ *'), 'abcd-efgh-2345');
    await activate(dialog);
    expect(body(api, 'POST', '/api/auth/email/verify').claimCode).toBe('abcd-efgh-2345');
    expect(await within(dialog).findByText('Đã nhận lại tài khoản cũ')).toBeInTheDocument();
  });

  test('từ tab Đăng nhập mở được màn gửi lại email xác minh; máy chủ chưa cấu hình → hiện lỗi, không báo đã gửi', async () => {
    const { dialog } = await renderModal({
      'POST /api/auth/email/resend': json({ error: 'Máy chủ chưa cấu hình gửi email.', code: 'email_not_configured' }, 503),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Chưa nhận được email xác minh?' }));
    expect(await screen.findByRole('dialog', { name: 'Gửi lại email xác minh' })).toBeInTheDocument();
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi lại email xác minh' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('chưa cấu hình gửi email');
    await userEvent.click(within(dialog).getByRole('button', { name: /Quay lại đăng nhập/ }));
    expect(await within(dialog).findByRole('tab', { name: 'Đăng nhập' })).toBeInTheDocument();
  });
});

describe('quên / đặt lại mật khẩu', () => {
  test('server chưa cấu hình email → báo "Chưa cấu hình", không có ô nhập', async () => {
    const { dialog } = await renderModal({ 'GET /api/auth/providers': providers({ passwordReset: { enabled: false } }) });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Quên mật khẩu?' }));
    expect(await within(dialog).findByText('Chưa cấu hình')).toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Email *')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: /Chọn phương thức khác/ }));
    expect(within(dialog).getByRole('tab', { name: 'Đăng nhập' })).toBeInTheDocument();
  });

  test('gửi yêu cầu → thông báo chung (không lộ email có tồn tại); chế độ console được ghi rõ; lỗi 429 hiển thị', async () => {
    let attempt = 0;
    const { dialog } = await renderModal({
      'GET /api/auth/providers': providers({ passwordReset: { enabled: true, devConsole: true } }),
      'POST /api/auth/password/forgot': () =>
        (attempt += 1) === 1
          ? json({ error: 'Bạn đã yêu cầu đặt lại mật khẩu quá nhiều lần.', code: 'too_many_attempts' }, 429)
          : json({ ok: true, message: 'Nếu email này thuộc một tài khoản GreenCanteen, liên kết sẽ được gửi.', devConsole: true }, 202),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Quên mật khẩu?' }));
    await userEvent.type(await within(dialog).findByLabelText('Email *'), 'ai@example.edu.vn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi email đặt lại' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('quá nhiều lần');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi email đặt lại' }));
    expect(await within(dialog).findByText(/Nếu email này thuộc một tài khoản/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Chế độ phát triển: email được ghi vào log máy chủ/)).toBeInTheDocument();
  });

  test('đặt lại: thiếu token → liên kết không hợp lệ; mật khẩu nhập lại không khớp → không gọi API; token hết hạn → yêu cầu liên kết mới', async () => {
    const noToken = await renderModal({}, { initialView: 'reset' });
    expect(within(noToken.dialog).getByRole('alert')).toHaveTextContent('Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn.');
    await userEvent.click(within(noToken.dialog).getByRole('button', { name: 'Yêu cầu liên kết mới' }));
    expect(await screen.findByRole('dialog', { name: 'Quên mật khẩu' })).toBeInTheDocument();
  });

  test('đặt lại: nhập lại không khớp → không gọi API; server báo token không hợp lệ → chuyển màn liên kết hết hạn', async () => {
    const { api, dialog } = await renderModal(
      { 'POST /api/auth/password/reset': json({ error: 'Liên kết đặt lại mật khẩu không hợp lệ, đã hết hạn hoặc đã được sử dụng.', code: 'reset_token_invalid' }, 400) },
      { initialView: 'reset', resetToken: 'T'.repeat(43) }
    );
    await userEvent.type(field(dialog, 'Mật khẩu mới (ít nhất 8 ký tự) *'), 'mat-khau-moi-123');
    await userEvent.type(field(dialog, 'Nhập lại mật khẩu mới *'), 'mat-khau-khac-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Hai mật khẩu chưa khớp nhau.');
    expect(api.callsTo('POST', '/api/auth/password/reset')).toHaveLength(0);

    await userEvent.clear(field(dialog, 'Nhập lại mật khẩu mới *'));
    await userEvent.type(field(dialog, 'Nhập lại mật khẩu mới *'), 'mat-khau-moi-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(await within(dialog).findByRole('button', { name: 'Yêu cầu liên kết mới' })).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('đã hết hạn hoặc đã được sử dụng');
  });
});

describe('quên mật khẩu bằng mã trong email', () => {
  const CODE_PROVIDERS = { 'GET /api/auth/providers': providers({ passwordReset: { enabled: true, devConsole: false, code: true } }) };
  const SENT = json(
    {
      ok: true,
      message: 'Nếu email này thuộc một tài khoản GreenCanteen, mã 6 số và liên kết đặt lại mật khẩu sẽ được gửi tới hộp thư trong vài phút.',
      devConsole: false,
      codeLength: 6,
    },
    202
  );
  const CODE_LABEL = 'Mã 6 số trong email *';

  async function requestCode(dialog) {
    await userEvent.click(within(dialog).getByRole('button', { name: 'Quên mật khẩu?' }));
    expect(await within(dialog).findByText(/mã 6 số và liên kết để đặt mật khẩu mới/)).toBeInTheDocument();
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi email đặt lại' }));
    return within(dialog).findByLabelText(CODE_LABEL);
  }

  async function fillPasswords(dialog, password, confirm = password) {
    await userEvent.type(field(dialog, 'Mật khẩu mới (ít nhất 8 ký tự) *'), password);
    await userEvent.type(field(dialog, 'Nhập lại mật khẩu mới *'), confirm);
  }

  test('nhập mã dán từ thư (có dấu cách) + mật khẩu mới ngay trong popup → đăng nhập', async () => {
    const { api, dialog, user } = await renderModal({
      ...CODE_PROVIDERS,
      'POST /api/auth/password/forgot': SENT,
      'POST /api/auth/password/reset-code': json({ user: USER }),
    });
    const code = await requestCode(dialog);
    expect(within(dialog).getByRole('status')).toHaveTextContent('mã 6 số và liên kết');
    expect(within(dialog).getByText('an@example.edu.vn')).toBeInTheDocument();
    expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    expect(code).toHaveAttribute('inputmode', 'numeric');
    await userEvent.click(code);
    await userEvent.paste('123 456');
    expect(code).toHaveValue('123456');
    await fillPasswords(dialog, 'mat-khau-moi-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(await within(dialog).findByText('Đã đặt mật khẩu mới')).toBeInTheDocument();
    expect(body(api, 'POST', '/api/auth/password/reset-code')).toEqual({ email: 'an@example.edu.vn', code: '123456', password: 'mat-khau-moi-123' });
    expect(user().isLoggedIn).toBe(true);
  });

  test('mã thiếu số hoặc mật khẩu nhập lại không khớp → không gọi API; mã sai → báo lỗi, xóa ô mã, giữ mật khẩu', async () => {
    const { api, dialog } = await renderModal({
      ...CODE_PROVIDERS,
      'POST /api/auth/password/forgot': SENT,
      'POST /api/auth/password/reset-code': json({ error: 'Mã không đúng hoặc đã hết hạn.', code: 'reset_code_invalid' }, 400),
    });
    const code = await requestCode(dialog);
    await userEvent.type(code, '12a34');
    expect(code).toHaveValue('1234');
    await fillPasswords(dialog, 'mat-khau-moi-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Mã gồm 6 chữ số.');

    await userEvent.type(code, '567890');
    expect(code).toHaveValue('123456');
    await userEvent.type(field(dialog, 'Nhập lại mật khẩu mới *'), 'x');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Hai mật khẩu chưa khớp nhau.');
    expect(api.callsTo('POST', '/api/auth/password/reset-code')).toHaveLength(0);

    await userEvent.type(field(dialog, 'Nhập lại mật khẩu mới *'), '{Backspace}');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Mã không đúng hoặc đã hết hạn.');
    expect(code).toHaveValue('');
    expect(field(dialog, 'Mật khẩu mới (ít nhất 8 ký tự) *')).toHaveValue('mat-khau-moi-123');
    expect(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' })).toBeEnabled();
  });

  test('tài khoản bật 2FA: đặt mật khẩu bằng mã xong vẫn phải qua bước hai', async () => {
    const { dialog, user } = await renderModal({
      ...CODE_PROVIDERS,
      'POST /api/auth/password/forgot': SENT,
      'POST /api/auth/password/reset-code': json({ mfaRequired: true }),
    });
    await userEvent.type(await requestCode(dialog), '123456');
    await fillPasswords(dialog, 'mat-khau-moi-123');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Lưu mật khẩu mới' }));
    expect(await within(dialog).findByLabelText('Mã xác thực *')).toBeInTheDocument();
    expect(user().isLoggedIn).toBe(false);
  });

  test('gửi lại mã: khóa 60 giây, gửi lại báo mã cũ hết hiệu lực; "Đổi email" quay về ô nhập email', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { api, dialog } = await renderModal({ ...CODE_PROVIDERS, 'POST /api/auth/password/forgot': SENT });
      const ue = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
      await requestCode(dialog);
      expect(within(dialog).getByRole('button', { name: /Gửi lại mã sau \d+ giây/ })).toBeDisabled();
      // Đồng hồ đếm ngược đặt lại setTimeout sau mỗi lần vẽ → tiến từng giây trong act để React kịp vẽ và hẹn giây tiếp theo
      for (let s = 0; s < 61; s += 1) await act(() => vi.advanceTimersByTimeAsync(1000));
      await ue.click(await within(dialog).findByRole('button', { name: 'Gửi lại mã' }));
      expect(await within(dialog).findByText(/Mã và liên kết trong email trước \(nếu có\) không còn dùng được/)).toBeInTheDocument();
      expect(api.callsTo('POST', '/api/auth/password/forgot')).toHaveLength(2);
      expect(body(api, 'POST', '/api/auth/password/forgot')).toEqual({ email: 'an@example.edu.vn' });
      expect(within(dialog).getByRole('button', { name: /Gửi lại mã sau \d+ giây/ })).toBeDisabled();

      await ue.click(within(dialog).getByRole('button', { name: 'Đổi email' }));
      expect(field(dialog, 'Email *')).toHaveValue('an@example.edu.vn');
      expect(within(dialog).queryByLabelText(CODE_LABEL)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  test('máy chủ không phát mã (codeLength 0): chỉ hướng dẫn mở liên kết, không có ô nhập mã', async () => {
    const { dialog } = await renderModal({
      'POST /api/auth/password/forgot': json({ ok: true, message: 'Nếu email này thuộc một tài khoản GreenCanteen, liên kết sẽ được gửi.', codeLength: 0 }, 202),
    });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Quên mật khẩu?' }));
    expect(await within(dialog).findByText(/bạn sẽ nhận được liên kết đặt mật khẩu mới/)).toBeInTheDocument();
    await userEvent.type(field(dialog, 'Email *'), 'an@example.edu.vn');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Gửi email đặt lại' }));
    expect(await within(dialog).findByText(/liên kết sẽ được gửi/)).toBeInTheDocument();
    expect(within(dialog).queryByLabelText(CODE_LABEL)).not.toBeInTheDocument();
  });
});

describe('hoàn tất đăng ký sau Google / Facebook', () => {
  test('điền mã SV → tạo tài khoản; phiên tạm hết hạn → báo và quay lại', async () => {
    let attempt = 0;
    const { api, dialog } = await renderModal(
      {
        'GET /api/auth/signup/pending': json({ provider: 'facebook', name: 'Bạn FB', email: '' }),
        'POST /api/auth/signup/complete': () =>
          (attempt += 1) === 1
            ? json({ error: 'Mã sinh viên này đã có tài khoản.', code: 'student_id_taken' }, 409)
            : json({ user: USER, claimed: false }, 201),
      },
      { initialView: 'complete-signup' }
    );
    expect(await within(dialog).findByText(/Đã xác minh tài khoản Facebook\./)).toBeInTheDocument();
    await userEvent.type(field(dialog, 'Mã sinh viên *'), 'SV001');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo tài khoản' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Mã sinh viên này đã có tài khoản.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Tạo tài khoản' }));
    expect(await within(dialog).findByText('Tạo tài khoản thành công')).toBeInTheDocument();
    expect(body(api, 'POST', '/api/auth/signup/complete')).toEqual({ name: 'Bạn FB', studentId: 'SV001' });
  });

  test('phiên đăng ký hết hạn khi mở / khi gửi; nút Hủy xóa phiên tạm ở server', async () => {
    const expired = await renderModal(
      { 'GET /api/auth/signup/pending': json({ error: 'Phiên đăng ký đã hết hạn.', code: 'signup_expired' }, 404) },
      { initialView: 'complete-signup' }
    );
    expect(await within(expired.dialog).findByRole('alert')).toHaveTextContent('Phiên đăng ký đã hết hạn.');
  });

  test('Hủy → DELETE phiên tạm rồi về danh sách phương thức', async () => {
    const { api, dialog } = await renderModal(
      {
        'GET /api/auth/signup/pending': json({ provider: 'google', name: 'G', email: 'g@gmail.com' }),
        'DELETE /api/auth/signup/pending': json({ ok: true }),
      },
      { initialView: 'complete-signup' }
    );
    await userEvent.click(await within(dialog).findByRole('button', { name: 'Hủy' }));
    expect(api.callsTo('DELETE', '/api/auth/signup/pending')).toHaveLength(1);
    expect(await within(dialog).findByRole('tab', { name: 'Đăng nhập' })).toBeInTheDocument();
  });
});

describe('đăng nhập bằng mã QR', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

  test('QR chỉ chứa challengeId (không chứa pollToken); chờ → được xác nhận → đăng nhập', async () => {
    const qrcode = (await import('qrcode')).default;
    let polls = 0;
    const { dialog } = await renderModal({
      'POST /api/auth/qr/start': json({ challengeId: 'CHALLENGE_ABCDEFGHIJKLMNOPQRSTU', pollToken: 'POLL_SECRET_ABCDEFGHIJKLMNOPQRSTUVWXYZ', matchCode: '4821', expiresInMs: 120000, pollIntervalMs: 2000 }),
      'POST /api/auth/qr/poll': () => ((polls += 1) < 2 ? json({ status: 'pending' }) : json({ status: 'approved', user: USER })),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(within(dialog).getByRole('button', { name: /Đăng nhập bằng mã QR/ }));
    expect(await within(dialog).findByAltText('Mã QR đăng nhập GreenCanteen')).toBeInTheDocument();
    const encoded = qrcode.toDataURL.mock.calls.at(-1)[0];
    expect(encoded).toMatch(/\/profile\?qr=CHALLENGE_ABCDEFGHIJKLMNOPQRSTU$/);
    expect(encoded).not.toContain('POLL_SECRET');
    expect(encoded).not.toContain('4821');
    expect(within(dialog).getByText('4821')).toBeInTheDocument();
    expect(within(dialog).getByText(/hết hạn sau 2:00/)).toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(4100));
    expect(await within(dialog).findByText('Đăng nhập bằng mã QR thành công')).toBeInTheDocument();
  });

  test('bị từ chối → "Tạo mã mới" tạo thử thách mới; lỗi tạo mã → thông báo', async () => {
    let starts = 0;
    const { api, dialog } = await renderModal({
      'POST /api/auth/qr/start': () =>
        (starts += 1) === 1
          ? json({ challengeId: 'C1_ABCDEFGHIJKLMNOPQRSTUVW', pollToken: 'P1_ABCDEFGHIJKLMNOPQRSTUVW', expiresInMs: 120000, pollIntervalMs: 2000 })
          : json({ error: 'Đã tạo quá nhiều mã QR.', code: 'too_many_attempts' }, 429),
      'POST /api/auth/qr/poll': json({ status: 'rejected' }),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(within(dialog).getByRole('button', { name: /Đăng nhập bằng mã QR/ }));
    await within(dialog).findByAltText('Mã QR đăng nhập GreenCanteen');
    await act(() => vi.advanceTimersByTimeAsync(2100));
    expect(await within(dialog).findByText('Yêu cầu đăng nhập đã bị từ chối trên thiết bị kia.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Tạo mã mới' }));
    expect(await within(dialog).findByText('Đã tạo quá nhiều mã QR.')).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/auth/qr/start')).toHaveLength(2);
  });

  test('hết hạn theo đồng hồ máy → "Mã QR đã hết hạn."; lỗi mạng khi chờ không làm dừng việc chờ', async () => {
    let polls = 0;
    const { dialog } = await renderModal({
      'POST /api/auth/qr/start': json({ challengeId: 'C2_ABCDEFGHIJKLMNOPQRSTUVW', pollToken: 'P2_ABCDEFGHIJKLMNOPQRSTUVW', expiresInMs: 6000, pollIntervalMs: 2000 }),
      'POST /api/auth/qr/poll': () => ((polls += 1) === 1 ? Promise.reject(new TypeError('offline')) : json({ status: 'pending' })),
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(within(dialog).getByRole('button', { name: /Đăng nhập bằng mã QR/ }));
    await within(dialog).findByAltText('Mã QR đăng nhập GreenCanteen');
    await act(() => vi.advanceTimersByTimeAsync(14000));
    expect(await within(dialog).findByText('Mã QR đã hết hạn.')).toBeInTheDocument();
    expect(polls).toBeGreaterThan(2);
  });
});
