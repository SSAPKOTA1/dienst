import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db';
import { resetAll, runSeed } from '../src/seed';

// The demo data is relative to "today" and the e2e tests clock employees in on the tablet, so who is clocked in
// right after seeding must be the same at every hour of the day (it used to depend on which shift was running).
const HOURS = Array.from({ length: 24 }, (_, h) => h);

describe('demo seed', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
  });
  afterAll(async () => {
    await db.destroy();
  });

  it.each(HOURS)('seeds at %i:20 UTC with only the deliberate open record', async (hour) => {
    const now = new Date(Date.UTC(2026, 9, 7, hour, 20)); // a Wednesday
    await resetAll(db);
    const r = await runSeed(db, now);

    const open = await db
      .selectFrom('punch_record')
      .select(['employee_id', 'is_unplanned', 'schedule_id'])
      .where('actual_punch_out', 'is', null)
      .execute();

    expect(open).toEqual([
      expect.objectContaining({ employee_id: r.ids.empIds.piotr, is_unplanned: true, schedule_id: null }),
    ]);
  });
});
