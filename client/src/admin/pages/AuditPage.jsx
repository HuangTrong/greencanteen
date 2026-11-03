import { useEffect, useState } from 'react';
import { adminApi } from '../adminApi';
import { AUDIT_ACTION_LABELS, AUDIT_RESULT_LABELS, formatDateTime } from '../format';
import { Badge, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, SelectField, TableFrame, Td, TextField, Th, useLoad } from '../ui';

const PAGE_SIZE = 20;
const RESULT_TONES = { success: 'green', failure: 'amber', denied: 'red' };
const ACTOR_LABELS = { admin: 'Quản trị viên', cli: 'Dòng lệnh', user: 'Sinh viên', anonymous: 'Chưa xác thực' };

function Details({ meta }) {
  if (!meta || Object.keys(meta).length === 0) return '—';
  return (
    <details>
      <summary className="cursor-pointer text-xs font-semibold text-leaf-800">Xem</summary>
      <pre className="mt-1 max-w-sm whitespace-pre-wrap break-words rounded-lg bg-stone-100 p-2 text-xs text-stone-700">{JSON.stringify(meta, null, 2)}</pre>
    </details>
  );
}

export default function AuditPage() {
  useEffect(() => {
    document.title = 'Nhật ký kiểm toán · Quản trị GreenCanteen';
  }, []);

  const [filter, setFilter] = useState({ action: '', result: '', from: '', to: '', page: 1 });
  const { data, loading, error, reload } = useLoad(
    () => adminApi.auditLogs({ ...filter, pageSize: PAGE_SIZE }),
    [filter.action, filter.result, filter.from, filter.to, filter.page]
  );
  const update = (patch) => setFilter((current) => ({ ...current, page: 1, ...patch }));
  const items = data?.items || [];

  return (
    <>
      <PageHeader title="Nhật ký kiểm toán" description="Ghi lại ai đã làm gì, trên đối tượng nào, khi nào và kết quả ra sao. Nhật ký chỉ đọc, không có thao tác sửa hay xóa." />

      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => event.preventDefault()}>
        <div className="w-full sm:w-64">
          <SelectField label="Thao tác" value={filter.action} onChange={(e) => update({ action: e.target.value })}>
            <option value="">Tất cả</option>
            {(data?.actions || []).map((action) => (
              <option key={action} value={action}>
                {AUDIT_ACTION_LABELS[action] || action}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="w-40">
          <SelectField label="Kết quả" value={filter.result} onChange={(e) => update({ result: e.target.value })}>
            <option value="">Tất cả</option>
            {Object.entries(AUDIT_RESULT_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
        </div>
        <div className="w-40">
          <TextField label="Từ ngày" type="date" value={filter.from} onChange={(e) => update({ from: e.target.value })} />
        </div>
        <div className="w-40">
          <TextField label="Đến ngày" type="date" value={filter.to} onChange={(e) => update({ to: e.target.value })} />
        </div>
      </form>

      {error && <ErrorState message={error} onRetry={reload} />}
      {!data && loading && <LoadingState />}
      {data && items.length === 0 && !loading && <EmptyState>Không có bản ghi phù hợp.</EmptyState>}

      {items.length > 0 && (
        <div className={loading ? 'opacity-60' : ''}>
          <TableFrame label="Nhật ký kiểm toán">
            <thead>
              <tr>
                <Th>Thời điểm</Th>
                <Th>Người thực hiện</Th>
                <Th>Thao tác</Th>
                <Th>Đối tượng</Th>
                <Th>Kết quả</Th>
                <Th>Chi tiết</Th>
                <Th>IP</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((entry) => (
                <tr key={entry.id}>
                  <Td className="whitespace-nowrap">{formatDateTime(entry.at)}</Td>
                  <Td>
                    <span className="block text-xs text-stone-500">{ACTOR_LABELS[entry.actorType]}</span>
                    <span className="font-mono text-xs">{entry.actorLabel || '—'}</span>
                  </Td>
                  <Td>{AUDIT_ACTION_LABELS[entry.action] || entry.action}</Td>
                  <Td>
                    <span className="font-mono text-xs">{entry.targetLabel || entry.targetId || '—'}</span>
                  </Td>
                  <Td>
                    <Badge tone={RESULT_TONES[entry.result]}>{AUDIT_RESULT_LABELS[entry.result]}</Badge>
                    {entry.reason && <span className="ml-1 font-mono text-xs text-stone-500">{entry.reason}</span>}
                  </Td>
                  <Td>
                    <Details meta={entry.meta} />
                  </Td>
                  <Td className="font-mono text-xs">{entry.ip || '—'}</Td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={(page) => setFilter((current) => ({ ...current, page }))} />
        </div>
      )}
    </>
  );
}
