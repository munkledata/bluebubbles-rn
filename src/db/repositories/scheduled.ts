import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { scheduledMessages } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
import { insertOutgoingTextWithinTransaction, type InsertOutgoingTextArgs } from './outgoing';

// ---- Scheduled messages ----------------------------------------------------

export interface ScheduledRow {
  id: number;
  serverId: string | null;
  chatGuid: string;
  text: string;
  selectedMessageGuid?: string;
  scheduledFor: number;
  status: string; // 'pending' | 'sending' | 'sent' | 'error' | 'uncertain'
  /** null/undefined = one-shot; 'daily' | 'weekly' | 'monthly' = re-armed after each send. */
  recurrence?: string | null;
}

interface ScheduledPayload {
  text: string;
  selectedMessageGuid?: string;
}

/** One exact local row that existed before a server scheduled-list request began. */
export interface ServerScheduledPruneExposure {
  id: number;
  serverId: string;
}

interface ReconcileServerScheduledOptions {
  /**
   * Exact rows that the server response is allowed to prune. Production captures this before the
   * HTTP request; direct repository callers default to a snapshot taken at function entry.
   */
  pruneExposure?: readonly ServerScheduledPruneExposure[];
  /** Reject a queued/in-flight account-scoped transaction rather than committing into a new owner. */
  commitGuard?: DbCommitGuard;
}

const SERVER_SCHEDULED_EXPOSURE_BATCH_SIZE = 500;
const SCHED_COLS = sql`id, server_id AS serverId, chat_guid AS chatGuid, payload, scheduled_for AS scheduledFor, status, recurrence`;

/** SQLite uses LIMIT -1 for "all rows"; every explicit caller-provided cap fails closed. */
function sqlRowLimit(limit?: number): number {
  if (limit === undefined) return -1;
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  return Math.floor(limit);
}

function mapScheduled(r: {
  id: number;
  serverId: string | null;
  chatGuid: string;
  payload: string;
  scheduledFor: number;
  status: string;
  recurrence: string | null;
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
    recurrence: r.recurrence,
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
    /** null/undefined = one-shot; 'daily' | 'weekly' | 'monthly' = re-armed after each send. */
    recurrence?: string | null;
  },
): Promise<number> {
  const payload: ScheduledPayload = {
    text: args.text,
    selectedMessageGuid: args.selectedMessageGuid,
  };
  return withDbTransaction(db, async () => {
    const rows = await db
      .insert(scheduledMessages)
      .values({
        chatGuid: args.chatGuid,
        serverId: args.serverId ?? null,
        payload: JSON.stringify(payload),
        scheduledFor: args.scheduledFor,
        status: 'pending',
        recurrence: args.recurrence ?? null,
      })
      .returning({ id: scheduledMessages.id });
    return rows[0]!.id;
  });
}

/**
 * Snapshot the exact server-backed rows a later server response may prune. Keeping both columns is
 * load-bearing: an edit can repoint the same local id to a fresh server uuid while the GET is in
 * flight, and that newer identity must not match the stale response's delete.
 */
export async function listServerScheduledPruneExposure(
  db: AppDatabase,
  commitGuard?: DbCommitGuard,
): Promise<ServerScheduledPruneExposure[]> {
  const exposure: ServerScheduledPruneExposure[] = [];
  let afterId = 0;
  while (true) {
    // A read outside the queue can observe rows another transaction later rolls back. Capture
    // committed rows in bounded pages so a phantom uuid cannot suppress a real server response.
    const batch = await withDbTransaction<ServerScheduledPruneExposure[]>(
      db,
      () =>
        db.all<ServerScheduledPruneExposure>(sql`
          SELECT id, server_id AS serverId
          FROM scheduled_messages
          WHERE server_id IS NOT NULL AND id > ${afterId}
          ORDER BY id ASC
          LIMIT ${SERVER_SCHEDULED_EXPOSURE_BATCH_SIZE}
        `),
      commitGuard,
    );
    if (batch.length === 0) break;
    exposure.push(...batch);
    const last = batch.at(-1);
    if (!last) break;
    afterId = last.id;
    if (batch.length < SERVER_SCHEDULED_EXPOSURE_BATCH_SIZE) break;
  }
  return exposure;
}

