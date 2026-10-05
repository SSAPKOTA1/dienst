import { useTranslation } from 'react-i18next';
import { setLang } from '../i18n';

export function LangSwitch() {
  const { t, i18n } = useTranslation();
  return (
    <div
      role="group"
      aria-label={t('Sprache')}
      style={{ display: 'flex', border: '1px solid var(--color-divider)' }}
    >
      {(['de', 'en'] as const).map((l) => {
        const on = i18n.language === l;
        return (
          <button
            key={l}
            onClick={() => setLang(l)}
            aria-pressed={on}
            style={{
              fontSize: 12,
              fontWeight: 700,
              padding: '5px 9px',
              border: 0,
              cursor: 'pointer',
              background: on ? 'var(--color-text)' : 'transparent',
              color: on ? 'var(--color-bg)' : 'var(--color-text)',
            }}
          >
            {l.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
