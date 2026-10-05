import type {
  FeatureSettingList,
  HourCategoryDto,
  Items,
  QualificationDto,
  RulesSettingsDto,
  HourCategoryRule,
} from '@dienst/shared';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { download, useGet, useSend, type ApiError } from '../lib/api';
import { useAuth } from '../lib/auth';
import { Dialog, ErrorNote, Field, Toggle, useToast } from '../components/ui';

const box: React.CSSProperties = { border: '2px solid var(--color-text)' };
const head: React.CSSProperties = {
  margin: 0,
  padding: 'var(--space-2) var(--space-4)',
  fontSize: 14,
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  background: 'var(--color-surface)',
  borderBottom: '2px solid var(--color-text)',
};

const LIMITS: Array<[string, string, string]> = [
  ['dailyMaxMinutes', 'Höchstarbeitszeit pro Tag (Min.)', 'gesetzlich höchstens 600'],
  ['dailyWarnMinutes', 'Warnung ab (Min. pro Tag)', 'gesetzlich höchstens 480'],
  ['restBlockMinutes', 'Ruhezeit gesperrt unter (Min.)', 'gesetzlich mindestens 600'],
  ['restWarnMinutes', 'Ruhezeit braucht Begründung unter (Min.)', 'gesetzlich mindestens 660'],
  ['minorRestMinutes', 'Jugendliche: Ruhezeit (Min.)', 'gesetzlich mindestens 720'],
  ['minorDailyMaxMinutes', 'Jugendliche: Höchstarbeitszeit pro Tag (Min.)', 'gesetzlich höchstens 480'],
  ['sundaysFreeMin', 'Freie Sonntage pro Jahr (mindestens)', 'gesetzlich mindestens 15'],
  ['nightWorkerNights', 'Nächte pro Jahr bis Nachtarbeitnehmer', 'gesetzlich höchstens 48'],
];

/** Limits as data: the form only accepts values that are stricter than the statutory baseline (the server enforces it). */
export function RuleLimitsEditor() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const toast = useToast();
  const rules = useGet<RulesSettingsDto>('/settings/rules');
  const [v, setV] = useState<Record<string, string>>({});
  const admin = me?.role !== 'manager';
  const save = useSend('PUT', '/settings/rules');
  const reset = useSend<void>('DELETE', '/settings/rules');
  useEffect(() => {
    if (rules.data)
      setV(Object.fromEntries(Object.entries(rules.data.limits).map(([k, x]) => [k, String(x)])));
  }, [rules.data]);
  const submit = () =>
    save.mutate(
      { limits: Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Number(x)])) },
      {
        onSuccess: () => {
          toast(t('Gespeichert.'));
          void rules.refetch();
        },
      },
    );
  const err = save.error as ApiError | null;
  return (
    <section style={box} aria-labelledby="rl-h">
      <h3 id="rl-h" style={head}>
        {t('Arbeitszeitgrenzen')}
      </h3>
      <div
        style={{
          padding: 'var(--space-3) var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        <div style={{ fontSize: 13 }}>
          {t('Die Grenzen dürfen nur strenger sein als das Gesetz. Ein Tarifvertrag kann sie nicht lockern.')}{' '}
          {rules.data?.customised ? <b>{t('Angepasst')}</b> : <span>{t('Gesetzliche Standardwerte')}</span>}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))',
            gap: 'var(--space-2) var(--space-4)',
          }}
        >
          {LIMITS.map(([k, label, hint]) => (
            <Field key={k} label={t(label)} htmlFor={`lim-${k}`} hint={t(hint)}>
              <input
                id={`lim-${k}`}
                data-testid={`lim-${k}`}
                type="number"
                className="input"
                disabled={!admin}
                value={v[k] ?? ''}
                onChange={(e) => setV({ ...v, [k]: e.target.value })}
              />
            </Field>
          ))}
        </div>
        {Array.isArray(err?.details?.errors) && (
          <ul role="alert" style={{ margin: 0, paddingLeft: 18, fontSize: 13, fontWeight: 700 }}>
            {(err.details.errors as string[]).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        )}
        {!err?.details?.errors && <ErrorNote error={err} />}
        {admin && (
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={save.isPending}
              data-testid="lim-save"
            >
              {t('Speichern')}
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => reset.mutate(undefined, { onSuccess: () => void rules.refetch() })}
            >
              {t('Auf Standard zurücksetzen')}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}

const FEATURE_LABEL: Record<string, string> = {
  wishes: 'Wünsche',
  swaps: 'Schichttausch',
  open_shifts: 'Offene Schichten',
  availability: 'Verfügbarkeit',
  announcements: 'Mitteilungen',
  feed: 'Neuigkeiten-Feed',
  messages: 'Fragen an die Leitung',
  documents: 'Dokumente',
  calendar_feed: 'Kalender-Abo',
  team_calendar: 'Team-Abwesenheiten',
};

export function FeatureToggles() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const list = useGet<FeatureSettingList>('/settings/features');
  const set = useSend<{ feature: string; enabled: boolean }>('PUT', '/settings/features');
  const admin = me?.role !== 'manager';
  return (
    <section style={box} aria-labelledby="ft-h">
      <h3 id="ft-h" style={head}>
        {t('Funktionen')}
      </h3>
      {(list.data?.items ?? []).map((f) => (
        <div
          key={f.feature}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            padding: 'var(--space-2) var(--space-4)',
            borderBottom: '1px solid var(--color-divider)',
          }}
          data-testid="feature-row"
        >
          <span style={{ marginRight: 'auto', fontWeight: 700 }}>
            {t(FEATURE_LABEL[f.feature] ?? f.feature)}
          </span>
          <Toggle
            on={f.enabled}
            label={t(FEATURE_LABEL[f.feature] ?? f.feature)}
            onChange={
              admin
                ? (on) =>
                    set.mutate({ feature: f.feature, enabled: on }, { onSuccess: () => void list.refetch() })
                : undefined
            }
          />
        </div>
      ))}
    </section>
  );
}

