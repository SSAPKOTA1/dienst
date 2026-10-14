import type { NfcResolveDto } from '@dienst/shared';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, useSend, type ApiError } from '../../lib/api';
import { ErrorNote, useToast } from '../../components/ui';
import { card, cardHead, line } from './common';

/** Where the app sends the employee after a tap on an NFC tag: confirm the punch at the hotel of the tag. */
export function NfcPunch() {
  const { t } = useTranslation();
  const toast = useToast();
  const [params] = useSearchParams();
  const token = params.get('t') ?? '';
  const [seen, setSeen] = useState<NfcResolveDto | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [b, setB] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const inn = useSend<{ hotelId: number; nfcToken: string }>('POST', '/me/punch/in');
  const out = useSend<{ breakMinutes: number; reason?: string; nfcToken: string }>('POST', '/me/punch/out');
  const brk = useSend<{ action: 'start' | 'end'; nfcToken: string }>('POST', '/me/punch/break');

  const load = () =>
    api<NfcResolveDto>('/me/punch/nfc', { method: 'POST', body: { token } })
      .then((r) => (setSeen(r), setError(null)))
      .catch((e: ApiError) => setError(e));
  useEffect(() => {
    try {
      sessionStorage.removeItem('afterLogin');
    } catch {
      /* private mode: nothing to clean up */
    }
    if (token) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const open = seen?.open ?? null;
  const chosen = b ?? open?.suggestedBreakMinutes ?? 0;
  const short = !!open && chosen < open.requiredBreakMinutes;
  const err = inn.error ?? out.error ?? brk.error ?? error;
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  return (
    <main data-testid="nfc-punch">
      <section style={card} aria-labelledby="nfc-h">
        <h1 id="nfc-h" style={{ ...cardHead, fontSize: 14 }}>
          {t('Stempeln mit NFC')}
        </h1>
        <div style={{ ...line, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {!token && <div role="alert">{t('Kein NFC-Tag erkannt. Bitte halte das Handy an den Tag.')}</div>}
          {error?.status === 404 && <div role="alert">{t('Dieser NFC-Tag ist nicht (mehr) gültig.')}</div>}
          {seen && (
            <div style={{ fontWeight: 700, fontSize: 18 }} data-testid="nfc-hotel">
              {seen.hotelName}
            </div>
          )}
          {done && (
            <div role="status" data-testid="nfc-done">
              {done}
            </div>
          )}
          {seen && !done && !open && (
            <button
              className="btn btn-primary"
              disabled={inn.isPending}
              data-testid="nfc-in"
              onClick={() =>
                inn.mutate(
                  { hotelId: seen.hotelId, nfcToken: token },
                  {
                    onSuccess: (r) => {
                      const at = (r as { clockedInAt?: string }).clockedInAt;
                      setDone(`${t('Eingestempelt')}${at ? ` · ${time(at)}` : ''}`);
                      toast(t('Eingestempelt.'));
                    },
                  },
                )
              }
            >
              {t('Einstempeln')}
            </button>
          )}
          {seen && !done && open && (
            <>
              <div role="status">
                ● {t('Eingestempelt seit')} {time(open.since)}
                {open.onBreak ? ` · ${t('In der Pause')}` : ''}
              </div>
              {seen.breakMode === 'start_stop' && (
                <button
                  className="btn btn-secondary"
                  onClick={() =>
                    brk.mutate(
                      { action: open.onBreak ? 'end' : 'start', nfcToken: token },
                      { onSuccess: () => void load() },
                    )
                  }
                >
                  {open.onBreak ? t('Pause beenden') : t('Pause starten')}
                </button>
              )}
              <div
                role="radiogroup"
                aria-label={t('Pause')}
                style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}
              >
                {open.options.map((o) => (
                  <button
                    key={o}
                    role="radio"
                    aria-checked={chosen === o}
                    className={chosen === o ? 'btn btn-primary' : 'btn btn-secondary'}
                    onClick={() => setB(o)}
                  >
                    {o} {t('Min.')}
                  </button>
                ))}
              </div>
              {short && (
                <input
                  className="input"
                  aria-label={t('Grund')}
                  placeholder={t('Grund (Pause kürzer als vorgeschrieben)')}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
              <button
                className="btn btn-primary"
                data-testid="nfc-out"
                disabled={out.isPending || (short && !reason.trim())}
                onClick={() =>
                  out.mutate(
                    { breakMinutes: chosen, reason: reason.trim() || undefined, nfcToken: token },
                    {
                      onSuccess: () => {
                        setDone(t('Ausgestempelt. Deine Leitung prüft die Zeit.'));
                        toast(t('Ausgestempelt. Deine Leitung prüft die Zeit.'));
                      },
                    },
                  )
                }
              >
                {t('Ausstempeln')}
              </button>
            </>
          )}
          <ErrorNote error={error?.status === 404 ? null : err} />
          <Link to="/me" className="btn btn-secondary" style={{ textAlign: 'center' }}>
            {t('Zur Startseite')}
          </Link>
        </div>
      </section>
    </main>
  );
}
