import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { adminApi } from '../adminApi';
import {
  CONFIG_STATUS_LABELS,
  formatDateTime,
  formatNumber,
  formatVnd,
  isoToLocalInput,
  localInputToIso,
  oddsText,
  percentToPpm,
  ppmToPercent,
} from '../format';
import { GachaTabs, MediaImage } from '../gacha';
import { useReauth } from '../session';
import { Badge, Button, Card, ConfirmDialog, ErrorState, LoadingState, PageHeader, TableFrame, Td, TextArea, TextField, Th, inputClass, useLoad, useNotice } from '../ui';

const TOTAL_PPM = 1_000_000;

function toForm(config) {
  const keychains = config.prizes.filter((prize) => !prize.legacy);
  return {
    prizes: keychains.map((prize) => ({
      prizeId: prize.prizeId,
      label: prize.label,
      description: prize.description || '',
      imageId: prize.imageId || '',
      enabled: prize.enabled,
      percentText: ppmToPercent(prize.probabilityPpm),
      quantityText: prize.maxQuantity === null ? '' : String(prize.maxQuantity),
    })),
    // Bản nháp tạo trước khi đổi sang móc khóa có thể còn dòng mã nạp: không sửa được, bị bỏ khi lưu
    droppedLegacy: config.prizes.length - keychains.length,
    claimInstructions: config.claimInstructions || '',
    effectiveFrom: isoToLocalInput(config.effectiveFrom),
    effectiveTo: isoToLocalInput(config.effectiveTo),
    note: config.note,
  };
}

// Ô trống hoặc sai định dạng được gửi nguyên để server báo lỗi đúng trường, không tự sửa số lượng hay xác suất
const toInteger = (text) => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : text.trim());

