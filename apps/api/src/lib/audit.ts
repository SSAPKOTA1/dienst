import { sql } from 'kysely';
import type { Trx, Db } from '../db';
import { sha256 } from './security';

export interface Actor {
  userId: number | null;
  type: 'super_admin' | 'admin' | 'manager' | 'employee' | 'system';
  ip?: string;
  userAgent?: string;
}

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: number | null;
  companyId?: number | null;
  hotelId?: number | null;
  old?: unknown;
  new?: unknown;
  reason?: string | null;
  status?: string;
}

export const SYSTEM_ACTOR: Actor = { userId: null, type: 'system' };

/** Append one audit row inside the caller's transaction. Hash chain: SHA-256(previous hash || row content). */
export async function audit(trx: Trx | Db, actor: Actor, e: AuditEntry): Promise<void> {
  await sql`select pg_advisory_xact_lock(7001)`.execute(trx);
  const prev = await trx
    .selectFrom('audit_log')
    .select('entry_hash')
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const content = JSON.stringify([
    actor.userId,
    actor.type,
    e.action,
    e.entityType ?? null,
    e.entityId ?? null,
    e.companyId ?? null,
    e.hotelId ?? null,
    e.old ?? null,
    e.new ?? null,
    e.reason ?? null,
    new Date().toISOString(),
  ]);
  const hash = sha256((prev?.entry_hash ?? '') + content);
  await trx
    .insertInto('audit_log')
    .values({
      company_id: e.companyId ?? null,
      hotel_id: e.hotelId ?? null,
      actor_id: actor.userId,
      actor_type: actor.type,
      action: e.action,
      entity_type: e.entityType ?? null,
      entity_id: e.entityId ?? null,
      old_values: e.old === undefined ? null : JSON.stringify(e.old),
      new_values: e.new === undefined ? null : JSON.stringify(e.new),
      reason: e.reason ?? null,
      status: e.status ?? 'ok',
      ip_address: actor.ip?.slice(0, 45) ?? null,
      user_agent: actor.userAgent ?? null,
      entry_hash: hash,
    })
    .execute();
}
