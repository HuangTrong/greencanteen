import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { adminApi } from '../adminApi';
import { CONFIG_STATUS_LABELS, formatDateTime, formatNumber, formatVnd, isoToLocalInput, localInputToIso, percentToPpm, ppmToPercent } from '../format';
import { useReauth } from '../session';
import { Badge, Button, Card, ConfirmDialog, ErrorState, LoadingState, PageHeader, TableFrame, Td, TextArea, TextField, Th, inputClass, useLoad, useNotice } from '../ui';

const TOTAL_PPM = 1_000_000;

function toForm(config) {
  return {
    prizes: config.prizes.map((prize) => ({
      ...prize,
      amountText: String(prize.amountVnd),
      percentText: ppmToPercent(prize.probabilityPpm),
      limitText: prize.maxQuantity === null ? '' : String(prize.maxQuantity),
    })),
    budgetText: config.budgetVnd === null ? '' : String(config.budgetVnd),
    effectiveFrom: isoToLocalInput(config.effectiveFrom),
    effectiveTo: isoToLocalInput(config.effectiveTo),
    note: config.note,
  };
}

// Ô trống hoặc sai định dạng được gửi nguyên để server báo lỗi đúng trường, không tự sửa số tiền hay xác suất
const toInteger = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : text.trim());

function toPayload(form, revision) {
  return {
    revision,
    prizes: form.prizes.map(({ prizeId, label, carrier, enabled, amountText, percentText, limitText }) => ({
      prizeId,
      label,
      carrier,
      enabled,
      amountVnd: toInteger(amountText),
      probabilityPpm: percentToPpm(percentText) ?? percentText,
      maxQuantity: limitText.trim() === '' ? null : toInteger(limitText),
    })),
    budgetVnd: form.budgetText.trim() === '' ? null : toInteger(form.budgetText),
    effectiveFrom: localInputToIso(form.effectiveFrom),
    effectiveTo: localInputToIso(form.effectiveTo),
    note: form.note,
  };
}

function ProbabilityTotal({ prizes }) {
  const total = useMemo(
    () => prizes.reduce((sum, prize) => (prize.enabled ? sum + (percentToPpm(prize.percentText) ?? 0) : sum), 0),
    [prizes]
  );
  const ok = total === TOTAL_PPM;
  return (
    <p role="status" className={`rounded-lg px-3 py-2 text-sm font-bold ${ok ? 'bg-leaf-100 text-leaf-900' : 'bg-amber-100 text-amber-900'}`}>
      Tổng xác suất các giải đang bật: {ppmToPercent(total)}%{ok ? ' — hợp lệ' : ' — phải bằng đúng 100% mới xuất bản được'}
    </p>
  );
}

