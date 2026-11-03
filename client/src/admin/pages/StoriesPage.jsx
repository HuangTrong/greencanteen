import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { adminApi } from '../adminApi';
import { STORY_STATUS_LABELS, formatDateTime } from '../format';
import { Badge, Button, EmptyState, ErrorState, LoadingState, PageHeader, Pagination, SelectField, TableFrame, Td, TextField, Th, useLoad } from '../ui';

const PAGE_SIZE = 20;
const STATUS_TONES = { draft: 'amber', published: 'green', archived: 'stone' };

export default function StoriesPage() {
  useEffect(() => {
    document.title = 'Câu chuyện · Quản trị GreenCanteen';
  }, []);

  const navigate = useNavigate();
  const [draftQuery, setDraftQuery] = useState('');
  const [filter, setFilter] = useState({ q: '', status: '', page: 1 });
  const { data, loading, error, reload } = useLoad(() => adminApi.stories({ ...filter, pageSize: PAGE_SIZE }), [filter.q, filter.status, filter.page]);
  const items = data?.items || [];

  return (
    <>
      <PageHeader
        title="Câu chuyện"
        description="Câu chuyện đã xuất bản hiển thị sau mỗi lượt check-in hợp lệ. Mọi câu chuyện xuất bản phải có nguồn nghiên cứu mở được qua HTTPS."
        actions={<Button onClick={() => navigate('/stories/new')}>Thêm câu chuyện</Button>}
      />

      <form
        className="mb-4 flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setFilter((current) => ({ ...current, q: draftQuery.trim(), page: 1 }));
        }}
      >
        <div className="w-full sm:w-72">
          <TextField label="Tìm theo tiêu đề" type="search" maxLength={80} value={draftQuery} onChange={(e) => setDraftQuery(e.target.value)} />
        </div>
        <Button type="submit" tone="secondary">
          Tìm
        </Button>
        <div className="w-44">
          <SelectField label="Trạng thái" value={filter.status} onChange={(e) => setFilter((current) => ({ ...current, status: e.target.value, page: 1 }))}>
            <option value="">Tất cả</option>
            {Object.entries(STORY_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </SelectField>
        </div>
      </form>

      {error && <ErrorState message={error} onRetry={reload} />}
      {!data && loading && <LoadingState />}
      {data && items.length === 0 && !loading && <EmptyState>Không có câu chuyện phù hợp.</EmptyState>}

      {items.length > 0 && (
        <div className={loading ? 'opacity-60' : ''}>
          <TableFrame label="Danh sách câu chuyện">
            <thead>
              <tr>
                <Th>Tiêu đề</Th>
                <Th>Loài</Th>
                <Th>Trạng thái</Th>
                <Th>Nguồn gốc</Th>
                <Th>Sửa lần cuối</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((story) => (
                <tr key={story.id}>
                  <Td>
                    <Link to={`/stories/${story.id}`} className="font-bold text-leaf-800 underline underline-offset-2">
                      {story.title}
                    </Link>
                  </Td>
                  <Td>{story.species || '—'}</Td>
                  <Td>
                    <Badge tone={STATUS_TONES[story.status]}>{STORY_STATUS_LABELS[story.status]}</Badge>
                  </Td>
                  <Td>{{ seed: 'Dữ liệu ban đầu', admin: 'Khu quản trị', external: 'Có sẵn trong DB' }[story.origin]}</Td>
                  <Td className="whitespace-nowrap">
                    {formatDateTime(story.updatedAt)}
                    {story.updatedByLabel && <span className="ml-1 text-xs text-stone-500">{story.updatedByLabel}</span>}
                  </Td>
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
