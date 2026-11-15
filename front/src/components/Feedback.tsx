import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import { useDialog, useTip, useToasts } from '../lib/feedback';

export function Toasts() {
  const list = useToasts();
  return (
    <div className="toasts" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          className={`toast ${t.kind}${t.out ? ' out' : ''}`}
          role={t.kind === 'error' ? 'alert' : 'status'}
        >
          <span className="dot" aria-hidden="true" />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}

/** The chart tooltip: placed next to the pointer and flipped to stay inside the viewport. */
export function Tip() {
  const t = useTip();
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!t || !node) return;
    const r = node.getBoundingClientRect();
    let left = t.x + 14,
      top = t.y + 14;
    if (left + r.width > window.innerWidth - 8) left = t.x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = t.y - r.height - 14;
    node.style.left = `${Math.max(8, left)}px`;
    node.style.top = `${Math.max(8, top)}px`;
  }, [t]);
  return (
    <div ref={ref} className="tip" role="tooltip" hidden={!t}>
      {t ? t.content : null}
    </div>
  );
}

export const TipHead = ({ children }: { children: ReactNode }) => (
  <div className="tip-head">{children}</div>
);
export const TipRow = ({ k, v, tone }: { k: ReactNode; v: ReactNode; tone?: string }) => (
  <div className="tip-row">
    <span className={tone ? `key ${tone}` : 'key'}>{k}</span>
    <b>{v}</b>
  </div>
);

/** Confirmation and small forms (see lib/feedback.ts dialog()). */
export function DialogHost() {
  const d = useDialog();
  const formRef = useRef<HTMLFormElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!d) return;
    setError('');
    setBusy(false);
    const first = formRef.current?.querySelector<HTMLElement>('input, select, textarea');
    (first || okRef.current)?.focus();
  }, [d]);

  if (!d) return null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    try {
      await d.onSubmit(new FormData(form), form);
      d.close(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };
  return (
    <div
      className="palette dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="dialog-title"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          d.close(false);
        }
      }}
    >
      <form
        ref={formRef}
        className={`palette-box dialog-box${d.wide ? ' wide' : ''}`}
        autoComplete="off"
        onSubmit={submit}
      >
        <h2 id="dialog-title">{d.title}</h2>
        <fieldset className="plain" disabled={busy}>
          <div>{d.body}</div>
          <div className="form-error" role="alert">
            {error}
          </div>
          <div className="row-actions end">
            {d.info ? null : (
              <button type="button" className="btn" onClick={() => d.close(false)}>
                Cancel
              </button>
            )}
            <button
              ref={okRef}
              type="submit"
              className={`btn ${d.danger ? 'danger solid' : 'primary'}`}
            >
              {d.ok}
            </button>
          </div>
        </fieldset>
      </form>
    </div>
  );
}
