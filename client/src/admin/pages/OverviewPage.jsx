import { useEffect, useMemo, useState } from 'react';
import BarChart, { SERIES_COLORS } from '../components/BarChart';
import { adminApi } from '../adminApi';
import { formatDateTime, formatNumber, formatPeriod, formatVnd, vietnamDate } from '../format';
import { Button, Card, ErrorState, LoadingState, PageHeader, SelectField, TableFrame, Td, TextField, Th, useLoad } from '../ui';

const PRESETS = [
  ['7 ngày', 6],
  ['30 ngày', 29],
  ['90 ngày', 89],
];

const NO_SOURCE = 'Chưa có nguồn dữ liệu';

function Tile({ label, value, note }) {
  return (
    <div className="rounded-2xl border border-stone-200 bg-white p-4">
      <p className="text-xs font-semibold text-stone-500">{label}</p>
      <p className="mt-1 text-2xl font-extrabold text-stone-900">{value}</p>
      {note && <p className="mt-1 text-xs text-stone-500">{note}</p>}
    </div>
  );
}

function activeUsersTile({ activeUsersAvailable, activeUsersSpansMonths, totals }) {
  if (!activeUsersAvailable) return { value: NO_SOURCE };
  if (activeUsersSpansMonths) {
    return { value: 'Không có tổng', note: 'Mã ẩn danh đổi theo tháng nên không gộp được một người qua hai tháng. Xem số từng kỳ ở bảng số liệu.' };
  }
  return { value: formatNumber(totals.activeUsers) };
}

