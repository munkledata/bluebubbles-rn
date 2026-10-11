import type { HttpClient } from '@core/api/http';
import { ApiError } from '@core/api/errors';
import { isRcsProviderEpoch } from '@core/rcs';
import {
  CURRENT_LOCATION_MAX_REPLAY_AGE_MS,
  isRetryableIMessagePlainTextUnavailable,
  sendContact,
  sendIMessagePlainText,
  sendLocation,
  sendReaction,
  sendText,
  type ContactEmail,
  type ContactPhone,
  type IMessageTextFormattingRange,
  type MessageMention,
} from '@core/api/endpoints/messages';
import { logger } from '@core/secure';
import {
  claimOutgoingForSendWithinTransaction,
  deferOutgoingSendClaimWithinTransaction,
  getAttachmentByGuid,
  imessagePlainTextQueueState,
  listRetryableOutgoing,
  MessageTargetCapabilityUnknownError,
  MessageTargetUnavailableError,
  queuedMessageTarget,
  resolveMessageTarget,
  retireOutgoingWithinTransaction,
  retireUncertainOutgoingWithinTransaction,
  type MessageTargetServerAuthorization,
  type RetryableOutgoing,
  type SendAttemptOwnerToken,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { ClientErrorCode, isRcsChatGuid } from '@utils';
import {
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import {
  handleSendFailure,
  isTerminalLocationSendError,
  ONE_SHOT_FAILURES,
  reconcileSendOutcome,
  UNCERTAIN_IMESSAGE_LOCATION_COPY,
  type OneShotSendKind,
} from './sendOutcome';
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
  textFormatting?: IMessageTextFormattingRange[];
  imessageEffectV1?: true;
  imessageMentionV1?: true;
  imessageFormattedV1?: true;
  imessagePlainTextV1?: true;
  imessagePlainTextRetrySafeV1?: true;
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
  imessageAttachmentV1?: true;
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
interface LocationPayload {
  latitude: number;
  longitude: number;
}

function parseLocationPayload(payload: string): LocationPayload | null {
  try {
    const value = JSON.parse(payload) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== 'latitude,longitude') return null;
    const { latitude, longitude } = record;
    if (
      typeof latitude !== 'number' ||
      !Number.isFinite(latitude) ||
      latitude < -90 ||
      latitude > 90 ||
      typeof longitude !== 'number' ||
      !Number.isFinite(longitude) ||
      longitude < -180 ||
      longitude > 180
    ) {
      return null;
    }
    return { latitude, longitude };
  } catch {
    return null;
  }
}

function isExpiredLocationReplay(row: QueueRowShape & { createdAt: number }, now: number): boolean {
  return (
    row.kind === 'location' &&
    (!Number.isSafeInteger(row.createdAt) ||
      row.createdAt < 0 ||
      row.createdAt > now ||
      now - row.createdAt >= CURRENT_LOCATION_MAX_REPLAY_AGE_MS)
  );
}

type QueueRowShape = Pick<RetryableOutgoing, 'chatGuid' | 'kind' | 'payload'>;

/** Retire helper-dependent queued work, including marked one-shot iMessage sends. */
function requiresRetiredPrivateApi(row: QueueRowShape): boolean {
  if (row.kind === 'text') {
    try {
      const payload = JSON.parse(row.payload) as TextPayload;
      if (payload.imessagePlainTextV1 === true) return false;
      // This explicit bit overrides a stale/malformed chat classification as well as a missing
      // rich field. Once marked one-shot, this row must never reach an ordinary text transport.
      if (
        payload.imessageEffectV1 === true ||
        payload.imessageMentionV1 === true ||
        payload.imessageFormattedV1 === true
      )
        return true;
      if (isRcsChatGuid(row.chatGuid)) return false;
      return (
        payload.selectedMessageGuid !== undefined ||
        payload.effectId !== undefined ||
        payload.subject !== undefined ||
        payload.mentions !== undefined ||
        payload.textFormatting !== undefined
      );
    } catch {
      // Malformed payloads follow the existing invalid-row retirement path.
      return false;
    }
  }
  if (isRcsChatGuid(row.chatGuid)) return false;
  if (row.kind === 'reaction' || row.kind === 'contact' || row.kind === 'attachment') return true;
  return false;
}

/** Only a new, explicitly marked one-shot attachment gets the uncertain-delivery outcome. */
function isMarkedImessageAttachment(row: QueueRowShape): boolean {
  if (row.kind !== 'attachment' || isRcsChatGuid(row.chatGuid)) return false;
  try {
    const payload = JSON.parse(row.payload) as AttachmentPayload;
    return payload?.imessageAttachmentV1 === true;
  } catch {
    return false;
  }
}

/** A narrow plain-text iMessage reply is one-shot and may never be replayed after interruption. */
function isNarrowImessageReply(row: QueueRowShape): boolean {
  if (row.kind !== 'text' || isRcsChatGuid(row.chatGuid)) return false;
  try {
    const payload = JSON.parse(row.payload) as TextPayload;
    return (
      typeof payload.selectedMessageGuid === 'string' &&
      payload.selectedMessageGuid.length > 0 &&
      payload.partIndex === 0 &&
      payload.effectId === undefined &&
      payload.subject === undefined &&
      payload.mentions === undefined &&
      payload.textFormatting === undefined
    );
  } catch {
    return false;
  }
}

/** A recovered marked effect may already have dispatched and must never enter text replay. */
function isNarrowImessageEffect(row: QueueRowShape): boolean {
  if (row.kind !== 'text') return false;
  try {
    const payload = JSON.parse(row.payload) as TextPayload;
    // Treat the one-shot bit as authoritative even when another payload field is malformed or
    // absent. Recovery may downgrade presentation, but it must never downgrade delivery safety.
    return payload.imessageEffectV1 === true;
  } catch {
    return false;
  }
}

/** A recovered marked mention may already have dispatched and must never enter text replay. */
function isNarrowImessageMention(row: QueueRowShape): boolean {
  if (row.kind !== 'text') return false;
  try {
    const payload = JSON.parse(row.payload) as TextPayload;
    // The marker, not reparsing the mutable rich payload, is the durable one-shot authority.
    return payload.imessageMentionV1 === true;
  } catch {
    return false;
  }
}

/** A recovered marked formatted message may already have dispatched and must never be replayed. */
function isNarrowImessageFormatted(row: QueueRowShape): boolean {
  if (row.kind !== 'text') return false;
  try {
    const payload = JSON.parse(row.payload) as TextPayload;
    return payload.imessageFormattedV1 === true;
  } catch {
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

/** Current RCS mutation authority. Omit ids only for the coarse "any current epoch?" SQL filter. */
export type RcsAvailability = (chatGuid?: string, messageGuid?: string) => boolean;
/** Current exact capability proof for the durable narrow plain-text route. */
export type IMessagePlainTextAvailability = (chatGuid?: string) => boolean;

/** What one re-POST attempt did. 'unsendable' = retired for good (nothing can ever fix it). */
export type ResendOutcome = 'sent' | 'failed' | 'unsendable' | 'paused' | 'deferred';

class RcsCapabilityUnavailableError extends Error {
  constructor() {
    super('RCS capability changed before the request started.');
    this.name = 'RcsCapabilityUnavailableError';
  }
}

class LocationCapabilityUnavailableError extends Error {
  constructor() {
    super('Current-location capability changed before the request started.');
    this.name = 'LocationCapabilityUnavailableError';
  }
}

class IMessagePlainTextCapabilityUnavailableError extends Error {
  constructor() {
    super('Narrow iMessage plain-text capability changed before the request started.');
    this.name = 'IMessagePlainTextCapabilityUnavailableError';
  }
}

class IMessagePlainTextInterruptedError extends Error {
  constructor() {
    super('A narrow iMessage plain-text attempt was interrupted with an unknown outcome.');
    this.name = 'IMessagePlainTextInterruptedError';
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
  rcsAvailable?: RcsAvailability,
  attachmentSignal?: AbortSignal,
  locationAvailable?: () => boolean,
  imessagePlainTextAvailable?: IMessagePlainTextAvailability,
): Promise<ResendOutcome> {
  if (!accountIsCurrent(accountLease)) return 'paused';
  const rcsChat = isRcsChatGuid(row.chatGuid);
  const rcsIsCurrent = (): boolean => !rcsChat || rcsAvailable?.(row.chatGuid) === true;
  const locationIsCurrent = (): boolean =>
    row.kind !== 'location' || locationAvailable?.() === true;
  const plainTextState = imessagePlainTextQueueState(row.kind, row.payload);
  const plainTextIsCurrent = (): boolean =>
    plainTextState !== 'retry-safe' || imessagePlainTextAvailable?.(row.chatGuid) === true;
  if (!plainTextIsCurrent()) return 'deferred';
  if (!rcsIsCurrent()) return 'deferred';
  const locationReplayNow = row.kind === 'location' ? clock() : null;
  if (locationReplayNow !== null && isExpiredLocationReplay(row, locationReplayNow)) {
    return (await runAccountCommit(accountLease, (guard) =>
      withDbTransaction(
        db,
        (context) =>
          retireUncertainOutgoingWithinTransaction(
            context,
            row.tempGuid,
            ClientErrorCode.locationDeliveryUnconfirmed,
            UNCERTAIN_IMESSAGE_LOCATION_COPY,
            true,
          ),
        guard,
      ),
    ))
      ? 'unsendable'
      : 'paused';
  }
  if (!locationIsCurrent()) return 'deferred';
  let networkStarted = false;
  const assertNetworkStart = (): void => {
    if (!accountIsCurrent(accountLease)) throw new DbCommitGuardRejectedError();
    if (!rcsIsCurrent()) throw new RcsCapabilityUnavailableError();
    if (!locationIsCurrent()) throw new LocationCapabilityUnavailableError();
    if (!plainTextIsCurrent()) throw new IMessagePlainTextCapabilityUnavailableError();
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
  const retirePrivateApiRow = async (): Promise<ResendOutcome> => {
    // Only reached for iMessage rows, so a contact card here is a one-shot helper send.
    const oneShotKind: OneShotSendKind | null = isNarrowImessageReply(row)
      ? 'reply'
      : isNarrowImessageEffect(row)
        ? 'effect'
        : isNarrowImessageMention(row)
          ? 'mention'
          : isNarrowImessageFormatted(row)
            ? 'formatted'
            : isMarkedImessageAttachment(row)
              ? 'attachment'
              : row.kind === 'contact'
                ? 'contact'
                : null;
    if (oneShotKind) {
      // A process death may have hidden a successful helper dispatch. Never replay this key or
      // present the generic "not sent" notification; keep the authored local row for review.
      const { code, detail } = ONE_SHOT_FAILURES[oneShotKind].unconfirmed;
      return (await runAccountCommit(accountLease, (guard) =>
        withDbTransaction(
          db,
          (context) =>
            retireUncertainOutgoingWithinTransaction(context, row.tempGuid, code, detail),
          guard,
        ),
      ))
        ? 'unsendable'
        : 'paused';
    }
    return (await runAccountCommit(accountLease, (guard) =>
      retireUnsendableOutgoing(db, row.chatGuid, row.tempGuid, guard),
    ))
      ? 'unsendable'
      : 'paused';
  };
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
    if (plainTextState === 'unsafe') throw new IMessagePlainTextInterruptedError();
    // Bind the whole physical retry to the transport present at entry. Attachment retries perform
    // DB and native-file awaits before upload; retaining the live client there could otherwise make
    // an account-A row start on account B's newly selected origin/credential.
    const retryHttp =
      row.kind === 'text' ||
      row.kind === 'reaction' ||
      row.kind === 'contact' ||
      row.kind === 'attachment' ||
      row.kind === 'location'
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
      server =
        plainTextState === 'retry-safe'
          ? await sendIMessagePlainText(retryHttp, {
              chatGuid: row.chatGuid,
              tempGuid: row.tempGuid,
              message: p.message,
            })
          : await sendText(retryHttp, {
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
      if (rcsChat && rcsAvailable?.(row.chatGuid, resolvedTarget.messageGuid) === false) {
        return 'deferred';
      }
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
    } else if (row.kind === 'location') {
      const p = parseLocationPayload(row.payload);
      if (!p) {
        logger.warn('[queue] invalid location retry payload — retiring');
        return retireTarget();
      }
      if (!accountIsCurrent(accountLease)) return 'paused';
      retryHttp.assertTransportCurrent();
      assertNetworkStart();
      server = await sendLocation(retryHttp, {
        chatGuid: row.chatGuid,
        tempGuid: row.tempGuid,
        latitude: p.latitude,
        longitude: p.longitude,
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
            signal: attachmentSignal,
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
        expectedChatGuid: row.chatGuid,
      }),
    ))
      ? 'sent'
      : 'paused';
  } catch (e) {
    if (!accountIsCurrent(accountLease)) return 'paused';
    if (
      e instanceof RcsCapabilityUnavailableError ||
      e instanceof LocationCapabilityUnavailableError ||
      e instanceof IMessagePlainTextCapabilityUnavailableError ||
      (rcsChat && !networkStarted && !rcsIsCurrent())
    ) {
      return 'deferred';
    }
    if (e instanceof DbCommitGuardRejectedError) return 'paused';
    if (e instanceof MessageTargetCapabilityUnknownError) return 'paused';
    if (e instanceof MessageTargetUnavailableError) return retireTarget();
    const terminalLocation = row.kind === 'location' && isTerminalLocationSendError(e);
    const retrySafePlainText =
      plainTextState === 'retry-safe' && isRetryableIMessagePlainTextUnavailable(e);
    return (await runAccountCommit(accountLease, (guard) =>
      handleSendFailure(db, row.tempGuid, e, 'queue', row.chatGuid, clock(), guard, {
        attemptOwnerToken,
        ...(retrySafePlainText
          ? { imessagePlainTextRetrySafe: true }
          : plainTextState !== 'legacy'
            ? { terminalUncertainKind: 'plain' as const }
            : terminalLocation
              ? { terminalUncertainKind: 'location' as const }
              : {}),
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
  rcsAvailable?: RcsAvailability,
  attachmentSignal?: AbortSignal,
  locationAvailable?: () => boolean,
  currentRcsProviderEpoch?: string | null,
  imessagePlainTextAvailable?: IMessagePlainTextAvailability,
): Promise<{ eligible: number; sent: number }> {
  if (!accountIsCurrent(accountLease)) return { eligible: 0, sent: 0 };
  // Filter disabled or old-provider RCS work in SQLite before applying the headless work cap.
  // Otherwise stale rows can occupy every bounded candidate slot and hide later sendable work.
  // An unbounded foreground drain may retain its JavaScript exact check; a bounded caller without
  // a validated epoch fails closed for RCS so it cannot reintroduce starvation or cross-epoch send.
  const boundedRcsProviderEpoch =
    maxRows === undefined
      ? undefined
      : isRcsProviderEpoch(currentRcsProviderEpoch)
        ? currentRcsProviderEpoch
        : null;
  const rows = await listRetryableOutgoing(
    db,
    now,
    maxRows,
    rcsAvailable?.() !== true || boundedRcsProviderEpoch === null,
    locationAvailable?.() !== true,
    boundedRcsProviderEpoch ?? undefined,
    imessagePlainTextAvailable?.() !== true,
  );
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
    const rcsIsCurrent = (): boolean => !rcsRow || rcsAvailable?.(row.chatGuid) === true;
    const locationRow = row.kind === 'location';
    const plainTextState = imessagePlainTextQueueState(row.kind, row.payload);
    const expiredLocation = locationRow && isExpiredLocationReplay(row, clock());
    if (expiredLocation) {
      if (maxRows !== undefined && attemptedRows >= maxRows) break;
      attemptedRows += 1;
      const retired = await runAccountCommit(accountLease, (guard) =>
        withDbTransaction(
          db,
          (context) =>
            retireUncertainOutgoingWithinTransaction(
              context,
              row.tempGuid,
              ClientErrorCode.locationDeliveryUnconfirmed,
              UNCERTAIN_IMESSAGE_LOCATION_COPY,
              true,
            ),
          guard,
        ),
      );
      if (!retired) break;
      continue;
    }
    const locationIsCurrent = (): boolean => !locationRow || locationAvailable?.() === true;
    // Capability-disabled RCS rows remain untouched and must not starve later AppleScript work.
    if (!rcsIsCurrent()) continue;
    // Location rows likewise wait untouched for an exact live capability snapshot.
    if (!locationIsCurrent()) continue;
    if (plainTextState === 'retry-safe' && imessagePlainTextAvailable?.(row.chatGuid) !== true) {
      continue;
    }
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
        const claimGuard = (): boolean =>
          (guard?.() ?? true) &&
          rcsIsCurrent() &&
          locationIsCurrent() &&
          (plainTextState !== 'retry-safe' || imessagePlainTextAvailable?.(row.chatGuid) === true);
        claim = await withDbTransaction(
          db,
          (context) =>
            claimOutgoingForSendWithinTransaction(
              context,
              row.id,
              clock,
              privateApiRetirementAuthorization,
              imessagePlainTextAvailable,
              row.payload,
            ),
          messageTargetCommitGuard(claimGuard, privateApiRetirementAuthorization),
        );
      });
    } catch (error) {
      if (
        error instanceof MessageTargetCapabilityUnknownError ||
        error instanceof DbCommitGuardRejectedError
      ) {
        if ((rcsRow && !rcsIsCurrent()) || (locationRow && !locationIsCurrent())) continue;
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
      attachmentSignal,
      locationAvailable,
      imessagePlainTextAvailable,
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
  rcsAvailable?: RcsAvailability,
  attachmentSignal?: AbortSignal,
  locationAvailable?: () => boolean,
  currentRcsProviderEpoch?: string | null,
  imessagePlainTextAvailable?: IMessagePlainTextAvailability,
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
      attachmentSignal,
      locationAvailable,
      currentRcsProviderEpoch,
      imessagePlainTextAvailable,
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
      attachmentSignal,
      locationAvailable,
      currentRcsProviderEpoch,
      imessagePlainTextAvailable,
    );
  });
  return status === 'delivered' && completed.value ? completed.value : { eligible: 0, sent: 0 };
}
