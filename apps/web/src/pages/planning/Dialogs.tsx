import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../lib/api';
import { fnum } from '../../lib/format';
import { Dialog } from '../../components/ui';
import { WarnIcon } from './Grid';
import type { GridEntry, GridRow } from './types';
import { OVERRIDABLE, violationText, type Violation } from './util';

export interface ReasonState {
  violations: Violation[];
  /** true when the server blocked it and an admin may use the emergency exception */
  emergency: boolean;
  retry: (reason: string, emergency: boolean) => void;
}

export function ReasonDialog({ state, onClose }: { state: ReasonState; onClose: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState('');
  const [emergency, setEmergency] = useState(state.emergency);
  const ok = reason.trim().length >= 5 && reason.trim().length <= 300;
  const overridable = state.violations.filter((v) => v.severity === 'block' && OVERRIDABLE.has(v.code));
  return (
    <Dialog
      title={t('Begründung erforderlich')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!ok}
            data-testid="reason-confirm"
            onClick={() => {
              state.retry(reason.trim(), emergency);
              onClose();
            }}
          >
            {t('Mit Begründung speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      {state.violations.map((v, i) => {
        const x = violationText(v, t);
        return (
          <div key={i} style={{ border: '2px solid var(--warn)', padding: 'var(--space-3)' }}>
            <div
              style={{
                display: 'flex',
                gap: 6,
                alignItems: 'center',
                fontSize: 12,
                fontWeight: 800,
                textTransform: 'uppercase',
                color: 'var(--warn)',
              }}
            >
              <WarnIcon size={14} />
              {x.title}
            </div>
            <div style={{ fontSize: 13 }}>{x.msg}</div>
          </div>
        );
      })}
      {state.emergency && overridable.length > 0 && (
        <label style={{ display: 'flex', gap: 8, fontSize: 13 }}>
          <input type="checkbox" checked={emergency} onChange={(e) => setEmergency(e.target.checked)} />{' '}
          {t('Notfall-Ausnahme (nur Administration, wird protokolliert)')}
        </label>
      )}
      <div className="field">
        <label htmlFor="rs">{t('Begründung (5–300 Zeichen, wird protokolliert)')}</label>
        <textarea
          id="rs"
          className="input"
          data-testid="reason-text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
        />
      </div>
    </Dialog>
  );
}

export function ClearDialog({
  n,
  pub,
  onConfirm,
  onClose,
}: {
  n: number;
  pub: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Dialog
      title={t('Plan dieser Woche leeren?')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            data-testid="clear-confirm"
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {t('Plan leeren')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 14, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div>
          <b>{n}</b> {t('Einträge werden gelöscht.')}
        </div>
        <div>
          <b>{pub}</b> {t('davon sind veröffentlicht. Betroffene Mitarbeitende werden benachrichtigt.')}
        </div>
        <div style={{ color: 'var(--color-neutral-700)' }}>
          {t('Abwesenheiten und vergangene Tage bleiben unverändert.')}
        </div>
        <div style={{ color: 'var(--color-neutral-700)' }}>
          {t('Nur die angezeigten Hotels und Abteilungen.')}
        </div>
      </div>
    </Dialog>
  );
}

export function FinderDialog({
  entry,
  row,
  onAssign,
  onClose,
}: {
  entry: GridEntry;
  row: GridRow;
  onAssign: (employeeId: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<any[] | null>(null);
  useEffect(() => {
    api('/schedule/candidates', {
      query: {
        hotelIds: entry.hotelId,
        shiftId: entry.shiftId ?? undefined,
        departmentId: entry.shiftId ? undefined : (row.departmentId ?? undefined),
        date: entry.date,
        start: entry.shiftId ? undefined : entry.start.slice(11, 16),
        end: entry.shiftId ? undefined : entry.end.slice(11, 16),
      },
    })
      .then((r) => setItems(r.items.filter((c: any) => c.employeeId !== entry.employeeId)))
      .catch(() => setItems([]));
  }, [entry, row.departmentId]);
  return (
    <Dialog
      title={`${t('Vertretung für')} ${entry.displayName}`}
      onClose={onClose}
      width={680}
      actions={
        <button className="btn btn-secondary" onClick={onClose}>
          {t('Schließen')}
        </button>
      }
    >
      <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
        {t('Reihenfolge: keine Warnung, wenig Wochenstunden. Es wird niemand automatisch benachrichtigt.')}
      </div>
      <div style={{ borderTop: '2px solid var(--color-divider)' }} data-testid="finder-list">
        {(items ?? []).map((c) => (
          <div
            key={c.employeeId}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0,1fr) auto',
              gap: 12,
              padding: '8px 0',
              borderBottom: '1px solid var(--color-divider)',
              alignItems: 'center',
            }}
          >
            <div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <b style={{ fontSize: 14 }}>{c.displayName}</b>
                {c.isFloater && (
                  <span className="tag tag-outline" style={{ padding: '0 5px', fontSize: 10 }}>
                    {t('Springer')}
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
                {c.hotelName} · {fnum(c.weekHours)} {t('Std.')}
                {c.targetHours != null ? ` ${t('von')} ${fnum(c.targetHours)}` : ''}
              </div>
              {c.warnings.map((w: Violation, i: number) => (
                <div key={i} style={{ fontSize: 12, fontWeight: 600, color: 'var(--warn)' }}>
                  {violationText(w, t).title}: {violationText(w, t).msg}
                </div>
              ))}
            </div>
            <button
              className="btn btn-secondary"
              onClick={() => {
                onAssign(c.employeeId);
                onClose();
              }}
            >
              {t('Zuweisen')}
            </button>
          </div>
        ))}
        {items && items.length === 0 && (
          <div style={{ padding: 'var(--space-3) 0', fontSize: 13 }}>{t('Keine passenden Kandidaten.')}</div>
        )}
      </div>
    </Dialog>
  );
}
