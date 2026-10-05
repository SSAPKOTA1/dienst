import { migrate, rollback } from './migrate';

// node migrate-cli.mjs            apply pending migrations
// node migrate-cli.mjs --rollback 2   undo the newest 2 (needs their .down.sql files)
const url = process.env.DATABASE_URL ?? 'postgres://dienst:dienst@localhost:5432/dienst';
const i = process.argv.indexOf('--rollback');
const steps = i >= 0 ? Number(process.argv[i + 1] ?? 1) || 1 : 0;
(steps ? rollback(url, steps) : migrate(url)).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
