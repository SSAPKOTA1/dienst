import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export const Kicker = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      fontSize: 11,
      letterSpacing: '.1em',
      textTransform: 'uppercase',
      color: 'var(--color-accent-700)',
    }}
  >
    {children}
  </div>
);

export function PageHead({
  kicker,
  title,
  children,
}: {
  kicker?: React.ReactNode;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 'var(--space-3)',
        flexWrap: 'wrap',
        padding: 'var(--space-4)',
      }}
    >
      <div style={{ marginRight: 'auto' }}>
        {kicker && <Kicker>{kicker}</Kicker>}
        <h1 style={{ margin: '2px 0 0', fontSize: 30, lineHeight: 1.1 }}>{title}</h1>
      </div>
      {children}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  children,
  hint,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  children: React.ReactNode;
  hint?: React.ReactNode;
}) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && <div style={{ fontSize: 11, color: 'var(--color-neutral-700)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

export const Label = ({ children }: { children: React.ReactNode }) => (
  <div
    style={{
      fontSize: 11,
      letterSpacing: '.08em',
      textTransform: 'uppercase',
      color: 'var(--color-neutral-700)',
    }}
  >
    {children}
  </div>
);

export const SectionTitle = ({ children }: { children: React.ReactNode }) => (
  <h2
    style={{
      margin: '0 0 var(--space-2)',
      fontSize: 18,
      borderBottom: '2px solid var(--color-text)',
      paddingBottom: 4,
    }}
  >
    {children}
  </h2>
);

/** Segmented control (design tokens `seg`), buttons instead of radios so it works inline. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      style={{ display: 'flex', border: '1px solid var(--color-divider)' }}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            style={{
              fontSize: 13,
              fontWeight: 600,
              padding: '7px 12px',
              border: 0,
              borderLeft: i ? '1px solid var(--color-divider)' : 0,
              cursor: 'pointer',
              background: on ? 'var(--color-text)' : 'transparent',
              color: on ? 'var(--color-bg)' : 'var(--color-text)',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Dialog({
  title,
  onClose,
  children,
  actions,
  width = 480,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  width?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('input,select,textarea,button');
    first?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        const f = [
          ...ref.current.querySelectorAll<HTMLElement>('input,select,textarea,button,a[href]'),
        ].filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        const a = document.activeElement;
        if (e.shiftKey && a === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && a === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div
      className="dialog-backdrop"
      style={{ zIndex: 50 }}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: `min(${width}px,100%)`, maxHeight: '92vh', overflow: 'auto' }}
      >
        <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 24 }}>{title}</h2>
        {children}
        {actions && (
          <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}>{actions}</div>
        )}
      </div>
    </div>
  );
}

// ---- toast ---------------------------------------------------------------------------------
const ToastCtx = createContext<(msg: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.setTimeout(() => setMsg((cur) => (cur === m ? null : cur)), 4000);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && (
        <div
          role="status"
          data-noprint
          style={{
            position: 'fixed',
            right: 16,
            bottom: 16,
            zIndex: 80,
            border: '2px solid var(--warn)',
            background: 'var(--color-bg)',
            padding: '8px 12px',
            fontSize: 13,
            fontWeight: 600,
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {msg}
        </div>
      )}
    </ToastCtx.Provider>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  const { t } = useTranslation();
  if (!error) return null;
  const e = error as { message?: string; code?: string };
  return (
    <div role="alert" style={{ color: 'var(--warn)', fontSize: 13, fontWeight: 600 }}>
      {t(e.code ?? 'Fehler')}: {e.message}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange?: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={!onChange}
      onClick={() => onChange?.(!on)}
      style={{
        width: 44,
        height: 24,
        border: '2px solid var(--color-text)',
        background: on ? 'var(--color-text)' : 'transparent',
        padding: 0,
        cursor: onChange ? 'pointer' : 'default',
        position: 'relative',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 22 : 2,
          width: 16,
          height: 16,
          background: on ? 'var(--color-bg)' : 'var(--color-text)',
        }}
      />
    </button>
  );
}