/**
 * Reconcile the server's scheduled list into the local DB (F-8). `items` are the WELL-FORMED
 * rows to upsert (by `server_id`); `serverIds` is EVERY id the server reported this fetch —
 * used for pruning, so a malformed-but-present item is kept (not pruned). Only exact rows in the
 * pre-request exposure can be pruned; rows created or repointed while the request was in flight
 * survive. Pruning is SKIPPED when `serverIds` is empty so a transient empty/failed response can't
 * wipe still-pending server-backed rows.
 *
 * Each item and exact-pair prune owns one short transaction. Do not replace the direct writes here
 * with public scheduled helpers: those helpers transact internally and would wedge the DB mutex.
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
  options: ReconcileServerScheduledOptions = {},
): Promise<void> {
  const exposure =
    options.pruneExposure === undefined
      ? await listServerScheduledPruneExposure(db)
      : [...options.pruneExposure];
  const exposedServerIds = new Set(exposure.map((row) => row.serverId));

  for (const it of items) {
    await withDbTransaction(
      db,
      async () => {
        const existing = await db.all<{ id: number; payload: string }>(
          sql`SELECT id, payload FROM scheduled_messages WHERE server_id = ${it.serverId} LIMIT 1`,
        );
        const row = existing[0];
        if (row) {
          // Preserve any local reply target — only text/time/status are server-authoritative.
          let p: ScheduledPayload = { text: it.text };
          try {
            p = { ...(JSON.parse(row.payload) as ScheduledPayload), text: it.text };
          } catch {
            /* corrupt local payload — fall back to text-only */
          }
          await db.run(
            sql`UPDATE scheduled_messages SET chat_guid = ${it.chatGuid}, payload = ${JSON.stringify(p)}, scheduled_for = ${it.scheduledFor}, status = ${it.status} WHERE id = ${row.id} AND server_id = ${it.serverId}`,
          );
          return;
        }

        // This uuid existed before the GET, but its exact local row was removed or repointed while
        // the response was in flight. Re-inserting it would resurrect a stale pre-edit identity.
        if (exposedServerIds.has(it.serverId)) return;
        await db.insert(scheduledMessages).values({
          serverId: it.serverId,
          chatGuid: it.chatGuid,
          payload: JSON.stringify({ text: it.text } satisfies ScheduledPayload),
          scheduledFor: it.scheduledFor,
          status: it.status,
        });
      },
      options.commitGuard,
    );
  }

  if (serverIds.length === 0) return; // never prune on an empty/suspect server view
  const keep = new Set(serverIds);
  for (const row of exposure) {
    if (keep.has(row.serverId)) continue;
    await withDbTransaction(
      db,
      () =>
        db
          .delete(scheduledMessages)
          .where(
            and(eq(scheduledMessages.id, row.id), eq(scheduledMessages.serverId, row.serverId)),
          ),
      options.commitGuard,
    );
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
  patch: {
    text?: string;
    scheduledFor?: number;
    serverId?: string | null;
    /** Pass null to clear back to one-shot; undefined leaves it untouched. */
    recurrence?: string | null;
  },
): Promise<void> {
  await withDbTransaction(db, async () => {
    const set: {
      payload?: string;
      scheduledFor?: number;
      serverId?: string | null;
      recurrence?: string | null;
    } = {};
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
    if (patch.recurrence !== undefined) set.recurrence = patch.recurrence;
    if (Object.keys(set).length === 0) return;
    await db
      .update(scheduledMessages)
      .set(set)
      .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending')));
  });
}

/** Fetch a single scheduled row by id (any status), for the edit screen. */
export async function getScheduledById(db: AppDatabase, id: number): Promise<ScheduledRow | null> {
  const rows = await db.all<Parameters<typeof mapScheduled>[0]>(
    sql`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE id = ${id} LIMIT 1`,
  );
  return rows[0] ? mapScheduled(rows[0]) : null;
}

/**
 * Completed history: sent, errored, and legacy-uncertain rows, newest-first. Previously these
 * vanished from the UI the moment they left 'pending' — a permanently-failing send
 * (status='error') disappeared silently, so the user never learned it didn't go out. The list
 * screen shows these under COMPLETED without claiming an ambiguous legacy handoff failed.
 */
export async function listScheduledHistory(db: AppDatabase, limit = 50): Promise<ScheduledRow[]> {
  const rows = await db.all<Parameters<typeof mapScheduled>[0]>(
    sql`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE status IN ('sent', 'error', 'uncertain')
        ORDER BY scheduled_for DESC LIMIT ${limit}`,
  );
  return rows.map(mapScheduled);
}

/** Delete one COMPLETED row while joining an authenticated transaction owner. */
export function deleteScheduledHistoryWithinTransaction(
  context: DbTransactionContext,
  id: number,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    await db
      .delete(scheduledMessages)
      .where(
        and(
          eq(scheduledMessages.id, id),
          inArray(scheduledMessages.status, ['sent', 'error', 'uncertain']),
        ),
      );
  });
}

