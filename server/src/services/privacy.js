/** Che dữ liệu cá nhân cho màn hình quản trị và nhật ký: đủ để phân biệt tài khoản, không đủ để dùng lại */
export function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  if (!domain) return email ? '***' : '';
  return `${local.slice(0, Math.min(2, Math.ceil(local.length / 2)))}***@${domain}`;
}

export function maskStudentId(studentId) {
  const value = String(studentId || '');
  if (value.length <= 4) return value ? `${value.slice(0, 1)}***` : '';
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}
