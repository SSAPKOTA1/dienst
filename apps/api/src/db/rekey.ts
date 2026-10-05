import { createDb } from './index';
import { loadConfig } from '../config';
import { Keys } from '../lib/keys';

/**
 * Re-encrypts data at rest with the current DATA_KEY (after a rotation, or once after upgrading from the
 * legacy TOTP_ENC_KEY). Safe to run repeatedly; it only touches rows that a previous key still opens.
 * Badge hashes cannot be migrated in bulk (the badge itself is not stored); they move on first use.
 */
const cfg = loadConfig();
const keys = new Keys(cfg);
const db = createDb(cfg.DATABASE_URL);

async function rekey(label: string, rows: Array<{ id: number; blob: Buffer | null }>, purpose: Parameters<Keys['seal']>[0], save: (id: number, blob: Buffer) => Promise<unknown>) {
  let moved = 0;
  let failed = 0;
  for (const r of rows) {
    if (!r.blob) continue;
    try {
      const { plain, current } = keys.openWithInfo(purpose, r.blob);
      if (current) continue;
      await save(r.id, keys.seal(purpose, plain));
      moved++;
    } catch {
      failed++; // not readable with any configured key: keep it untouched and report
    }
  }
  console.log(`${label.padEnd(24)} re-encrypted ${moved}, unreadable ${failed}, total ${rows.length}`);
  return failed;
}

try {
  let failed = 0;
  failed += await rekey(
    'TOTP secrets',
    (await db.selectFrom('user_account').select(['id', 'totp_secret_enc']).where('totp_secret_enc', 'is not', null).execute()).map((r) => ({ id: r.id, blob: r.totp_secret_enc as Buffer | null })),
    'totp',
    (id, blob) => db.updateTable('user_account').set({ totp_secret_enc: blob }).where('id', '=', id).execute(),
  );
  failed += await rekey(
    'Documents',
    (await db.selectFrom('employee_document').select(['id', 'content_enc']).execute()).map((r) => ({ id: r.id, blob: r.content_enc as Buffer })),
    'documents',
    (id, blob) => db.updateTable('employee_document').set({ content_enc: blob }).where('id', '=', id).execute(),
  );
  failed += await rekey(
    'Import credentials',
    (await db.selectFrom('import_job').select(['id', 'credentials_enc']).where('credentials_enc', 'is not', null).execute()).map((r) => ({ id: r.id, blob: r.credentials_enc as Buffer | null })),
    'import-credentials',
    (id, blob) => db.updateTable('import_job').set({ credentials_enc: blob }).where('id', '=', id).execute(),
  );
  failed += await rekey(
    'SSO client secrets',
    (await db.selectFrom('sso_provider').select(['id', 'client_secret_enc']).execute()).map((r) => ({ id: r.id, blob: r.client_secret_enc as Buffer })),
    'sso-client-secret',
    (id, blob) => db.updateTable('sso_provider').set({ client_secret_enc: blob }).where('id', '=', id).execute(),
  );
  if (failed) process.exitCode = 1;
} finally {
  await db.destroy();
}
