/** Minutes since local midnight of the start day; `endMin` may exceed 1440 for overnight entries. */
export function overlapsNightWindow(startMin: number, endMin: number): boolean {
  // night window = 20:00-06:00 local (JArbSchG 14)
  const windows: Array<[number, number]> = [
    [0, 360],
    [1200, 1800],
    [2640, 3240],
  ];
  return windows.some(([a, b]) => startMin < b && endMin > a);
}

export function ageOn(dobIso: string, dayIso: string): number {
  const [by, bm, bd] = dobIso.split('-').map(Number);
  const [y, m, d] = dayIso.split('-').map(Number);
  let age = y - by;
  if (m < bm || (m === bm && d < bd)) age--;
  return age;
}

export const isMinor = (dobIso: string, dayIso: string): boolean => ageOn(dobIso, dayIso) < 18;
