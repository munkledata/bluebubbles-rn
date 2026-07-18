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

type Sender = (chatGuid: string, text: string, selectedMessageGuid?: string) => Promise<void>;

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
 */
export async function runDueScheduled(
  db: AppDatabase,
  http: HttpClient,
  now: number,
  sender: Sender = (chatGuid, text, selectedMessageGuid) =>
    sendTextMessage(db, http, { chatGuid, text, selectedMessageGuid }).then(() => undefined),
): Promise<number> {
  const due = await listDueScheduled(db, now);
  let fired = 0;
  for (const m of due) {
    // Server-backed rows are fired by the SERVER — never locally (the double-send guard).
    if (m.serverId != null) continue;
    // Claim atomically; if another runner already took it, skip (no double-send).
    if (!(await claimScheduled(db, m.id))) continue;
    try {
      await sender(m.chatGuid, m.text, m.selectedMessageGuid);
      const recurrence = asRecurrence(m.recurrence);
      if (recurrence) {
        // Catch-up semantics: nextOccurrence skips every stale slot, so a device that
        // was off for a week fires ONE daily send now and re-arms for tomorrow.
        await rearmScheduled(db, m.id, nextOccurrence(m.scheduledFor, recurrence, now));
      } else {
        await markScheduledSent(db, m.id, null);
      }
      fired += 1;
    } catch (e) {
      const status = await markScheduledFailed(db, m.id);
      logger.debug(`[sched] send failed (${m.id}) → ${status}`, e);
    }
  }
  return fired;
}
