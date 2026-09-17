import type { HttpClient } from '@core/api/http';
import { ApiError } from '@core/api/errors';
import {
  sendContact,
  sendReaction,
  sendText,
  type ContactEmail,
  type ContactPhone,
  type MessageMention,
} from '@core/api/endpoints/messages';
import { logger } from '@core/secure';
import {
  claimOutgoingForSendWithinTransaction,
  deferOutgoingSendClaimWithinTransaction,
  getAttachmentByGuid,
  listRetryableOutgoing,
  MessageTargetCapabilityUnknownError,
  MessageTargetUnavailableError,
  queuedMessageTarget,
  resolveMessageTarget,
  retireOutgoingWithinTransaction,
  type MessageTargetServerAuthorization,
  type RetryableOutgoing,
  type SendAttemptOwnerToken,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isRcsChatGuid } from '@utils/chat';
import {
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';
import { notifyFailedSend } from './sendFailureNotice';
import type { AttachmentUploader } from './sendAttachmentService';
import { messageTargetCommitGuard } from './rcsAttemptCapability';

interface TextPayload {
  message: string;
  selectedMessageGuid?: string;
  partIndex?: number;
  effectId?: string;
  subject?: string;
  mentions?: MessageMention[];
}
interface ReactionPayload {
  selectedMessageGuid: string;
  reaction: string;
  emoji?: string;
  partIndex?: number;
  selectedMessageText?: string;
}
interface AttachmentPayload {
  attachmentGuid: string;
  localPath?: string;
  text?: string;
  selectedMessageGuid?: string;
  partIndex?: number;
}
/**
 * A contact card's STRUCTURED fields (the server rebuilds the vCard). Queued under its own
 * kind so a retry re-sends the CARD — queuing contacts as 'text' made a failed send retry as
 * a plain message containing the contact's display name.
 */
interface ContactPayload {
  firstName?: string;
  lastName?: string;
  organization?: string;
  phones?: ContactPhone[];
  emails?: ContactEmail[];
  selectedMessageGuid?: string;
  partIndex?: number;
}

type QueueRowShape = Pick<RetryableOutgoing, 'chatGuid' | 'kind' | 'payload'>;

/** Current-client policy: only ordinary iMessage text survives the retired helper boundary. */
function requiresRetiredPrivateApi(row: QueueRowShape): boolean {
  if (isRcsChatGuid(row.chatGuid)) return false;
  if (row.kind === 'reaction' || row.kind === 'contact' || row.kind === 'attachment') return true;
  if (row.kind !== 'text') return false;
  try {
    const payload = JSON.parse(row.payload) as TextPayload;
    return (
      payload.selectedMessageGuid !== undefined ||
      payload.effectId !== undefined ||
      payload.subject !== undefined ||
      payload.mentions !== undefined
    );
  } catch {
    // Malformed payloads follow the existing invalid-row retirement path.
    return false;
  }
}

/**
 * The native I/O an attachment re-upload needs, INJECTED so this module stays free of RN
 * imports (it runs in Node tests against better-sqlite3). Production wires the expo
 * implementations (`expoAttachmentUploader` / `expoFileExists`); tests inject fakes.
 */
export interface OutgoingQueueIO {
  upload: AttachmentUploader;
  fileExists: (uri: string) => Promise<boolean>;
}

/** What one re-POST attempt did. 'unsendable' = retired for good (nothing can ever fix it). */
export type ResendOutcome = 'sent' | 'failed' | 'unsendable' | 'paused' | 'deferred';

class RcsCapabilityUnavailableError extends Error {
  constructor() {
    super('RCS capability changed before the request started.');
    this.name = 'RcsCapabilityUnavailableError';
  }
}

const accountIsCurrent = (lease?: RealtimeDeliveryLease): boolean => !lease || lease.isCurrent();
const MAX_TIMER_MS = 2_147_483_647;
/** Elapsed-time clock: a user/NTP wall-clock correction must not lengthen a safety deadline. */
const monotonicNow = (): number => globalThis.performance?.now?.() ?? Date.now();

function attachmentDeadlineAt(timeoutMs?: number): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMER_MS) {
    throw new RangeError(`attachmentTimeoutMs must be between 1 and ${MAX_TIMER_MS}`);
  }
  return monotonicNow() + timeoutMs;
}