function toPayload(form, revision) {
  return {
    revision,
    prizes: form.prizes.map(({ prizeId, label, description, imageId, enabled, percentText, quantityText }) => ({
      prizeId,
      label,
      description,
      imageId,
      enabled,
      probabilityPpm: percentToPpm(percentText) ?? percentText,
      maxQuantity: toInteger(quantityText),
    })),
    claimInstructions: form.claimInstructions,
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
  const over = total > TOTAL_PPM;
  const warn = over || total === 0;
  return (
    <p role="status" className={`rounded-lg px-3 py-2 text-sm font-bold ${warn ? 'bg-amber-100 text-amber-900' : 'bg-leaf-100 text-leaf-900'}`}>
      Tổng xác suất trúng của các mẫu đang bật: {ppmToPercent(total)}% ({oddsText(total)}). Không trúng:{' '}
      {over ? '—' : `${ppmToPercent(TOTAL_PPM - total)}%`}
      {over && '. Vượt 100% nên chưa xuất bản được.'}
      {total === 0 && '. Chưa mẫu nào có cơ hội trúng.'}
    </p>
  );
}

const FieldError = ({ children }) => (children ? <p className="max-w-56 text-xs font-semibold text-red-700">{children}</p> : null);

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
  const { data: library, reload: reloadLibrary, error: libraryError } = useLoad(() => adminApi.gachaMedia({ kind: 'keychain' }), []);
  const images = library?.items || [];
  const imageById = new Map(images.map((image) => [image.id, image]));
  const used = new Map((config.usage || []).map((row) => [row.prizeId, row.used]));

  const setPrize = (index, patch) =>
    setForm((current) => ({ ...current, prizes: current.prizes.map((prize, i) => (i === index ? { ...prize, ...patch } : prize)) }));
  const removePrize = (index) => setForm((current) => ({ ...current, prizes: current.prizes.filter((_, i) => i !== index) }));
  const addPrize = () =>
    setForm((current) => ({
      ...current,
      prizes: [
        ...current.prizes,
        { prizeId: `moc-khoa-${Date.now().toString(36)}`, label: '', description: '', imageId: '', enabled: true, percentText: '0', quantityText: '' },
      ],
    }));
  const setField = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

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
        <Card title="Mẫu móc khóa">
          {form.droppedLegacy > 0 && (
            <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Bản nháp này có {form.droppedLegacy} giải mã nạp điện thoại cũ. Mã nạp không còn được phát nên các dòng đó sẽ bị bỏ khi lưu.
            </p>
          )}
          <p className="mb-3 text-xs text-stone-600">
            Xác suất là cơ hội trúng của mỗi lượt quay, tối đa 4 chữ số thập phân (nhỏ nhất 0,0001% = 1 trên 1.000.000 lượt). Số lượng là
            tổng số móc khóa thật của mẫu, tính cả số đã trúng ở các phiên bản trước; muốn thêm mẫu mới thì thêm dòng mới thay vì đổi ảnh
            của dòng cũ. Ảnh lấy từ{' '}
            <Link to="/gacha/media" target="_blank" className="font-semibold text-leaf-800 underline underline-offset-2">
              thư viện ảnh (mở thẻ mới)
            </Link>
            .{' '}
            <button type="button" onClick={reloadLibrary} className="font-semibold text-leaf-800 underline underline-offset-2">
              Tải lại danh sách ảnh
            </button>
          </p>
          {libraryError && <p className="mb-3 text-sm font-semibold text-red-700">Không tải được thư viện ảnh: {libraryError}</p>}
          <TableFrame label="Mẫu móc khóa của bản nháp">
            <thead>
              <tr>
                <Th>Bật</Th>
                <Th>Ảnh</Th>
                <Th>Tên và mô tả</Th>
                <Th>Xác suất trúng (%)</Th>
                <Th>Tổng số lượng</Th>
                <Th>
                  <span className="sr-only">Xóa dòng</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {form.prizes.map((prize, index) => {
                const image = imageById.get(prize.imageId);
                const ppm = percentToPpm(prize.percentText);
                const usedCount = used.get(prize.prizeId) || 0;
                return (
                  <tr key={prize.prizeId}>
                    <Td>
                      <input type="checkbox" aria-label={`Bật mẫu ${index + 1}`} checked={prize.enabled} onChange={(e) => setPrize(index, { enabled: e.target.checked })} />
                    </Td>
                    <Td>
                      <div className="flex w-52 items-start gap-2">
                        <MediaImage url={image?.url} alt={image ? `Ảnh ${image.name}` : ''} className="h-14 w-14 shrink-0" />
                        <select
                          aria-label={`Ảnh móc khóa mẫu ${index + 1}`}
                          className={`${inputClass} min-w-0`}
                          value={prize.imageId}
                          onChange={(e) => setPrize(index, { imageId: e.target.value })}
                        >
                          <option value="">Chọn ảnh</option>
                          {prize.imageId && !image && library && <option value={prize.imageId}>(ảnh không còn trong thư viện)</option>}
                          {images.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <FieldError>{inlineError(index, 'imageId')}</FieldError>
                    </Td>
                    <Td>
                      <div className="w-60 space-y-1">
                        <input
                          aria-label={`Tên móc khóa mẫu ${index + 1}`}
                          placeholder="Tên móc khóa"
                          className={inputClass}
                          maxLength={80}
                          value={prize.label}
                          onChange={(e) => setPrize(index, { label: e.target.value })}
                        />
                        <FieldError>{inlineError(index, 'label')}</FieldError>
                        <textarea
                          aria-label={`Mô tả mẫu ${index + 1}`}
                          placeholder="Mô tả ngắn (không bắt buộc)"
                          rows={2}
                          className={inputClass}
                          maxLength={300}
                          value={prize.description}
                          onChange={(e) => setPrize(index, { description: e.target.value })}
                        />
                        <FieldError>{inlineError(index, 'description')}</FieldError>
                      </div>
                    </Td>
                    <Td>
                      <input
                        aria-label={`Xác suất trúng mẫu ${index + 1}`}
                        className={`${inputClass} w-28`}
                        inputMode="decimal"
                        value={prize.percentText}
                        onChange={(e) => setPrize(index, { percentText: e.target.value })}
                      />
                      <p className="mt-1 text-xs text-stone-500">{ppm === null ? 'Sai định dạng' : oddsText(ppm)}</p>
                      <FieldError>{inlineError(index, 'probabilityPpm')}</FieldError>
                    </Td>
                    <Td>
                      <input
                        aria-label={`Tổng số lượng mẫu ${index + 1}`}
                        className={`${inputClass} w-28`}
                        inputMode="numeric"
                        value={prize.quantityText}
                        onChange={(e) => setPrize(index, { quantityText: e.target.value })}
                      />
                      <p className="mt-1 text-xs text-stone-500">Đã trúng: {formatNumber(usedCount)}</p>
                      <FieldError>{inlineError(index, 'maxQuantity')}</FieldError>
                    </Td>
                    <Td>
                      <Button tone="dangerOutline" className="px-2 py-1" aria-label={`Xóa mẫu ${index + 1}`} onClick={() => removePrize(index)}>
                        Xóa
                      </Button>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </TableFrame>
          <div className="mt-3 space-y-3">
            <Button tone="secondary" onClick={addPrize}>
              Thêm mẫu móc khóa
            </Button>
            <ProbabilityTotal prizes={form.prizes} />
            {fields.prizes && <p className="text-sm font-semibold text-red-700">{fields.prizes}</p>}
            {fields.probabilityTotal && <p className="text-sm font-semibold text-red-700">{fields.probabilityTotal}</p>}
          </div>
        </Card>

        <Card title="Hiệu lực và nhận quà">
          <div className="grid gap-3 md:grid-cols-2">
            <TextField
              label="Hiệu lực từ (giờ Việt Nam)"
              hint="Để trống: áp dụng ngay khi xuất bản."
              type="datetime-local"
              value={form.effectiveFrom}
              onChange={setField('effectiveFrom')}
              error={fields.effectiveFrom}
            />
            <TextField
              label="Hiệu lực đến (giờ Việt Nam)"
              hint="Để trống: không tự kết thúc."
              type="datetime-local"
              value={form.effectiveTo}
              onChange={setField('effectiveTo')}
              error={fields.effectiveTo}
            />
          </div>
          <div className="mt-3 space-y-3">
            <TextArea
              label="Hướng dẫn nhận quà"
              hint="Nơi nhận, giờ nhận, cần mang gì (mã nhận quà, thẻ sinh viên), hạn nhận. Hiện cho người trúng và trên trang thể lệ."
              maxLength={500}
              value={form.claimInstructions}
              onChange={setField('claimInstructions')}
              error={fields.claimInstructions}
            />
            <TextArea label="Ghi chú nội bộ" hint="Không hiện cho sinh viên." maxLength={500} value={form.note} onChange={setField('note')} error={fields.note} />
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
          description="Sau khi xuất bản, mẫu móc khóa, xác suất và hướng dẫn nhận quà của phiên bản này không sửa được nữa; trang thể lệ công khai cập nhật ngay. Thao tác cần xác thực lại."
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

function KeychainTable({ config }) {
  const wonHere = new Map(config.issued.map((row) => [row.prizeId, row.count]));
  const used = new Map((config.usage || []).map((row) => [row.prizeId, row.used]));
  return (
    <TableFrame label="Mẫu móc khóa của phiên bản đã xuất bản">
      <thead>
        <tr>
          <Th>Ảnh</Th>
          <Th>Mẫu móc khóa</Th>
          <Th className="text-right">Xác suất trúng</Th>
          <Th>Trạng thái</Th>
          <Th className="text-right">Trúng ở phiên bản này</Th>
          <Th className="text-right">Đã trúng / tổng số lượng</Th>
        </tr>
      </thead>
      <tbody className="[font-variant-numeric:tabular-nums]">
        {config.prizes.map((prize) => (
          <tr key={prize.prizeId}>
            <Td>
              <MediaImage url={prize.imageUrl} alt={`Ảnh ${prize.label}`} className="h-12 w-12" />
            </Td>
            <Td>
              <p className="font-semibold">{prize.label}</p>
              {prize.description && <p className="max-w-xs text-xs text-stone-500">{prize.description}</p>}
            </Td>
            <Td className="whitespace-nowrap text-right">
              {ppmToPercent(prize.probabilityPpm)}%<br />
              <span className="text-xs text-stone-500">{oddsText(prize.probabilityPpm)}</span>
            </Td>
            <Td>{prize.enabled ? 'Bật' : 'Tắt'}</Td>
            <Td className="text-right">{formatNumber(wonHere.get(prize.prizeId) ?? 0)}</Td>
            <Td className="text-right">
              {formatNumber(used.get(prize.prizeId) ?? 0)} / {prize.maxQuantity === null ? '—' : formatNumber(prize.maxQuantity)}
            </Td>
          </tr>
        ))}
      </tbody>
    </TableFrame>
  );
}

/** Phiên bản mã nạp demo trước khi đổi sang móc khóa: chỉ xem, giữ để đối chiếu mã đã phát */
function LegacyPrizeTable({ config }) {
  const issuedByPrize = new Map(config.issued.map((row) => [row.prizeId, row]));
  return (
    <>
      <p className="mb-3 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-700">
        Phiên bản mã nạp điện thoại demo trước khi đổi sang móc khóa. Không còn được dùng để quay; giữ lại để đối chiếu mã đã phát.
      </p>
      <TableFrame label="Danh mục giải mã nạp cũ">
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
              <Td>{prize.carrier || '—'}</Td>
              <Td className="text-right">{formatVnd(prize.amountVnd)}</Td>
              <Td className="text-right">{ppmToPercent(prize.probabilityPpm)}%</Td>
              <Td>{prize.enabled ? 'Bật' : 'Tắt'}</Td>
              <Td className="text-right">{formatNumber(issuedByPrize.get(prize.prizeId)?.count ?? 0)}</Td>
              <Td className="text-right">{prize.maxQuantity === null ? 'Không giới hạn' : formatNumber(prize.maxQuantity)}</Td>
            </tr>
          ))}
        </tbody>
      </TableFrame>
    </>
  );
}

function PublishedView({ config, onChanged }) {
  const navigate = useNavigate();
  const notify = useNotice();
  const withReauth = useReauth();
  const [confirmEnd, setConfirmEnd] = useState(false);
  const canEnd = config.status === 'published' && (!config.effectiveTo || new Date(config.effectiveTo) > new Date());
  const spins = config.spins || { total: 0, wins: 0, losses: 0 };

  const cloneToDraft = async () => {
    try {
      const draft = await adminApi.createGachaDraft(config.id);
      navigate(`/gacha/${draft.id}`);
    } catch (err) {
      notify(err.message, 'error');
    }
  };

  const details = [
    ['Hiệu lực từ', formatDateTime(config.effectiveFrom)],
    ['Hiệu lực đến', config.effectiveTo ? formatDateTime(config.effectiveTo) : 'Không tự kết thúc'],
    ['Lượt quay ở phiên bản này', `${formatNumber(spins.total)} lượt: ${formatNumber(spins.wins)} trúng, ${formatNumber(spins.losses)} không trúng`],
    ...(config.legacy
      ? [['Ngân sách', config.budgetVnd === null ? 'Không giới hạn' : `${formatVnd(config.budgetUsedVnd)} / ${formatVnd(config.budgetVnd)} đã dùng`]]
      : [['Hướng dẫn nhận quà', config.claimInstructions || '—']]),
    ['Người sửa cuối', config.updatedByLabel || '—'],
    ['Sửa lúc', formatDateTime(config.updatedAt)],
    ['Người xuất bản', config.publishedByLabel || '—'],
    ['Xuất bản lúc', formatDateTime(config.publishedAt)],
    ['Sao từ phiên bản', config.basedOnVersion ?? '—'],
    ['Ghi chú nội bộ', config.note || '—'],
  ];

  return (
    <div className="space-y-4">
      <Card title={config.legacy ? 'Danh mục giải' : 'Mẫu móc khóa'}>
        {config.legacy ? <LegacyPrizeTable config={config} /> : <KeychainTable config={config} />}
      </Card>

      <Card title="Thông tin phiên bản">
        <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {details.map(([label, value]) => (
            <div key={label}>
              <dt className="text-stone-500">{label}</dt>
              <dd className="whitespace-pre-line break-words font-semibold text-stone-800">{value}</dd>
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
          description="Phiên bản còn hiệu lực gần nhất sẽ được dùng. Nếu không còn bản nào, quay thưởng tri ân tạm dừng và sinh viên giữ nguyên lượt quay. Móc khóa đã trúng vẫn được trao như cũ."
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
    document.title = 'Cấu hình quay thưởng tri ân · Quản trị GreenCanteen';
  }, []);

  if (!config && loading) return <LoadingState />;
  if (!config) return <ErrorState message={error} onRetry={reload} />;

  const isDraft = config.status === 'draft';
  return (
    <>
      <PageHeader
        title={`Phiên bản ${config.version}`}
        description={
          <Link to="/gacha" className="font-semibold text-leaf-800 underline underline-offset-2">
            Các phiên bản
          </Link>
        }
        actions={
          <>
            <Badge tone={isDraft ? 'amber' : 'stone'}>{CONFIG_STATUS_LABELS[config.status]}</Badge>
            {config.isCurrent && <Badge tone="green">Đang hiệu lực</Badge>}
          </>
        }
      />
      <GachaTabs />
      {isDraft ? (
        <DraftEditor key={config.id} config={config} onSaved={(saved) => setData({ ...config, ...saved })} onChanged={reload} />
      ) : (
        <PublishedView config={config} onChanged={reload} />
      )}
    </>
  );
}
