import { useEffect, useId, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Khung popup dùng chung: nút đóng + phím Escape, giữ focus trong popup, khóa cuộn trang nền */
export default function Modal({ title, onClose, children }) {
  const titleId = useId();
  const panelRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panelRef.current?.focus();

    const onKeyDown = (e) => {
      // isComposing: đang gõ dấu tiếng Việt bằng bộ gõ IME thì Escape thuộc về bộ gõ
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll(FOCUSABLE)];
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-stone-900/65 p-4 sm:items-center">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="animate-pop-in max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-3xl bg-white shadow-2xl outline-none"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-leaf-100 bg-white px-5 py-3">
          <h2 id={titleId} className="text-base font-extrabold text-leaf-800">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-2xl leading-none text-stone-500 transition hover:bg-stone-100 hover:text-stone-800"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