/** Delete a COMPLETED (sent/error/uncertain) row from the local history list. */
export async function deleteScheduledHistory(db: AppDatabase, id: number): Promise<void> {
  await withDbTransaction(db, (context) => deleteScheduledHistoryWithinTransaction(context, id));
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

/** Due = pending AND scheduledFor <= now. `limit` bounds headless/background recovery runs. */
export async function listDueScheduled(
  db: AppDatabase,
  now: number,
  limit?: number,
  localOnly = false,
): Promise<ScheduledRow[]> {
  const serverScope = localOnly ? sql`AND server_id IS NULL` : sql``;
  const rows = await db.all<Parameters<typeof mapScheduled>[0]>(
    sql`SELECT ${SCHED_COLS} FROM scheduled_messages WHERE status = 'pending' AND scheduled_for <= ${now} ${serverScope} ORDER BY scheduled_for ASC LIMIT ${sqlRowLimit(limit)}`,
  );
  return rows.map(mapScheduled);
}

/** Max send attempts before a scheduled row is retired to status='error'. */
export const SCHED_MAX_ATTEMPTS = 5;

/** The durable scheduled-row state committed alongside its outgoing queue handoff. */
export type ScheduledTextHandoverTransition =
  { kind: 'sent' } | { kind: 'rearm'; nextScheduledFor: number };

export interface ScheduledTextHandoverArgs {
  scheduledId: number;
  outgoing: InsertOutgoingTextArgs;
  transition: ScheduledTextHandoverTransition;
}

/** The scheduled row no longer belongs to the runner attempting the outgoing handoff. */
export class ScheduledOutgoingClaimLostError extends Error {
  readonly scheduledId: number;

  constructor(scheduledId: number) {
    super(`scheduled outgoing claim lost for row ${scheduledId}`);
    this.name = 'ScheduledOutgoingClaimLostError';
    this.scheduledId = scheduledId;
  }
}

/**
 * Atomically claim a pending row for sending (pending → sending). The
 * `status = 'pending'` guard makes this the concurrency lock: a second caller
 * (overlapping tick, or the home + chat tickers racing) finds the row already
 * 'sending' and gets back `false`, so the same message is never sent twice.
 * Retained for compatibility and explicit repository state transitions; the production due ticker
 * must use `claimDueScheduled`, which also re-checks time and local ownership.
 */
export async function claimScheduled(
  db: AppDatabase,
  id: number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    async () => {
      const rows = await db
        .update(scheduledMessages)
        .set({ status: 'sending' })
        .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'pending')))
        .returning({ id: scheduledMessages.id });
      return rows.length > 0;
    },
    commitGuard,
  );
}

/**
 * Claim one row only when it is still a due, local pending message, and return the exact row that
 * won the claim. The due-list is only a bounded candidate snapshot: an edit may move a row into the
 * future, change its payload, or hand it to the server before this transaction reaches SQLite.
 * Reading through UPDATE ... RETURNING makes this claim the final authority for both eligibility
 * and the payload the sender is allowed to use.
 */
export async function claimDueScheduled(
  db: AppDatabase,
  id: number,
  now: number,
  commitGuard?: DbCommitGuard,
): Promise<ScheduledRow | null> {
  return withDbTransaction(
    db,
    async () => {
      const rows = await db.all<Parameters<typeof mapScheduled>[0]>(sql`
        UPDATE scheduled_messages
           SET status = 'sending'
         WHERE id = ${id}
           AND status = 'pending'
           AND server_id IS NULL
           AND scheduled_for <= ${now}
        RETURNING ${SCHED_COLS}`);
      return rows[0] ? mapScheduled(rows[0]) : null;
    },
    commitGuard,
  );
}

/**
 * Finish a claimed local row. Returns false when the row is no longer `sending` or became
 * server-owned, so a stale runner cannot overwrite its newer state.
 */
export async function markScheduledSent(
  db: AppDatabase,
  id: number,
  serverId: string | null = null,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    async () => {
      const rows = await db
        .update(scheduledMessages)
        .set({ status: 'sent', serverId })
        .where(
          and(
            eq(scheduledMessages.id, id),
            eq(scheduledMessages.status, 'sending'),
            isNull(scheduledMessages.serverId),
          ),
        )
        .returning({ id: scheduledMessages.id });
      return rows.length > 0;
    },
    commitGuard,
  );
}