function attachmentTimeoutError(): ApiError {
  return new ApiError('timeout', 'Attachment retry timed out');
}

function remainingAttachmentTime(deadlineAt?: number): number | undefined {
  if (deadlineAt === undefined) return undefined;
  const remaining = deadlineAt - monotonicNow();
  if (remaining <= 0) throw attachmentTimeoutError();
  return remaining;
}

/** Race even injected/native implementations that ignore their timeout option. */
async function runBeforeAttachmentDeadline<T>(
  run: (remainingMs?: number) => Promise<T>,
  deadlineAt?: number,
): Promise<T> {
  const remaining = remainingAttachmentTime(deadlineAt);
  if (remaining === undefined) return run();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      run(remaining),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(attachmentTimeoutError()), remaining);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

/**
 * Admit one short DB outcome into account teardown's drain. Unit callers without a lease retain the
 * original unscoped behavior; every production entry point supplies one.
 */
async function runAccountCommit(
  lease: RealtimeDeliveryLease | undefined,
  task: (commitGuard?: DbCommitGuard) => Promise<unknown>,
): Promise<boolean> {
  if (!lease) {
    await task();
    return true;
  }
  try {
    return (
      (await runTrackedRealtimeWork(lease, () => task(() => lease.isCurrent()))) === 'delivered'
    );
  } catch (error) {
    // Teardown's drain is deliberately bounded. A commit can therefore remain queued behind the
    // process-wide DB mutex after the old account is wiped; its transaction guard rejects it at
    // lock acquisition (or rolls it back at the final pre-COMMIT check).
    if (error instanceof DbCommitGuardRejectedError) return false;
    throw error;
  }
}

/**
 * Commit one permanent retry retirement, then present its failure notice outside SQLite. Both
 * terminal causes use this owner so missing-file and unknown-kind settlement cannot drift.
 */
async function retireUnsendableOutgoing(
  db: AppDatabase,
  chatGuid: string,
  tempGuid: string,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => retireOutgoingWithinTransaction(context, tempGuid, 1),
    commitGuard,
  );
  await notifyFailedSend(db, chatGuid, tempGuid, commitGuard);
}

/**
 * Re-POST a single queued send (temp row + queue row already exist) and reconcile.
 *
 * Exported because the user's "Try Again" drives exactly one attempt through it: the manual retry
 * must re-POST the QUEUE PAYLOAD under the row's ORIGINAL temp guid, like the drain does, not
 * rebuild a send from the bubble under a fresh id. Rebuilding delivered a failed contact card as a
 * plain text message reading the contact's name; a fresh id defeats the server's temp-id-keyed
 * idempotency, so an ack-lost send goes out twice.
 *
 * `clock` is read at the OUTCOME, never at the top of the drain: foreground attempts may run for
 * minutes (only the headless adapter currently supplies an attachment timeout), and stamping the
 * backoff with a timestamp taken before all the earlier rows in the batch schedules the next attempt
 * too early — for a big upload, into the past, which makes the row re-eligible on the very next 20 s
 * tick with no backoff at all.
 */
