import { editMessage, unsendMessage } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import { plainTextFromAttributedBody } from '@core/richtext';
import {
  applyLocalEdit,
  applyLocalUnsendWithinTransaction,
  revertLocalEdit,
  revertLocalUnsendWithinTransaction,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';

export interface SendEditArgs {
  messageGuid: string;
  newText: string;
  /** Chat the message lives in (server-required). Resolved from the DB row when omitted. */
  chatGuid?: string;
}

/**
 * One optimistic message mutation at a time per database/message. The DB mutex protects each
 * short local owner, not the HTTP gap between optimistic apply and possible revert. Edits and
 * unsends share this queue because either kind can otherwise snapshot the other's optimistic row
 * and later restore a predecessor that is no longer current. Queue admission is synchronous; no
 * network or waiting tail runs under the DB lock.
 */
const messageMutationTails = new WeakMap<AppDatabase, Map<string, Promise<void>>>();

function messageMutationQueue(db: AppDatabase): Map<string, Promise<void>> {
  const existing = messageMutationTails.get(db);
  if (existing) return existing;
  const created = new Map<string, Promise<void>>();
  messageMutationTails.set(db, created);
  return created;
}

function queueMessageMutation<T>(
  db: AppDatabase,
  messageGuid: string,
  operation: () => Promise<T>,
): Promise<T> {
  const queue = messageMutationQueue(db);
  const previous = queue.get(messageGuid) ?? Promise.resolve();
  const result = previous.then(operation);
  // A tail always fulfills so one unexpected local/driver failure cannot poison later mutations.
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queue.set(messageGuid, tail);
  void tail.then(() => {
    if (queue.get(messageGuid) !== tail) return;
    queue.delete(messageGuid);
    if (queue.size === 0) messageMutationTails.delete(db);
  });
  return result;
}

/**
 * Optimistic edit: snapshot the prior text, apply locally (UI shows the new text
 * + "Edited"), POST, and revert on failure so the bubble never lies. Pure
 * orchestration (no RN imports) → Node-testable against better-sqlite3.
 */
async function sendEditOnce(
  db: AppDatabase,
  http: HttpClient,
  args: SendEditArgs,
  now: number,
): Promise<{ ok: boolean }> {
  // Snapshot + optimistic write share one DB owner. This prevents a bare shared-connection read
  // from capturing another transaction's uncommitted value before the write queues behind it.
  const prev = await applyLocalEdit(db, args.messageGuid, args.newText, now);
  if (!prev) return { ok: false };
  // Rich bodies can be arbitrarily large. Decode after the short DB owner commits so parsing never
  // blocks the process-wide write mutex used by every message, sync, and settings mutation.
  const restoreText =
    prev.storedText && prev.storedText.length > 0
      ? prev.storedText
      : plainTextFromAttributedBody(prev.attributedBody) || prev.storedText;
  const chatGuid = args.chatGuid ?? prev.chatGuid;
  if (!chatGuid) {
    await revertLocalEdit(
      db,
      args.messageGuid,
      restoreText,
      prev.dateEdited,
      now,
      prev.attributedBody,
      args.newText,
    );
    return { ok: false };
  }
  try {
    // The server returns the sender's send ack `{ guid? }`. A present guid is the
    // Private-API confirmation that the edit went through; treat its absence as a
    // soft failure and revert (edits require the Private API, so no guid = no edit).
    const ack = await editMessage(http, {
      chatGuid,
      messageGuid: args.messageGuid,
      editedMessage: args.newText,
      backwardsCompatibilityMessage: `Edited to: “${args.newText}”`,
      partIndex: 0,
    });
    if (!ack.guid) {
      // Compare-and-set, not a blind write: an edit the server DID apply whose response was lost
      // still echoes over the socket, and that echo lands FIRST. Reverting blindly would overwrite
      // it, leaving the message reading the old wording to you and the new one to everyone else.
      // `prev.dateEdited` is passed through rather than `?? 0` — a literal 0 is not "never edited".
      await revertLocalEdit(
        db,
        args.messageGuid,
        restoreText,
        prev.dateEdited,
        now,
        prev.attributedBody,
        args.newText,
      );
      return { ok: false };
    }
    return { ok: true };
  } catch {
    // Same compare-and-set as above: a transport failure does NOT prove the edit wasn't applied.
    await revertLocalEdit(
      db,
      args.messageGuid,
      restoreText,
      prev.dateEdited,
      now,
      prev.attributedBody,
      args.newText,
    );
    return { ok: false };
  }
}

export function sendEdit(
  db: AppDatabase,
  http: HttpClient,
  args: SendEditArgs,
  now: number = Date.now(),
): Promise<{ ok: boolean }> {
  // Capture the key synchronously. Callers own their argument object and may mutate/reuse it after
  // admission; queue cleanup must still address the exact slot this operation claimed.
  const messageGuid = args.messageGuid;
  const queuedArgs = { ...args, messageGuid };
  return queueMessageMutation(db, messageGuid, () => sendEditOnce(db, http, queuedArgs, now));
}

export interface SendUnsendArgs {
  messageGuid: string;
  /** Chat the message lives in (server-required). Resolved from the DB row when omitted. */
  chatGuid?: string;
}

/** One short guarded owner for every compare-and-set unsend rollback. */
function revertOptimisticUnsend(
  db: AppDatabase,
  messageGuid: string,
  appliedAt: number,
  previousDateRetracted: number | null,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) =>
      revertLocalUnsendWithinTransaction(context, messageGuid, appliedAt, previousDateRetracted),
    commitGuard,
  );
}