/**
 * Re-arm a RECURRING row after a successful send: back to 'pending' at its next
 * occurrence with the attempt counter cleared, in ONE UPDATE. The `status = 'sending'`
 * guard mirrors `claimScheduled` — only the runner that holds the claim can re-arm, so
 * the claim contract (exactly one owner between claim and terminal write) is preserved.
 */
export async function rearmScheduled(
  db: AppDatabase,
  id: number,
  nextScheduledFor: number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    async () => {
      const rows = await db
        .update(scheduledMessages)
        .set({ status: 'pending', scheduledFor: nextScheduledFor, attempts: 0 })
        .where(and(eq(scheduledMessages.id, id), eq(scheduledMessages.status, 'sending')))
        .returning({ id: scheduledMessages.id });
      return rows.length > 0;
    },
    commitGuard,
  );
}

/**
 * Atomically transfer one claimed LOCAL scheduled text into the durable outgoing queue.
 *
 * The scheduled transition and optimistic message/queue insert are one commit: after a crash the
 * database contains either the original `sending` claim with no outgoing work, or the terminal/
 * re-armed schedule plus its outgoing work. The compare-and-set deliberately requires both
 * `status='sending'` and `server_id IS NULL`; server-backed schedules belong to the server and must
 * never enter the local delivery queue.
 */
export async function handoverScheduledTextToOutgoing(
  db: AppDatabase,
  args: ScheduledTextHandoverArgs,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    async (context) => {
      const claimed =
        args.transition.kind === 'rearm'
          ? await db
              .update(scheduledMessages)
              .set({
                status: 'pending',
                scheduledFor: args.transition.nextScheduledFor,
                attempts: 0,
              })
              .where(
                and(
                  eq(scheduledMessages.id, args.scheduledId),
                  eq(scheduledMessages.status, 'sending'),
                  isNull(scheduledMessages.serverId),
                ),
              )
              .returning({ id: scheduledMessages.id })
          : await db
              .update(scheduledMessages)
              .set({ status: 'sent' })
              .where(
                and(
                  eq(scheduledMessages.id, args.scheduledId),
                  eq(scheduledMessages.status, 'sending'),
                  isNull(scheduledMessages.serverId),
                ),
              )
              .returning({ id: scheduledMessages.id });

      if (claimed.length === 0) {
        throw new ScheduledOutgoingClaimLostError(args.scheduledId);
      }

      await insertOutgoingTextWithinTransaction(context, args.outgoing);
    },
    commitGuard,
  );
}

/**
 * Record a failed send: bump attempts and either release the row back to
 * 'pending' for a later retry or retire it to 'error' once the attempt cap is
 * hit (so a permanently-failing row — e.g. its chat was deleted — stops
 * retrying every tick). Only a claimed local `sending` row is eligible; `stale` means this runner
 * no longer owns the row and nothing was written.
 */
export async function markScheduledFailed(
  db: AppDatabase,
  id: number,
  commitGuard?: DbCommitGuard,
): Promise<'pending' | 'error' | 'stale'> {
  return withDbTransaction(
    db,
    async () => {
      const rows = await db.all<{ status: 'pending' | 'error' }>(sql`
        UPDATE scheduled_messages
           SET attempts = attempts + 1,
               status = CASE
                 WHEN attempts + 1 >= ${SCHED_MAX_ATTEMPTS} THEN 'error'
                 ELSE 'pending'
               END
         WHERE id = ${id}
           AND status = 'sending'
           AND server_id IS NULL
        RETURNING status`);
      return rows[0]?.status ?? 'stale';
    },
    commitGuard,
  );
}

/**
 * Recover LOCAL rows interrupted mid-send (left 'sending' by a crash/kill) back to `pending`.
 * Server-backed rows remain server-owned. Run once at app launch before the first fire. Returns
 * the count.
 */
export async function resetStuckScheduled(
  db: AppDatabase,
  limit?: number,
  commitGuard?: DbCommitGuard,
): Promise<number> {
  return withDbTransaction(
    db,
    async () => {
      const rows = await db.all<{ id: number }>(sql`
        UPDATE scheduled_messages SET status = 'pending'
        WHERE id IN (
          SELECT id FROM scheduled_messages
          WHERE status = 'sending' AND server_id IS NULL
          ORDER BY id ASC
          LIMIT ${sqlRowLimit(limit)}
        )
        AND status = 'sending'
        AND server_id IS NULL
        RETURNING id`);
      return rows.length;
    },
    commitGuard,
  );
}

export async function deleteScheduled(db: AppDatabase, id: number): Promise<void> {
  await withDbTransaction(db, () =>
    db.delete(scheduledMessages).where(eq(scheduledMessages.id, id)),
  );
}
