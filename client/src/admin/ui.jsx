import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import Modal from '../components/Modal';

export const inputClass =
  'w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-800 outline-none ring-leaf-400 focus:ring-2 disabled:bg-stone-100 disabled:text-stone-500';

const BUTTON_TONES = {
  primary: 'bg-leaf-700 text-white hover:bg-leaf-800',
  secondary: 'border border-stone-300 bg-white text-stone-700 hover:bg-stone-100',
  danger: 'bg-red-700 text-white hover:bg-red-800',
  dangerOutline: 'border border-red-200 bg-white text-red-700 hover:bg-red-50',
};

export function Button({ tone = 'primary', className = '', type = 'button', ...props }) {
  return (
    <button
      type={type}
      className={`rounded-xl px-4 py-2 text-sm font-bold outline-none ring-leaf-400 transition focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-60 ${BUTTON_TONES[tone]} ${className}`}
      {...props}
    />
  );
}

/** Ô nhập có nhãn và thông báo lỗi gắn đúng trường */
export function Field({ label, error, hint, children }) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-semibold text-stone-700">
        {label}
      </label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy, className: inputClass })}
      {hint && !error && (
        <p id={`${id}-hint`} className="text-xs text-stone-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-error`} className="text-xs font-semibold text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextField({ label, error, hint, ...props }) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(field) => <input {...field} {...props} />}
    </Field>
  );
}

export function TextArea({ label, error, hint, ...props }) {
  return (
    <Field label={label} error={error} hint={hint}>
      {(field) => <textarea rows={3} {...field} {...props} />}
    </Field>
  );
}

export function SelectField({ label, children, ...props }) {
  return <Field label={label}>{(field) => <select {...field} {...props}>{children}</select>}</Field>;
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-xl font-extrabold text-leaf-900">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-sm text-stone-600">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, children, className = '' }) {
  return (
    <section className={`rounded-2xl border border-stone-200 bg-white p-4 ${className}`}>
      {title && <h2 className="mb-3 text-sm font-extrabold text-stone-800">{title}</h2>}
      {children}
    </section>
  );
}

const BADGE_TONES = {
  green: 'bg-leaf-100 text-leaf-900',
  amber: 'bg-amber-100 text-amber-900',
  red: 'bg-red-100 text-red-800',
  stone: 'bg-stone-200 text-stone-700',
  blue: 'bg-sky-100 text-sky-900',
};

export function Badge({ tone = 'stone', children }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-bold ${BADGE_TONES[tone]}`}>{children}</span>;
}

export const LoadingState = ({ text = 'Đang tải...' }) => (
  <p role="status" className="py-8 text-center text-sm text-stone-500">
    {text}
  </p>
);

export const EmptyState = ({ children }) => <p className="py-8 text-center text-sm text-stone-500">{children}</p>;

export function ErrorState({ message, onRetry }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <Button tone="dangerOutline" onClick={onRetry} className="px-3 py-1 text-xs">
          Thử lại
        </Button>
      )}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onChange }) {
  const pages = Math.max(Math.ceil(total / pageSize), 1);
  if (total === 0) return null;
  return (
    <nav aria-label="Phân trang" className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm text-stone-600">
      <span>
        Trang {page} / {pages} · {total.toLocaleString('vi-VN')} dòng
      </span>
      <span className="flex gap-2">
        <Button tone="secondary" className="px-3 py-1" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          Trước
        </Button>
        <Button tone="secondary" className="px-3 py-1" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          Sau
        </Button>
      </span>
    </nav>
  );
}

/**
 * Bảng cuộn ngang trong khung của nó: trang không bị cuộn ngang trên màn hình nhỏ. `relative` là bắt buộc: phần tử sr-only
 * trong bảng có position: absolute, không có nó thì không bị khung cắt và kéo giãn cả trang.
 */
export function TableFrame({ label, children }) {
  return (
    <div role="region" aria-label={label} tabIndex={0} className="relative overflow-x-auto rounded-xl border border-stone-200 bg-white outline-none ring-leaf-400 focus-visible:ring-2">
      <table className="w-full min-w-max text-left text-sm">{children}</table>
    </div>
  );
}

export const Th = ({ children, className = '' }) => (
  <th scope="col" className={`whitespace-nowrap border-b border-stone-200 bg-stone-50 px-3 py-2 text-xs font-bold text-stone-600 ${className}`}>
    {children}
  </th>
);

export const Td = ({ children, className = '' }) => <td className={`border-b border-stone-100 px-3 py-2 align-top text-stone-800 ${className}`}>{children}</td>;

/** Xác nhận thao tác nguy hiểm; nhập lý do nếu có `reasonLabel`. Trả promise để giữ hộp thoại mở tới khi xong và hiện lỗi tại chỗ. */
export function ConfirmDialog({ title, description, confirmLabel, tone = 'danger', reasonLabel, onConfirm, onClose, children }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (err) {
      if (!err?.cancelled) setError(err.message || 'Không thực hiện được thao tác.');
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 p-5">
        {description && <p className="text-sm text-stone-600">{description}</p>}
        {children}
        {reasonLabel && <TextArea label={reasonLabel} required minLength={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} disabled={busy} />}
        {error && (
          <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button tone="secondary" onClick={onClose} disabled={busy}>
            Hủy
          </Button>
          <Button type="submit" tone={tone} disabled={busy}>
            {busy ? 'Đang xử lý...' : confirmLabel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

const NoticeContext = createContext(() => {});

/** Thông báo kết quả thao tác, đọc được bằng trình đọc màn hình */
export function NoticeProvider({ children }) {
  const [notice, setNotice] = useState(null);
  const timer = useRef(null);

  const notify = useCallback((text, tone = 'success') => {
    clearTimeout(timer.current);
    setNotice({ text, tone });
    timer.current = setTimeout(() => setNotice(null), 6000);
  }, []);

  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <NoticeContext.Provider value={notify}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed bottom-4 left-4 right-4 z-[60] flex justify-center">
        {notice && (
          <p
            role="status"
            className={`pointer-events-auto max-w-lg rounded-xl px-4 py-3 text-sm font-semibold shadow-lg ${
              notice.tone === 'error' ? 'bg-red-700 text-white' : 'bg-leaf-900 text-white'
            }`}
          >
            {notice.text}
          </p>
        )}
      </div>
    </NoticeContext.Provider>
  );
}

export const useNotice = () => useContext(NoticeContext);

/** Tải dữ liệu theo tham số; giữ dữ liệu cũ khi tải lại, bỏ qua phản hồi đến trễ của lần gọi trước */
export function useLoad(loader, deps) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let stale = false;
    setState((current) => ({ ...current, loading: true, error: '' }));
    loader()
      .then((data) => {
        if (!stale) setState({ data, loading: false, error: '' });
      })
      .catch((err) => {
        if (!stale) setState((current) => ({ ...current, loading: false, error: err.message || 'Không tải được dữ liệu.' }));
      });
    return () => {
      stale = true;
    };
  }, [...deps, reloadKey]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);
  return { ...state, reload, setData: (data) => setState((current) => ({ ...current, data })) };
}