/** Optimistic unsend: mark retracted locally, POST, restore the prior mark on failure. */
async function sendUnsendOnce(
  db: AppDatabase,
  http: HttpClient,
  args: SendUnsendArgs,
  now: number,
  commitGuard?: DbCommitGuard,
): Promise<{ ok: boolean }> {
  // Row existence, committed predecessor, owning chat and optimistic write share one DB owner.
  // An explicit route chat may override the snapshotted chat, but never bypass a missing row.
  const previous = await withDbTransaction(
    db,
    (context) => applyLocalUnsendWithinTransaction(context, args.messageGuid, now),
    commitGuard,
  );
  if (!previous) return { ok: false };

  // Disconnect can retire this account immediately after COMMIT. Do not start an old-account
  // request through whatever credential boundary a successor account installs.
  if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();

  const chatGuid = args.chatGuid ?? previous.chatGuid;
  if (!chatGuid) {
    await revertOptimisticUnsend(db, args.messageGuid, now, previous.dateRetracted, commitGuard);
    return { ok: false };
  }

  let accepted = false;
  try {
    // The server returns a status object `{ unsent: true }`; derive ok from it (a
    // 2xx that didn't actually unsend → revert the local retraction).
    const ack = await unsendMessage(http, {
      chatGuid,
      messageGuid: args.messageGuid,
      partIndex: 0,
    });
    accepted = ack.unsent === true;
  } catch {
    // A transport failure follows the same single guarded revert as a soft negative response.
  }

  if (accepted) return { ok: true };

  // Compare-and-set, not a blind clear: a lost response can still be followed by a differently
  // stamped server echo. Keeping this outside the HTTP catch ensures a rejected/failed DB owner is
  // never caught and attempted a second time.
  await revertOptimisticUnsend(db, args.messageGuid, now, previous.dateRetracted, commitGuard);
  return { ok: false };
}

export function sendUnsend(
  db: AppDatabase,
  http: HttpClient,
  args: SendUnsendArgs,
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
): Promise<{ ok: boolean }> {
  // Capture every caller-owned input synchronously, including the clock marker. The full lifecycle
  // then shares the exact same per-row queue as edit, while each DB callback stays HTTP-free.
  const messageGuid = args.messageGuid;
  const queuedArgs = { ...args, messageGuid };
  return queueMessageMutation(db, messageGuid, () =>
    sendUnsendOnce(db, http, queuedArgs, now, commitGuard),
  );
}
