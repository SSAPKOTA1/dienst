import type { FeedResponse } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { fdatetime } from '../lib/format';
import { ErrorNote } from './ui';

/** Hotel board: short posts, comments and likes. Plain text only (React escapes it). */
export function FeedBoard({ hotels }: { hotels: Array<{ id: number; name: string }> }) {
  const { t } = useTranslation();
  const [hotelId, setHotelId] = useState(String(hotels[0]?.id ?? ''));
  const feed = useGet<FeedResponse>(hotelId ? '/feed' : null, { hotelId });
  const [text, setText] = useState('');
  const post = useSend('POST', '/feed/posts');
  const comment = useSend<{ id: number; body: string }>('POST', (b) => `/feed/posts/${b.id}/comments`);
  const like = useSend<number>('PUT', (id) => `/feed/posts/${id}/like`);
  const del = useSend<number>('DELETE', (id) => `/feed/posts/${id}`);
  const delC = useSend<number>('DELETE', (id) => `/feed/comments/${id}`);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const refresh = () => void feed.refetch();
  return (
    <div data-testid="feed" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      {hotels.length > 1 && (
        <select
          className="input"
          aria-label={t('Hotel')}
          value={hotelId}
          onChange={(e) => setHotelId(e.target.value)}
        >
          {hotels.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          className="input"
          style={{ flex: 1 }}
          aria-label={t('Neuer Beitrag')}
          placeholder={t('Etwas mit dem Team teilen …')}
          maxLength={2000}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="feed-input"
        />
        <button
          className="btn btn-primary"
          disabled={!text.trim() || post.isPending}
          data-testid="feed-post"
          onClick={() =>
            post.mutate(
              { hotelId: Number(hotelId), body: text },
              {
                onSuccess: () => {
                  setText('');
                  refresh();
                },
              },
            )
          }
        >
          {t('Posten')}
        </button>
      </div>
      <ErrorNote error={post.error} />
      {(feed.data?.items ?? []).map((p) => (
        <article
          key={p.id}
          data-testid="feed-post-item"
          style={{ border: '2px solid var(--color-text)', padding: 'var(--space-2) var(--space-3)' }}
        >
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <b>{p.author}</b>
            <span style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>{fdatetime(p.createdAt)}</span>
            {p.canDelete && (
              <button
                className="btn btn-ghost"
                style={{ marginLeft: 'auto' }}
                onClick={() => del.mutate(p.id, { onSuccess: refresh })}
              >
                {t('Löschen')}
              </button>
            )}
          </div>
          <p style={{ margin: '4px 0', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{p.body}</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-ghost"
              aria-pressed={p.likedByMe}
              onClick={() => like.mutate(p.id, { onSuccess: refresh })}
            >
              {p.likedByMe ? '♥' : '♡'} {p.likes}
            </button>
          </div>
          {p.comments.map((c) => (
            <div
              key={c.id}
              style={{
                fontSize: 13,
                padding: '2px 0 2px 12px',
                borderLeft: '2px solid var(--color-divider)',
              }}
            >
              <b>{c.author}</b> {c.body}
              {c.canDelete && (
                <button className="btn btn-ghost" onClick={() => delC.mutate(c.id, { onSuccess: refresh })}>
                  ×
                </button>
              )}
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input
              className="input"
              style={{ flex: 1, minHeight: 30 }}
              aria-label={t('Kommentar')}
              placeholder={t('Kommentar')}
              maxLength={1000}
              value={drafts[p.id] ?? ''}
              onChange={(e) => setDrafts({ ...drafts, [p.id]: e.target.value })}
            />
            <button
              className="btn btn-secondary"
              disabled={!(drafts[p.id] ?? '').trim()}
              onClick={() =>
                comment.mutate(
                  { id: p.id, body: drafts[p.id]! },
                  {
                    onSuccess: () => {
                      setDrafts({ ...drafts, [p.id]: '' });
                      refresh();
                    },
                  },
                )
              }
            >
              {t('Senden')}
            </button>
          </div>
        </article>
      ))}
      {(feed.data?.items ?? []).length === 0 && (
        <div style={{ fontSize: 13 }}>{t('Noch keine Beiträge.')}</div>
      )}
    </div>
  );
}