type RuleKind = 'daily' | 'weekday' | 'holiday' | 'dates';

export function HourCategories() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const list = useGet<Items<HourCategoryDto>>('/hour-categories');
  const [dlg, setDlg] = useState(false);
  const del = useSend<number>('DELETE', (id) => `/hour-categories/${id}`);
  const admin = me?.role !== 'manager';
  const describe = (r: HourCategoryRule) =>
    r.daily
      ? `${r.daily.from}–${r.daily.to}`
      : r.weekday
        ? `${t('Wochentag')} ${r.weekday}`
        : r.holiday
          ? t('Feiertage')
          : `${(r.dates ?? []).join(', ')} ${r.from}–${r.to}`;
  return (
    <section style={box} aria-labelledby="hc-h">
      <h3 id="hc-h" style={{ ...head, display: 'flex', alignItems: 'center' }}>
        <span style={{ marginRight: 'auto' }}>{t('Stundenkategorien')}</span>
        {admin && (
          <button className="btn btn-secondary" onClick={() => setDlg(true)} data-testid="cat-new">
            {t('Kategorie anlegen')}
          </button>
        )}
      </h3>
      <div style={{ padding: 'var(--space-2) var(--space-4)', fontSize: 12 }}>
        {t('Aus den Kategorien entstehen Stunden für die Lohnabrechnung. Löhne werden nicht berechnet.')}
      </div>
      {(list.data?.items ?? []).map((c) => (
        <div
          key={c.code}
          style={{
            display: 'flex',
            gap: 'var(--space-3)',
            alignItems: 'baseline',
            padding: 'var(--space-2) var(--space-4)',
            borderTop: '1px solid var(--color-divider)',
          }}
          data-testid="cat-row"
        >
          <b style={{ minWidth: 220 }}>{c.name}</b>
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{c.code}</span>
          <span style={{ fontSize: 13 }}>{describe(c.rule as HourCategoryRule)}</span>
          <span style={{ marginLeft: 'auto' }}>
            {c.system ? (
              <span className="tag tag-neutral">{t('Standard')}</span>
            ) : (
              admin && (
                <button
                  className="btn btn-ghost"
                  onClick={() => del.mutate(c.id as number, { onSuccess: () => void list.refetch() })}
                >
                  {t('Löschen')}
                </button>
              )
            )}
          </span>
        </div>
      ))}
      {dlg && (
        <CategoryDialog
          onClose={() => setDlg(false)}
          onDone={() => {
            setDlg(false);
            void list.refetch();
          }}
        />
      )}
    </section>
  );
}

function CategoryDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<RuleKind>('weekday');
  const [from, setFrom] = useState('22:00');
  const [to, setTo] = useState('06:00');
  const [weekday, setWeekday] = useState('6');
  const [dates, setDates] = useState('12-24,12-31');
  const m = useSend('POST', '/hour-categories');
  const rule =
    kind === 'daily'
      ? { daily: { from, to } }
      : kind === 'weekday'
        ? { weekday: Number(weekday) }
        : kind === 'holiday'
          ? { holiday: true }
          : { dates: dates.split(',').map((d) => d.trim()), from, to };
  return (
    <Dialog
      title={t('Kategorie anlegen')}
      onClose={onClose}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!code || !name || m.isPending}
            onClick={() => m.mutate({ code, name, rule }, { onSuccess: onDone })}
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <Field label={t('Code (a-z, 0-9, _)')} htmlFor="hc-code">
        <input
          id="hc-code"
          className="input"
          value={code}
          onChange={(e) => setCode(e.target.value.toLowerCase())}
        />
      </Field>
      <Field label={t('Name')} htmlFor="hc-name">
        <input id="hc-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('Regel')} htmlFor="hc-kind">
        <select
          id="hc-kind"
          className="input"
          value={kind}
          onChange={(e) => setKind(e.target.value as typeof kind)}
        >
          <option value="daily">{t('Täglich von bis')}</option>
          <option value="weekday">{t('Wochentag')}</option>
          <option value="holiday">{t('Feiertage')}</option>
          <option value="dates">{t('Bestimmte Tage im Jahr')}</option>
        </select>
      </Field>
      {kind === 'weekday' && (
        <Field label={t('Wochentag (1 = Montag … 7 = Sonntag)')} htmlFor="hc-wd">
          <input
            id="hc-wd"
            type="number"
            min={1}
            max={7}
            className="input"
            value={weekday}
            onChange={(e) => setWeekday(e.target.value)}
          />
        </Field>
      )}
      {kind === 'dates' && (
        <Field label={t('Tage (MM-TT, Komma getrennt)')} htmlFor="hc-dates">
          <input id="hc-dates" className="input" value={dates} onChange={(e) => setDates(e.target.value)} />
        </Field>
      )}
      {(kind === 'daily' || kind === 'dates') && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label={t('Von')} htmlFor="hc-from">
            <input
              id="hc-from"
              type="time"
              className="input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </Field>
          <Field label={t('Bis')} htmlFor="hc-to">
            <input
              id="hc-to"
              type="time"
              className="input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </Field>
        </div>
      )}
      <ErrorNote error={m.error} />
    </Dialog>
  );
}

