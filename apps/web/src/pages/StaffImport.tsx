import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { download, upload } from '../lib/api';
import { ErrorNote, Field, PageHead, SectionTitle, useToast } from '../components/ui';

interface Summary {
  id: number;
  dryRun: boolean;
  totalRows: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  rows: Array<{ row: number; status: string; field?: string; code?: string; message?: string }>;
  credentialsAvailable: boolean;
}

export function StaffImport() {
  const { t } = useTranslation();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dup, setDup] = useState('skip');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [res, setRes] = useState<Summary | null>(null);

  const send = async (dryRun: boolean) => {
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const f = new FormData();
      f.append('dryRun', String(dryRun));
      f.append('onDuplicateEmail', dup);
      f.append('file', file);
      setRes(await upload<Summary>('/employees/import', f));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const fail = () => toast(t('Download fehlgeschlagen'));
  const problems = (res?.rows ?? []).filter((r) => r.status === 'error' || r.status === 'skipped');
  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Team')} title={t('Excel-Import')}>
        <Link className="btn btn-secondary" to="/staff">
          {t('Zurück zur Liste')}
        </Link>
      </PageHead>
      <div
        style={{
          padding: '0 var(--space-4) var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
          maxWidth: 820,
        }}
      >
        <section
          style={{
            border: '2px solid var(--color-text)',
            padding: 'var(--space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          <SectionTitle>{t('1. Vorlage')}</SectionTitle>
          <div style={{ fontSize: 13 }}>
            {t(
              'Laden Sie die Vorlage herunter. Das Blatt „Hinweise“ listet Hotels und Abteilungen mit ihren IDs.',
            )}
          </div>
          <div>
            <button
              className="btn btn-secondary"
              onClick={() =>
                void download('/employees/import-template', {}, 'mitarbeiter-import-vorlage.xlsx').catch(fail)
              }
            >
              {t('Vorlage herunterladen')}
            </button>
          </div>
        </section>
        <section
          style={{
            border: '2px solid var(--color-text)',
            padding: 'var(--space-3)',
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-2)',
          }}
        >
          <SectionTitle>{t('2. Datei prüfen')}</SectionTitle>
          <Field label={t('Excel-Datei (.xlsx, höchstens 10 MB, 5000 Zeilen)')} htmlFor="imp-file">
            <input
              id="imp-file"
              ref={input}
              type="file"
              accept=".xlsx"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setRes(null);
                setErr(null);
              }}
            />
          </Field>
          <Field label={t('Bei bereits vorhandener E-Mail')} htmlFor="imp-dup">
            <select
              id="imp-dup"
              className="input"
              value={dup}
              onChange={(e) => {
                setDup(e.target.value);
                setRes(null);
              }}
            >
              <option value="skip">{t('Zeile überspringen')}</option>
              <option value="update">{t('Person aktualisieren')}</option>
              <option value="conflict">{t('Als Fehler melden')}</option>
            </select>
          </Field>
          <div>
            <button
              className="btn btn-primary"
              disabled={!file || busy}
              onClick={() => void send(true)}
              data-testid="import-dry"
            >
              {t('Prüfen (Probelauf)')}
            </button>
          </div>
          <ErrorNote error={err} />
        </section>
        {res && (
          <section
            style={{
              border: '2px solid var(--color-text)',
              padding: 'var(--space-3)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}
            data-testid="import-result"
          >
            <SectionTitle>
              {res.dryRun ? t('3. Ergebnis des Probelaufs') : t('3. Import abgeschlossen')}
            </SectionTitle>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))',
                gap: 'var(--space-2)',
              }}
            >
              {(
                [
                  ['Zeilen', res.totalRows],
                  [res.dryRun ? 'Würden angelegt' : 'Angelegt', res.created],
                  ['Aktualisiert', res.updated],
                  ['Übersprungen', res.skipped],
                  ['Fehler', res.errors],
                ] as Array<[string, number]>
              ).map(([l, v]) => (
                <div key={l}>
                  <div
                    style={{
                      fontSize: 11,
                      letterSpacing: '.08em',
                      textTransform: 'uppercase',
                      color: 'var(--color-neutral-700)',
                    }}
                  >
                    {t(l)}
                  </div>
                  <div style={{ fontSize: 28, fontWeight: 800 }}>{v}</div>
                </div>
              ))}
            </div>
            {problems.length > 0 && (
              <div style={{ overflowX: 'auto', border: '1px solid var(--color-divider)', maxHeight: 280 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('Zeile')}</th>
                      <th>{t('Status')}</th>
                      <th>{t('Feld')}</th>
                      <th>{t('Meldung')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {problems.map((p) => (
                      <tr key={p.row} data-testid="import-problem">
                        <td>{p.row}</td>
                        <td>{p.status === 'error' ? t('Fehler') : t('Übersprungen')}</td>
                        <td>{p.field ?? ''}</td>
                        <td>{p.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              {res.errors > 0 && (
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    void download(`/imports/${res.id}/errors.csv`, {}, `import-${res.id}-fehler.csv`).catch(
                      fail,
                    )
                  }
                >
                  {t('Fehler als CSV')}
                </button>
              )}
              {res.dryRun && res.created + res.updated > 0 && (
                <button
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void send(false)}
                  data-testid="import-confirm"
                >
                  {t('Import bestätigen')} ({res.created + res.updated})
                </button>
              )}
              {!res.dryRun && res.credentialsAvailable && (
                <button
                  className="btn btn-primary"
                  data-testid="import-credentials"
                  onClick={() =>
                    void download(
                      `/imports/${res.id}/credentials.pdf`,
                      {},
                      `zugangsdaten-import-${res.id}.pdf`,
                    )
                      .then(() => setRes({ ...res, credentialsAvailable: false }))
                      .catch(fail)
                  }
                >
                  {t('Zugangsdaten (PDF) herunterladen')}
                </button>
              )}
            </div>
            {!res.dryRun && res.created > 0 && (
              <div style={{ fontSize: 12 }}>
                {t(
                  'Das Zugangsdaten-Blatt mit PINs und Aktivierungscodes kann einmal innerhalb von 24 Stunden heruntergeladen werden.',
                )}
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
}
