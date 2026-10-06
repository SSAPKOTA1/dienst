import type { ContractDto, DepartmentDto, EmployeeDetailDto, HotelDto, Items } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { WEEKDAYS } from '../lib/format';
import { Dialog, ErrorNote, Field, Segmented } from '../components/ui';

const EMPLOYMENT: Array<[string, string]> = [
  ['full_time', 'Vollzeit'],
  ['part_time', 'Teilzeit'],
  ['minijob', 'Minijob'],
  ['werkstudent', 'Werkstudent'],
  ['apprentice', 'Azubi'],
  ['short_term', 'Kurzfristig'],
  ['other', 'Sonstiges'],
];

const uniq = (a: number[]) => [...new Set(a)];
const dayAfter = (d: string) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + 1);
  return x.toISOString().slice(0, 10);
};

/** Admins and super admins: personal data, hotels and departments of one employee. */
export function EditEmployeeDialog({
  e,
  onClose,
  onDone,
}: {
  e: EmployeeDetailDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  // only hotels and departments in the caller's scope are offered; assignments elsewhere stay as they are (server side)
  const hotels = useGet<Items<HotelDto>>('/hotels');
  const depts = useGet<Items<DepartmentDto>>('/departments');
  const save = useSend('PUT', `/employees/${e.employeeId}`);
  const [f, setF] = useState({
    firstName: e.firstName ?? '',
    lastName: e.lastName ?? '',
    dateOfBirth: e.dateOfBirth ?? '',
    email: e.email ?? '',
    phone: e.phone ?? '',
    preferredLanguage: e.preferredLanguage ?? 'de',
    isFloater: e.isFloater,
  });
  const [primaryHotel, setPrimaryHotel] = useState(e.homeHotel.id);
  const [primaryDept, setPrimaryDept] = useState(e.department.id);
  const [hotelSel, setHotelSel] = useState<number[]>(e.hotelIds ?? [e.homeHotel.id]);
  const [deptSel, setDeptSel] = useState<number[]>(e.departmentIds ?? [e.department.id]);
  const hotelList = hotels.data?.items ?? [];
  const deptList = depts.data?.items ?? [];
  const primaryEditable = hotelList.some((h) => h.id === primaryHotel);
  const chosenHotels = uniq([primaryHotel, ...hotelSel]);
  const deptsOfPrimary = deptList.filter((d) => d.hotelId === primaryHotel);
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const changePrimaryHotel = (id: number) => {
    setPrimaryHotel(id);
    const first = deptList.find((d) => d.hotelId === id);
    if (first) setPrimaryDept(first.id);
  };
  const complete =
    !!f.firstName && !!f.lastName && !!f.dateOfBirth && deptsOfPrimary.some((d) => d.id === primaryDept);
  return (
    <Dialog
      title={`${t('Mitarbeiter bearbeiten')}: ${e.displayName ?? ''}`.trim()}
      onClose={onClose}
      width={560}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!complete || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  firstName: f.firstName,
                  lastName: f.lastName,
                  dateOfBirth: f.dateOfBirth,
                  email: f.email || null,
                  phone: f.phone || null,
                  preferredLanguage: f.preferredLanguage,
                  isFloater: f.isFloater,
                  primaryHotelId: primaryHotel,
                  primaryDepartmentId: primaryDept,
                  hotelIds: chosenHotels,
                  departmentIds: uniq([primaryDept, ...deptSel]),
                },
                { onSuccess: onDone },
              )
            }
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2) var(--space-3)' }}>
        <Field label={t('Vorname')} htmlFor="ee1">
          <input
            id="ee1"
            className="input"
            value={f.firstName}
            onChange={(x) => set({ firstName: x.target.value })}
          />
        </Field>
        <Field label={t('Nachname')} htmlFor="ee2">
          <input
            id="ee2"
            className="input"
            value={f.lastName}
            onChange={(x) => set({ lastName: x.target.value })}
          />
        </Field>
        <Field label={t('Geburtsdatum')} htmlFor="ee3">
          <input
            id="ee3"
            className="input"
            type="date"
            value={f.dateOfBirth}
            onChange={(x) => set({ dateOfBirth: x.target.value })}
          />
        </Field>
        <Field label={t('Sprache')} htmlFor="ee4">
          <select
            id="ee4"
            className="input"
            value={f.preferredLanguage}
            onChange={(x) => set({ preferredLanguage: x.target.value })}
          >
            <option value="de">Deutsch</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field label={t('Kontakt-E-Mail')} htmlFor="ee5">
          <input
            id="ee5"
            className="input"
            type="email"
            value={f.email}
            onChange={(x) => set({ email: x.target.value })}
          />
        </Field>
        <Field label={t('Telefon')} htmlFor="ee6">
          <input
            id="ee6"
            className="input"
            value={f.phone}
            onChange={(x) => set({ phone: x.target.value })}
          />
        </Field>
      </div>
      <label style={{ display: 'flex', gap: 8, fontSize: 14, padding: '4px 0' }}>
        <input type="checkbox" checked={f.isFloater} onChange={(x) => set({ isFloater: x.target.checked })} />
        {t('Springer')}
      </label>
      <Field
        label={t('Stammhaus')}
        htmlFor="ee7"
        hint={
          primaryEditable
            ? undefined
            : t('Das Stammhaus gehört nicht zu deinen Hotels und kann nicht geändert werden.')
        }
      >
        <select
          id="ee7"
          className="input"
          value={primaryHotel}
          disabled={!primaryEditable}
          onChange={(x) => changePrimaryHotel(Number(x.target.value))}
        >
          {primaryEditable ? (
            hotelList.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))
          ) : (
            <option value={primaryHotel}>{e.homeHotel.name}</option>
          )}
        </select>
      </Field>
      <Field label={t('Abteilung')} htmlFor="ee8">
        <select
          id="ee8"
          className="input"
          value={primaryDept}
          disabled={!primaryEditable}
          onChange={(x) => setPrimaryDept(Number(x.target.value))}
        >
          {primaryEditable ? (
            deptsOfPrimary.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))
          ) : (
            <option value={primaryDept}>{e.department.name}</option>
          )}
        </select>
      </Field>
      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ fontSize: 12, marginBottom: 5 }}>{t('Arbeitet auch in')}</legend>
        {hotelList
          .filter((h) => h.id !== primaryHotel)
          .map((h) => (
            <div key={h.id}>
              <label style={{ display: 'flex', gap: 8, fontSize: 14, padding: '3px 0' }}>
                <input
                  type="checkbox"
                  checked={hotelSel.includes(h.id)}
                  onChange={(x) => {
                    setHotelSel(x.target.checked ? [...hotelSel, h.id] : hotelSel.filter((i) => i !== h.id));
                    if (!x.target.checked)
                      setDeptSel(deptSel.filter((d) => deptList.find((y) => y.id === d)?.hotelId !== h.id));
                  }}
                />
                {h.name}
              </label>
              {hotelSel.includes(h.id) &&
                deptList
                  .filter((d) => d.hotelId === h.id)
                  .map((d) => (
                    <label
                      key={d.id}
                      style={{ display: 'flex', gap: 8, fontSize: 13, padding: '2px 0 2px 24px' }}
                    >
                      <input
                        type="checkbox"
                        checked={deptSel.includes(d.id)}
                        onChange={(x) =>
                          setDeptSel(
                            x.target.checked ? [...deptSel, d.id] : deptSel.filter((i) => i !== d.id),
                          )
                        }
                      />
                      {d.name}
                    </label>
                  ))}
            </div>
          ))}
      </fieldset>
      <ErrorNote error={save.error} />
    </Dialog>
  );
}

