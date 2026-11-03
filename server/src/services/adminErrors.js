/** Lỗi nghiệp vụ của khu quản trị: trả JSON { error, code } như các API khác */
export class AdminError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const notFound = (message = 'Không tìm thấy dữ liệu.') => new AdminError(404, 'not_found', message);

export const versionConflict = () =>
  new AdminError(409, 'version_conflict', 'Dữ liệu vừa được người khác cập nhật. Tải lại trang rồi thử lại.');

export const invalidInput = (fields, message = 'Dữ liệu chưa hợp lệ.') => new AdminError(400, 'invalid_input', message, { fields });

/** Đổi lỗi bất kỳ thành AdminError; lỗi không lường trước được ghi log và trả thông báo chung */
export function toAdminError(err) {
  if (err instanceof AdminError) return err;
  if (err?.name === 'VersionError') return versionConflict();
  if (err?.name === 'ValidationError') {
    const fields = Object.fromEntries(Object.entries(err.errors || {}).map(([path, e]) => [path, e.message]));
    return invalidInput(fields);
  }
  if (Number(err?.code) === 11000) return new AdminError(409, 'conflict', 'Giá trị này đã tồn tại.');
  console.error(err);
  return new AdminError(500, 'server_error', 'Lỗi máy chủ.');
}
