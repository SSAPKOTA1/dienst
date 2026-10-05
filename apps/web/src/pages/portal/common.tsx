import { fdate } from '../../lib/format';

export const TZ = 'Europe/Berlin';
export const card: React.CSSProperties = {
  border: '2px solid var(--color-text)',
  margin: 'var(--space-3)',
  background: 'var(--color-bg)',
};
export const cardHead: React.CSSProperties = {
  margin: 0,
  padding: 'var(--space-2) var(--space-3)',
  fontSize: 13,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  background: 'var(--color-surface)',
  borderBottom: '2px solid var(--color-text)',
};
export const line: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  borderBottom: '1px solid var(--color-divider)',
  fontSize: 14,
};
export const stat = (label: string, value: React.ReactNode) => (
  <div style={{ padding: 'var(--space-2) var(--space-3)' }}>
    <div
      style={{
        fontSize: 11,
        letterSpacing: '.08em',
        textTransform: 'uppercase',
        color: 'var(--color-neutral-700)',
      }}
    >
      {label}
    </div>
    <div style={{ fontSize: 26, fontWeight: 800, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
  </div>
);
export const dayLabel = (iso: string) => fdate(iso, { weekday: 'short', day: '2-digit', month: '2-digit' });

export const NOTE_TEXT = (n: any, t: (s: string) => string): string => {
  const p = n.payload ?? {};
  const verdict = p.decision === 'approve' ? t('freigegeben') : t('abgelehnt');
  switch (n.kind) {
    case 'schedule_published':
      return t('Neuer Dienstplan veröffentlicht');
    case 'schedule_changed':
      return t('Dein Dienstplan wurde geändert');
    case 'approval_decision':
      return p.timeOffId
        ? `${t('Dein Urlaubsantrag wurde')} ${verdict}`
        : p.correctionId
          ? `${t('Deine Korrektur wurde')} ${verdict}`
          : `${t('Deine Zeit wurde')} ${verdict}`;
    case 'auto_checkout':
      return t('Du wurdest automatisch ausgestempelt');
    case 'swap_offered':
      return t('Dir wurde eine Schicht zum Tausch angeboten');
    case 'swap_accepted':
      return t('Dein Tauschangebot wurde angenommen');
    case 'swap_declined':
      return t('Dein Tauschangebot wurde abgelehnt');
    case 'swap_decision':
      return `${t('Dein Schichttausch wurde')} ${p.decision === 'approved' ? t('genehmigt') : t('abgelehnt')}`;
    case 'swap_expired':
      return t('Dein Tauschangebot ist abgelaufen');
    case 'open_shift_decision':
      return `${t('Deine Bewerbung auf eine offene Schicht wurde')} ${p.decision === 'approved' ? t('angenommen') : t('abgelehnt')}`;
    case 'announcement':
      return `${t('Neue Mitteilung')}: ${p.title ?? ''}`;
    case 'question_answered':
      return t('Die Leitung hat deine Frage beantwortet');
    case 'wish_decision':
      return `${t('Dein Wunsch wurde')} ${p.decision === 'granted' ? t('erfüllt') : t('abgelehnt')}`;
    case 'vacation_notice':
      return t('Hinweis zu deinem Resturlaub');
    default:
      return n.kind;
  }
};

// ---------------------------------------------------------------- home