export async function resendOutgoingRow(
  db: AppDatabase,
  http: HttpClient,
  io: OutgoingQueueIO,
  row: RetryableOutgoing,
  clock: () => number,
  accountLease?: RealtimeDeliveryLease,
  attachmentTimeoutMs?: number,
  attemptOwnerToken?: SendAttemptOwnerToken,
  serverAuthorization?: MessageTargetServerAuthorization,
  rcsAvailable?: () => boolean,
): Promise<ResendOutcome> {
  if (!accountIsCurrent(accountLease)) return 'paused';
  const rcsChat = isRcsChatGuid(row.chatGuid);
  const rcsIsCurrent = (): boolean => !rcsChat || (rcsAvailable?.() ?? true);
  if (!rcsIsCurrent()) return 'deferred';
  let networkStarted = false;
  const assertNetworkStart = (): void => {
    if (!accountIsCurrent(accountLease)) throw new DbCommitGuardRejectedError();
    if (!rcsIsCurrent()) throw new RcsCapabilityUnavailableError();
    networkStarted = true;
  };
  const retiredPrivateApiRow = requiresRetiredPrivateApi(row);
  const queuedTarget = queuedMessageTarget(row.kind, row.payload);
  const target =
    queuedTarget.kind === 'target'
      ? {
          chatGuid: row.chatGuid,
          messageGuid: queuedTarget.messageGuid,
          partIndex: queuedTarget.partIndex,
          serverAuthorization,
          allowRcsWholeMessage: row.kind === 'reaction' && isRcsChatGuid(row.chatGuid),
        }
      : null;
  const retireTarget = async (): Promise<ResendOutcome> =>
    (await runAccountCommit(accountLease, (guard) =>
      retireUnsendableOutgoing(
        db,
        row.chatGuid,
        row.tempGuid,
        messageTargetCommitGuard(guard, serverAuthorization),
      ),
    ))
      ? 'unsendable'
      : 'paused';
  const retirePrivateApiRow = async (): Promise<ResendOutcome> =>
    (await runAccountCommit(accountLease, (guard) =>
      retireUnsendableOutgoing(db, row.chatGuid, row.tempGuid, guard),
    ))
      ? 'unsendable'
      : 'paused';
  if (retiredPrivateApiRow) return retirePrivateApiRow();
  if (queuedTarget.kind === 'invalid') return retireTarget();

  const textPayload = row.kind === 'text' ? (JSON.parse(row.payload) as TextPayload) : undefined;
  // Old builds could persist a locally-threaded RCS text/media/contact send even though the
  // Google Messages bridge discards that target. Never let a recovered row become an ordinary
  // unthreaded send. Whole-message RCS reactions remain the only intentional exception.
  if (queuedTarget.kind === 'target' && row.kind !== 'reaction' && isRcsChatGuid(row.chatGuid)) {
    return retireTarget();
  }
  const authorizeTarget = async (): Promise<{ messageGuid: string; partIndex: number } | null> => {
    if (!target) return null;
    if (!accountIsCurrent(accountLease)) throw new DbCommitGuardRejectedError();
    const resolved = await resolveMessageTarget(
      db,
      target,
      accountLease ? () => accountLease.isCurrent() : undefined,
    );
    if (!resolved) throw new MessageTargetUnavailableError();
    if (serverAuthorization && !serverAuthorization.isCurrent()) {
      throw new DbCommitGuardRejectedError();
    }
    return { messageGuid: resolved.messageGuid, partIndex: resolved.partIndex };
  };
  try {
    // Bind the whole physical retry to the transport present at entry. Attachment retries perform
    // DB and native-file awaits before upload; retaining the live client there could otherwise make
    // an account-A row start on account B's newly selected origin/credential.
    const retryHttp =
      row.kind === 'text' ||
      row.kind === 'reaction' ||
      row.kind === 'contact' ||
      row.kind === 'attachment'
        ? http.pinTransport()
        : http;
    // The row is already flipped to 'sending' — that happens in the SAME transaction as the lease
    // (see runOutgoingQueue), never here, so there is no instant in which a leased row still reads
    // 'error' for the user's "Try Again" to claim out from under this attempt.
    let server;
    if (row.kind === 'text') {
      const p = textPayload!;
      if (!accountIsCurrent(accountLease)) return 'paused';
      const resolvedTarget = await authorizeTarget();
      retryHttp.assertTransportCurrent();
      assertNetworkStart();
      server = await sendText(retryHttp, {
        chatGuid: row.chatGuid,
        tempGuid: row.tempGuid,
        clientAttemptGeneration: attemptOwnerToken?.generation,
        message: p.message,
        method: rcsChat ? undefined : 'apple-script',
        selectedMessageGuid: resolvedTarget?.messageGuid,
        partIndex: resolvedTarget?.partIndex,
        effectId: p.effectId,
        subject: p.subject,
        mentions: p.mentions,
      });
    } else if (row.kind === 'reaction') {
      const p = JSON.parse(row.payload) as ReactionPayload;
      if (!target) return retireTarget();
      if (!accountIsCurrent(accountLease)) return 'paused';
      const resolvedTarget = await authorizeTarget();
      if (!resolvedTarget) return retireTarget();
      retryHttp.assertTransportCurrent();
      assertNetworkStart();
      server = await sendReaction(retryHttp, {
        chatGuid: row.chatGuid,
        selectedMessageGuid: resolvedTarget.messageGuid,
        reaction: p.reaction,
        emoji: p.emoji,
        partIndex: resolvedTarget.partIndex,
      });
    } else if (row.kind === 'contact') {
      const p = JSON.parse(row.payload) as ContactPayload;
      if (!accountIsCurrent(accountLease)) return 'paused';
      const resolvedTarget = await authorizeTarget();
      retryHttp.assertTransportCurrent();
      assertNetworkStart();
      server = await sendContact(retryHttp, {
        chatGuid: row.chatGuid,
        tempGuid: row.tempGuid,
        clientAttemptGeneration: attemptOwnerToken?.generation,
        firstName: p.firstName,
        lastName: p.lastName,
        organization: p.organization,
        phones: p.phones,
        emails: p.emails,
        selectedMessageGuid: resolvedTarget?.messageGuid,
        partIndex: resolvedTarget?.partIndex,
      });
    } else if (row.kind === 'attachment') {
      // One deadline spans the queue's DB/stat preflight AND the uploader's own preflight, FIFO
      // wait, native transfer and response. Starting only inside the uploader left a hung native
      // `fileExists` here able to consume the whole killed-app wake before upload even began.
      const deadlineAt = attachmentDeadlineAt(attachmentTimeoutMs);
      const p = JSON.parse(row.payload) as AttachmentPayload;
      // name/mimeType live on the attachments row (the payload only pins guid + path); the
      // row also holds the freshest localPath should anything have rewritten it.
      const att = await runBeforeAttachmentDeadline(
        () => getAttachmentByGuid(db, p.attachmentGuid),
        deadlineAt,
      );
      if (!accountIsCurrent(accountLease)) return 'paused';
      const uri = att?.localPath ?? p.localPath;
      const exists =
        att && uri
          ? await runBeforeAttachmentDeadline(() => io.fileExists(uri), deadlineAt)
          : false;
      // This is the original P0 window: fileExists is native/async. Disconnect can wipe A and the
      // user can connect B before it resolves; never invoke an uploader that would then snapshot B.
      if (!accountIsCurrent(accountLease)) return 'paused';
      if (!att || !uri || !exists) {
        // The on-disk file is gone (OS cache eviction / rows deleted) — no retry can ever
        // succeed. Retire now instead of burning attempts; the bubble keeps its error badge
        // and the sheet's Delete still works.
        logger.warn(`[queue] attachment retry has no local file — retiring`);
        return (await runAccountCommit(accountLease, (guard) =>
          retireUnsendableOutgoing(db, row.chatGuid, row.tempGuid, guard),
        ))
          ? 'unsendable'
          : 'paused';
      }
      if (!accountIsCurrent(accountLease)) return 'paused';
      // Keep this check and the uploader call in one synchronous turn. The uploader receives the
      // same pinned client captured before our DB/stat awaits and snapshots its native transport.
      retryHttp.assertTransportCurrent();
      server = await runBeforeAttachmentDeadline(
        (remainingMs) =>
          io.upload({
            http: retryHttp,
            chatGuid: row.chatGuid,
            tempGuid: row.tempGuid,
            clientAttemptGeneration: attemptOwnerToken?.generation,
            assertNetworkStart,
            text: p.text,
            attachmentGuid: att.guid,
            name: att.transferName ?? 'attachment',
            uri,
            mimeType: att.mimeType ?? 'application/octet-stream',
            totalBytes: att.totalBytes ?? 0,
            timeoutMs: remainingMs,
          }),
        deadlineAt,
      );
    } else {
      // Unknown kind: retire rather than skip, or the row is claimed-and-skipped on every
      // drain forever (the old zombie behavior attachments used to have).
      logger.warn(`[queue] unknown outgoing kind '${row.kind}' — retiring`);
      return (await runAccountCommit(accountLease, (guard) =>
        retireUnsendableOutgoing(db, row.chatGuid, row.tempGuid, guard),
      ))
        ? 'unsendable'
        : 'paused';
    }
    if (!accountIsCurrent(accountLease)) return 'paused';
    return (await runAccountCommit(accountLease, (guard) =>
      reconcileSendOutcome(db, row.tempGuid, server, clock(), guard, {
        attemptOwnerToken,
      }),
    ))
      ? 'sent'
      : 'paused';
  } catch (e) {
    if (!accountIsCurrent(accountLease)) return 'paused';
    if (
      e instanceof RcsCapabilityUnavailableError ||
      (rcsChat && !networkStarted && !rcsIsCurrent())
    ) {
      return 'deferred';
    }
    if (e instanceof DbCommitGuardRejectedError) return 'paused';
    if (e instanceof MessageTargetCapabilityUnknownError) return 'paused';
    if (e instanceof MessageTargetUnavailableError) return retireTarget();
    return (await runAccountCommit(accountLease, (guard) =>
      handleSendFailure(db, row.tempGuid, e, 'queue', row.chatGuid, clock(), guard, {
        attemptOwnerToken,
      }),
    ))
      ? 'failed'
      : 'paused';
  }
}

