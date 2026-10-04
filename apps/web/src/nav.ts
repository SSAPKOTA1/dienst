export interface NavSection {
  key: string;
  label: string;
  items: Array<{ path: string; label: string }>;
}

/** Top navigation of the planner roles (design/DESIGN.md section 3). Vacation planner is v2 and hidden. */
export const PLANNER_NAV: NavSection[] = [
  { key: 'plan', label: 'Planung', items: [{ path: '/planning', label: 'Dienstplan' }] },
  {
    key: 'today',
    label: 'Heute',
    items: [
      { path: '/live', label: 'Live' },
      { path: '/requests', label: 'Anträge' },
    ],
  },
  { key: 'team', label: 'Team', items: [{ path: '/staff', label: 'Mitarbeiter' }] },
  { key: 'admin', label: 'Admin', items: [{ path: '/admin/overview', label: 'Einrichtung' }] },
];
