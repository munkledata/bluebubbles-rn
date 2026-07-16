import { and, eq, inArray, sql } from 'drizzle-orm';
import { scheduledMessages } from '../schema';
import type { AppDatabase } from '../types';

// ---- Scheduled messages ----------------------------------------------------

export interface ScheduledRow {
  id: number;
  serverId: string | null;
  chatGuid: string;
  text: string;
  selectedMessageGuid?: string;
  scheduledFor: number;
  status: string; // 'pending' | 'sending' | 'sent' | 'error'
}

interface ScheduledPayload {
  text: string;
  selectedMessageGuid?: string;
}

const SCHED_COLS = sql`id, server_id AS serverId, chat_guid AS chatGuid, payload, scheduled_for AS scheduledFor, status`;

function mapScheduled(r: {
  id: number;
  serverId: string | null;
  chatGuid: string;
  payload: string;
  scheduledFor: number;
  status: string;
}): ScheduledRow {
  const p: ScheduledPayload = JSON.parse(r.payload);
  return {
    id: r.id,
    serverId: r.serverId,
    chatGuid: r.chatGuid,
    text: p.text,
    selectedMessageGuid: p.selectedMessageGuid,
    scheduledFor: r.scheduledFor,
    status: r.status,
  };
}

export async function insertScheduled(
  db: AppDatabase,
  args: {
    chatGuid: string;
    text: string;
    scheduledFor: number;
    selectedMessageGuid?: string;
    /** Set when the server is also tracking this row (server fires it; the local ticker skips it). */
    serverId?: string | null;
  },
): Promise<number> {
  const payload: ScheduledPayload = {
    text: args.text,
    selectedMessageGuid: args.selectedMessageGuid,
  };
  const rows = await db
    .insert(scheduledMessages)
    .values({
      chatGuid: args.chatGuid,
      serverId: args.serverId ?? null,
      payload: JSON.stringify(payload),
      scheduledFor: args.scheduledFor,
      status: 'pending',
    })
    .returning({ id: scheduledMessages.id });
  return rows[0]!.id;
}

/**
 * Reconcile the server's scheduled list into the local DB (F-8). `items` are the WELL-FORMED
 * rows to upsert (by `server_id`); `serverIds` is EVERY id the server reported this fetch —
 * used for pruning, so a malformed-but-present item is kept (not pruned). Local server-backed
 * rows the server no longer reports are pruned; local-only rows (server_id IS NULL) are never
 * touched. Pruning is SKIPPED when `serverIds` is empty so a transient empty/failed response
 * can't wipe still-pending server-backed rows.
 */
export async function reconcileServerScheduled(
  db: AppDatabase,
  items: {
    serverId: string;
    chatGuid: string;
    text: string;
    scheduledFor: number;
    status: string;
  }[],
  serverIds: string[],
): Promise<void> {
  for (const it of items) {
    const existing = await db.all<{ id: number; payload: string }>(
      sql`SELECT id, payload FROM scheduled_messages WHERE server_id = ${it.serverId} LIMIT 1`,
    );
    if (existing[0]) {
      // Preserve any local reply target — only text/time/status are server-authoritative.
      let p: ScheduledPayload = { text: it.text };
      try {
        p = { ...(JSON.parse(existing[0].payload) as ScheduledPayload), text: it.text };
      } catch {
        /* corrupt local payload — fall back to text-only */
      }
      await db.run(
        sql`UPDATE scheduled_messages SET chat_guid = ${it.chatGuid}, payload = ${JSON.stringify(p)}, scheduled_for = ${it.scheduledFor}, status = ${it.status} WHERE server_id = ${it.serverId}`,
      );
    } else {
      await db.insert(scheduledMessages).values({
        serverId: it.serverId,
        chatGuid: it.chatGuid,
        payload: JSON.stringify({ text: it.text } satisfies ScheduledPayload),
        scheduledFor: it.scheduledFor,
        status: it.status,
      });
    }
  }
  if (serverIds.length === 0) return; // never prune on an empty/suspect server view
  const keep = new Set(serverIds);
  const localServer = await db.all<{ id: number; serverId: string }>(
    sql`SELECT id, server_id AS serverId FROM scheduled_messages WHERE server_id IS NOT NULL`,
  );
  const stale: number[] = [];
  for (const r of localServer) {
    if (!keep.has(r.serverId)) stale.push(r.id);
  }
  if (stale.length > 0) {
    await db.delete(scheduledMessages).where(inArray(scheduledMessages.id, stale));
  }
}

/**
 * Edit a still-pending scheduled message's text and/or fire time (and, when a server-backed
 * row is re-created against Gator's no-PUT API, its new `serverId`). The `status='pending'`
 * guard is the correctness lock — a row already claimed/sent can't be edited (mirrors
 * `claimScheduled`). The reply target (selectedMessageGuid) is preserved through the JSON.
 */
