// Cài đặt bảo mật ở trang Cá nhân: bật, tắt 2FA, mã khôi phục, thêm, xóa passkey. Trọng tâm: phiên đã cũ phải hỏi lại mật khẩu,
// mã khôi phục chỉ hiện đúng một lần, và lỗi của thiết bị không lộ ra người dùng bằng thông báo kỹ thuật
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SECURITY, USER, json, mockApi } from '../helpers';

const webauthn = vi.hoisted(() => ({ browserSupportsWebAuthn: vi.fn(), startAuthentication: vi.fn(), startRegistration: vi.fn() }));

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(async () => 'data:image/png;base64,QR') } }));
vi.mock('@simplewebauthn/browser', () => webauthn);

const REAUTH = () => json({ error: 'Cần xác thực lại trước khi thay đổi cài đặt bảo mật.', code: 'reauth_required' }, 403);
const CODES = ['AAAA-BBBB-CCCC', 'DDDD-EEEE-FFFF'];
const ENABLED = { mfa: { available: true, enabled: true, recoveryCodesLeft: 8 }, passkeys: [] };
const NO_PASSWORD = { ...USER, authMethods: { password: false, google: true, facebook: false } };
const KEY = { id: 'a'.repeat(24), name: 'Điện thoại', backedUp: true, createdAt: '2026-10-01T03:00:00.000Z', lastUsedAt: '2026-10-20T03:00:00.000Z' };
const body = (api, path) => JSON.parse(api.callsTo('POST', path).at(-1).init.body);

/** `security` là mảng thì lần tải thứ n dùng phần tử thứ n: trạng thái sau thao tác do máy chủ quyết định */
async function renderSection(security, routes = {}, user = USER) {
  const states = Array.isArray(security) ? [...security] : [security];
  const api = mockApi({ 'GET /api/auth/security': () => json(states.length > 1 ? states.shift() : states[0]), ...routes });
  const { default: SecuritySection } = await import('../../src/components/SecuritySection');
  render(<SecuritySection user={user} />);
  return api;
}

const panel = async (heading) => (await screen.findByText(heading)).closest('div.rounded-xl');

beforeEach(() => {
  webauthn.browserSupportsWebAuthn.mockReturnValue(true);
  webauthn.startRegistration.mockReset();
});

