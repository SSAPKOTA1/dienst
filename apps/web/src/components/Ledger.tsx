import type { LedgerDto } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { fdate, fnum, fsigned } from '../lib/format';
import { Dialog, ErrorNote, Field } from './ui';

const TYPE_LABEL: Record<string, string> = {
  opening_balance: 'Anfangsstand',
  worked: 'Gearbeitet (freigegeben)',
  absence_credit: 'Gutschrift Abwesenheit',
  target: 'Soll',
  correction: 'Korrektur',
  payout: 'Auszahlung',
};

/** Month-by-month ledger of the time account; admins may add a correction or a payout. */
export function LedgerTable({
  path,
  canEdit,
  employeeId,
}: {
  path: string;
  canEdit?: boolean;
  employeeId?: number;
}) {
  const { t } = useTranslation();
  const l = useGet<LedgerDto>(path);
  const [dlg, setDlg] = useState(false);
  if (!l.data) return null;
  if (l.data.balanceHours == null) return <div style={{ fontSize: 13 }}>{t('kein Zeitkonto')}</div>;
  return (
    <div data-testid="ledger">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
        <b style={{ fontSize: 22 }} data-testid="ledger-balance">
          {fsigned(l.data.balanceHours)}
        </b>
        <span style={{ fontSize: 12 }}>
          {t('Stand')} {fdate(l.data.asOf)}
        </span>
        {canEdit && (
          <button
            className="btn btn-secondary"
            style={{ marginLeft: 'auto' }}
            onClick={() => setDlg(true)}
            data-testid="ledger-add"
          >
            {t('Buchung hinzufügen')}
          </button>
        )}
      </div>
      <div style={{ maxHeight: 320, overflow: 'auto', border: '1px solid var(--color-divider)' }}>
        <table className="table" style={{ fontSize: 13 }}>
          <tbody>
            {[...l.data.lines].reverse().map((x, i) => (
              <tr key={i} data-testid="ledger-line">
                <td style={{ whiteSpace: 'nowrap' }}>{x.month.length === 7 ? x.month : fdate(x.month)}</td>
                <td>
                  {t(TYPE_LABEL[x.type] ?? x.type)}
                  {x.note ? ` · ${x.note}` : ''}
                </td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {fnum(x.hours, 2)} h
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {dlg && employeeId && (
        <EntryDialog
          employeeId={employeeId}
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            void l.refetch();
          }}
        />
      )}
    </div>
  );
}

function EntryDialog({
  employeeId,
  onClose,
  onDone,
}: {
  employeeId: number;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [type, setType] = useState('correction');
  const [hours, setHours] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [note, setNote] = useState('');
  const m = useSend('POST', `/employees/${employeeId}/time-account/entries`);
  return (
    <Dialog
      title={t('Buchung hinzufügen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!hours || note.trim().length < 3 || m.isPending}
            onClick={() =>
              m.mutate({ type, hours: Number(hours.replace(',', '.')), date, note }, { onSuccess: onDone })
            }
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Art')} htmlFor="le-type">
        <select id="le-type" className="input" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="correction">{t('Korrektur (+/−)')}</option>
          <option value="payout">{t('Auszahlung (Stunden)')}</option>
        </select>
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label={t('Stunden')} htmlFor="le-h">
          <input
            id="le-h"
            className="input"
            inputMode="decimal"
            value={hours}
            onChange={(e) => setHours(e.target.value)}
          />
        </Field>
        <Field label={t('Datum')} htmlFor="le-d">
          <input
            id="le-d"
            type="date"
            className="input"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
      </div>
      <Field label={t('Begründung (wird protokolliert)')} htmlFor="le-n">
        <input
          id="le-n"
          className="input"
          value={note}
          maxLength={300}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}
