const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/** Phân trang phía server: tham số sai kiểu hoặc quá lớn được đưa về giới hạn */
export function parsePaging(query) {
  const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(Number.parseInt(query.pageSize, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
