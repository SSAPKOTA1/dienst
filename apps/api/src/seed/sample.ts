import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export interface SampleEmp {
  id: string;
  name: string;
  d: 'fd' | 'hk' | 'bf';
  meta: string;
  t: number;
  w: string;
  num: string;
  birth: string; // dd.mm.yyyy
  vac: string;
  acct: string;
  carry: string;
  h?: 'ffm' | 'ber';
  floating?: boolean;
  minor?: boolean;
}
export interface Sample {
  SH: Record<string, { n: string; t: string; s: string; p: number; d: string }>;
  ABS: Record<string, string>;
  DEPTS: Array<{ id: string; name: string; min: number; opts: string[] }>;
  HOTELS: Record<string, string>;
  EMPS: SampleEmp[];
}

export const loadSample = (): Sample =>
  JSON.parse(readFileSync(path.resolve(here, '../../../../design/sample-data.json'), 'utf8'));

export const num = (s: string): number =>
  Number(
    s
      .replace('−', '-')
      .replace(',', '.')
      .replace(/[^\d.+-]/g, ''),
  );
export const isoBirth = (dmy: string): string => dmy.split('.').reverse().join('-');

/** Fixed demo PINs (non-weak) so the printed seed output and the e2e suite are reproducible. */
export const DEMO_PINS = [
  '482915',
  '736204',
  '159357',
  '864219',
  '297031',
  '513684',
  '640872',
  '925461',
  '371596',
  '708342',
  '246813',
  '581927',
  '439065',
  '862710',
  '195837',
];
export const DEMO_PASSWORD = 'Demo!2345';
export const DEMO_KIOSK_TOKEN = 'kd_demo_frankfurt_4f1c9a7e2b6d8035a1e94c7b02d6f83a';
export const DEMO_TOTP_SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
/** Demo values of the backlog features (printed by the seed). */
export const DEMO_BERLIN_KIOSK_TOKEN = 'kd_demo_berlin_8b2e5d1c7a9f4630c2e81d5b9a7f3e04';
export const DEMO_BADGE = 'B-DEMO-CLARA-0001';
export const DEMO_API_KEY = 'dk_demo_readonly_5c8e2a9f1b7d4630a2e91c5d8b7f3a06';
