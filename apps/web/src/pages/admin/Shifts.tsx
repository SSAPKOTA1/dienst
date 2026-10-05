import type { DepartmentDto, Items, QualificationDto, ShiftDto } from '@dienst/shared';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, useGet } from '../../lib/api';
import { Dialog, ErrorNote, Field, useToast } from '../../components/ui';

export function minimums(shifts: ShiftDto[], deptId: number): string {
  const mine = shifts.filter((x) => x.departmentId === deptId);
  if (!mine.length) return '–';
  const sum = (wd: string) => mine.reduce((a, x) => a + (x.weekdayDefaults?.[wd] ?? 0), 0);
  return `${sum('1')} · ${sum('6')}`;
}

const WD = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];

function ShiftEditor({
  hotelId,
  deptId,
  shift,
  onDone,
}: {
  hotelId: number;
  deptId: number;
  shift?: ShiftDto;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const [f, setF] = useState({
    name: shift?.name ?? '',
    startTime: shift?.startTime ?? '06:00',
    endTime: shift?.endTime ?? '14:00',
    breakMinutes: String(shift?.breakMinutes ?? 30),
    requiredQualificationId: String(shift?.requiredQualificationId ?? ''),
  });
  const quals = useGet<Items<QualificationDto>>('/qualifications');
  const [wd, setWd] = useState<Record<string, string>>(
    Object.fromEntries(
      WD.map((_, i) => [String(i + 1), String(shift?.weekdayDefaults?.[String(i + 1)] ?? '')]),
    ),
  );
  const [ov, setOv] = useState<Array<{ date: string; count: string }>>(
    (shift?.overrides ?? []).map((o) => ({ date: o.date, count: String(o.count) })),
  );
  const [error, setError] = useState<unknown>(null);
  const save = async () => {
    setError(null);
    try {
      const base = {
        name: f.name,
        startTime: f.startTime,
        endTime: f.endTime,
        breakMinutes: Number(f.breakMinutes) || 0,
        requiredQualificationId: f.requiredQualificationId ? Number(f.requiredQualificationId) : null,
      };
      const saved = shift
        ? await api<ShiftDto>(`/shifts/${shift.id}`, { method: 'PUT', body: base })
        : await api<ShiftDto>('/shifts', { body: { ...base, hotelId, departmentId: deptId } });
      await api(`/shifts/${saved.id}/staffing`, {
        method: 'PUT',
        body: {
          weekdayDefaults: Object.fromEntries(
            Object.entries(wd)
              .filter(([, v]) => v !== '')
              .map(([k, v]) => [k, Number(v)]),
          ),
          overrides: ov
            .filter((o) => o.date && o.count !== '')
            .map((o) => ({ date: o.date, count: Number(o.count) })),
        },
      });
      toast(t('Gespeichert.'));
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  const remove = async () => {
    if (!shift || !window.confirm(t('Schicht löschen?'))) return;
    try {
      await api(`/shifts/${shift.id}`, { method: 'DELETE' });
      onDone();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div
      style={{
        border: '2px solid var(--color-text)',
        padding: 'var(--space-3)',
        display: 'grid',
        gap: 'var(--space-3)',
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr 1fr', gap: 'var(--space-2)' }}>
        <Field label={t('Name')}>
          <input
            className="input"
            aria-label={t('Name')}
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
          />
        </Field>
        <Field label={t('Beginn')}>
          <input
            className="input"
            placeholder="HH:mm"
            maxLength={5}
            aria-label={t('Beginn')}
            value={f.startTime}
            onChange={(e) => setF({ ...f, startTime: e.target.value })}
          />
        </Field>
        <Field label={t('Ende')}>
          <input
            className="input"
            placeholder="HH:mm"
            maxLength={5}
            aria-label={t('Ende')}
            value={f.endTime}
            onChange={(e) => setF({ ...f, endTime: e.target.value })}
          />
        </Field>
        <Field label={t('Pause (Min.)')}>
          <input
            className="input"
            inputMode="numeric"
            aria-label={t('Pause (Min.)')}
            value={f.breakMinutes}
            onChange={(e) => setF({ ...f, breakMinutes: e.target.value })}
          />
        </Field>
      </div>
      {(quals.data?.items ?? []).length > 0 && (
        <Field label={t('Erforderliche Qualifikation')} htmlFor="sh-qual">
          <select
            id="sh-qual"
            className="input"
            value={f.requiredQualificationId}
            onChange={(e) => setF({ ...f, requiredQualificationId: e.target.value })}
          >
            <option value="">{t('Keine')}</option>
            {(quals.data?.items ?? []).map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div>
        <div style={{ fontSize: 12, marginBottom: 4 }}>{t('Mindestbesetzung pro Wochentag')}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
          {WD.map((d, i) => (
            <label key={d} style={{ fontSize: 11, textAlign: 'center' }}>
              {t(d)}
              <input
                className="input"
                style={{ textAlign: 'center', padding: '2px 4px' }}
                inputMode="numeric"
                value={wd[String(i + 1)]}
                onChange={(e) => setWd({ ...wd, [String(i + 1)]: e.target.value })}
              />
            </label>
          ))}
        </div>
      </div>
      <div>
        <div style={{ fontSize: 12, marginBottom: 4 }}>{t('Abweichungen an einzelnen Tagen')}</div>
        {ov.map((o, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
            <input
              className="input"
              type="date"
              aria-label={t('Datum')}
              value={o.date}
              onChange={(e) => setOv(ov.map((x, j) => (j === i ? { ...x, date: e.target.value } : x)))}
            />
            <input
              className="input"
              style={{ width: 80 }}
              inputMode="numeric"
              aria-label={t('Anzahl')}
              value={o.count}
              onChange={(e) => setOv(ov.map((x, j) => (j === i ? { ...x, count: e.target.value } : x)))}
            />
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setOv(ov.filter((_, j) => j !== i))}
            >
              {t('Entfernen')}
            </button>
          </div>
        ))}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => setOv([...ov, { date: '', count: '' }])}
        >
          {t('Tag hinzufügen')}
        </button>
      </div>
      <ErrorNote error={error} />
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-primary" disabled={!f.name} onClick={() => void save()}>
          {t('Speichern')}
        </button>
        {shift && (
          <button className="btn btn-ghost" onClick={() => void remove()}>
            {t('Löschen')}
          </button>
        )}
      </div>
    </div>
  );
}

export function ShiftsDialog({
  hotelId,
  dept,
  shifts,
  onClose,
  onChanged,
}: {
  hotelId: number;
  dept: DepartmentDto;
  shifts: ShiftDto[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  return (
    <Dialog
      title={`${dept.name}: ${t('Schichten & Besetzung')}`}
      onClose={onClose}
      width={720}
      actions={
        <button className="btn btn-secondary" onClick={onClose}>
          {t('Schließen')}
        </button>
      }
    >
      {shifts.map((x) => (
        <ShiftEditor
          key={`${x.id}-${JSON.stringify(x)}`}
          hotelId={hotelId}
          deptId={dept.id}
          shift={x}
          onDone={onChanged}
        />
      ))}
      {adding ? (
        <ShiftEditor
          hotelId={hotelId}
          deptId={dept.id}
          onDone={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : (
        <button
          className="btn btn-secondary"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setAdding(true)}
        >
          {t('Schicht hinzufügen')}
        </button>
      )}
    </Dialog>
  );
}