/**
 * Process the outgoing queue: retry every eligible stranded/failed text, reaction, and
 * attachment send with exponential backoff, retiring a row to the 'error' bubble after the
 * attempt cap (or immediately when its local file is gone). Each row is leased
 * (`claimOutgoingForSend`) so two concurrent runners never double-send; retries reuse the original
 * tempGuid so the server's idempotency cache can absorb an ack-lost duplicate. This is the
 * recovery missing from the original optimistic-send path — run it at boot, from the
 * background task, and from the in-session drains (chat ticker / AppState active). Pure
 * orchestration (no RN imports — attachment I/O is injected) → runs in Node tests.
 */
async function runOutgoingQueueBody(
  db: AppDatabase,
  http: HttpClient,
  io: OutgoingQueueIO,
  now: number = Date.now(),
  accountLease?: RealtimeDeliveryLease,
  maxRows?: number,
  attachmentTimeoutMs?: number,
  serverAuthorization?: MessageTargetServerAuthorization,
  rcsAvailable?: () => boolean,
): Promise<{ eligible: number; sent: number }> {
  if (!accountIsCurrent(accountLease)) return { eligible: 0, sent: 0 };
  // Filter disabled RCS work in SQLite before applying the headless work cap. Fetching every
  // eligible row merely to skip RCS in JavaScript would make one background pass unbounded.
  const rows = await listRetryableOutgoing(db, now, maxRows, rcsAvailable?.() === false);
  if (!accountIsCurrent(accountLease)) return { eligible: rows.length, sent: 0 };
  // `now` anchors the drain (and is injectable, so tests keep a deterministic clock), but every
  // claim and every outcome reads the time AGAIN through here. A single loop-start value both
  // under-schedules the backoff of every row after the first and hands each row a lease measured
  // from before the batch started — so a long upload can outlive its own 120 s lease and a second
  // drain re-claims the row and uploads the same file again alongside it.
  const startedAt = Date.now();
  const clock = (): number => now + (Date.now() - startedAt);
  let sent = 0;
  let attemptedRows = 0;
  for (const row of rows) {
    if (!accountIsCurrent(accountLease)) break;
    const rcsRow = isRcsChatGuid(row.chatGuid);
    const rcsIsCurrent = (): boolean => !rcsRow || (rcsAvailable?.() ?? true);
    // Capability-disabled RCS rows remain untouched and must not starve later AppleScript work.
    if (!rcsIsCurrent()) continue;
    if (maxRows !== undefined && attemptedRows >= maxRows) break;
    attemptedRows += 1;
    // THE LEASE AND THE VISIBLE STATE FLIP ARE ONE STEP. This service owns their short guarded
    // transaction: the lease lives in
    // outgoing_queue.next_retry_at; 'sending' on the message row is what every OTHER actor reads
    // — the "Try Again" button's claim is a compare-and-set on `send_state = 'error'`. If these
    // were separate commits, a just-leased row could still read 'error' and let a tap start an
    // overlapping POST. Manual retry now preserves the same temp guid, but overlapping requests
    // are still unsafe and can outlive the server's idempotency window.
    //
    // The flip is also what keeps a retry's SUCCESS from being swallowed: a row retried from
    // 'error' that acks without a guid (RCS tempGuid echo / AppleScript) hits
    // markOutgoingSentNoGuid's sticky-error guard, and the bubble stays errored with its queue row
    // un-bumped — so the same message re-sends on every later drain (duplicates).
    let claim: Awaited<ReturnType<typeof claimOutgoingForSendWithinTransaction>> = {
      claimed: false,
    };
    let claimCommitted: boolean;
    // A legacy part-zero target normally waits for current ServerInfo before it can be claimed.
    // These rows are being retired by permanent local product policy, not sent, so supply a
    // fail-closed local authorization solely to keep claim + visible state atomic. This never
    // authorizes a target or an HTTP request.
    const privateApiRetirementAuthorization: MessageTargetServerAuthorization | undefined =
      requiresRetiredPrivateApi(row)
        ? { allowsLegacyPartZero: false, isCurrent: () => accountIsCurrent(accountLease) }
        : serverAuthorization;
    try {
      claimCommitted = await runAccountCommit(accountLease, async (guard) => {
        const claimGuard = (): boolean => (guard?.() ?? true) && rcsIsCurrent();
        claim = await withDbTransaction(
          db,
          (context) =>
            claimOutgoingForSendWithinTransaction(
              context,
              row.id,
              clock,
              privateApiRetirementAuthorization,
            ),
          messageTargetCommitGuard(claimGuard, privateApiRetirementAuthorization),
        );
      });
    } catch (error) {
      if (
        error instanceof MessageTargetCapabilityUnknownError ||
        error instanceof DbCommitGuardRejectedError
      ) {
        if (rcsRow && !rcsIsCurrent()) continue;
        break;
      }
      throw error;
    }
    if (!claimCommitted) break;
    if (!claim.claimed) continue;
    const outcome = await resendOutgoingRow(
      db,
      http,
      io,
      row,
      clock,
      accountLease,
      attachmentTimeoutMs,
      claim.attemptOwnerToken,
      privateApiRetirementAuthorization,
      rcsAvailable,
    );
    if (outcome === 'sent') sent += 1;
    if (outcome === 'deferred') {
      if (!claim.deferToken) throw new Error('claimed outgoing row is missing its defer token');
      const released = await runAccountCommit(accountLease, (guard) =>
        withDbTransaction(
          db,
          (context) => deferOutgoingSendClaimWithinTransaction(context, claim.deferToken!),
          guard,
        ),
      );
      if (!released) break;
      continue;
    }
    if (outcome === 'paused') break;
  }
  return { eligible: rows.length, sent };
}

