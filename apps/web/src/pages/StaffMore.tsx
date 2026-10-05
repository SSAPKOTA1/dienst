import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { download, upload, useGet, useSend } from '../lib/api';
import { fdate, fnum } from '../lib/format';
import { Dialog, ErrorNote, Field, Label, useToast } from '../components/ui';

const DOC_TYPES: Array<[string, string]> = [
  ['contract', 'Arbeitsvertrag'],
  ['hygiene_instruction', 'Belehrung Infektionsschutz'],
  ['work_permit', 'Arbeitserlaubnis'],
  ['training_certificate', 'Schulungsnachweis'],
  ['payslip', 'Gehaltsabrechnung'],
  ['other', 'Sonstiges'],
];

/** Qualifications of one employee (planners) with optional expiry. */
export function QualificationsEditor({ id }: { id: number }) {
  const { t } = useTranslation();
  const toast = useToast();
  const all = useGet('/qualifications');
  const mine = useGet(`/employees/${id}/qualifications`);
  const save = useSend<any>('PUT', `/employees/${id}/qualifications`);
  const [add, setAdd] = useState('');
  const [until, setUntil] = useState('');
  const held: any[] = mine.data?.items ?? [];
  const put = (items: any[]) =>
    save.mutate(
      { items: items.map((x) => ({ qualificationId: x.qualificationId, validUntil: x.validUntil ?? null })) },
      {
        onSuccess: () => {
          toast(t('Gespeichert.'));
          void mine.refetch();
        },
      },
    );
  const free = (all.data?.items ?? []).filter((q: any) => !held.some((h) => h.qualificationId === q.id));
  const pick = free.find((q: any) => String(q.id) === add) ?? free[0];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }} data-testid="quals">
      <Label>{t('Qualifikationen')}</Label>
      {held.map((h) => (
        <div
          key={h.qualificationId}
          style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 14 }}
        >
          <b>{h.name}</b>
          {h.validUntil && (
            <span>
              {t('gültig bis')} {fdate(h.validUntil)}
            </span>
          )}
          <button
            className="btn btn-ghost"
            style={{ marginLeft: 'auto' }}
            onClick={() => put(held.filter((x) => x.qualificationId !== h.qualificationId))}
          >
            {t('Entfernen')}
          </button>
        </div>
      ))}
      {pick && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <select
            className="input"
            style={{ width: 'auto' }}
            aria-label={t('Qualifikation')}
            value={String(pick.id)}
            onChange={(e) => setAdd(e.target.value)}
          >
            {free.map((q: any) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
          {pick.hasExpiry && (
            <input
              type="date"
              className="input"
              style={{ width: 'auto' }}
              aria-label={t('gültig bis')}
              value={until}
              onChange={(e) => setUntil(e.target.value)}
            />
          )}
          <button
            className="btn btn-secondary"
            disabled={pick.hasExpiry && !until}
            onClick={() =>
              put([...held, { qualificationId: pick.id, validUntil: pick.hasExpiry ? until : null }])
            }
          >
            {t('Hinzufügen')}
          </button>
        </div>
      )}
      <ErrorNote error={save.error} />
    </div>
  );
}

/** Personnel documents (admins). No health data. Stored encrypted, every download is logged. */
export function DocumentsPanel({ id }: { id: number }) {
  const { t } = useTranslation();
  const toast = useToast();
  const list = useGet(`/employees/${id}/documents`);
  const del = useSend<number>('DELETE', (d) => `/documents/${d}`);
  const [dlg, setDlg] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }} data-testid="docs">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Label>{t('Dokumente')}</Label>
        <button
          className="btn btn-secondary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setDlg(true)}
          data-testid="doc-new"
        >
          {t('Hochladen')}
        </button>
      </div>
      {(list.data?.items ?? []).map((d: any) => (
        <div
          key={d.id}
          style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 14 }}
          data-testid="doc-row"
        >
          <b>{d.title}</b>
          <span style={{ fontSize: 12 }}>
            {t(DOC_TYPES.find((x) => x[0] === d.docType)?.[1] ?? d.docType)}
            {d.validUntil ? ` · ${t('gültig bis')} ${fdate(d.validUntil)}` : ''}
            {d.visibleToEmployee ? '' : ` · ${t('nur intern')}`}
          </span>
          <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap' }}>
            <button
              className="btn btn-ghost"
              onClick={() =>
                void download(`/documents/${d.id}/download`, {}, d.fileName).catch(() =>
                  toast(t('Download fehlgeschlagen')),
                )
              }
            >
              {t('Herunterladen')}
            </button>
            <button
              className="btn btn-ghost"
              onClick={() => del.mutate(d.id, { onSuccess: () => void list.refetch() })}
            >
              {t('Löschen')}
            </button>
          </span>
        </div>
      ))}
      {(list.data?.items ?? []).length === 0 && <div style={{ fontSize: 13 }}>{t('Keine Dokumente.')}</div>}
      {dlg && (
        <UploadDialog
          id={id}
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            void list.refetch();
          }}
        />
      )}
    </div>
  );
}