// ---------------------------------------------------------------- payroll export
export function PayrollExport() {
  const { t } = useTranslation();
  const toast = useToast();
  const now = new Date();
  const prev = new Date(Date.UTC(now.getFullYear(), now.getMonth() - 1, 1)).toISOString().slice(0, 7);
  const [month, setMonth] = useState(prev);
  const [open, setOpen] = useState(false);
  const get = (format: 'csv' | 'xlsx') =>
    void download(
      '/payroll/export',
      { month, format, includeOpen: open },
      `lohnexport_${month}.${format}`,
    ).catch((e) =>
      toast(
        e?.code === 'CONFLICT' ? t('Der Monat ist noch nicht abgeschlossen.') : t('Export fehlgeschlagen'),
      ),
    );
  return (
    <section
      style={{ padding: 'var(--space-4)', borderTop: '2px solid var(--color-divider)' }}
      data-testid="payroll"
    >
      <h2 style={{ margin: '0 0 var(--space-2)', fontSize: 20 }}>{t('Lohnexport (Stunden)')}</h2>
      <div style={{ fontSize: 12, marginBottom: 'var(--space-2)' }}>
        {t(
          'Arbeitsstunden, Stunden je Kategorie, Abwesenheitstage und Zeitkonto je Personalnummer. Es werden keine Löhne berechnet.',
        )}
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="month"
          className="input"
          aria-label={t('Monat')}
          style={{ width: 'auto' }}
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
        <label style={{ fontSize: 13, display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="checkbox" checked={open} onChange={(e) => setOpen(e.target.checked)} />{' '}
          {t('Auch offenen Monat (Vorschau)')}
        </label>
        <button className="btn btn-secondary" data-testid="payroll-csv" onClick={() => get('csv')}>
          CSV
        </button>
        <button className="btn btn-secondary" onClick={() => get('xlsx')}>
          Excel
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- qualifications and team visibility
export function QualificationManager() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const list = useGet<Items<QualificationDto>>('/qualifications');
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState(false);
  const add = useSend('POST', '/qualifications');
  const del = useSend<number>('DELETE', (id) => `/qualifications/${id}`);
  const admin = me?.role !== 'manager';
  return (
    <section style={box} aria-labelledby="qm-h">
      <h3 id="qm-h" style={head}>
        {t('Qualifikationen')}
      </h3>
      {(list.data?.items ?? []).map((q) => (
        <div
          key={q.id}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            padding: 'var(--space-2) var(--space-4)',
            borderBottom: '1px solid var(--color-divider)',
          }}
          data-testid="qual-row"
        >
          <b style={{ marginRight: 'auto' }}>{q.name}</b>
          {q.hasExpiry && <span className="tag tag-neutral">{t('mit Ablaufdatum')}</span>}
          {admin && (
            <button
              className="btn btn-ghost"
              onClick={() => del.mutate(q.id, { onSuccess: () => void list.refetch() })}
            >
              {t('Löschen')}
            </button>
          )}
        </div>
      ))}
      {admin && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            padding: 'var(--space-2) var(--space-4)',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <input
            className="input"
            style={{ width: 220 }}
            aria-label={t('Name')}
            placeholder={t('z. B. Ersthelfer')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="qual-name"
          />
          <label style={{ fontSize: 13, display: 'flex', gap: 6 }}>
            <input type="checkbox" checked={expiry} onChange={(e) => setExpiry(e.target.checked)} />{' '}
            {t('läuft ab')}
          </label>
          <button
            className="btn btn-secondary"
            disabled={!name.trim()}
            data-testid="qual-add"
            onClick={() =>
              add.mutate(
                { name, hasExpiry: expiry },
                {
                  onSuccess: () => {
                    setName('');
                    void list.refetch();
                  },
                },
              )
            }
          >
            {t('Hinzufügen')}
          </button>
          <ErrorNote error={add.error ?? del.error} />
        </div>
      )}
    </section>
  );
}

export function TeamVisibility() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const toast = useToast();
  const set = useSend<{ value: string }>('PUT', '/settings/team-visibility');
  if (me?.role === 'manager') return null;
  return (
    <section
      style={{
        ...box,
        padding: 'var(--space-3) var(--space-4)',
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'center',
        flexWrap: 'wrap',
      }}
    >
      <span style={{ marginRight: 'auto', fontWeight: 700 }}>
        {t('Abwesenheiten im Team sichtbar (nur Namen)')}
      </span>
      <button
        className="btn btn-secondary"
        onClick={() => set.mutate({ value: 'names_only' }, { onSuccess: () => toast(t('Gespeichert.')) })}
      >
        {t('Einschalten')}
      </button>
      <button
        className="btn btn-secondary"
        onClick={() => set.mutate({ value: 'none' }, { onSuccess: () => toast(t('Gespeichert.')) })}
      >
        {t('Ausschalten')}
      </button>
    </section>
  );
}