describe('tải trạng thái', () => {
  test('máy chủ chưa có khóa: báo "Chưa cấu hình", không có nút bật giả', async () => {
    await renderSection({ mfa: { available: false, enabled: false, recoveryCodesLeft: 0 }, passkeys: [] });
    const mfa = await panel('Xác thực hai lớp');
    expect(mfa).toHaveTextContent('Chưa cấu hình');
    expect(within(mfa).queryByRole('button', { name: 'Bật' })).not.toBeInTheDocument();
  });

  test('không tải được: báo lỗi và cho thử lại, không hiện trạng thái đoán', async () => {
    const failing = mockApi({});
    const { default: SecuritySection } = await import('../../src/components/SecuritySection');
    render(<SecuritySection user={USER} />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Không kết nối được máy chủ');
    expect(screen.queryByText('Xác thực hai lớp')).not.toBeInTheDocument();
    expect(failing.calls).toHaveLength(1);

    mockApi({ 'GET /api/auth/security': json(SECURITY) });
    await userEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(await screen.findByText('Xác thực hai lớp')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('bật 2FA', () => {
  const SETUP = { 'POST /api/auth/mfa/setup': json({ secret: 'KHOAGIAMAU', otpauthUri: 'otpauth://totp/GreenCanteen:an?secret=KHOAGIAMAU' }) };

  test('hiện QR và khóa thủ công; mã sai báo lỗi; mã đúng hiện mã khôi phục, phải tích đã lưu mới đóng; đóng xong không xem lại được', async () => {
    let attempts = 0;
    const api = await renderSection([SECURITY, ENABLED], {
      ...SETUP,
      'POST /api/auth/mfa/enable': () =>
        (attempts += 1) === 1 ? json({ error: 'Mã xác thực không đúng hoặc đã được dùng.', code: 'invalid_mfa_code' }, 400) : json({ recoveryCodes: CODES }),
    });
    await userEvent.click(within(await panel('Xác thực hai lớp')).getByRole('button', { name: 'Bật' }));
    expect(await screen.findByTestId('mfa-secret')).toHaveTextContent('KHOAGIAMAU');
    expect(screen.getByAltText('Mã QR thiết lập ứng dụng xác thực')).toBeInTheDocument();

    const field = screen.getByLabelText('Mã 6 chữ số');
    await userEvent.type(field, '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Bật' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mã xác thực không đúng');
    expect(field).toHaveValue('');

    await userEvent.type(field, '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Bật' }));
    const list = await screen.findByRole('list', { name: 'Mã khôi phục' });
    expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual(CODES);
    expect(screen.queryByTestId('mfa-secret')).not.toBeInTheDocument();
    expect(body(api, '/api/auth/mfa/enable')).toEqual({ code: '123456' });

    expect(screen.getByRole('button', { name: 'Xong' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tôi đã lưu các mã này' }));
    await userEvent.click(screen.getByRole('button', { name: 'Xong' }));
    expect(screen.queryByRole('list', { name: 'Mã khôi phục' })).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('Đã bật xác thực hai lớp và đăng xuất các thiết bị khác.');
    expect(await screen.findByText(/Còn 8 mã khôi phục/)).toBeInTheDocument();
  });

  test('phiên đã cũ: hỏi lại mật khẩu rồi mới hiện khóa', async () => {
    let attempts = 0;
    const api = await renderSection(SECURITY, {
      'POST /api/auth/reauth': json({ ok: true }),
      'POST /api/auth/mfa/setup': () => ((attempts += 1) === 1 ? REAUTH() : SETUP['POST /api/auth/mfa/setup']),
    });
    await userEvent.click(within(await panel('Xác thực hai lớp')).getByRole('button', { name: 'Bật' }));
    const password = await screen.findByLabelText('Nhập lại mật khẩu để tiếp tục');
    expect(screen.queryByTestId('mfa-secret')).not.toBeInTheDocument();
    await userEvent.type(password, 'mat-khau-hien-tai');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    expect(await screen.findByTestId('mfa-secret')).toBeInTheDocument();
    expect(api.callsTo('POST', '/api/auth/mfa/setup')).toHaveLength(2);
  });

  test('tài khoản không có mật khẩu, phiên đã cũ: hướng dẫn đăng nhập lại, không hiện ô mật khẩu vô nghĩa', async () => {
    await renderSection(SECURITY, { 'POST /api/auth/mfa/setup': REAUTH }, NO_PASSWORD);
    await userEvent.click(within(await panel('Xác thực hai lớp')).getByRole('button', { name: 'Bật' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('đăng nhập lại');
    expect(screen.queryByLabelText('Nhập lại mật khẩu để tiếp tục')).not.toBeInTheDocument();
  });
});

describe('đã bật 2FA', () => {
  test('tắt: mật khẩu và mã đi cùng một yêu cầu, không gọi /reauth trước vì sẽ tiêu mất mã', async () => {
    const api = await renderSection([ENABLED, SECURITY], { 'POST /api/auth/mfa/disable': json({ ok: true }) });
    await userEvent.click(within(await panel('Xác thực hai lớp')).getByRole('button', { name: 'Tắt' }));
    await userEvent.type(screen.getByLabelText('Mật khẩu hiện tại'), 'mat-khau-hien-tai');
    await userEvent.type(screen.getByLabelText('Mã xác thực'), ' 123456 ');
    await userEvent.click(screen.getByRole('button', { name: 'Tắt' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Đã tắt xác thực hai lớp.');
    expect(body(api, '/api/auth/mfa/disable')).toEqual({ password: 'mat-khau-hien-tai', code: '123456' });
    expect(api.callsTo('POST', '/api/auth/reauth')).toHaveLength(0);
    await waitFor(() => expect(within(screen.getByText('Xác thực hai lớp').closest('div.rounded-xl')).getByRole('button', { name: 'Bật' })).toBeInTheDocument());
  });

  test('tắt sai mã: báo lỗi, giữ biểu mẫu, xóa ô mã; Hủy quay lại', async () => {
    await renderSection(ENABLED, { 'POST /api/auth/mfa/disable': json({ error: 'Mã xác thực không đúng hoặc đã được dùng.', code: 'invalid_mfa_code' }, 400) });
    await userEvent.click(within(await panel('Xác thực hai lớp')).getByRole('button', { name: 'Tắt' }));
    await userEvent.type(screen.getByLabelText('Mật khẩu hiện tại'), 'mat-khau-hien-tai');
    await userEvent.type(screen.getByLabelText('Mã xác thực'), '000000');
    await userEvent.click(screen.getByRole('button', { name: 'Tắt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Mã xác thực không đúng');
    expect(screen.getByLabelText('Mã xác thực')).toHaveValue('');
    await userEvent.click(screen.getByRole('button', { name: 'Hủy' }));
    expect(screen.queryByLabelText('Mã xác thực')).not.toBeInTheDocument();
  });

  test('tài khoản không có mật khẩu: chỉ hỏi mã; phiên cũ thì hướng dẫn đăng nhập lại', async () => {
    const api = await renderSection(ENABLED, { 'POST /api/auth/mfa/disable': REAUTH }, NO_PASSWORD);
    await userEvent.click(within(await panel('Xác thực hai lớp')).getByRole('button', { name: 'Tắt' }));
    expect(screen.queryByLabelText('Mật khẩu hiện tại')).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Mã xác thực'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Tắt' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('đăng nhập lại');
    expect(body(api, '/api/auth/mfa/disable')).toEqual({ code: '123456' });
  });

  test('tạo mã khôi phục mới: hiện mã một lần, báo mã cũ không còn dùng được', async () => {
    const api = await renderSection(ENABLED, { 'POST /api/auth/mfa/recovery-codes': json({ recoveryCodes: CODES }) });
    await userEvent.click(within(await panel('Xác thực hai lớp')).getByRole('button', { name: 'Tạo mã khôi phục mới' }));
    await userEvent.type(screen.getByLabelText('Mật khẩu hiện tại'), 'mat-khau-hien-tai');
    await userEvent.type(screen.getByLabelText('Mã xác thực'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Tạo mã mới' }));
    expect(await screen.findByRole('list', { name: 'Mã khôi phục' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Tôi đã lưu các mã này' }));
    await userEvent.click(screen.getByRole('button', { name: 'Xong' }));
    expect(await screen.findByRole('status')).toHaveTextContent('các mã cũ không còn dùng được');
    expect(body(api, '/api/auth/mfa/recovery-codes')).toEqual({ password: 'mat-khau-hien-tai', code: '123456' });
  });
});

describe('passkey', () => {
  const registration = { id: 'khoa-moi', type: 'public-key', response: {} };
  const WITH_KEY = { ...SECURITY, passkeys: [KEY] };
  const REGISTER = { 'POST /api/auth/passkeys/register/options': json({ challenge: 'thu-thach' }), 'POST /api/auth/passkeys/register/verify': json({ passkey: KEY }, 201) };

  test('trình duyệt không hỗ trợ: nói rõ, không có biểu mẫu thêm', async () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    await renderSection(SECURITY);
    expect(await screen.findByText('Trình duyệt này chưa hỗ trợ passkey.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thêm passkey' })).not.toBeInTheDocument();
  });

  test('thêm: gửi phản hồi của thiết bị kèm tên, danh sách cập nhật theo máy chủ', async () => {
    webauthn.startRegistration.mockResolvedValue(registration);
    const api = await renderSection([SECURITY, WITH_KEY], REGISTER);
    await userEvent.type(await screen.findByLabelText('Tên passkey'), 'Điện thoại');
    await userEvent.click(screen.getByRole('button', { name: 'Thêm passkey' }));
    const list = await screen.findByRole('list', { name: 'Passkey đã thêm' });
    expect(list).toHaveTextContent('Điện thoại');
    expect(list).toHaveTextContent('Đồng bộ qua tài khoản thiết bị');
    expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: { challenge: 'thu-thach' } });
    expect(body(api, '/api/auth/passkeys/register/verify')).toEqual({ response: registration, name: 'Điện thoại' });
    expect(screen.getByRole('status')).toHaveTextContent('Đã thêm passkey.');
    expect(screen.getByLabelText('Tên passkey')).toHaveValue('');
  });

  test('phiên đã cũ: hỏi lại mật khẩu rồi mới mở hộp thoại của thiết bị', async () => {
    webauthn.startRegistration.mockResolvedValue(registration);
    let attempts = 0;
    await renderSection([SECURITY, WITH_KEY], {
      ...REGISTER,
      'POST /api/auth/reauth': json({ ok: true }),
      'POST /api/auth/passkeys/register/options': () => ((attempts += 1) === 1 ? REAUTH() : json({ challenge: 'thu-thach' })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm passkey' }));
    await userEvent.type(await screen.findByLabelText('Nhập lại mật khẩu để tiếp tục'), 'mat-khau-hien-tai');
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    expect(await screen.findByRole('list', { name: 'Passkey đã thêm' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Nhập lại mật khẩu để tiếp tục')).not.toBeInTheDocument();
  });

  test('hủy trên thiết bị ngay sau khi xác thực lại: báo tiếng Việt, không lộ thông báo kỹ thuật', async () => {
    webauthn.startRegistration.mockRejectedValue(Object.assign(new Error('The operation either timed out or was not allowed.'), { name: 'NotAllowedError' }));
    let attempts = 0;
    await renderSection(SECURITY, {
      'POST /api/auth/reauth': json({ ok: true }),
      'POST /api/auth/passkeys/register/options': () => ((attempts += 1) === 1 ? REAUTH() : json({ challenge: 'thu-thach' })),
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm passkey' }));
    await userEvent.type(await screen.findByLabelText('Nhập lại mật khẩu để tiếp tục'), 'mat-khau-hien-tai');
    await userEvent.click(screen.getByRole('button', { name: 'Tiếp tục' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Bạn đã hủy, hoặc thiết bị chưa xác nhận được passkey.');
    expect(screen.queryByText(/timed out/)).not.toBeInTheDocument();
  });

  test('passkey đã có trên thiết bị: báo đúng lý do', async () => {
    webauthn.startRegistration.mockRejectedValue(Object.assign(new Error('The authenticator was previously registered'), { name: 'InvalidStateError' }));
    await renderSection(SECURITY, REGISTER);
    await userEvent.click(await screen.findByRole('button', { name: 'Thêm passkey' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Thiết bị này đã có passkey của tài khoản.');
  });

  test('xóa: danh sách cập nhật; cách đăng nhập cuối cùng bị máy chủ từ chối thì giữ nguyên và báo lý do', async () => {
    let attempts = 0;
    const route = `DELETE /api/auth/passkeys/${KEY.id}`;
    const api = await renderSection(WITH_KEY, {
      [route]: () =>
        (attempts += 1) === 1
          ? json({ error: 'Không thể xóa cách đăng nhập cuối cùng. Hãy đặt mật khẩu hoặc thêm phương thức khác trước.', code: 'last_login_method' }, 409)
          : json({ ok: true }),
    });
    await userEvent.click(await screen.findByRole('button', { name: `Xóa passkey ${KEY.name}` }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Không thể xóa cách đăng nhập cuối cùng.');
    expect(screen.getByRole('list', { name: 'Passkey đã thêm' })).toHaveTextContent(KEY.name);

    await userEvent.click(screen.getByRole('button', { name: `Xóa passkey ${KEY.name}` }));
    expect(await screen.findByRole('status')).toHaveTextContent(`Đã xóa passkey ${KEY.name}.`);
    expect(api.callsTo('DELETE', `/api/auth/passkeys/${KEY.id}`)).toHaveLength(2);
  });
});
