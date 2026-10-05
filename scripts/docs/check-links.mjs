// Fails when a relative link in a Markdown file points to a file that does not exist.  node scripts/docs/check-links.mjs
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';

const files = [];
const walk = (d) => {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.md')) files.push(p);
  }
};
walk('docs');
files.push('README.md', 'CONTRIBUTING.md', 'SECURITY.md');
let bad = 0;
for (const f of files) {
  if (!existsSync(f)) continue;
  for (const m of readFileSync(f, 'utf8').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const t = m[1];
    if (/^(https?:|mailto:)/.test(t)) continue;
    if (!existsSync(normalize(join(dirname(f), t)))) {
      console.error(`${f}: broken link ${t}`);
      bad++;
    }
  }
}
if (bad) process.exit(1);
console.log(`${files.length} files, no broken links`);
