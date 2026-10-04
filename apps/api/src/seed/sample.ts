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