export async function updateScheduled(
  db: AppDatabase,
  id: number,
  patch: { text?: string; scheduledFor?: number; serverId?: string | null },
): Promise<void> {
  const set: { payload?: string; scheduledFor?: number; serverId?: string | null } = {};
  if (patch.text !== undefined) {
    const cur = await db.all<{ payload: string }>(
      sql`SELECT payload FROM scheduled_messages WHERE id = ${id} LIMIT 1`,
    );
    const p: ScheduledPayload = JSON.parse(cur[0]?.payload ?? '{}');
    p.text = patch.text;
    set.payload = JSON.stringify(p);
  }
  if (patch.scheduledFor !== undefined) set.scheduledFor = patch.scheduledFor;
  if (patch.serverId !== undefined) set.serverId = patch.serverId;
  if (Object.keys(set).length === 0) return;
  await db
    .update(scheduledMessages)
    .set(set)
    .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending')));
}

/** Fetch a single scheduled row by id (any status), for the edit screen. */
export async function getScheduledById(db: AppDatabase, id: number): Promise<ScheduledRow | null> {
  const rows = await db.all<Parameters<typeof mapScheduled>[0]>(
    sql`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE id = ${id} LIMIT 1`,
  );
  return rows[0] ? mapScheduled(rows[0]) : null;
}

/**
 * Completed history: sent + errored rows, newest-first. Previously these vanished from the UI the
 * moment they left 'pending' — a permanently-failing send (status='error') disappeared silently,
 * so the user never learned it didn't go out. The list screen shows these under COMPLETED.
 */
export async function listScheduledHistory(db: AppDatabase, limit = 50): Promise<ScheduledRow[]> {
  const rows = await db.all<Parameters<typeof mapScheduled>[0]>(
    sql`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE status IN ('sent', 'error')
        ORDER BY scheduled_for DESC LIMIT ${limit}`,
  );
  return rows.map(mapScheduled);
}

/** Delete a COMPLETED (sent/error) row from the local history list. */
export async function deleteScheduledHistory(db: AppDatabase, id: number): Promise<void> {
  await db
    .delete(scheduledMessages)
    .where(and(eq(scheduledMessages.id, id), inArray(scheduledMessages.status, ['sent', 'error'])));
}

export async function listAllScheduled(db: AppDatabase): Promise<ScheduledRow[]> {
  const rows = await db.all<Parameters<typeof mapScheduled>[0]>(
    sql`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE status = 'pending' ORDER BY scheduled_for ASC`,
  );
  return rows.map(mapScheduled);
}

export async function listScheduledByChat(
  db: AppDatabase,
  chatGuid: string,
): Promise<ScheduledRow[]> {
  const rows = await db.all<Parameters<typeof mapScheduled>[0]>(
    sql`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE status = 'pending' AND chat_guid = ${chatGuid} ORDER BY scheduled_for ASC`,
  );
  return rows.map(mapScheduled);
}

/** Due = pending AND scheduledFor <= now. */
export async function listDueScheduled(db: AppDatabase, now: number): Promise<ScheduledRow[]> {
  const rows = await db.all<Parameters<typeof mapScheduled>[0]>(
    sql`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE status = 'pending' AND scheduled_for <= ${now} ORDER BY scheduled_for ASC`,
  );
  return rows.map(mapScheduled);
}

/** Max send attempts before a scheduled row is retired to status='error'. */
export const SCHED_MAX_ATTEMPTS = 5;

/**
 * Atomically claim a pending row for sending (pending → sending). The
 * `status = 'pending'` guard makes this the concurrency lock: a second caller
 * (overlapping tick, or the home + chat tickers racing) finds the row already
 * 'sending' and gets back `false`, so the same message is never sent twice.
 */
export async function claimScheduled(db: AppDatabase, id: number): Promise<boolean> {
  const rows = await db
    .update(scheduledMessages)
    .set({ status: 'sending' })
    .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending')))
    .returning({ id: scheduledMessages.id });
  return rows.length > 0;
}

export async function markScheduledSent(
  db: AppDatabase,
  id: number,
  serverId: string | null = null,
): Promise<void> {
  await db
    .update(scheduledMessages)
    .set({ status: 'sent', serverId })
    .where(eq(scheduledMessages.id, id));
}

/**
 * Record a failed send: bump attempts and either release the row back to
 * 'pending' for a later retry or retire it to 'error' once the attempt cap is
 * hit (so a permanently-failing row — e.g. its chat was deleted — stops
 * retrying every tick). Returns the new status.
 */
export async function markScheduledFailed(
  db: AppDatabase,
  id: number,
): Promise<'pending' | 'error'> {
  const rows = await db.all<{ attempts: number }>(
    sql`SELECT attempts FROM scheduled_messages WHERE id = ${id} LIMIT 1`,
  );
  const attempts = (rows[0]?.attempts ?? 0) + 1;
  const status = attempts >= SCHED_MAX_ATTEMPTS ? 'error' : 'pending';
  await db.update(scheduledMessages).set({ attempts, status }).where(eq(scheduledMessages.id, id));
  return status;
}

/**
 * Recover rows interrupted mid-send (left 'sending' by a crash/kill) back to
 * 'pending'. Run once at app launch before the first fire. Returns the count.
 */
export async function resetStuckScheduled(db: AppDatabase): Promise<number> {
  const rows = await db
    .update(scheduledMessages)
    .set({ status: 'pending' })
    .where(eq(scheduledMessages.status, 'sending'))
    .returning({ id: scheduledMessages.id });
  return rows.length;
}

export async function deleteScheduled(db: AppDatabase, id: number): Promise<void> {
  await db.delete(scheduledMessages).where(eq(scheduledMessages.id, id));
}