function UploadDialog({ id, onClose, onDone }: { id: number; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [docType, setDocType] = useState('contract');
  const [validUntil, setValidUntil] = useState('');
  const [visible, setVisible] = useState(true);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const f = new FormData();
      f.append('title', title);
      f.append('docType', docType);
      f.append('validUntil', validUntil);
      f.append('visibleToEmployee', String(visible));
      f.append('file', file);
      await upload(`/employees/${id}/documents`, f);
      onDone();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={t('Dokument hochladen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!file || !title.trim() || busy}
            data-testid="doc-save"
            onClick={() => void send()}
          >
            {t('Hochladen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 12 }}>
        {t('PDF, PNG oder JPEG bis 10 MB. Keine Gesundheitsdaten (z. B. Krankmeldungen).')}
      </p>
      <Field label={t('Datei')} htmlFor="doc-file">
        <input
          id="doc-file"
          ref={input}
          type="file"
          accept=".pdf,.png,.jpg,.jpeg"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, ''));
          }}
        />
      </Field>
      <Field label={t('Titel')} htmlFor="doc-title">
        <input
          id="doc-title"
          className="input"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label={t('Art')} htmlFor="doc-type">
        <select id="doc-type" className="input" value={docType} onChange={(e) => setDocType(e.target.value)}>
          {DOC_TYPES.map(([k, l]) => (
            <option key={k} value={k}>
              {t(l)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Gültig bis (optional)')} htmlFor="doc-until">
        <input
          id="doc-until"
          type="date"
          className="input"
          value={validUntil}
          onChange={(e) => setValidUntil(e.target.value)}
        />
      </Field>
      <label style={{ display: 'flex', gap: 6, fontSize: 14 }}>
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />{' '}
        {t('Für die Person sichtbar')}
      </label>
      <ErrorNote error={err} />
    </Dialog>
  );
}

/** Offboarding: last day, exit statement. */
export function TerminatePanel({ id, name, lastDay }: { id: number; name: string; lastDay: string | null }) {
  const { t } = useTranslation();
  const [dlg, setDlg] = useState(false);
  const [st, setSt] = useState<any | null>(null);
  const stmt = useGet(lastDay ? `/employees/${id}/exit-statement` : null);
  const shown = st ?? stmt.data;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }} data-testid="terminate">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <Label>{t('Austritt')}</Label>
        <button
          className="btn btn-secondary"
          style={{ marginLeft: 'auto' }}
          onClick={() => setDlg(true)}
          data-testid="terminate-open"
        >
          {lastDay ? t('Letzten Arbeitstag ändern') : t('Austritt erfassen')}
        </button>
      </div>
      {shown && (
        <div style={{ fontSize: 13 }} data-testid="exit-statement">
          <div>
            {t('Letzter Arbeitstag')}: <b>{fdate(shown.lastDay)}</b>
            {shown.reason ? ` · ${shown.reason}` : ''}
          </div>
          <div>
            {t('Resturlaub (auszuzahlen)')}:{' '}
            <b>
              {fnum(shown.vacation.payoutDays)} {t('Tage')}
            </b>
          </div>
          <div>
            {t('Zeitkonto')}:{' '}
            <b>{shown.timeAccountHours == null ? '–' : `${fnum(shown.timeAccountHours)} h`}</b>
          </div>
          <div>
            {t('Offen')}: {shown.open.pendingTimeRecords} {t('Zeiten')}, {shown.open.pendingCorrections}{' '}
            {t('Korrekturen')}, {shown.open.pendingAbsenceRequests} {t('Urlaubsanträge')}
          </div>
        </div>
      )}
      {dlg && (
        <TerminateDialog
          id={id}
          name={name}
          onClose={() => setDlg(false)}
          onDone={(r) => {
            setDlg(false);
            setSt(r);
            void stmt.refetch();
          }}
        />
      )}
    </div>
  );
}

function TerminateDialog({
  id,
  name,
  onClose,
  onDone,
}: {
  id: number;
  name: string;
  onClose: () => void;
  onDone: (r: any) => void;
}) {
  const { t } = useTranslation();
  const [lastDay, setLastDay] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');
  const m = useSend<any, any>('POST', `/employees/${id}/terminate`);
  return (
    <Dialog
      title={`${t('Austritt')}: ${name}`}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={m.isPending}
            data-testid="terminate-save"
            onClick={() => m.mutate({ lastDay, reason: reason || undefined }, { onSuccess: onDone })}
          >
            {t('Austritt speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <p style={{ margin: 0, fontSize: 13 }}>
        {t(
          'Nach dem letzten Arbeitstag wird nicht mehr geplant, PIN und Login werden abgeschaltet. Spätere Schichten werden entfernt.',
        )}
      </p>
      <Field label={t('Letzter Arbeitstag')} htmlFor="te-day">
        <input
          id="te-day"
          type="date"
          className="input"
          value={lastDay}
          onChange={(e) => setLastDay(e.target.value)}
        />
      </Field>
      <Field label={t('Grund (optional)')} htmlFor="te-reason">
        <input
          id="te-reason"
          className="input"
          maxLength={300}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}
