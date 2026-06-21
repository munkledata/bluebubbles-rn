import type { HttpClient } from '@core/api/http';
// Import the endpoint module directly (not the @core/api barrel) so this stays
// node-importable in tests without pulling in ky (ESM).
import * as scheduledApi from '@core/api/endpoints/scheduled';
import type { ScheduleSpec } from '@core/api/endpoints/scheduled';
import { logger } from '@core/secure';
import {
  claimScheduled,
  insertScheduled,
  listDueScheduled,
  markScheduledFailed,
  markScheduledSent,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sendTextMessage } from './sendService';

export interface ScheduleArgs {
  chatGuid: string;
  text: string;
  scheduledFor: number;
  selectedMessageGuid?: string;
  /** Recurrence (defaults to once). */
  schedule?: ScheduleSpec;
  /** Send method to record server-side ('private-api' | 'apple-script'). */
  method?: string;
}

/**
 * Schedule a message. Prefers SERVER-side scheduling (the server fires it on time even if
 * the phone is asleep), recording the returned id so the on-device worker SKIPS it (no
 * double-send). Falls back to a local-only row when the server can't schedule it: an older
 * server, an offline create, or a reply-target message (the server payload can't carry one).
 */
export async function scheduleTextMessage(
  db: AppDatabase,
  http: HttpClient,
  args: ScheduleArgs,
): Promise<{ id: number; serverId: number | null }> {
  let serverId: number | null = null;
  if (!args.selectedMessageGuid) {
    try {
      const created = await scheduledApi.createScheduled(http, {
        chatGuid: args.chatGuid,
        message: args.text,
        scheduledFor: args.scheduledFor,
        schedule: args.schedule,
        method: args.method,
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
 * 'pending' for a later retry or retires it to 'error' past the cap. `sender` is
 * injected so dev can pass devSendFake (no server). Node-testable. Returns the
 * number actually sent this run.
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
      await markScheduledSent(db, m.id, null);
      fired += 1;
    } catch (e) {
      const status = await markScheduledFailed(db, m.id);
      logger.debug(`[sched] send failed (${m.id}) → ${status}`, e);
    }
  }
  return fired;
}
