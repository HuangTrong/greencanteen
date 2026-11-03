import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { adminApi } from '../adminApi';
import { ROLE_LABELS, USER_STATUS_LABELS, formatDateTime, formatNumber } from '../format';
import { useReauth } from '../session';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, SelectField, TableFrame, Td, TextField, Th, useLoad, useNotice } from '../ui';

const PAGE_SIZE = 20;

export default function UsersPage() {
  useEffect(() => {
    document.title = 'Tài khoản · Quản trị GreenCanteen';
  }, []);

  const notify = useNotice();
  const withReauth = useReauth();
  const [draftQuery, setDraftQuery] = useState('');
  const [filter, setFilter] = useState({ q: '', status: '', role: '', page: 1 });
  const [selected, setSelected] = useState(new Set());
  const [bulk, setBulk] = useState(null); // 'locked' | 'active' khi hộp thoại đang mở
  const { data, loading, error, reload } = useLoad(
    () => adminApi.users({ ...filter, pageSize: PAGE_SIZE }),
    [filter.q, filter.status, filter.role, filter.page]
  );

  const update = (patch) => {
    setFilter((current) => ({ ...current, page: 1, ...patch }));
    setSelected(new Set());
  };
  const toggle = (id) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const items = data?.items || [];
  const allOnPage = items.length > 0 && items.every((user) => selected.has(user.id));

  const applyBulk = async (reason) => {
    const { results } = await withReauth(() => adminApi.bulkStatus([...selected], bulk, reason));
    const failed = results.filter((result) => !result.ok);
    notify(
      failed.length ? `Thành công ${results.length - failed.length}, thất bại ${failed.length}: ${failed[0].error}` : `Đã cập nhật ${results.length} tài khoản.`,
      failed.length ? 'error' : 'success'
    );
    setSelected(new Set());
    reload();
  };

  return (
    <>
      <PageHeader title="Tài khoản" description="Email và mã sinh viên được che mặc định. Tìm theo họ tên, hoặc nhập đúng toàn bộ email / mã sinh viên." />

      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          update({ q: draftQuery.trim() });
        }}
      >
        <div className="w-full sm:w-72">
          <TextField label="Tìm kiếm" type="search" maxLength={80} value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} />
        </div>
        <Button type="submit" tone="secondary">
          Tìm
        </Button>
        <div className="w-40">
          <SelectField label="Trạng thái" value={filter.status} onChange={(e) => update({ status: e.target.value })}>
            <option value="">Tất cả</option>
            <option value="active">Đang hoạt động</option>
            <option value="locked">Đang khóa</option>
          </SelectField>
        </div>
        <div className="w-40">
          <SelectField label="Vai trò" value={filter.role} onChange={(e) => update({ role: e.target.value })}>
            <option value="">Tất cả</option>
            <option value="user">Người dùng</option>
            <option value="admin">Quản trị viên</option>
          </SelectField>
        </div>
      </form>

      {selected.size > 0 && (
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900">
          <span>Đã chọn {selected.size} tài khoản</span>
          <Button tone="dangerOutline" className="px-3 py-1" onClick={() => setBulk('locked')}>
            Khóa đã chọn
          </Button>
          <Button tone="secondary" className="px-3 py-1" onClick={() => setBulk('active')}>
            Mở khóa đã chọn
          </Button>
        </div>
      )}

      {error && <ErrorState message={error} onRetry={reload} />}
      {!data && loading && <LoadingState />}
      {data && items.length === 0 && !loading && <EmptyState>Không có tài khoản phù hợp.</EmptyState>}

      {items.length > 0 && (
        <div className={loading ? 'opacity-60' : ''}>
          <TableFrame label="Danh sách tài khoản">
            <thead>
              <tr>
                <Th>
                  <input
                    type="checkbox"
                    aria-label="Chọn tất cả trên trang này"
                    checked={allOnPage}
                    onChange={() => setSelected(allOnPage ? new Set() : new Set(items.map((user) => user.id)))}
                  />
                </Th>
                <Th>Họ tên</Th>
                <Th>Mã sinh viên</Th>
                <Th>Email</Th>
                <Th>Vai trò</Th>
                <Th>Trạng thái</Th>
                <Th className="text-right">Check-in</Th>
                <Th>Tạo lúc</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((user) => (
                <tr key={user.id}>
                  <Td>
                    <input type="checkbox" aria-label={`Chọn ${user.name}`} checked={selected.has(user.id)} onChange={() => toggle(user.id)} />
                  </Td>
                  <Td>
                    <Link to={`/users/${user.id}`} className="font-bold text-leaf-800 underline underline-offset-2">
                      {user.name}
                    </Link>
                  </Td>
                  <Td className="font-mono text-xs">{user.studentId}</Td>
                  <Td className="font-mono text-xs">{user.email || '—'}</Td>
                  <Td>{user.role === 'admin' ? <Badge tone="blue">{ROLE_LABELS.admin}</Badge> : ROLE_LABELS.user}</Td>
                  <Td>
                    <Badge tone={user.status === 'locked' ? 'red' : 'green'}>{USER_STATUS_LABELS[user.status]}</Badge>
                  </Td>
                  <Td className="text-right [font-variant-numeric:tabular-nums]">{formatNumber(user.totalCheckIns)}</Td>
                  <Td className="whitespace-nowrap">{formatDateTime(user.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={(page) => setFilter((current) => ({ ...current, page }))} />
        </div>
      )}

      {bulk && (
        <ConfirmDialog
          title={bulk === 'locked' ? 'Khóa các tài khoản đã chọn' : 'Mở khóa các tài khoản đã chọn'}
          description={`Áp dụng cho ${selected.size} tài khoản. ${bulk === 'locked' ? 'Tài khoản bị khóa sẽ bị đăng xuất ngay và không đăng nhập được.' : ''}`}
          confirmLabel={bulk === 'locked' ? 'Khóa tài khoản' : 'Mở khóa'}
          tone={bulk === 'locked' ? 'danger' : 'primary'}
          reasonLabel="Lý do"
          onConfirm={applyBulk}
          onClose={() => setBulk(null)}
        />
      )}
    </>
  );
}
