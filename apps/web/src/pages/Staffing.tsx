import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useGet, useSend } from '../lib/api';
import { fdate } from '../lib/format';
import { ErrorNote, Field, PageHead, useToast } from '../components/ui';
import { addDaysIso, mondayOfIso, todayIso } from './planning/util';

const box: React.CSSProperties = { border: '2px solid var(--color-text)' };
const head: React.CSSProperties = {
  padding: 'var(--space-3) var(--space-4)',
  background: 'var(--color-surface)',
  borderBottom: '2px solid var(--color-text)',
  fontWeight: 800,
};

/** "01.03.2027;85" or "2027-03-01,85" per line. */
function parseForecast(text: string): Array<{ date: string; occupancyPct: number }> | null {
  const out: Array<{ date: string; occupancyPct: number }> = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2}|\d{2}\.\d{2}\.\d{4})\s*[;,\t ]\s*(\d{1,3})\s*%?$/);
    if (!m) return null;
    const d = m[1].includes('.') ? m[1].split('.').reverse().join('-') : m[1];
    out.push({ date: d, occupancyPct: Number(m[2]) });
  }
  return out;
}

/** Occupancy forecast, staffing rules and suggestions. Suggestions never change the plan by themselves. */
export function Staffing() {
  const { t } = useTranslation();
  const toast = useToast();
  const hotels = useGet('/hotels');
  const [hotel, setHotel] = useState<number | ''>('');
  const hotelId = hotel || hotels.data?.items?.[0]?.id || '';
  const [from, setFrom] = useState(mondayOfIso(todayIso()));
  const to = addDaysIso(from, 13);
  const q = hotelId ? { hotelId: String(hotelId), from, to } : undefined;
  const shifts = useGet('/shifts', hotelId ? { hotelId: String(hotelId) } : undefined, {
    enabled: !!hotelId,
  });
  const rules = useGet('/staffing-rules', hotelId ? { hotelId: String(hotelId) } : undefined, {
    enabled: !!hotelId,
  });
  const sug = useGet('/staffing/suggestions', q, { enabled: !!hotelId });
  const forecast = useSend<any>('PUT', '/occupancy');
  const addRule = useSend<any>('POST', '/staffing-rules');
  const delRule = useSend<number>('DELETE', (id) => `/staffing-rules/${id}`);
  const apply = useSend<any>('POST', '/staffing/apply');
  const [text, setText] = useState('');
  const [shiftId, setShiftId] = useState<number | ''>('');
  const [pct, setPct] = useState(0);
  const [heads, setHeads] = useState(1);
  const parsed = useMemo(() => parseForecast(text), [text]);
  const open = (sug.data?.items ?? []).filter((s: any) => s.deltaToRequired !== 0);
  return (
    <main style={{ flex: 1, minWidth: 0 }}>
      <PageHead kicker={t('Planung')} title={t('Besetzung nach Auslastung')} />
      <div
        style={{
          padding: '0 var(--space-4) var(--space-4)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <Field label={t('Hotel')} htmlFor="st-hotel">
            <select
              id="st-hotel"
              className="input"
              value={hotelId}
              onChange={(e) => setHotel(Number(e.target.value))}
            >
              {(hotels.data?.items ?? []).map((h: any) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
          <button className="btn btn-secondary" onClick={() => setFrom(addDaysIso(from, -14))}>
            ←
          </button>
          <span style={{ fontWeight: 700 }}>
            {fdate(from)} – {fdate(to)}
          </span>
          <button className="btn btn-secondary" onClick={() => setFrom(addDaysIso(from, 14))}>
            →
          </button>
        </div>

        <section style={box}>
          <div style={head}>{t('Auslastungsprognose')}</div>
          <div
            style={{
              padding: 'var(--space-3) var(--space-4)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}
          >
            <label htmlFor="st-forecast" style={{ fontSize: 13 }}>
              {t('Eine Zeile je Tag: Datum;Prozent (z. B. 01.03.2027;85)')}
            </label>
            <textarea
              id="st-forecast"
              className="input"
              rows={4}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-testid="forecast-text"
            />
            {parsed === null && (
              <div style={{ color: 'var(--warn)', fontSize: 13 }}>{t('Eine Zeile ist nicht lesbar.')}</div>
            )}
            <ErrorNote error={forecast.error} />
            <button
              className="btn btn-primary"
              style={{ alignSelf: 'flex-start' }}
              disabled={!hotelId || !parsed?.length}
              onClick={() =>
                forecast.mutate(
                  { hotelId, items: parsed },
                  { onSuccess: () => (toast(t('Gespeichert.')), setText('')) },
                )
              }
            >
              {t('Prognose speichern')}
            </button>
          </div>
        </section>

        <section style={box}>
          <div style={head}>{t('Regeln: ab wie viel Prozent wie viele Personen')}</div>
          <table className="table">
            <tbody>
              {(rules.data?.items ?? []).map((r: any) => (
                <tr key={r.id} data-testid="rule-row">
                  <td style={{ paddingLeft: 'var(--space-4)', fontWeight: 700 }}>{r.shiftName}</td>
                  <td>
                    {t('ab')} {r.minOccupancyPct} %
                  </td>
                  <td>
                    {r.headcount} {t('Personen')}
                  </td>
                  <td style={{ textAlign: 'right', paddingRight: 'var(--space-4)' }}>
                    <button className="btn btn-ghost" onClick={() => delRule.mutate(r.id)}>
                      {t('Löschen')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-3)',
              alignItems: 'flex-end',
              flexWrap: 'wrap',
              padding: 'var(--space-3) var(--space-4)',
            }}
          >
            <Field label={t('Schicht')} htmlFor="st-shift">
              <select
                id="st-shift"
                className="input"
                value={shiftId}
                onChange={(e) => setShiftId(Number(e.target.value))}
              >
                <option value="">–</option>
                {(shifts.data?.items ?? []).map((s: any) => (
                  <option key={s.id} value={s.id}>
                    {s.name} {s.startTime}–{s.endTime}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('ab % Auslastung')} htmlFor="st-pct">
              <input
                id="st-pct"
                className="input"
                type="number"
                min={0}
                max={100}
                value={pct}
                onChange={(e) => setPct(Number(e.target.value))}
              />
            </Field>
            <Field label={t('Personen')} htmlFor="st-heads">
              <input
                id="st-heads"
                className="input"
                type="number"
                min={0}
                value={heads}
                onChange={(e) => setHeads(Number(e.target.value))}
              />
            </Field>
            <button
              className="btn btn-primary"
              disabled={!shiftId}
              onClick={() =>
                addRule.mutate(
                  { hotelId, shiftId, minOccupancyPct: pct, headcount: heads },
                  { onSuccess: () => toast(t('Gespeichert.')) },
                )
              }
            >
              {t('Regel speichern')}
            </button>
          </div>
          <div style={{ padding: '0 var(--space-4) var(--space-3)' }}>
            <ErrorNote error={addRule.error} />
          </div>
        </section>

        <section style={box}>
          <div style={{ ...head, display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <span style={{ marginRight: 'auto' }}>{t('Vorschläge')}</span>
            <button
              className="btn btn-primary"
              disabled={!open.length}
              onClick={() =>
                apply.mutate(
                  {
                    hotelId,
                    items: open.map((s: any) => ({
                      shiftId: s.shiftId,
                      date: s.date,
                      headcount: s.suggested,
                    })),
                  },
                  { onSuccess: () => toast(t('Übernommen.')) },
                )
              }
              data-testid="apply-all"
            >
              {t('Alle als Sollbesetzung übernehmen')}
            </button>
          </div>
          <div style={{ padding: 'var(--space-2) var(--space-4)', fontSize: 13 }}>
            {t('Vorschläge ändern den Dienstplan nicht. Übernehmen setzt nur die Soll-Besetzung des Tages.')}
          </div>
          <table className="table">
            <thead>
              <tr>
                <th style={{ paddingLeft: 'var(--space-4)' }}>{t('Tag')}</th>
                <th>{t('Schicht')}</th>
                <th>{t('Auslastung')}</th>
                <th>{t('Vorschlag')}</th>
                <th>{t('Soll')}</th>
                <th>{t('Geplant')}</th>
              </tr>
            </thead>
            <tbody>
              {(sug.data?.items ?? []).map((s: any) => (
                <tr key={`${s.date}-${s.shiftId}`} data-testid="suggestion-row">
                  <td style={{ paddingLeft: 'var(--space-4)' }}>
                    {fdate(s.date, { weekday: 'short', day: '2-digit', month: '2-digit' })}
                  </td>
                  <td>{s.shiftName}</td>
                  <td>{s.occupancyPct} %</td>
                  <td style={{ fontWeight: 800 }}>{s.suggested}</td>
                  <td>{s.required}</td>
                  <td>
                    {s.planned}
                    {s.gap > 0 ? ` (${t('es fehlen')} ${s.gap})` : ''}
                  </td>
                </tr>
              ))}
              {(sug.data?.items ?? []).length === 0 && (
                <tr>
                  <td colSpan={6} style={{ paddingLeft: 'var(--space-4)' }}>
                    {t('Keine Vorschläge: Prognose und Regeln fehlen.')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