function DraftEditor({ config, onSaved, onChanged }) {
  const navigate = useNavigate();
  const notify = useNotice();
  const withReauth = useReauth();
  const [form, setForm] = useState(() => toForm(config));
  const [fields, setFields] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const setPrize = (index, patch) =>
    setForm((current) => ({ ...current, prizes: current.prizes.map((prize, i) => (i === index ? { ...prize, ...patch } : prize)) }));
  const removePrize = (index) => setForm((current) => ({ ...current, prizes: current.prizes.filter((_, i) => i !== index) }));
  const addPrize = () =>
    setForm((current) => ({
      ...current,
      prizes: [
        ...current.prizes,
        { prizeId: `giai-${Date.now().toString(36)}`, label: 'Mã nạp điện thoại', carrier: '', enabled: true, amountText: '', percentText: '0', limitText: '' },
      ],
    }));

  const save = async () => {
    setFields({});
    setMessage('');
    const saved = await adminApi.updateGachaDraft(config.id, toPayload(form, config.revision));
    onSaved(saved);
    return saved;
  };

  const showError = (err) => {
    if (err.cancelled) return;
    setFields(err.payload?.fields || {});
    setMessage(err.message || 'Không lưu được.');
  };

  const onSave = async () => {
    setBusy(true);
    try {
      await save();
      notify('Đã lưu bản nháp.');
    } catch (err) {
      showError(err);
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    try {
      const saved = await save();
      onChanged(await withReauth(() => adminApi.publishGachaConfig(saved.id, saved.revision)));
      notify(`Đã xuất bản phiên bản ${saved.version}.`);
    } catch (err) {
      showError(err);
      setConfirmPublish(false);
      throw Object.assign(err, { cancelled: true });
    }
  };

  const inlineError = (index, key) => fields[`prizes.${index}.${key}`];

  return (
    <>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          onSave();
        }}
      >
        <Card title="Danh mục giải">
          <TableFrame label="Danh mục giải của bản nháp">
            <thead>
              <tr>
                <Th>Bật</Th>
                <Th>Tên giải</Th>
                <Th>Nhà mạng</Th>
                <Th>Mệnh giá (VND)</Th>
                <Th>Xác suất (%)</Th>
                <Th>Giới hạn kho</Th>
                <Th>
                  <span className="sr-only">Xóa dòng</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {form.prizes.map((prize, index) => (
                <tr key={prize.prizeId}>
                  <Td>
                    <input type="checkbox" aria-label={`Bật giải ${index + 1}`} checked={prize.enabled} onChange={(e) => setPrize(index, { enabled: e.target.checked })} />
                  </Td>
                  <Td>
                    <input aria-label={`Tên giải ${index + 1}`} className={`${inputClass} w-44`} maxLength={80} value={prize.label} onChange={(e) => setPrize(index, { label: e.target.value })} />
                    {inlineError(index, 'label') && <p className="text-xs font-semibold text-red-700">{inlineError(index, 'label')}</p>}
                  </Td>
                  <Td>
                    <input aria-label={`Nhà mạng giải ${index + 1}`} className={`${inputClass} w-32`} maxLength={40} value={prize.carrier} onChange={(e) => setPrize(index, { carrier: e.target.value })} />
                    {inlineError(index, 'carrier') && <p className="text-xs font-semibold text-red-700">{inlineError(index, 'carrier')}</p>}
                  </Td>
                  <Td>
                    <input aria-label={`Mệnh giá giải ${index + 1}`} className={`${inputClass} w-28`} inputMode="numeric" value={prize.amountText} onChange={(e) => setPrize(index, { amountText: e.target.value })} />
                    {inlineError(index, 'amountVnd') && <p className="max-w-40 text-xs font-semibold text-red-700">{inlineError(index, 'amountVnd')}</p>}
                  </Td>
                  <Td>
                    <input aria-label={`Xác suất giải ${index + 1}`} className={`${inputClass} w-24`} inputMode="decimal" value={prize.percentText} onChange={(e) => setPrize(index, { percentText: e.target.value })} />
                    {inlineError(index, 'probabilityPpm') && <p className="max-w-40 text-xs font-semibold text-red-700">{inlineError(index, 'probabilityPpm')}</p>}
                  </Td>
                  <Td>
                    <input aria-label={`Giới hạn kho giải ${index + 1}`} placeholder="Không giới hạn" className={`${inputClass} w-32`} inputMode="numeric" value={prize.limitText} onChange={(e) => setPrize(index, { limitText: e.target.value })} />
                    {inlineError(index, 'maxQuantity') && <p className="max-w-40 text-xs font-semibold text-red-700">{inlineError(index, 'maxQuantity')}</p>}
                  </Td>
                  <Td>
                    <Button tone="dangerOutline" className="px-2 py-1" aria-label={`Xóa giải ${index + 1}`} onClick={() => removePrize(index)}>
                      Xóa
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
          <div className="mt-3 space-y-3">
            <Button tone="secondary" onClick={addPrize}>
              Thêm giải
            </Button>
            <ProbabilityTotal prizes={form.prizes} />
            {fields.prizes && <p className="text-sm font-semibold text-red-700">{fields.prizes}</p>}
            {fields.probabilityTotal && <p className="text-sm font-semibold text-red-700">{fields.probabilityTotal}</p>}
          </div>
        </Card>

        <Card title="Hiệu lực và giới hạn">
          <div className="grid gap-3 md:grid-cols-3">
            <TextField
              label="Hiệu lực từ (giờ Việt Nam)"
              hint="Để trống: áp dụng ngay khi xuất bản."
              type="datetime-local"
              value={form.effectiveFrom}
              onChange={(e) => setForm((current) => ({ ...current, effectiveFrom: e.target.value }))}
              error={fields.effectiveFrom}
            />
            <TextField
              label="Hiệu lực đến (giờ Việt Nam)"
              hint="Để trống: không tự kết thúc."
              type="datetime-local"
              value={form.effectiveTo}
              onChange={(e) => setForm((current) => ({ ...current, effectiveTo: e.target.value }))}
              error={fields.effectiveTo}
            />
            <TextField
              label="Ngân sách tối đa (VND)"
              hint="Tổng mệnh giá được phát. Để trống: không giới hạn."
              inputMode="numeric"
              value={form.budgetText}
              onChange={(e) => setForm((current) => ({ ...current, budgetText: e.target.value }))}
              error={fields.budgetVnd}
            />
          </div>
          <div className="mt-3">
            <TextArea label="Ghi chú" maxLength={500} value={form.note} onChange={(e) => setForm((current) => ({ ...current, note: e.target.value }))} error={fields.note} />
          </div>
        </Card>

        {message && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {message}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <Button type="submit" tone="secondary" disabled={busy}>
            Lưu nháp
          </Button>
          <Button disabled={busy} onClick={() => setConfirmPublish(true)}>
            Xuất bản
          </Button>
          <Button tone="dangerOutline" disabled={busy} onClick={() => setConfirmDiscard(true)}>
            Hủy bản nháp
          </Button>
        </div>
      </form>

      {/* Hộp thoại có <form> riêng nên phải nằm ngoài biểu mẫu trên: form lồng nhau làm trình duyệt tự gửi và tải lại trang */}
      {confirmPublish && (
        <ConfirmDialog
          title={`Xuất bản phiên bản ${config.version}`}
          description="Sau khi xuất bản, danh mục giải của phiên bản này không sửa được nữa. Thao tác cần xác thực lại."
          confirmLabel="Xuất bản"
          tone="primary"
          onConfirm={publish}
          onClose={() => setConfirmPublish(false)}
        />
      )}
      {confirmDiscard && (
        <ConfirmDialog
          title="Hủy bản nháp"
          description={`Phiên bản ${config.version} sẽ không còn trong danh sách.`}
          confirmLabel="Hủy bản nháp"
          onConfirm={async () => {
            await adminApi.discardGachaDraft(config.id, config.revision);
            notify('Đã hủy bản nháp.');
            navigate('/gacha', { replace: true });
          }}
          onClose={() => setConfirmDiscard(false)}
        />
      )}
    </>
  );
}

function PublishedView({ config, onChanged }) {
  const navigate = useNavigate();
  const notify = useNotice();
  const withReauth = useReauth();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const issuedByPrize = new Map(config.issued.map((row) => [row.prizeId, row]));
  const canEnd = config.status === 'published' && (!config.effectiveTo || new Date(config.effectiveTo) > new Date());

  const cloneToDraft = async () => {
    try {
      const draft = await adminApi.createGachaDraft(config.id);
      navigate(`/gacha/${draft.id}`);
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  return (
    <div className="space-y-4">
      <Card title="Danh mục giải">
        <TableFrame label="Danh mục giải của phiên bản đã xuất bản">
          <thead>
            <tr>
              <Th>Tên giải</Th>
              <Th>Nhà mạng</Th>
              <Th className="text-right">Mệnh giá</Th>
              <Th className="text-right">Xác suất</Th>
              <Th>Trạng thái</Th>
              <Th className="text-right">Đã phát</Th>
              <Th className="text-right">Giới hạn kho</Th>
            </tr>
          </thead>
          <tbody className="[font-variant-numeric:tabular-nums]">
            {config.prizes.map((prize) => (
              <tr key={prize.prizeId}>
                <Td>{prize.label}</Td>
                <Td>{prize.carrier}</Td>
                <Td className="text-right">{formatVnd(prize.amountVnd)}</Td>
                <Td className="text-right">{ppmToPercent(prize.probabilityPpm)}%</Td>
                <Td>{prize.enabled ? 'Bật' : 'Tắt'}</Td>
                <Td className="text-right">{formatNumber(issuedByPrize.get(prize.prizeId)?.count ?? 0)}</Td>
                <Td className="text-right">{prize.maxQuantity === null ? 'Không giới hạn' : formatNumber(prize.maxQuantity)}</Td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </Card>

      <Card title="Thông tin phiên bản">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {[
            ['Hiệu lực từ', formatDateTime(config.effectiveFrom)],
            ['Hiệu lực đến', config.effectiveTo ? formatDateTime(config.effectiveTo) : 'Không tự kết thúc'],
            ['Ngân sách', config.budgetVnd === null ? 'Không giới hạn' : `${formatVnd(config.budgetUsedVnd)} / ${formatVnd(config.budgetVnd)} đã dùng`],
            ['Người sửa cuối', config.updatedByLabel || '—'],
            ['Sửa lúc', formatDateTime(config.updatedAt)],
            ['Người xuất bản', config.publishedByLabel || '—'],
            ['Xuất bản lúc', formatDateTime(config.publishedAt)],
            ['Sao từ phiên bản', config.basedOnVersion ?? '—'],
            ['Ghi chú', config.note || '—'],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-stone-500">{label}</dt>
              <dd className="font-semibold text-stone-800">{value}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <div className="flex flex-wrap gap-2">
        <Button tone="secondary" onClick={cloneToDraft}>
          Tạo bản nháp từ phiên bản này
        </Button>
        {canEnd && (
          <Button tone="dangerOutline" onClick={() => setConfirmEnd(true)}>
            Ngừng hiệu lực
          </Button>
        )}
      </div>

      {confirmEnd && (
        <ConfirmDialog
          title={`Ngừng phiên bản ${config.version}`}
          description="Phiên bản còn hiệu lực gần nhất sẽ được dùng. Nếu không còn bản nào, Gacha tạm dừng và sinh viên giữ nguyên lượt quay."
          confirmLabel="Ngừng hiệu lực"
          onConfirm={async () => {
            onChanged(await withReauth(() => adminApi.endGachaConfig(config.id)));
            notify('Đã ngừng hiệu lực.');
          }}
          onClose={() => setConfirmEnd(false)}
        />
      )}
    </div>
  );
}

export default function GachaConfigPage() {
  const { id } = useParams();
  const { data: config, loading, error, reload, setData } = useLoad(() => adminApi.gachaConfig(id), [id]);

  useEffect(() => {
    document.title = 'Cấu hình Gacha · Quản trị GreenCanteen';
  }, []);

  if (!config && loading) return <LoadingState />;
  if (!config) return <ErrorState message={error} onRetry={reload} />;

  const isDraft = config.status === 'draft';
  return (
    <>
      <PageHeader
        title={`Phiên bản ${config.version}`}
        description={<Link to="/gacha" className="font-semibold text-leaf-800 underline underline-offset-2">Các phiên bản</Link>}
        actions={
          <>
            <Badge tone={isDraft ? 'amber' : 'stone'}>{CONFIG_STATUS_LABELS[config.status]}</Badge>
            {config.isCurrent && <Badge tone="green">Đang hiệu lực</Badge>}
          </>
        }
      />
      {isDraft ? (
        <DraftEditor key={config.id} config={config} onSaved={(saved) => setData({ ...config, ...saved })} onChanged={reload} />
      ) : (
        <PublishedView config={config} onChanged={reload} />
      )}
    </>
  );
}
