import type { HotelDto, Items, NfcTagDto } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../../lib/api';
import { fdatetime } from '../../lib/format';
import { Dialog, ErrorNote, Field, useToast } from '../../components/ui';

/** NFC tags at the hotel entrance: employees tap one with the Android app to clock in and out. */
export function NfcTags({ hotels }: { hotels: HotelDto[] }) {
  const { t } = useTranslation();
  const toast = useToast();
  const tags = useGet<Items<NfcTagDto>>('/nfc-tags');
  const [add, setAdd] = useState(false);
  const [shown, setShown] = useState<NfcTagDto | null>(null);
  const revoke = useSend<{ id: number }>('DELETE', (b) => `/nfc-tags/${b.id}`, [['api', '/nfc-tags']]);
  const hotelName = (id: number) => hotels.find((h) => h.id === id)?.name ?? id;
  return (
    <section
      aria-labelledby="nfc-h"
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <h2 id="nfc-h" style={{ margin: 0, fontSize: 20, marginRight: 'auto' }}>
          {t('NFC-Tags')}
        </h2>
        <button className="btn btn-primary" data-testid="nfc-add" onClick={() => setAdd(true)}>
          {t('NFC-Tag anlegen')}
        </button>
      </div>
      <div style={{ overflowX: 'auto', border: '2px solid var(--color-text)' }}>
        <table className="table" style={{ minWidth: 560 }}>
          <thead>
            <tr>
              <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Name')}</th>
              <th>{t('Hotel')}</th>
              <th>{t('Angelegt')}</th>
              <th>{t('Status')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(tags.data?.items ?? []).map((g) => (
              <tr key={g.id} data-testid="nfc-row">
                <td style={{ paddingLeft: 'var(--space-4)', fontWeight: 700 }}>{g.label}</td>
                <td>{hotelName(g.hotelId)}</td>
                <td style={{ fontVariantNumeric: 'tabular-nums' }}>{fdatetime(g.createdAt)}</td>
                <td>
                  <span className={`tag ${g.revokedAt ? 'tag-neutral' : 'tag-accent'}`}>
                    {g.revokedAt ? t('Gesperrt') : t('Aktiv')}
                  </span>
                </td>
                <td style={{ textAlign: 'right', paddingRight: 'var(--space-4)' }}>
                  {!g.revokedAt && (
                    <button
                      className="btn btn-secondary"
                      onClick={() => {
                        if (window.confirm(t('Diesen NFC-Tag sperren? Er funktioniert danach nicht mehr.')))
                          revoke.mutate({ id: g.id }, { onSuccess: () => toast(t('Gespeichert.')) });
                      }}
                    >
                      {t('Sperren')}
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {(tags.data?.items ?? []).length === 0 && (
              <tr>
                <td colSpan={5} style={{ paddingLeft: 'var(--space-4)' }}>
                  {t('Noch kein NFC-Tag angelegt.')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
        {t(
          'Mitarbeitende halten ihr Handy mit der Android-App an den Tag und stempeln so ein oder aus. Nur wer im Hotel arbeitet, kann damit stempeln; die Zeit geht wie beim Stempeln im Browser zur Prüfung.',
        )}
      </div>
      {add && (
        <AddDialog
          hotels={hotels}
          onClose={() => setAdd(false)}
          onDone={(g) => {
            setAdd(false);
            setShown(g);
          }}
        />
      )}
      {shown && (
        <Dialog
          title={t('NFC-Tag angelegt')}
          onClose={() => setShown(null)}
          actions={
            <button className="btn btn-primary" onClick={() => setShown(null)}>
              {t('Fertig')}
            </button>
          }
        >
          <p style={{ margin: 0, fontSize: 13 }}>
            {t(
              'Schreiben Sie diesen Text mit einer NFC-Schreib-App (z. B. „NFC Tools“) als URL/URI-Eintrag auf einen NFC-Aufkleber. Er wird nur jetzt angezeigt.',
            )}
          </p>
          {/localhost|127\.0\.0\.1/.test(shown.url ?? '') && (
            <p role="alert" style={{ margin: 0, fontSize: 13, fontWeight: 700 }}>
              {t(
                'Achtung: Diese Adresse zeigt auf „localhost“ und funktioniert nur an diesem Computer. Stellen Sie WEB_ORIGIN auf die Adresse ein, unter der Ihr Team die App öffnet.',
              )}
            </p>
          )}
          <code
            data-testid="nfc-url"
            style={{
              display: 'block',
              padding: 'var(--space-2)',
              border: '2px solid var(--color-text)',
              wordBreak: 'break-all',
              fontSize: 14,
            }}
          >
            {shown.url}
          </code>
          <button
            className="btn btn-secondary"
            onClick={() =>
              void navigator.clipboard?.writeText(shown.url ?? '').then(() => toast(t('Kopiert.')))
            }
          >
            {t('Kopieren')}
          </button>
        </Dialog>
      )}
    </section>
  );
}

function AddDialog({
  hotels,
  onClose,
  onDone,
}: {
  hotels: HotelDto[];
  onClose: () => void;
  onDone: (g: NfcTagDto) => void;
}) {
  const { t } = useTranslation();
  const [hotelId, setHotelId] = useState(String(hotels[0]?.id ?? ''));
  const [label, setLabel] = useState('');
  const m = useSend<Record<string, unknown>, NfcTagDto>('POST', '/nfc-tags', [['api', '/nfc-tags']]);
  return (
    <Dialog
      title={t('NFC-Tag anlegen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!label.trim() || !hotelId || m.isPending}
            onClick={() => m.mutate({ hotelId: Number(hotelId), label: label.trim() }, { onSuccess: onDone })}
          >
            {t('Anlegen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Hotel')} htmlFor="nt-hotel">
        <select id="nt-hotel" className="input" value={hotelId} onChange={(e) => setHotelId(e.target.value)}>
          {hotels.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('Name des Tags')} htmlFor="nt-label">
        <input
          id="nt-label"
          className="input"
          value={label}
          maxLength={100}
          placeholder={t('z. B. Personaleingang')}
          onChange={(e) => setLabel(e.target.value)}
        />
      </Field>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}