/**
 * Run the complete automatic retry attempt inside the account teardown barrier when production
 * supplies a lease. Short claim/outcome commits retain their narrower guards, while this outer
 * slot also covers the HTTP/native interval between them. Unit callers without a lease keep the
 * original standalone behavior.
 */
export async function runOutgoingQueue(
  db: AppDatabase,
  http: HttpClient,
  io: OutgoingQueueIO,
  now: number = Date.now(),
  accountLease?: RealtimeDeliveryLease,
  maxRows?: number,
  attachmentTimeoutMs?: number,
  serverAuthorization?: MessageTargetServerAuthorization,
  rcsAvailable?: () => boolean,
): Promise<{ eligible: number; sent: number }> {
  if (!accountLease) {
    return runOutgoingQueueBody(
      db,
      http,
      io,
      now,
      undefined,
      maxRows,
      attachmentTimeoutMs,
      serverAuthorization,
      rcsAvailable,
    );
  }

  const completed: { value?: { eligible: number; sent: number } } = {};
  const status = await runTrackedRealtimeWork(accountLease, async (activeLease) => {
    completed.value = await runOutgoingQueueBody(
      db,
      http,
      io,
      now,
      activeLease,
      maxRows,
      attachmentTimeoutMs,
      serverAuthorization,
      rcsAvailable,
    );
  });
  return status === 'delivered' && completed.value ? completed.value : { eligible: 0, sent: 0 };
}
