import { browserSupportsWebAuthn, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from './api';

export const passkeySupported = browserSupportsWebAuthn;

/** Lỗi của trình duyệt chỉ có tên kỹ thuật; lỗi của máy chủ đã có thông báo tiếng Việt */
export function passkeyErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Bạn đã hủy, hoặc thiết bị chưa xác nhận được passkey.';
    case 'InvalidStateError':
      return 'Thiết bị này đã có passkey của tài khoản.';
    case 'SecurityError':
      return 'Tên miền của trang chưa khớp cấu hình máy chủ nên không dùng được passkey.';
    default:
      return err?.message || 'Không xử lý được passkey.';
  }
}

export const askPasskey = (optionsJSON) => startAuthentication({ optionsJSON });

export async function signInWithPasskey() {
  const response = await askPasskey(await api.passkeyLoginOptions());
  const { user } = await api.passkeyLoginVerify(response);
  return user;
}

export async function addPasskey(name) {
  const optionsJSON = await api.passkeyRegisterOptions();
  const response = await startRegistration({ optionsJSON });
  const { passkey } = await api.passkeyRegisterVerify(response, name);
  return passkey;
}
