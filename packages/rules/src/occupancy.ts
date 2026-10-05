// Occupancy-based staffing (backlog). Pure: turns a forecast and a ladder of rules into a suggestion.
// "From X % occupancy this shift needs N people": the rule with the highest threshold that is
// reached wins. Below the lowest threshold there is no suggestion.

export interface OccupancyRule {
  minOccupancyPct: number;
  headcount: number;
}

export function suggestHeadcount(occupancyPct: number, rules: OccupancyRule[]): number | null {
  let best: OccupancyRule | null = null;
  for (const r of rules) {
    if (occupancyPct >= r.minOccupancyPct && (!best || r.minOccupancyPct > best.minOccupancyPct)) best = r;
  }
  return best ? best.headcount : null;
}

export interface StaffingSuggestion {
  date: string;
  shiftId: number;
  occupancyPct: number;
  suggested: number;
  required: number;
  planned: number;
  /** positive: more people suggested than required; negative: fewer */
  deltaToRequired: number;
  /** suggested minus planned; positive = short of staff by that many */
  gap: number;
}

export function buildSuggestion(p: {
  date: string;
  shiftId: number;
  occupancyPct: number;
  rules: OccupancyRule[];
  required: number;
  planned: number;
}): StaffingSuggestion | null {
  const suggested = suggestHeadcount(p.occupancyPct, p.rules);
  if (suggested === null) return null;
  return {
    date: p.date,
    shiftId: p.shiftId,
    occupancyPct: p.occupancyPct,
    suggested,
    required: p.required,
    planned: p.planned,
    deltaToRequired: suggested - p.required,
    gap: suggested - p.planned,
  };
}
