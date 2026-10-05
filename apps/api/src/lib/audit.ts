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

/** Sub-chains for entries without a company (logins, system events): spreads them so they do not queue up. */
export const GLOBAL_CHAINS = 16;

/** Chain of an entry: its company, or one of the negative global sub-chains chosen by the actor. */
export const chainKeyOf = (companyId: number | null | undefined, actorId: number | null): number =>
  companyId ?? -(1 + (Math.abs(actorId ?? 0) % GLOBAL_CHAINS));

/** JSON with sorted keys, so the same value always hashes the same (JSONB does not keep key order). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(',')}}`;
}

/** The fields an entry hash covers: exactly what is stored in the row (and nothing else). */
export interface HashedRow {
  chainKey: number;
  prevHash: string;
  actorId: number | null;
  actorType: string | null;
  action: string;
  entityType: string | null;
  entityId: number | null;
  companyId: number | null;
  hotelId: number | null;
  oldValues: unknown;
  newValues: unknown;
  reason: string | null;
  status: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: string; // ISO, milliseconds
}
export const entryHash = (r: HashedRow): string => sha256(canonical({ v: 2, ...r }));

/**
 * Append one audit row inside the caller's transaction. The hash chain is per company (`chain_key`): the lock
 * that keeps a chain linear is per chain, so writes of different companies no longer wait for each other.
 */
export async function audit(trx: Trx | Db, actor: Actor, e: AuditEntry): Promise<void> {
  // The chain lock lives as long as the transaction. On a plain connection it would be released at once and two
  // concurrent writers could both extend the same entry, forking the chain: give such calls their own transaction.
  if (!trx.isTransaction) return (trx as Db).transaction().execute((t) => audit(t, actor, e));
  const chainKey = chainKeyOf(e.companyId, actor.userId);
  await sql`select pg_advisory_xact_lock(7001, ${chainKey})`.execute(trx);
  const prev = await trx
    .selectFrom('audit_log')
    .select('entry_hash')
    .where('chain_key', '=', chainKey)
    .where('hash_version', '=', 2)
    .orderBy('id', 'desc')
    .limit(1)
    .executeTakeFirst();
  const createdAt = new Date();
  const oldValues = e.old === undefined ? null : JSON.parse(JSON.stringify(e.old));
  const newValues = e.new === undefined ? null : JSON.parse(JSON.stringify(e.new));
  const row: HashedRow = {
    chainKey,
    prevHash: prev?.entry_hash ?? '',
    actorId: actor.userId,
    actorType: actor.type,
    action: e.action,
    entityType: e.entityType ?? null,
    entityId: e.entityId ?? null,
    companyId: e.companyId ?? null,
    hotelId: e.hotelId ?? null,
    oldValues,
    newValues,
    reason: e.reason ?? null,
    status: e.status ?? 'ok',
    ip: actor.ip?.slice(0, 45) ?? null,
    userAgent: actor.userAgent ?? null,
    createdAt: createdAt.toISOString(),
  };
  await trx
    .insertInto('audit_log')
    .values({
      company_id: row.companyId,
      hotel_id: row.hotelId,
      actor_id: row.actorId,
      actor_type: row.actorType,
      action: row.action,
      entity_type: row.entityType,
      entity_id: row.entityId,
      old_values: oldValues === null ? null : JSON.stringify(oldValues),
      new_values: newValues === null ? null : JSON.stringify(newValues),
      reason: row.reason,
      status: row.status,
      ip_address: row.ip,
      user_agent: row.userAgent,
      created_at: createdAt,
      chain_key: chainKey,
      prev_hash: row.prevHash || null, // CHAR(64) would pad an empty string; the first row of a chain has none
      hash_version: 2,
      entry_hash: entryHash(row),
    })
    .execute();
}

export interface ChainReport {
  chainKey: number;
  rows: number;
  ok: boolean;
  /** first row whose content or link does not match */
  brokenAt: number | null;
  /** hash of the newest row: keep a copy elsewhere to also detect removed tail rows */
  head: string | null;
}

/** Recomputes the chains of version-2 entries. `chainKeys` limits the check (a company admin sees only the own company). */
export async function verifyAuditChains(
  db: Db,
  chainKeys?: number[],
): Promise<{ chains: ChainReport[]; legacyRows: number }> {
  const keysRows = await db
    .selectFrom('audit_log')
    .select('chain_key')
    .distinct()
    .where('hash_version', '=', 2)
    .$if(!!chainKeys, (q) => q.where('chain_key', 'in', chainKeys!.length ? chainKeys! : [0]))
    .orderBy('chain_key')
    .execute();
  const chains: ChainReport[] = [];
  for (const { chain_key } of keysRows) {
    let afterId = '0';
    let prev = '';
    let rows = 0;
    let broken: number | null = null;
    for (;;) {
      const batch = await db
        .selectFrom('audit_log')
        .selectAll()
        .where('chain_key', '=', chain_key)
        .where('hash_version', '=', 2)
        .where('id', '>', afterId)
        .orderBy('id')
        .limit(2000)
        .execute();
      if (!batch.length) break;
      for (const r of batch) {
        rows++;
        const expected = entryHash({
          chainKey: r.chain_key,
          prevHash: (r.prev_hash ?? '').trim(),
          actorId: r.actor_id,
          actorType: r.actor_type,
          action: r.action,
          entityType: r.entity_type,
          entityId: r.entity_id,
          companyId: r.company_id,
          hotelId: r.hotel_id,
          oldValues: r.old_values,
          newValues: r.new_values,
          reason: r.reason,
          status: r.status,
          ip: r.ip_address,
          userAgent: r.user_agent,
          createdAt: (r.created_at as Date).toISOString(),
        });
        if (broken === null && ((r.prev_hash ?? '').trim() !== prev || r.entry_hash !== expected))
          broken = Number(r.id);
        prev = (r.entry_hash ?? '').trim();
        afterId = String(r.id);
      }
    }
    chains.push({ chainKey: chain_key, rows, ok: broken === null, brokenAt: broken, head: prev || null });
  }
  const legacy = await db
    .selectFrom('audit_log')
    .select(sql<number>`count(*)::int`.as('n'))
    .where('hash_version', '=', 1)
    .executeTakeFirstOrThrow();
  return { chains, legacyRows: legacy.n };
}
