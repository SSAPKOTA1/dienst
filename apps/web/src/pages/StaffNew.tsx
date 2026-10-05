import type { DepartmentDto, HotelDto, Items } from '@dienst/shared';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, useGet } from '../lib/api';
import { ErrorNote, Field, Kicker, PageHead, Segmented } from '../components/ui';
import { WEEKDAYS } from '../lib/format';

interface Created {
  employeeId: number;
  username: string | null;
  personnelNumber: string;
  pin: string;
  activation: { method: string; code?: string; expiresAt?: string };
}

const today = () => new Date().toISOString().slice(0, 10);

export function StaffNew() {
  const { t } = useTranslation();
  const hotelsQ = useGet<Items<HotelDto>>('/hotels');
  const deptsQ = useGet<Items<DepartmentDto>>('/departments');
  const hotels: HotelDto[] = hotelsQ.data?.items ?? [];
  const depts: DepartmentDto[] = useMemo(() => deptsQ.data?.items ?? [], [deptsQ.data]);
  const [step, setStep] = useState(0);
  const [f, setF] = useState({
    firstName: '',
    lastName: '',
    dateOfBirth: '',
    email: '',
    primaryHotelId: 0,
    primaryDepartmentId: 0,
    extraHotels: [] as number[],
    extraDepts: [] as number[],
    isFloater: false,
    contractStartDate: today(),
    employmentType: 'full_time',
    workingModel: 'salary',
    workingWeekdays: [1, 2, 3, 4, 5],
    targetKind: 'week' as 'week' | 'month',
    target: '40',
    vacationDaysPerYear: '30',
    allocated: '',
    used: '',
    opening: '',
  });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);
  const set = (p: Partial<typeof f>) => setF((x) => ({ ...x, ...p }));
  const hotelId = f.primaryHotelId || hotels[0]?.id || 0;
  const hotelDepts = useMemo(() => depts.filter((d) => d.hotelId === hotelId), [depts, hotelId]);
  const deptId = hotelDepts.some((d) => d.id === f.primaryDepartmentId)
    ? f.primaryDepartmentId
    : (hotelDepts[0]?.id ?? 0);
  const otherHotels = hotels.filter(
    (h) => h.id !== hotelId && h.companyId === hotels.find((x) => x.id === hotelId)?.companyId,
  );
  const steps = ['Person', 'Einsatz', 'Vertrag', 'Prüfen'];

  const valid =
    step === 0
      ? f.firstName && f.lastName && /^\d{4}-\d{2}-\d{2}$/.test(f.dateOfBirth)
      : step === 1
        ? hotelId && deptId
        : step === 2
          ? f.contractStartDate &&
            f.workingWeekdays.length &&
            Number(f.target) >= 0 &&
            f.vacationDaysPerYear !== ''
          : true;

  const submit = async () => {
    setBusy(true);
    setError(null);
    const num = (s: string) => (s === '' ? undefined : Number(s.replace(',', '.')));
    try {
      const r = await api<Created>('/employees', {
        body: {
          firstName: f.firstName.trim(),
          lastName: f.lastName.trim(),
          dateOfBirth: f.dateOfBirth,
          email: f.email.trim() || null,
          primaryHotelId: hotelId,
          primaryDepartmentId: deptId,
          hotelIds: f.extraHotels,
          departmentIds: f.extraDepts,
          isFloater: f.isFloater,
          contractStartDate: f.contractStartDate,
          employmentType: f.employmentType,
          workingModel: f.workingModel,
          workDaysPerWeek: f.workingWeekdays.length,
          workingWeekdays: f.workingWeekdays,
          ...(f.targetKind === 'week'
            ? { targetHoursPerWeek: num(f.target) }
            : { targetHoursPerMonth: num(f.target) }),
          vacationDaysPerYear: num(f.vacationDaysPerYear),
          vacationDaysAllocatedThisYear: num(f.allocated),
          vacationDaysUsedThisYear: num(f.used),
          openingBalanceHours: num(f.opening),
        },
      });
      setCreated(r);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <main style={{ flex: 1 }}>
        <div data-noprint>
          <PageHead
            kicker={`${t('Personalnummer')} ${created.personnelNumber}`}
            title={`${f.firstName} ${f.lastName}`}
          />
        </div>
        <section
          className="slip"
          style={{
            padding: '0 var(--space-4) var(--space-4)',
            maxWidth: 560,
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-3)',
          }}
        >
          <div
            style={{
              border: '2px solid var(--color-accent)',
              padding: 'var(--space-4)',
              display: 'grid',
              gap: 'var(--space-3)',
            }}
            role="status"
          >
            <div>
              <Kicker>{t('Personalnummer')}</Kicker>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{created.personnelNumber}</div>
            </div>
            <div>
              <Kicker>{t('Tablet-PIN')}</Kicker>
              <div
                style={{
                  fontSize: 34,
                  fontWeight: 800,
                  letterSpacing: '.2em',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {created.pin}
              </div>
            </div>
            {created.activation.method !== 'existing_account' && (
              <div>
                <Kicker>{t('Benutzername')}</Kicker>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{created.username}</div>
              </div>
            )}
            {created.activation.method === 'code' && (
              <div>
                <Kicker>{t('Aktivierungscode')}</Kicker>
                <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: '.15em' }}>
                  {created.activation.code}
                </div>
              </div>
            )}
            {created.activation.method === 'email' && (
              <div style={{ fontSize: 13 }}>{t('Eine Einladung wurde per E-Mail gesendet.')}</div>
            )}
            {created.activation.method === 'existing_account' && (
              <div style={{ fontSize: 13 }}>
                {t('Das bestehende Konto erhält die zusätzliche Mitarbeiterrolle.')}
              </div>
            )}
            <div style={{ fontSize: 12, color: 'var(--color-neutral-700)' }}>
              {t('Wird nur einmal angezeigt. Persönlich übergeben.')}
            </div>
          </div>
          <div data-noprint style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button className="btn btn-primary" onClick={() => window.print()}>
              {t('Zettel drucken')}
            </button>
            <Link className="btn btn-secondary" to={`/staff/${created.employeeId}`}>
              {t('Zum Mitarbeiter')}
            </Link>
            <Link className="btn btn-ghost" to="/staff/new" reloadDocument>
              {t('Weitere Person anlegen')}
            </Link>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main style={{ flex: 1 }}>
      <PageHead kicker={t('Mitarbeiter')} title={t('Mitarbeiter anlegen')} />
      <div
        style={{
          display: 'flex',
          borderTop: '2px solid var(--color-divider)',
          borderBottom: '2px solid var(--color-divider)',
        }}
        role="list"
      >
        {steps.map((s, i) => (
          <div
            key={s}
            role="listitem"
            aria-current={i === step ? 'step' : undefined}
            style={{
              padding: '10px 18px',
              fontSize: 14,
              fontWeight: i === step ? 800 : 500,
              borderRight: '1px solid var(--color-divider)',
              background: i === step ? 'var(--color-text)' : 'transparent',
              color: i === step ? 'var(--color-bg)' : 'var(--color-text)',
            }}
          >
            {i + 1}. {t(s)}
          </div>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (step < 3) setStep(step + 1);
          else void submit();
        }}
        style={{ padding: 'var(--space-4)', maxWidth: 640, display: 'grid', gap: 'var(--space-4)' }}
      >
        {step === 0 && (
          <>
            <Field label={t('Vorname')} htmlFor="fn">
              <input
                id="fn"
                className="input"
                value={f.firstName}
                onChange={(e) => set({ firstName: e.target.value })}
                autoFocus
              />
            </Field>
            <Field label={t('Nachname')} htmlFor="ln">
              <input
                id="ln"
                className="input"
                value={f.lastName}
                onChange={(e) => set({ lastName: e.target.value })}
              />
            </Field>
            <Field label={t('Geburtsdatum')} htmlFor="dob">
              <input
                id="dob"
                className="input"
                type="date"
                value={f.dateOfBirth}
                onChange={(e) => set({ dateOfBirth: e.target.value })}
              />
            </Field>
            <Field
              label={t('E-Mail (optional)')}
              htmlFor="em"
              hint={t(
                'Ohne E-Mail erhält die Person einen Benutzernamen und einen einmaligen Aktivierungscode.',
              )}
            >
              <input
                id="em"
                className="input"
                type="email"
                value={f.email}
                onChange={(e) => set({ email: e.target.value })}
              />
            </Field>
          </>
        )}
        {step === 1 && (
          <>
            <Field label={t('Stammhaus')} htmlFor="hotel">
              <select
                id="hotel"
                className="input"
                value={hotelId}
                onChange={(e) =>
                  set({
                    primaryHotelId: Number(e.target.value),
                    primaryDepartmentId: 0,
                    extraHotels: [],
                    extraDepts: [],
                  })
                }
              >
                {hotels.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Abteilung')} htmlFor="dept">
              <select
                id="dept"
                className="input"
                value={deptId}
                onChange={(e) => set({ primaryDepartmentId: Number(e.target.value) })}
              >
                {hotelDepts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            {hotelDepts.length > 1 && (
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontSize: 12, marginBottom: 5 }}>{t('Weitere Abteilungen')}</legend>
                {hotelDepts
                  .filter((d) => d.id !== deptId)
                  .map((d) => (
                    <label key={d.id} style={{ display: 'flex', gap: 8, fontSize: 14, padding: '3px 0' }}>
                      <input
                        type="checkbox"
                        checked={f.extraDepts.includes(d.id)}
                        onChange={(e) =>
                          set({
                            extraDepts: e.target.checked
                              ? [...f.extraDepts, d.id]
                              : f.extraDepts.filter((x) => x !== d.id),
                          })
                        }
                      />{' '}
                      {d.name}
                    </label>
                  ))}
              </fieldset>
            )}
            {otherHotels.length > 0 && (
              <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
                <legend style={{ fontSize: 12, marginBottom: 5 }}>{t('Arbeitet auch in')}</legend>
                {otherHotels.map((h) => (
                  <div key={h.id}>
                    <label style={{ display: 'flex', gap: 8, fontSize: 14, padding: '3px 0' }}>
                      <input
                        type="checkbox"
                        checked={f.extraHotels.includes(h.id)}
                        onChange={(e) =>
                          set({
                            extraHotels: e.target.checked
                              ? [...f.extraHotels, h.id]
                              : f.extraHotels.filter((x) => x !== h.id),
                            extraDepts: e.target.checked
                              ? f.extraDepts
                              : f.extraDepts.filter((d) => depts.find((x) => x.id === d)?.hotelId !== h.id),
                          })
                        }
                      />{' '}
                      {h.name}
                    </label>
                    {f.extraHotels.includes(h.id) &&
                      depts
                        .filter((d) => d.hotelId === h.id)
                        .map((d) => (
                          <label
                            key={d.id}
                            style={{ display: 'flex', gap: 8, fontSize: 13, padding: '2px 0 2px 24px' }}
                          >
                            <input
                              type="checkbox"
                              checked={f.extraDepts.includes(d.id)}
                              onChange={(e) =>
                                set({
                                  extraDepts: e.target.checked
                                    ? [...f.extraDepts, d.id]
                                    : f.extraDepts.filter((x) => x !== d.id),
                                })
                              }
                            />{' '}
                            {d.name}
                          </label>
                        ))}
                  </div>
                ))}
              </fieldset>
            )}
            <label style={{ display: 'flex', gap: 8, fontSize: 14 }}>
              <input
                type="checkbox"
                checked={f.isFloater}
                onChange={(e) => set({ isFloater: e.target.checked })}
              />{' '}
              {t('Springer')}
            </label>
          </>
        )}
        {step === 2 && (
          <>
            <Field label={t('Vertragsbeginn')} htmlFor="start">
              <input
                id="start"
                className="input"
                type="date"
                value={f.contractStartDate}
                onChange={(e) => set({ contractStartDate: e.target.value })}
              />
            </Field>
            <Field label={t('Beschäftigung')} htmlFor="type">
              <select
                id="type"
                className="input"
                value={f.employmentType}
                onChange={(e) => set({ employmentType: e.target.value })}
              >
                {Object.entries({
                  full_time: 'Vollzeit',
                  part_time: 'Teilzeit',
                  minijob: 'Minijob',
                  werkstudent: 'Werkstudent',
                  apprentice: 'Azubi',
                  short_term: 'Kurzfristig',
                  other: 'Sonstiges',
                }).map(([k, v]) => (
                  <option key={k} value={k}>
                    {t(v)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('Arbeitszeitmodell')}>
              <Segmented
                value={f.workingModel as 'hourly' | 'salary'}
                onChange={(v) => set({ workingModel: v })}
                options={[
                  { value: 'salary', label: t('Gehalt (Zeitkonto)') },
                  { value: 'hourly', label: t('Stunden') },
                ]}
              />
            </Field>
            <div>
              <div style={{ fontSize: 12, marginBottom: 5 }}>{t('Arbeitstage')}</div>
              <div style={{ display: 'flex', gap: 2 }} role="group" aria-label={t('Arbeitstage')}>
                {WEEKDAYS.map((d, i) => {
                  const on = f.workingWeekdays.includes(i + 1);
                  return (
                    <button
                      type="button"
                      key={d}
                      aria-pressed={on}
                      onClick={() =>
                        set({
                          workingWeekdays: on
                            ? f.workingWeekdays.filter((x) => x !== i + 1)
                            : [...f.workingWeekdays, i + 1].sort(),
                        })
                      }
                      style={{
                        width: 36,
                        padding: '6px 0',
                        border: 0,
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 700,
                        background: on ? 'var(--color-text)' : 'var(--color-neutral-200)',
                        color: on ? 'var(--color-bg)' : 'var(--color-neutral-700)',
                      }}
                    >
                      {t(d)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
              <Field label={t('Soll')} htmlFor="target">
                <input
                  id="target"
                  className="input"
                  inputMode="decimal"
                  value={f.target}
                  onChange={(e) => set({ target: e.target.value })}
                />
              </Field>
              <Field label={t('pro')}>
                <Segmented
                  value={f.targetKind}
                  onChange={(v) => set({ targetKind: v })}
                  options={[
                    { value: 'week', label: t('Woche') },
                    { value: 'month', label: t('Monat') },
                  ]}
                />
              </Field>
              <Field label={t('Urlaubstage pro Jahr')} htmlFor="vac">
                <input
                  id="vac"
                  className="input"
                  inputMode="decimal"
                  value={f.vacationDaysPerYear}
                  onChange={(e) => set({ vacationDaysPerYear: e.target.value })}
                />
              </Field>
              <Field label={t('Zeitkonto-Startwert (Std.)')} htmlFor="open">
                <input
                  id="open"
                  className="input"
                  inputMode="decimal"
                  value={f.opening}
                  onChange={(e) => set({ opening: e.target.value })}
                />
              </Field>
              <Field
                label={t('Urlaub dieses Jahr (überschreiben)')}
                htmlFor="alloc"
                hint={t('Leer lassen: anteilig nach BUrlG.')}
              >
                <input
                  id="alloc"
                  className="input"
                  inputMode="decimal"
                  value={f.allocated}
                  onChange={(e) => set({ allocated: e.target.value })}
                />
              </Field>
              <Field label={t('Bereits genommen')} htmlFor="used">
                <input
                  id="used"
                  className="input"
                  inputMode="decimal"
                  value={f.used}
                  onChange={(e) => set({ used: e.target.value })}
                />
              </Field>
            </div>
          </>
        )}
        {step === 3 && (
          <dl
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr',
              gap: '6px 16px',
              fontSize: 14,
              margin: 0,
            }}
          >
            <dt>{t('Name')}</dt>
            <dd style={{ margin: 0, fontWeight: 700 }}>
              {f.firstName} {f.lastName}
            </dd>
            <dt>{t('Geburtsdatum')}</dt>
            <dd style={{ margin: 0 }}>{f.dateOfBirth}</dd>
            <dt>{t('E-Mail')}</dt>
            <dd style={{ margin: 0 }}>{f.email || t('keine')}</dd>
            <dt>{t('Stammhaus')}</dt>
            <dd style={{ margin: 0 }}>
              {hotels.find((h) => h.id === hotelId)?.name} · {depts.find((d) => d.id === deptId)?.name}
            </dd>
            <dt>{t('Vertragsbeginn')}</dt>
            <dd style={{ margin: 0 }}>{f.contractStartDate}</dd>
            <dt>{t('Soll')}</dt>
            <dd style={{ margin: 0 }}>
              {f.target} {t('Std.')} / {f.targetKind === 'week' ? t('Woche') : t('Monat')} ·{' '}
              {f.workingWeekdays.length} {t('Tage')}
            </dd>
            <dt>{t('Urlaub')}</dt>
            <dd style={{ margin: 0 }}>
              {f.vacationDaysPerYear} {t('Tage')}
            </dd>
          </dl>
        )}
        <ErrorNote error={error} />
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {step > 0 && (
            <button type="button" className="btn btn-secondary" onClick={() => setStep(step - 1)}>
              {t('Zurück')}
            </button>
          )}
          <button className="btn btn-primary" disabled={!valid || busy}>
            {step < 3 ? t('Weiter') : t('Mitarbeiter anlegen')}
          </button>
          <Link className="btn btn-ghost" to="/staff">
            {t('Abbrechen')}
          </Link>
        </div>
      </form>
    </main>
  );
}
