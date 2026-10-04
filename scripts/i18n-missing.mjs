// Lists German keys used via t('...') that have no English translation yet.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
const root = 'apps/web/src';
const en = JSON.parse(readFileSync(`${root}/i18n/en.json`, 'utf8'));
const extra = readFileSync(`${root}/i18n/extra-en.ts`, 'utf8');
const have = new Set(Object.keys(en));
for (const m of extra.matchAll(/^\s*(?:'((?:[^'\\]|\\.)*)'|([A-Za-z_]\w*)):/gm))
  have.add((m[1] ?? m[2]).replace(/\\'/g, "'"));
const used = new Map();
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(f) && !p.includes('i18n/')) {
      const s = readFileSync(p, 'utf8');
      for (const m of s.matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)) used.set(m[1].replace(/\\'/g, "'"), p);
      for (const m of s.matchAll(/\bt\(\s*"((?:[^"\\]|\\.)*)"/g)) used.set(m[1], p);
      for (const m of s.matchAll(/\bt\(\s*`([^`$]*)`/g)) used.set(m[1], p);
      // strings passed through label tables: ['key', 'Label'] style are covered by hand
    }
  }
};
walk(root);
const missing = [...used.keys()].filter((k) => !have.has(k) && k.trim());
console.log(missing.map((k) => `  '${k.replace(/'/g, "\\'")}': '',`).join('\n'));
console.error(`${missing.length} missing`);
