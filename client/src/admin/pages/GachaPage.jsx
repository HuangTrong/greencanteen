import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { adminApi } from '../adminApi';
import { CONFIG_STATUS_LABELS, formatDateTime, formatVnd } from '../format';
import { Badge, Button, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, TableFrame, Td, Th, useLoad, useNotice } from '../ui';

const PAGE_SIZE = 20;

/** Trạng thái hiệu lực tính theo thời điểm hiện tại, chỉ để hiển thị; server mới quyết định bản nào được dùng */
function effectLabel(config, now = Date.now()) {
  if (config.isCurrent) return ['Đang hiệu lực', 'green'];
  if (config.status === 'draft') return [CONFIG_STATUS_LABELS.draft, 'amber'];
  if (config.effectiveTo && new Date(config.effectiveTo).getTime() <= now) return ['Đã kết thúc', 'stone'];
  if (new Date(config.effectiveFrom).getTime() > now) return ['Đã hẹn giờ', 'blue'];
  return ['Được thay bằng bản mới hơn', 'stone'];
}

export default function GachaPage() {
  useEffect(() => {
    document.title = 'Gacha · Quản trị GreenCanteen';
  }, []);

  const navigate = useNavigate();
  const notify = useNotice();
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, loading, error, reload } = useLoad(() => adminApi.gachaConfigs({ page, pageSize: PAGE_SIZE }), [page]);
  const items = data?.items || [];

  const createDraft = async () => {
    setCreating(true);
    try {
      const draft = await adminApi.createGachaDraft();
      navigate(`/gacha/${draft.id}`);
    } catch (err) {
      notify(err.message, 'error');
      setCreating(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Gacha"
        description="Mỗi phiên bản là một bản chụp danh mục giải. Bản đã xuất bản không sửa được; mỗi phần thưởng lưu phiên bản đã tạo ra nó."
        actions={
          <Button disabled={creating} onClick={createDraft}>
            {creating ? 'Đang tạo...' : 'Tạo bản nháp mới'}
          </Button>
        }
      />
      <p className="mb-4 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
        Mã nạp hiện là mã demo, chưa tích hợp nhà mạng nên chưa được xác minh đổi được. Mệnh giá chỉ là giá trị danh nghĩa.
      </p>

      {error && <ErrorState message={error} onRetry={reload} />}
      {!data && loading && <LoadingState />}
      {data && items.length === 0 && !loading && <EmptyState>Chưa có phiên bản nào.</EmptyState>}

      {items.length > 0 && (
        <div className={loading ? 'opacity-60' : ''}>
          <TableFrame label="Các phiên bản cấu hình Gacha">
            <thead>
              <tr>
                <Th>Phiên bản</Th>
                <Th>Trạng thái</Th>
                <Th className="text-right">Số giải bật</Th>
                <Th className="text-right">Ngân sách</Th>
                <Th>Hiệu lực từ</Th>
                <Th>Đến</Th>
                <Th>Người xuất bản</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((config) => {
                const [label, tone] = effectLabel(config);
                return (
                  <tr key={config.id}>
                    <Td>
                      <Link to={`/gacha/${config.id}`} className="font-bold text-leaf-800 underline underline-offset-2">
                        Phiên bản {config.version}
                      </Link>
                    </Td>
                    <Td>
                      <Badge tone={tone}>{label}</Badge>
                    </Td>
                    <Td className="text-right [font-variant-numeric:tabular-nums]">{config.prizes.filter((prize) => prize.enabled).length}</Td>
                    <Td className="text-right [font-variant-numeric:tabular-nums]">{config.budgetVnd === null ? 'Không giới hạn' : formatVnd(config.budgetVnd)}</Td>
                    <Td className="whitespace-nowrap">{formatDateTime(config.effectiveFrom)}</Td>
                    <Td className="whitespace-nowrap">{config.effectiveTo ? formatDateTime(config.effectiveTo) : '—'}</Td>
                    <Td>{config.publishedByLabel || '—'}</Td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
          <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onChange={setPage} />
        </div>
      )}
    </>
  );
}
