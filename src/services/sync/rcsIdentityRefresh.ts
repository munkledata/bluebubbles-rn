import type { ServerInfo } from '@core/models';
import { currentRcsProviderEpoch, isCurrentRcsChatGuid } from '@core/rcs';
import {
  kvDeleteWithinTransaction,
  kvGet,
  kvSetWithinTransaction,
  RCS_IDENTITY_APPLIED_KEY,
  RCS_IDENTITY_PROGRESS_KEY,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { ReadDb } from '@db/types';

/**
 * The one-time RCS history refresh for a server that names RCS people by number.
 *
 * Before `rcs_identity_version` 2 the server named RCS people by their Google display name, which no
 * phone contact can match. After the switch, re-reading a conversation's history re-points its
 * stored messages to the number handles (the message upsert keeps `handle_id` current). This module
 * keeps the bookkeeping for that one pass across syncs:
 * - which conversations are already re-read for the version (so a later sync re-reads only the
 *   rest, and one conversation that keeps failing costs one read per sync, not a full pass);
 * - when the pass is complete: every stored conversation of the current Google pairing that holds
 *   messages has been re-read, or is gone from the server. The server's RCS cache prunes messages
 *   about 90 days after it stored them and then drops the emptied conversations, so a quiet
 *   conversation comes back with no messages or is no longer listed. "Gone" needs a complete
 *   listing that names other current RCS conversations, because a listing taken while the Mac's
 *   RCS bridge is still starting names none, and that must never finish the pass;
 * - forgetting all of it when the server names people by Google name again (a rollback), so the next
 *   switch to numbers refreshes again.
 * Reactions are not covered: the server only sends them live, so stored ones keep their old sender.
 */

/** The first server RCS identity version that names people by number instead of Google name. */
export const RCS_NUMBER_IDENTITY_VERSION = 2;

/** The pass this phone still owes the server's RCS identity version. */
export interface RcsIdentityRefresh {
  readonly version: number;
  /** Conversations already re-read for {@link version}, including those finished in this run. */
  readonly done: Set<string>;
  /** Conversations added to {@link done} since the progress record was last written. */
  unsaved: number;
}

/** What this sync's chat listing showed. */
export interface RcsIdentityListing {
  /** The whole listing came back (it did not fail part-way). */
  readonly complete: boolean;
  /** The RCS conversations it named. */
  readonly rcsChats: ReadonlySet<string>;
}

/** Progress is written every this many newly re-read conversations, and at the end of a run. */
const PROGRESS_SAVE_EVERY = 10;

/**
 * The refresh this sync still owes, or null when nothing is due. On a server that names RCS people
 * by Google name it also deletes any applied version or unfinished progress. A version too large to
 * compare exactly is ignored rather than refreshed on every sync.
 */
export async function beginRcsIdentityRefresh(
  db: ReadDb,
  serverInfo: ServerInfo,
  shouldContinue: () => boolean,
): Promise<RcsIdentityRefresh | null> {
  const version = serverInfo.rcs_identity_version;
  if (version == null || (Number.isSafeInteger(version) && version < RCS_NUMBER_IDENTITY_VERSION)) {
    const applied = await kvGet(db, RCS_IDENTITY_APPLIED_KEY);
    const progress = await kvGet(db, RCS_IDENTITY_PROGRESS_KEY);
    if (applied != null || progress != null)
      await withDbTransaction(
        db,
        (db, context) =>
          kvDeleteWithinTransaction(context, [RCS_IDENTITY_APPLIED_KEY, RCS_IDENTITY_PROGRESS_KEY]),
        shouldContinue,
      );
    return null;
  }
  if (!Number.isSafeInteger(version)) return null;
  // Without a current Google pairing the RCS pages are refused, so a pass could move nothing.
  if (currentRcsProviderEpoch(serverInfo) == null) return null;
  const applied = Number(await kvGet(db, RCS_IDENTITY_APPLIED_KEY));
  if (Number.isSafeInteger(applied) && applied >= version) return null;
  return {
    version,
    done: readProgress(await kvGet(db, RCS_IDENTITY_PROGRESS_KEY), version),
    unsaved: 0,
  };
}

function readProgress(raw: string | null, version: number): Set<string> {
  if (raw == null) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return new Set();
    const record = parsed as { version?: unknown; done?: unknown };
    if (record.version !== version || !Array.isArray(record.done)) return new Set();
    return new Set(record.done.filter((guid): guid is string => typeof guid === 'string'));
  } catch {
    // A malformed record simply starts the pass again.
    return new Set();
  }
}

/**
 * Record one more conversation as re-read for the refresh's version. The record is written in
 * batches; a run that stops between them simply re-reads those few conversations next time.
 */
export async function noteRcsIdentityChatDone(
  db: ReadDb,
  refresh: RcsIdentityRefresh,
  chatGuid: string,
  shouldContinue: () => boolean,
): Promise<void> {
  if (refresh.done.has(chatGuid)) return;
  refresh.done.add(chatGuid);
  refresh.unsaved += 1;
  if (refresh.unsaved >= PROGRESS_SAVE_EVERY)
    await saveRcsIdentityProgress(db, refresh, shouldContinue);
}

/** Write the conversations re-read so far, when any are not written yet. */
export async function saveRcsIdentityProgress(
  db: ReadDb,
  refresh: RcsIdentityRefresh,
  shouldContinue: () => boolean,
): Promise<void> {
  if (refresh.unsaved === 0) return;
  const value = JSON.stringify({ version: refresh.version, done: [...refresh.done] });
  await withDbTransaction(
    db,
    (db, context) => kvSetWithinTransaction(context, RCS_IDENTITY_PROGRESS_KEY, value),
    shouldContinue,
  );
  refresh.unsaved = 0;
}

/**
 * Finish the refresh when every stored conversation of the current Google pairing that holds
 * messages (`storedNewest`: chat guid → newest stored message guid, read before this sync's listing)
 * has been re-read or is gone from the server. Returns whether it finished.
 */
export async function finishRcsIdentityRefreshIfComplete(
  db: ReadDb,
  refresh: RcsIdentityRefresh,
  serverInfo: ServerInfo,
  storedNewest: ReadonlyMap<string, string | null>,
  listing: RcsIdentityListing,
  shouldContinue: () => boolean,
): Promise<boolean> {
  // Only a complete listing that names a current RCS conversation shows the RCS bridge answered.
  const bridgeAnswered =
    listing.complete &&
    [...listing.rcsChats].some((guid) => isCurrentRcsChatGuid(serverInfo, guid));
  for (const [chatGuid, newest] of storedNewest) {
    if (newest == null || !isCurrentRcsChatGuid(serverInfo, chatGuid)) continue;
    if (refresh.done.has(chatGuid)) continue;
    if (bridgeAnswered && !listing.rcsChats.has(chatGuid)) continue; // gone from the server
    return false;
  }
  await withDbTransaction(
    db,
    async (db, context) => {
      await kvSetWithinTransaction(context, RCS_IDENTITY_APPLIED_KEY, String(refresh.version));
      await kvDeleteWithinTransaction(context, [RCS_IDENTITY_PROGRESS_KEY]);
    },
    shouldContinue,
  );
  return true;
}
