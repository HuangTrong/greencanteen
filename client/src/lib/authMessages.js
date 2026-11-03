export const PROVIDER_LABELS = { google: 'Google', facebook: 'Facebook' };

export const REAUTH_REQUIRED_MESSAGE =
  'Cần xác thực lại trước khi thay đổi phương thức đăng nhập. Hãy nhập lại mật khẩu; nếu tài khoản chưa có mật khẩu, hãy đăng xuất rồi đăng nhập lại bằng Google hoặc Facebook và thử trong vòng 10 phút.';

const providerName = (provider) => PROVIDER_LABELS[provider] || 'nhà cung cấp';

/** Server chỉ gửi mã lỗi qua URL (?auth_error=...) — nội dung thông báo do client quyết định */
export function oauthErrorMessage(code, provider) {
  const name = providerName(provider);
  switch (code) {
    case 'provider_not_configured':
      return `Đăng nhập bằng ${name} chưa được cấu hình trên máy chủ.`;
    case 'oauth_cancelled':
      return `Bạn đã hủy đăng nhập bằng ${name}.`;
    case 'invalid_state':
      return 'Phiên đăng nhập không hợp lệ hoặc đã hết hạn. Vui lòng thử lại.';
    case 'email_in_use':
      return `Email của tài khoản ${name} này đã gắn với một tài khoản GreenCanteen. Hãy đăng nhập bằng phương thức đã dùng trước đây, rồi liên kết ${name} tại trang Cá nhân.`;
    case 'provider_already_linked':
      return `Tài khoản ${name} này đã liên kết với một tài khoản GreenCanteen khác.`;
    case 'different_account_linked':
      return `Tài khoản của bạn đã liên kết với một tài khoản ${name} khác.`;
    case 'login_required':
      return `Bạn cần đăng nhập trước khi liên kết ${name}.`;
    case 'reauth_required':
      return REAUTH_REQUIRED_MESSAGE;
    case 'account_locked':
      return 'Tài khoản này đang bị khóa. Vui lòng liên hệ quản trị viên.';
    default:
      return `Không thể đăng nhập bằng ${name}. Vui lòng thử lại.`;
  }
}

export function oauthSuccessMessage(kind, provider) {
  const name = providerName(provider);
  return kind === 'linked' ? `Đã liên kết ${name} với tài khoản của bạn.` : `Đăng nhập bằng ${name} thành công.`;
}
