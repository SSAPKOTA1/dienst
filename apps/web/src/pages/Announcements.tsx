import type { AnnouncementList, HotelDto, Items } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { useAuth } from '../lib/auth';
import { fdatetime } from '../lib/format';
import { Dialog, ErrorNote, Field, PageHead, useToast } from '../components/ui';
import { FeedBoard } from '../components/Feed';

/** Announcements of the planners with optional read confirmation, and the hotel feed (moderation). */
export function Announcements() {
  const { t } = useTranslation();
  const toast = useToast();
  const { me } = useAuth();
  const list = useGet<AnnouncementList>('/announcements');
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const del = useSend<number>('DELETE', (id) => `/announcements/${id}`);
  const [dlg, setDlg] = useState(false);
  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Heute')} title={t('Mitteilungen')}>
        <button className="btn btn-primary" onClick={() => setDlg(true)} data-testid="ann-new">
          {t('Mitteilung schreiben')}
        </button>
      </PageHead>
      <div
        style={{
          padding: '0 var(--space-4) var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-3)',
        }}
      >
        {(list.data?.items ?? []).length === 0 && (
          <div style={{ fontSize: 13 }}>{t('Keine Mitteilungen.')}</div>
        )}
        {(list.data?.items ?? []).map((a) => (
          <article
            key={a.id}
            style={{ border: '2px solid var(--color-text)', padding: 'var(--space-2) var(--space-3)' }}
            data-testid="ann-row"
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
              <b>
                {a.pinned ? '📌 ' : ''}
                {a.title}
              </b>
              <span style={{ fontSize: 12 }}>
                {fdatetime(a.publishAt)} ·{' '}
                {a.hotelId
                  ? (hotels.data?.items ?? []).find((h) => h.id === a.hotelId)?.name
                  : t('Alle Hotels')}
              </span>
              <button
                className="btn btn-ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() =>
                  del.mutate(a.id, {
                    onSuccess: () => {
                      toast(t('Gelöscht'));
                      void list.refetch();
                    },
                  })
                }
              >
                {t('Löschen')}
              </button>
            </div>
            <div style={{ whiteSpace: 'pre-wrap', fontSize: 14 }}>{a.body}</div>
            {a.requiresAck && (
              <div style={{ fontSize: 12, marginTop: 4 }}>
                {t('Bestätigt')}: {a.acknowledged}/{a.recipients}
                {a.missing.length > 0 && (
                  <>
                    {' '}
                    · {t('Fehlt noch')}: {a.missing.join(', ')}
                  </>
                )}
              </div>
            )}
          </article>
        ))}
        <h2 style={{ margin: '16px 0 0', fontSize: 20 }}>{t('Neuigkeiten')}</h2>
        {hotels.data && hotels.data.items.length > 0 && <FeedBoard hotels={hotels.data.items} />}
      </div>
      {dlg && (
        <AnnDialog
          hotels={hotels.data?.items ?? []}
          canCompany={me?.role !== 'manager'}
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            void list.refetch();
          }}
        />
      )}
    </main>
  );
}

function AnnDialog({
  hotels,
  canCompany,
  onClose,
  onDone,
}: {
  hotels: HotelDto[];
  canCompany: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [hotelId, setHotelId] = useState(canCompany ? '' : String(hotels[0]?.id ?? ''));
  const [pinned, setPinned] = useState(false);
  const [ack, setAck] = useState(false);
  const m = useSend('POST', '/announcements');
  return (
    <Dialog
      title={t('Mitteilung schreiben')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!title.trim() || !body.trim() || m.isPending}
            data-testid="ann-save"
            onClick={() =>
              m.mutate(
                { title, body, hotelId: hotelId ? Number(hotelId) : null, pinned, requiresAck: ack },
                { onSuccess: onDone },
              )
            }
          >
            {t('Veröffentlichen')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Titel')} htmlFor="an-t">
        <input
          id="an-t"
          className="input"
          maxLength={200}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field label={t('Text')} htmlFor="an-b">
        <textarea
          id="an-b"
          className="input"
          rows={5}
          maxLength={5000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      </Field>
      <Field label={t('Für')} htmlFor="an-h">
        <select id="an-h" className="input" value={hotelId} onChange={(e) => setHotelId(e.target.value)}>
          {canCompany && <option value="">{t('Alle Hotels')}</option>}
          {hotels.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </Field>
      <label style={{ display: 'flex', gap: 6, fontSize: 14 }}>
        <input type="checkbox" checked={pinned} onChange={(e) => setPinned(e.target.checked)} />{' '}
        {t('Oben anheften')}
      </label>
      <label style={{ display: 'flex', gap: 6, fontSize: 14 }}>
        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />{' '}
        {t('Lesebestätigung verlangen')}
      </label>
      <ErrorNote error={m.error} />
    </Dialog>
  );
}
