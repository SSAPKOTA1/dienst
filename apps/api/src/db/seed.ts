import { createDb } from './index';
import { loadConfig } from '../config';
import { resetAll, runSeed } from '../seed';
import { DEMO_PASSWORD } from '../seed/sample';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed in production.');
  process.exit(1);
}
const db = createDb(loadConfig().DATABASE_URL);
try {
  await resetAll(db);
  const r = await runSeed(db, new Date());
  console.log(
    `\nDemo data created (relative to ${r.today}). Password for all demo accounts: ${DEMO_PASSWORD}\n`,
  );
  console.log('Staff logins');
  for (const l of r.logins) console.log(`  ${l.login.padEnd(22)} ${l.role}${l.note ? `  (${l.note})` : ''}`);
  console.log(`  TOTP secret for sa@/admin@demo.test (authenticator app): ${r.totpSecret}`);
  console.log('\nEmployees (username / e-mail, tablet PIN, personnel number)');
  for (const e of r.employees) {
    console.log(
      `  ${e.name.padEnd(16)} ${(e.username ?? '').padEnd(18)} ${(e.email ?? '(no e-mail)').padEnd(28)} PIN ${e.pin}  ${e.personnelNumber}  ${e.hotel}${e.activationCode ? `  activation code ${e.activationCode}` : ''}`,
    );
  }
  console.log(`\nKiosk device token (Frankfurt reception tablet): ${r.kioskToken}\n`);
} finally {
  await db.destroy();
}
