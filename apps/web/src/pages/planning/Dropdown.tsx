import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export interface Opt {
  id: string;
  label: string;
  count?: number;
}

/** Multi-select dropdown with counts, search and "select all" (prototype: Hotels / Abteilungen). */
export function MultiSelect({
  label,
  options,
  value,
  onChange,
  allLabel,
  searchable,
}: {
  label: string;
  options: Opt[];
  value: string[];
  onChange: (v: string[]) => void;
  allLabel: string;
  searchable?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  const all = value.length === options.length;
  const summary = all
    ? allLabel
    : value.length === 0
      ? t('Keine')
      : value.length === 1
        ? (options.find((o) => o.id === value[0])?.label ?? '')
        : `${value.length} ${t('von')} ${options.length}`;
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.toLowerCase()));
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div ref={ref} style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 6 }}>
      <span
        style={{
          fontSize: 11,
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--color-neutral-700)',
        }}
      >
        {label}
      </span>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        style={{
          fontSize: 13,
          padding: '6px 10px',
          border: '1px solid var(--color-text)',
          background: 'var(--color-bg)',
          cursor: 'pointer',
          display: 'flex',
          gap: 10,
          alignItems: 'center',
          justifyContent: 'space-between',
          minWidth: 150,
          color: 'var(--color-text)',
        }}
      >
        {summary}
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          aria-hidden
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 4,
            zIndex: 41,
            minWidth: 260,
            background: 'var(--color-bg)',
            border: '2px solid var(--color-text)',
            boxShadow: 'var(--shadow-md)',
          }}
        >
          {(searchable ?? options.length > 5) && (
            <div style={{ padding: 8, borderBottom: '1px solid var(--color-divider)' }}>
              <input
                className="input"
                placeholder={t('Suchen')}
                aria-label={t('Suchen')}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                autoFocus
              />
            </div>
          )}
          <label
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'center',
              fontSize: 13,
              fontWeight: 700,
              padding: '9px 12px',
              borderBottom: '2px solid var(--color-divider)',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={all}
              onChange={() => onChange(all ? [] : options.map((o) => o.id))}
            />{' '}
            {allLabel}
          </label>
          <div role="listbox" aria-multiselectable="true" style={{ maxHeight: 260, overflow: 'auto' }}>
            {shown.map((o) => (
              <label
                key={o.id}
                role="option"
                aria-selected={value.includes(o.id)}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  fontSize: 13,
                  padding: '9px 12px',
                  borderBottom: '1px solid var(--color-divider)',
                  cursor: 'pointer',
                }}
              >
                <input type="checkbox" checked={value.includes(o.id)} onChange={() => toggle(o.id)} />
                <span style={{ flex: 1 }}>{o.label}</span>
                {o.count != null && (
                  <span style={{ color: 'var(--color-neutral-700)', fontVariantNumeric: 'tabular-nums' }}>
                    {o.count}
                  </span>
                )}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