function TrafficSection({ traffic }) {
  if (traffic.status !== 'ok') {
    return (
      <Card title="Truy cập">
        <p className="text-sm text-stone-600">
          <span className="font-bold">{NO_SOURCE}.</span>{' '}
          {traffic.status === 'disabled'
            ? 'Thu thập sự kiện đang tắt (ANALYTICS_ENABLED). Lượt xem, lượt truy cập và người dùng hoạt động không suy ra từ số check-in.'
            : 'Chưa nhận được sự kiện truy cập nào.'}
        </p>
      </Card>
    );
  }
  const { totals, clickThrough, retentionDays, collectingSince } = traffic;
  return (
    <Card title="Truy cập">
      <div className="grid gap-3 sm:grid-cols-3">
        <Tile label="Lượt xem trang" value={formatNumber(totals.pageViews)} />
        <Tile label="Lượt truy cập" value={formatNumber(totals.visits)} />
        <Tile label="Người dùng hoạt động" {...activeUsersTile(traffic)} />
      </div>
      <h3 className="mb-2 mt-4 text-sm font-bold text-stone-700">Tỉ lệ nhấp</h3>
      <TableFrame label="Tỉ lệ nhấp theo mục">
        <thead>
          <tr>
            <Th>Mục</Th>
            <Th className="text-right">Lượt hiển thị</Th>
            <Th className="text-right">Lượt nhấp</Th>
            <Th className="text-right">Tỉ lệ</Th>
          </tr>
        </thead>
        <tbody>
          {clickThrough.map((row) => (
            <tr key={row.target}>
              <Td>{row.label}</Td>
              <Td className="text-right [font-variant-numeric:tabular-nums]">{formatNumber(row.impressions)}</Td>
              <Td className="text-right [font-variant-numeric:tabular-nums]">{formatNumber(row.clicks)}</Td>
              <Td className="text-right [font-variant-numeric:tabular-nums]">{row.ratePercent === null ? '—' : `${row.ratePercent.toLocaleString('vi-VN')}%`}</Td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
      <p className="mt-2 text-xs text-stone-500">
        Dữ liệu từ {formatDateTime(collectingSince)}, giữ {retentionDays} ngày rồi tự xóa. Kỳ ngoài khoảng này hiển thị “—”, không phải 0.
      </p>
    </Card>
  );
}

function FinancialSection({ financial }) {
  return (
    <Card title="Tài chính">
      <dl className="grid gap-3 sm:grid-cols-3">
        {['Doanh thu', 'Chi phí', 'Lợi nhuận'].map((label) => (
          <div key={label} className="rounded-xl bg-stone-100 p-3">
            <dt className="text-xs font-semibold text-stone-500">{label}</dt>
            <dd className="mt-1 text-sm font-bold text-stone-700">{NO_SOURCE}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-2 text-xs text-stone-500">{financial.note}</p>
    </Card>
  );
}

export default function OverviewPage() {
  useEffect(() => {
    document.title = 'Tổng quan · Quản trị GreenCanteen';
  }, []);

  const [filter, setFilter] = useState({ from: vietnamDate(-29), to: vietnamDate(), granularity: 'day' });
  const { data, loading, error, reload } = useLoad(() => adminApi.overview(filter), [filter.from, filter.to, filter.granularity]);

  const update = (patch) => setFilter((current) => ({ ...current, ...patch }));
  const activePreset = useMemo(
    () => PRESETS.find(([, days]) => filter.to === vietnamDate() && filter.from === vietnamDate(-days))?.[1] ?? null,
    [filter.from, filter.to]
  );

  return (
    <>
      <PageHeader title="Tổng quan" description="Số liệu đếm từ dữ liệu lưu trong hệ thống, theo giờ Việt Nam (UTC+7)." />

      <form className="mb-4 flex flex-wrap items-end gap-3" onSubmit={(event) => event.preventDefault()}>
        <div role="group" aria-label="Khoảng thời gian nhanh" className="flex gap-1 rounded-xl bg-stone-200 p-1">
          {PRESETS.map(([label, days]) => (
            <button
              key={label}
              type="button"
              aria-pressed={activePreset === days}
              onClick={() => update({ from: vietnamDate(-days), to: vietnamDate(), granularity: 'day' })}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold outline-none ring-leaf-400 focus-visible:ring-2 ${activePreset === days ? 'bg-white text-leaf-800' : 'text-stone-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="w-40">
          <TextField label="Từ ngày" type="date" value={filter.from} max={filter.to} onChange={(e) => e.target.value && update({ from: e.target.value })} />
        </div>
        <div className="w-40">
          <TextField label="Đến ngày" type="date" value={filter.to} min={filter.from} onChange={(e) => e.target.value && update({ to: e.target.value })} />
        </div>
        <div className="w-36">
          <SelectField label="Gộp theo" value={filter.granularity} onChange={(e) => update({ granularity: e.target.value })}>
            <option value="day">Ngày</option>
            <option value="month">Tháng</option>
          </SelectField>
        </div>
      </form>

      {error && <ErrorState message={error} onRetry={reload} />}
      {!data && loading && <LoadingState text="Đang tải số liệu..." />}

      {data && (
        <div className={`space-y-4 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Tile label="Tổng tài khoản" value={formatNumber(data.totals.accountsTotal)} note={`${formatNumber(data.totals.accountsNew)} mới trong kỳ, ${formatNumber(data.totals.accountsLocked)} đang khóa`} />
            <Tile label="Check-in hợp lệ" value={formatNumber(data.totals.checkInsValid)} note={data.totals.checkInsSimulated > 0 ? `Gồm ${formatNumber(data.totals.checkInsSimulated)} lượt mô phỏng` : undefined} />
            <Tile label="Check-in không hợp lệ" value={formatNumber(data.totals.checkInsInvalid)} />
            <Tile label="Lượt quay thưởng tri ân" value={formatNumber(data.totals.gachaSpins)} note="Gồm cả lượt không trúng" />
            <Tile label="Lượt trúng móc khóa" value={formatNumber(data.totals.gachaWins)} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <BarChart
              title="Check-in"
              unit="lượt"
              rows={data.series}
              series={[
                { key: 'checkInsValid', label: 'hợp lệ', color: SERIES_COLORS.first },
                { key: 'checkInsInvalid', label: 'không hợp lệ', color: SERIES_COLORS.second },
              ]}
            />
            <BarChart title="Tài khoản mới" unit="tài khoản" rows={data.series} series={[{ key: 'accountsNew', label: 'tài khoản mới', color: SERIES_COLORS.single }]} />
            <BarChart title="Lượt quay thưởng tri ân" unit="lượt" rows={data.series} series={[{ key: 'gachaSpins', label: 'lượt', color: SERIES_COLORS.single }]} />
            <BarChart title="Lượt trúng móc khóa" unit="lượt" rows={data.series} series={[{ key: 'gachaWins', label: 'lượt', color: SERIES_COLORS.single }]} />
          </div>

          <Card title="Bảng số liệu">
            <TableFrame label="Số liệu theo từng kỳ">
              <thead>
                <tr>
                  <Th>Kỳ</Th>
                  <Th className="text-right">Tài khoản mới</Th>
                  <Th className="text-right">Check-in hợp lệ</Th>
                  <Th className="text-right">Không hợp lệ</Th>
                  <Th className="text-right">Lượt quay thưởng</Th>
                  <Th className="text-right">Lượt trúng móc khóa</Th>
                  <Th className="text-right">Lượt xem trang</Th>
                  <Th className="text-right">Lượt truy cập</Th>
                  <Th className="text-right">Người dùng hoạt động</Th>
                </tr>
              </thead>
              <tbody className="[font-variant-numeric:tabular-nums]">
                {data.series.map((row) => (
                  <tr key={row.period}>
                    <Td>{formatPeriod(row.period)}</Td>
                    <Td className="text-right">{formatNumber(row.accountsNew)}</Td>
                    <Td className="text-right">{formatNumber(row.checkInsValid)}</Td>
                    <Td className="text-right">{formatNumber(row.checkInsInvalid)}</Td>
                    <Td className="text-right">{formatNumber(row.gachaSpins)}</Td>
                    <Td className="text-right">{formatNumber(row.gachaWins)}</Td>
                    <Td className="text-right">{formatNumber(row.pageViews)}</Td>
                    <Td className="text-right">{formatNumber(row.visits)}</Td>
                    <Td className="text-right">{formatNumber(row.activeUsers)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableFrame>
          </Card>

          {data.rewardsByAmount.length > 0 && (
            <Card title="Mã nạp demo đã phát trước khi đổi sang móc khóa">
              <TableFrame label="Phần thưởng theo mệnh giá">
                <thead>
                  <tr>
                    <Th>Mệnh giá</Th>
                    <Th className="text-right">Số mã đã phát</Th>
                    <Th className="text-right">Tổng mệnh giá</Th>
                  </tr>
                </thead>
                <tbody className="[font-variant-numeric:tabular-nums]">
                  {data.rewardsByAmount.map((row) => (
                    <tr key={row.amountVnd}>
                      <Td>{formatVnd(row.amountVnd)}</Td>
                      <Td className="text-right">{formatNumber(row.count)}</Td>
                      <Td className="text-right">{formatVnd(row.faceValueVnd)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableFrame>
              <p className="mt-2 text-xs text-stone-500">Mã hiện là mã demo, chưa được xác minh đổi được tại nhà mạng.</p>
            </Card>
          )}

          <TrafficSection traffic={data.traffic} />
          <FinancialSection financial={data.financial} />

          <details className="rounded-2xl border border-stone-200 bg-white p-4">
            <summary className="cursor-pointer text-sm font-extrabold text-stone-800">Định nghĩa số liệu, đơn vị, nguồn dữ liệu</summary>
            <dl className="mt-3 space-y-2 text-sm">
              {data.definitions.map((item) => (
                <div key={item.key}>
                  <dt className="font-bold text-stone-800">
                    {item.label} <span className="font-normal text-stone-500">({item.unit})</span>
                  </dt>
                  <dd className="text-stone-600">
                    {item.definition} <span className="text-stone-500">Nguồn: {item.source}.</span>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-xs text-stone-500">
              Múi giờ {data.range.timezone} ({data.range.utcOffset}). Số liệu tạo lúc {formatDateTime(data.generatedAt)}; bản ghi vừa phát sinh có thể vào thống kê chậm tối đa 5 phút.
            </p>
          </details>

          <div>
            <Button tone="secondary" onClick={reload} disabled={loading}>
              Tải lại số liệu
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
