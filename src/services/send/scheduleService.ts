import type { HttpClient } from '@core/api/http';
// Import the endpoint module directly (not the @core/api barrel) so this stays
// node-importable in tests without pulling in ky (ESM).
import * as scheduledApi from '@core/api/endpoints/scheduled';
import { asRecurrence, nextOccurrence, type Recurrence } from '@core/schedule';
import { logger } from '@core/secure';
import {
  claimScheduled,
  insertScheduled,
  listDueScheduled,
  markScheduledFailed,
  markScheduledSent,
  rearmScheduled,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { sendTextMessage } from './sendService';

export interface ScheduleArgs {
  chatGuid: string;
  text: string;
  scheduledFor: number;
  selectedMessageGuid?: string;
  /** null/undefined = one-shot; a recurring message is LOCAL-ONLY (the server can't repeat). */
  recurrence?: Recurrence | null;
}

/**
 * Schedule a message. Prefers SERVER-side scheduling (Gator fires it on time even if the
 * phone is asleep), recording the returned uuid so the on-device worker SKIPS it (no
 * double-send). Falls back to a local-only row when the server can't schedule it: an older
 * server, an offline create, a reply-target message (Gator's flat body can't carry one), or
 * a RECURRING message (the server fires once and forgets — only the local ticker re-arms).
 */
export async function scheduleTextMessage(
  db: AppDatabase,
  http: HttpClient,
  args: ScheduleArgs,
): Promise<{ id: number; serverId: string | null }> {
  let serverId: string | null = null;
  if (!args.selectedMessageGuid && !args.recurrence) {
    try {
      const created = await scheduledApi.createScheduled(http, {
        chatGuid: args.chatGuid,
        message: args.text,
        scheduledFor: args.scheduledFor,
      });
      serverId = created?.id ?? null;
    } catch (e) {
      logger.debug('[sched] server-side schedule failed; using on-device fallback', e);
    }
  }
  const id = await insertScheduled(db, { ...args, serverId });
  return { id, serverId };
}

/**
 * How a due row is actually sent. `onQueued` is the handover signal: the sender awaits it the
 * instant delivery is durably owned by something else (for the real path, the outgoing queue).
 * A sender that never calls it — the dev fixtures, which have no queue behind them — is settled
 * on resolve instead, exactly as before.
 */
type Sender = (
  chatGuid: string,
  text: string,
  selectedMessageGuid: string | undefined,
  onQueued: () => Promise<void>,
) => Promise<void>;

/**
 * Fire every due scheduled message: atomically CLAIM the row (pending → sending)
 * so a concurrent tick / the home+chat tickers can't double-send it, send via the
 * normal optimistic path (preserving any reply target), then mark it sent. A send
 * that throws bumps the attempt counter and either releases the row back to
 * 'pending' for a later retry or retires it to 'error' past the cap (recurring
 * rows included — a permanently-failing recurring row still retires). A RECURRING
 * row that sends successfully is NOT marked sent: it is re-armed to its next
 * occurrence (pending, attempts reset) in one UPDATE. `sender` is injected so dev
 * can pass devSendFake (no server). Node-testable. Returns the number actually
 * sent this run.
 *
 * WHEN the row goes terminal is the delicate part. It used to be after the whole network round
 * trip, but the outgoing queue owns delivery from the moment its row commits — seconds earlier.
 * Killed in between, the app relaunched with BOTH a live queue row and a scheduled row still
 * marked 'sending', and boot ran `resetStuckScheduled` (which arms it again, unconditionally) and
 * the queue drain and the ticker in that order: two copies, three if the original POST had also
 * landed. So the terminal write now happens at the handover, before the POST is awaited — and it is
 * MANDATORY: a row handed over but left at 'sending' by a failed terminal write is re-armed by that
 * same boot path, so the write is RE-APPLIED unconditionally once the send settles (see below —
 * a write that was erased rather than thrown reports nothing at all, so it cannot be conditional).
 */
export async function runDueScheduled(
  db: AppDatabase,
  http: HttpClient,
  now: number,
  sender: Sender = (chatGuid, text, selectedMessageGuid, onQueued) =>
    sendTextMessage(db, http, { chatGuid, text, selectedMessageGuid }, Date.now(), onQueued).then(
      () => undefined,
    ),
): Promise<number> {
  const due = await listDueScheduled(db, now);
  let fired = 0;
  for (const m of due) {
    // Server-backed rows are fired by the SERVER — never locally (the double-send guard).
    if (m.serverId != null) continue;
    // Claim atomically; if another runner already took it, skip (no double-send).
    if (!(await claimScheduled(db, m.id))) continue;
    // `settled` = the outgoing queue owns delivery from here on (flipped BEFORE the terminal write,
    // because that is the instant ownership changes hands). `terminalWritten` = the row actually
    // reached its terminal state on disk. They are separate because the write can fail on its own,
    // and the two mean very different things to the catch below.
    let settled = false;
    let terminalWritten = false;
    /**
     * Stamp the row terminal. Returns whether THIS attempt matched a row: `rearmScheduled` is a
     * compare-and-set on `status='sending'`, so it legitimately reports false when a previous
     * attempt already re-armed it. `terminalWritten` therefore accumulates — it means "at least one
     * attempt landed", which is the only thing the diagnostic below can honestly claim.
     *
     * Its own transaction. As a bare autocommit on the single shared connection this write JOINS
     * whatever transaction a neighbouring writer happens to have open (a live-message sink, a sync
     * slice, a queue claim — all realistic at boot, which is exactly when the ticker runs) and is
     * erased with its rollback. Serializing BEHIND that transaction instead makes it atomic on its
     * own. Safe against the no-nesting rule: `settle` is invoked from `sendTextMessage` only after
     * `insertOutgoingText`'s transaction has committed, and again after `sender()` resolves.
     */
    const writeTerminal = async (): Promise<boolean> => {
      const recurrence = asRecurrence(m.recurrence);
      const matched = await withDbTransaction(db, async () => {
        if (recurrence) {
          // Catch-up semantics: nextOccurrence skips every stale slot, so a device that
          // was off for a week fires ONE daily send now and re-arms for tomorrow.
          return rearmScheduled(db, m.id, nextOccurrence(m.scheduledFor, recurrence, now));
        }
        await markScheduledSent(db, m.id, null);
        return true;
      });
      terminalWritten = terminalWritten || matched;
      return matched;
    };
    const settle = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      // Counted at the HANDOVER, not after the write: the message is durably queued at this point,
      // so it fired even if stamping the row fails and has to be re-attempted below.
      fired += 1;
      await writeTerminal();
    };
    try {
      await sender(m.chatGuid, m.text, m.selectedMessageGuid, settle);
      await settle(); // no-op when the sender already handed over
    } catch (e) {
      // A throw BEFORE the handover is an ordinary send failure: release/retire the row.
      if (!settled) {
        const status = await markScheduledFailed(db, m.id);
        logger.debug(`[sched] send failed (${m.id}) → ${status}`, e);
        continue;
      }
      // A throw AFTER the handover is a delivery problem the queue now owns — re-arming the
      // scheduled row on top of it (markScheduledFailed releases it to 'pending') would send the
      // message a second time.
      logger.debug(`[sched] send threw after handover (${m.id}); queue owns delivery`, e);
    }
    // THE TERMINAL WRITE IS VERIFIED, NOT TRUSTED — re-applied unconditionally once the send has
    // settled, never only when the first attempt THREW. A row left at 'sending' is re-armed to
    // 'pending' by the NEXT LAUNCH's unconditional resetStuckScheduled and fires again alongside
    // the queue row this run already committed: the exact double-send the early handover exists to
    // prevent. The gap this closes is the one the old `if (!terminalWritten)` guard structurally
    // could not see — a write that RESOLVED and was then erased as a bystander in someone else's
    // rolled-back transaction reports no error and sets no flag, so nothing distinguishes it from
    // success. Both writers are compare-and-set safe and idempotent, so a redundant re-apply costs
    // one short transaction and repairs the erased case in the same statement.
    if (settled) {
      try {
        await writeTerminal();
      } catch (e2) {
        logger.warn(`[sched] terminal write failed twice (${m.id}); row left 'sending'`, e2);
      }
      // Neither attempt matched: a recurring row whose `status='sending'` guard missed (someone
      // else moved it) is left 'pending' at a PAST scheduledFor and re-fires on every tick.
      if (!terminalWritten) {
        logger.warn(`[sched] scheduled row ${m.id} was never stamped terminal`);
      }
    }
  }
  return fired;
}
