import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every run starts from the demo seed (relative to today) so that dates and PINs are known.
export default function setup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  execSync('pnpm db:migrate && pnpm db:seed', { cwd: root, stdio: 'inherit' });
}
