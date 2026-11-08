import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { adminApi } from '../adminApi';
import { DELIVERY_STATUS_LABELS, formatDateTime } from '../format';
import { GachaTabs, MediaImage } from '../gacha';
import { Badge, Button, ConfirmDialog, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, SelectField, TableFrame, Td, TextArea, TextField, Th, useLoad, useNotice } from '../ui';

const PAGE_SIZE = 20;

export default function GachaRewardsPage() {
  useEffect(() => {
    document.title = 'Trao quà quay thưởng · Quản trị GreenCanteen';
  }, []);

  const notify = useNotice();
  const [filter, setFilter] = useState({ status: 'pending', q: '', page: 1 });
  const [codeText, setCodeText] = useState('');
  const [delivering, setDelivering] = useState(null);
  const [undoing, setUndoing] = useState(null);
  const [note, setNote] = useState('');
  const { data, loading, error, reload } = useLoad(() => adminApi.gachaRewards({ ...filter, pageSize: PAGE_SIZE }), [filter.status, filter.q, filter.page]);
  const items = data?.items || [];

  return (
    <>
      <PageHeader
        title="Trao quà"
        description="Người trúng đưa mã nhận quà trên trang Cá nhân của họ. Tra đúng mã, đối chiếu tài khoản rồi xác nhận đã trao; mỗi lần xác nhận được ghi nhật ký."
      />
      <GachaTabs />
      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter((current) => ({ ...current, q: codeText.trim(), page: 1 }));
        }}
      >
        <div className="w-48">
          <SelectField label="Trạng thái" value={filter.status} onChange={(e) => setFilter((current) => ({ ...current, status: e.target.value, page: 1 }))}>
            <option value="pending">Chờ trao</option>
            <option value="delivered">Đã trao</option>
            <option value="">Tất cả</option>
          </SelectField>
        </div>
        <div className="w-64">
          <TextField label="Mã nhận quà (đúng nguyên mã)" placeholder="TA-XXXXX-XXXXX" value={codeText} onChange={(e) => setCodeText(e.target.value)} />
        </div>
        <Button type="submit" tone="secondary">
          Tìm
        </Button>
      </form>
      {data && <p className="mb-3 text-sm text-stone-600">Đang chờ trao: {data.pending} móc khóa.</p>}

      {error && <ErrorState message={error} onRetry={reload} />}
      {!data && loading && <LoadingState />}
      {data && items.length === 0 && !loading && <EmptyState>Không có lượt trúng nào khớp bộ lọc.</EmptyState>}
      {items.length > 0 && (
        <div className={loading ? 'opacity-60' : ''}>
          <TableFrame label="Lượt trúng móc khóa">
            <thead>
              <tr>
                <Th>Mã nhận quà</Th>
                <Th>Móc khóa</Th>
                <Th>Người trúng</Th>
                <Th>Trúng lúc</Th>
                <Th>Trạng thái</Th>
                <Th>
                  <span className="sr-only">Thao tác</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {items.map((row) => (
                <tr key={row.id}>
                  <Td className="whitespace-nowrap font-mono font-bold">{row.claimCode}</Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <MediaImage url={row.imageUrl} alt={`Ảnh ${row.prizeLabel}`} className="h-10 w-10 shrink-0" />
                      <span>
                        {row.prizeLabel}
                        <br />
                        <span className="text-xs text-stone-500">Phiên bản {row.configVersion ?? '—'}</span>
                      </span>
                    </div>
                  </Td>
                  <Td>
                    {row.winner ? (
                      <Link to={`/users/${row.winner.id}`} className="font-semibold text-leaf-800 underline underline-offset-2">
                        {row.winner.name} · {row.winner.studentId}
                      </Link>
                    ) : (
                      'Tài khoản đã xóa'
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">{formatDateTime(row.createdAt)}</Td>
                  <Td>
                    <Badge tone={row.deliveryStatus === 'delivered' ? 'green' : 'amber'}>{DELIVERY_STATUS_LABELS[row.deliveryStatus]}</Badge>
                    {row.deliveryStatus === 'delivered' && (
                      <p className="mt-1 text-xs text-stone-500">
                        {formatDateTime(row.deliveredAt)} · {row.deliveredByLabel}
                        {row.deliveryNote ? ` · ${row.deliveryNote}` : ''}
                      </p>
                    )}
                  </Td>
                  <Td>
                    {row.deliveryStatus === 'delivered' ? (
                      <Button tone="dangerOutline" className="px-3 py-1" aria-label={`Hoàn tác trao quà ${row.claimCode}`} onClick={() => setUndoing(row)}>
                        Hoàn tác
                      </Button>
                    ) : (
                      <Button className="px-3 py-1" aria-label={`Xác nhận đã trao ${row.claimCode}`} onClick={() => setDelivering(row)}>
                        Đã trao
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={(page) => setFilter((current) => ({ ...current, page }))} />
        </div>
      )}

      {delivering && (
        <ConfirmDialog
          title={`Xác nhận đã trao ${delivering.claimCode}`}
          description={`Móc khóa «${delivering.prizeLabel}» cho ${delivering.winner?.name || 'người trúng'}. Chỉ xác nhận sau khi đã đối chiếu tài khoản.`}
          confirmLabel="Xác nhận đã trao"
          tone="primary"
          onConfirm={async () => {
            await adminApi.deliverGachaReward(delivering.id, note.trim());
            setNote('');
            notify('Đã xác nhận trao quà.');
            reload();
          }}
          onClose={() => {
            setDelivering(null);
            setNote('');
          }}
        >
          <TextArea label="Ghi chú (không bắt buộc)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        </ConfirmDialog>
      )}
      {undoing && (
        <ConfirmDialog
          title={`Hoàn tác trao quà ${undoing.claimCode}`}
          description="Lượt trúng quay lại trạng thái chờ trao."
          confirmLabel="Hoàn tác"
          reasonLabel="Lý do hoàn tác"
          onConfirm={async (reason) => {
            await adminApi.undeliverGachaReward(undoing.id, reason);
            notify('Đã chuyển về chờ trao.');
            reload();
          }}
          onClose={() => setUndoing(null)}
        />
      )}
    </>
  );
}