/** Admins and super admins: a new contract version (employment type, working days, target hours, vacation). */
export function ContractDialog({
  e,
  onClose,
  onDone,
}: {
  e: EmployeeDetailDto;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const c = e.contract;
  const save = useSend('PUT', `/employees/${e.employeeId}/contract`);
  const history = useGet<Items<ContractDto>>(`/employees/${e.employeeId}/contracts`);
  // a new version has to start after the current one
  const earliest = c ? dayAfter(c.validFrom) : '';
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({
    validFrom: earliest > today ? earliest : today,
    employmentType: c?.employmentType ?? 'full_time',
    workingModel: c?.workingModel ?? 'salary',
    targetHoursPerWeek: c?.targetHoursPerWeek != null ? String(c.targetHoursPerWeek) : '',
    vacationDaysPerYear: c ? String(c.vacationDaysPerYear) : '30',
    monthlyHoursCap: c?.monthlyHoursCap != null ? String(c.monthlyHoursCap) : '',
    getsPublicHoliday: c?.getsPublicHoliday ?? false,
  });
  const [days, setDays] = useState<number[]>(c?.workingWeekdays ?? [1, 2, 3, 4, 5]);
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  const num = (v: string) => (v.trim() === '' ? null : Number(v.replace(',', '.')));
  const complete =
    !!f.validFrom && f.validFrom >= earliest && days.length > 0 && num(f.vacationDaysPerYear) !== null;
  return (
    <Dialog
      title={`${t('Vertrag ändern')}: ${e.displayName ?? ''}`.trim()}
      onClose={onClose}
      width={560}
      actions={
        <>
          <button
            className="btn btn-primary"
            disabled={!complete || save.isPending}
            onClick={() =>
              save.mutate(
                {
                  validFrom: f.validFrom,
                  employmentType: f.employmentType,
                  workingModel: f.workingModel,
                  workDaysPerWeek: days.length,
                  workingWeekdays: [...days].sort(),
                  targetHoursPerWeek: num(f.targetHoursPerWeek),
                  vacationDaysPerYear: num(f.vacationDaysPerYear),
                  monthlyHoursCap: num(f.monthlyHoursCap),
                  getsPublicHoliday: f.getsPublicHoliday,
                },
                { onSuccess: onDone },
              )
            }
          >
            {t('Speichern')}
          </button>
          <button className="btn btn-secondary" onClick={onClose}>
            {t('Abbrechen')}
          </button>
        </>
      }
    >
      {(history.data?.items.length ?? 0) > 0 && (
        <div data-testid="contract-history" style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 3 }}>{t('Vertragsverlauf')}</div>
          {history.data!.items.map((v) => (
            <div key={v.id} style={{ display: 'flex', gap: 10, fontVariantNumeric: 'tabular-nums' }}>
              <span>
                {v.validFrom} – {v.validTo ?? t('offen')}
              </span>
              <span>{t(EMPLOYMENT.find(([k]) => k === v.employmentType)?.[1] ?? v.employmentType)}</span>
              <span>
                {v.targetHoursPerWeek ?? '–'} {t('Std.')}
              </span>
              <span>
                {v.vacationDaysPerYear} {t('Urlaubstage')}
              </span>
            </div>
          ))}
        </div>
      )}
      <div style={{ fontSize: 13, color: 'var(--color-neutral-700)' }}>
        {t('Die Änderung gilt ab dem gewählten Datum. Frühere Zeiten bleiben unverändert.')}
        {c ? ` ${t('Aktueller Vertrag seit')} ${c.validFrom}.` : ''}
      </div>
      <Field label={t('Gültig ab')} htmlFor="ec1">
        <input
          id="ec1"
          className="input"
          type="date"
          min={earliest || undefined}
          value={f.validFrom}
          onChange={(x) => set({ validFrom: x.target.value })}
        />
      </Field>
      <Field label={t('Beschäftigung')} htmlFor="ec2">
        <select
          id="ec2"
          className="input"
          value={f.employmentType}
          onChange={(x) => set({ employmentType: x.target.value })}
        >
          {EMPLOYMENT.map(([k, v]) => (
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
            const on = days.includes(i + 1);
            return (
              <button
                type="button"
                key={d}
                aria-pressed={on}
                onClick={() => setDays(on ? days.filter((x) => x !== i + 1) : [...days, i + 1])}
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
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 'var(--space-3)' }}>
        <Field label={t('Soll pro Woche')} htmlFor="ec3">
          <input
            id="ec3"
            className="input"
            inputMode="decimal"
            value={f.targetHoursPerWeek}
            onChange={(x) => set({ targetHoursPerWeek: x.target.value })}
          />
        </Field>
        <Field label={t('Urlaubstage pro Jahr')} htmlFor="ec4">
          <input
            id="ec4"
            className="input"
            inputMode="decimal"
            value={f.vacationDaysPerYear}
            onChange={(x) => set({ vacationDaysPerYear: x.target.value })}
          />
        </Field>
        <Field label={t('Monatsgrenze (Std.)')} htmlFor="ec5">
          <input
            id="ec5"
            className="input"
            inputMode="decimal"
            value={f.monthlyHoursCap}
            onChange={(x) => set({ monthlyHoursCap: x.target.value })}
          />
        </Field>
      </div>
      <label style={{ display: 'flex', gap: 8, fontSize: 14, padding: '4px 0' }}>
        <input
          type="checkbox"
          checked={f.getsPublicHoliday}
          onChange={(x) => set({ getsPublicHoliday: x.target.checked })}
        />
        {t('Feiertage werden bezahlt')}
      </label>
      <ErrorNote error={save.error} />
    </Dialog>
  );
}
