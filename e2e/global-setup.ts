import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Every run starts from the demo seed (relative to today) so that dates and PINs are known.
export default function setup() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const env = { ...process.env };
  // Ensure DATABASE_URL is set for migrations; GitHub Actions job-level env vars should be present
  if (!env.DATABASE_URL) {
    env.DATABASE_URL = 'postgres://dienst:dienst@localhost:5432/dienst_test';
  }
  execSync('pnpm db:migrate && pnpm db:seed', { cwd: root, stdio: 'inherit', env });
}
