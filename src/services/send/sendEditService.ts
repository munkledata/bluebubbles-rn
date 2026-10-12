import { chatMessages, editMessage, unsendMessage } from '@core/api/endpoints/messages';
import { IMESSAGE_UNSEND_WINDOW_MS } from '@core/messages/retraction';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { plainTextFromAttributedBody } from '@core/richtext';
import { logger } from '@core/secure';
import {
  applyLocalEditWithinTransaction,
  applyLocalUnsendWithinTransaction,
  explicitMessageTargetPart,
  MessageTargetUnavailableError,
  clearUnconfirmedUnsendWithinTransaction,
  readMessageUnsendFence,
  readUnconfirmedUnsend,
  recordUnconfirmedUnsendWithinTransaction,
  resolveMessageTarget,
  resolveMessageTargetWithinTransaction,
  resolvePendingUnsendTarget,
  revertLocalEditWithinTransaction,
  revertLocalUnsendWithinTransaction,
  type MessageTargetServerAuthorization,
  type UnconfirmedUnsend,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { utf8Decode, utf8Encode } from '@utils/bytes';
import { messageTargetCommitGuard } from './rcsAttemptCapability';

const EDIT_ID_MAX_BYTES = 1_024;
const EDIT_TEXT_MAX_BYTES = 65_536;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const DEFINITE_EDIT_FAILURES = new Set([
  'imessage_edit_invalid_target',
  'imessage_edit_unavailable',
  'imessage_edit_rejected',
]);
const DEFINITE_UNSEND_FAILURES = new Set([
  'imessage_unsend_invalid_target',
  'imessage_unsend_unavailable',
  'imessage_unsend_rejected',
  'unsupported_rcs_action',
]);

export interface SendEditArgs {
  messageGuid: string;
  newText: string;
  /** Proven existing one-to-one iMessage chat that owns the exact message target. */
  chatGuid: string;
  /** The narrow command accepts only exact text part zero. */
  partIndex?: 0;
}

export type SendEditResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected' }
  | { readonly status: 'outcome-unknown' };

export interface SendUnsendArgs {
  messageGuid: string;
  /** Proven existing one-to-one iMessage chat that owns the exact message target. */
  chatGuid: string;
  /** The narrow command accepts only exact text part zero. */
  partIndex?: 0;
}

export type SendUnsendResult =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected' }
  | { readonly status: 'outcome-unknown' };

/** One edit/unsend lifecycle at a time per database/message; queued operations are never retried. */
const messageMutationTails = new WeakMap<AppDatabase, Map<string, Promise<void>>>();

function queueMessageMutation<T>(
  db: AppDatabase,
  messageGuid: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queue = messageMutationTails.get(db);
  if (!queue) {
    queue = new Map();
    messageMutationTails.set(db, queue);
  }
  const previous = queue.get(messageGuid) ?? Promise.resolve();
  const result = previous.then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  queue.set(messageGuid, tail);
  void tail.then(() => {
    if (queue?.get(messageGuid) !== tail) return;
    queue.delete(messageGuid);
    if (queue.size === 0) messageMutationTails.delete(db);
  });
  return result;
}

function isWellFormedBoundedUtf8(value: string, maxBytes: number): boolean {
  const bytes = utf8Encode(value);
  return bytes.byteLength > 0 && bytes.byteLength <= maxBytes && utf8Decode(bytes) === value;
}

function requireNarrowEditArgs(args: SendEditArgs): void {
  const target = explicitMessageTargetPart(args.messageGuid, args.partIndex);
  if (
    !target ||
    target.partIndex !== 0 ||
    target.messageGuid.trim() !== target.messageGuid ||
    CONTROL_CHARACTER.test(target.messageGuid) ||
    !isWellFormedBoundedUtf8(target.messageGuid, EDIT_ID_MAX_BYTES) ||
    args.newText.trim().length === 0 ||
    args.newText.includes('\u0000') ||
    !isWellFormedBoundedUtf8(args.newText, EDIT_TEXT_MAX_BYTES)
  ) {
    throw new MessageTargetUnavailableError('This message cannot be edited.');
  }
}

function isNarrowIMessageChatGuid(chatGuid: string): boolean {
  return (
    /^(?:iMessage|any);-;.+$/u.test(chatGuid) &&
    !CONTROL_CHARACTER.test(chatGuid) &&
    isWellFormedBoundedUtf8(chatGuid, EDIT_ID_MAX_BYTES)
  );
}

function requireNarrowUnsendArgs(args: SendUnsendArgs): void {
  const target = explicitMessageTargetPart(args.messageGuid, args.partIndex);
  if (
    !target ||
    target.partIndex !== 0 ||
    target.messageGuid.trim() !== target.messageGuid ||
    CONTROL_CHARACTER.test(target.messageGuid) ||
    !isWellFormedBoundedUtf8(target.messageGuid, EDIT_ID_MAX_BYTES) ||
    !isNarrowIMessageChatGuid(args.chatGuid)
  ) {
    throw new MessageTargetUnavailableError('This message cannot be unsent.');
  }
}

function editOutcomeIsUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.serverErrorType === 'imessage_edit_outcome_unknown') return true;
  if (error.serverErrorType && DEFINITE_EDIT_FAILURES.has(error.serverErrorType)) return false;
  return (
    error.kind === 'no_connection' ||
    error.kind === 'timeout' ||
    error.kind === 'server_error' ||
    error.kind === 'parse_error' ||
    error.kind === 'cancelled'
  );
}

function unsendOutcomeIsUnknown(error: unknown): boolean {
  if (!(error instanceof ApiError)) return true;
  if (error.serverErrorType === 'imessage_unsend_outcome_unknown') return true;
  if (error.serverErrorType && DEFINITE_UNSEND_FAILURES.has(error.serverErrorType)) return false;
  return (
    error.kind === 'no_connection' ||
    error.kind === 'timeout' ||
    error.kind === 'server_error' ||
    error.kind === 'parse_error' ||
    error.kind === 'cancelled'
  );
}

function revertOptimisticEdit(
  db: AppDatabase,
  messageGuid: string,
  restoreText: string | null,
  previousDateEdited: number | null,
  appliedAt: number,
  previousAttributedBody: string | null,
  expectedOptimisticText: string,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) =>
      revertLocalEditWithinTransaction(
        context,
        messageGuid,
        restoreText,
        previousDateEdited,
        appliedAt,
        previousAttributedBody,
        expectedOptimisticText,
      ),
    commitGuard,
  );
}

function revertOptimisticUnsend(
  db: AppDatabase,
  messageGuid: string,
  appliedAt: number,
  previousDateRetracted: number | null,
  previousRetractionState: string | null,
  previousPendingRetractionPartIndex: number | null,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) =>
      revertLocalUnsendWithinTransaction(
        context,
        messageGuid,
        appliedAt,
        previousDateRetracted,
        previousRetractionState,
        previousPendingRetractionPartIndex,
        0,
      ),
    commitGuard,
  );
}

async function sendEditOnce(
  db: AppDatabase,
  http: HttpClient,
  args: SendEditArgs,
  now: number,
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<SendEditResult> {
  requireNarrowEditArgs(args);
  const target = {
    chatGuid: args.chatGuid,
    messageGuid: args.messageGuid,
    partIndex: 0,
    partKind: 'text' as const,
    serverAuthorization,
  };
  const targetCommitGuard = messageTargetCommitGuard(commitGuard, serverAuthorization);
  const admission = await withDbTransaction(
    db,
    async (context) => {
      const resolvedTarget = await resolveMessageTargetWithinTransaction(context, target);
      if (!resolvedTarget || resolvedTarget.partIndex !== 0) return null;
      const previous = await applyLocalEditWithinTransaction(
        context,
        resolvedTarget.messageGuid,
        args.newText,
        now,
      );
      return previous ? { previous, resolvedTarget } : null;
    },
    targetCommitGuard,
  );
  if (!admission) return { status: 'rejected' };

  const { previous, resolvedTarget: admittedTarget } = admission;
  if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();

  const restoreText =
    previous.storedText && previous.storedText.length > 0
      ? previous.storedText
      : plainTextFromAttributedBody(previous.attributedBody) || previous.storedText;
  const chatGuid = args.chatGuid;
  if (!isNarrowIMessageChatGuid(chatGuid)) {
    await revertOptimisticEdit(
      db,
      admittedTarget.messageGuid,
      restoreText,
      previous.dateEdited,
      now,
      previous.attributedBody,
      args.newText,
      commitGuard,
    );
    return { status: 'rejected' };
  }

  let finalTarget;
  try {
    finalTarget = await resolveMessageTarget(db, { ...target, chatGuid }, targetCommitGuard);
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError) {
      await revertOptimisticEdit(
        db,
        admittedTarget.messageGuid,
        restoreText,
        previous.dateEdited,
        now,
        previous.attributedBody,
        args.newText,
        commitGuard,
      );
    }
    throw error;
  }
  if (!finalTarget || finalTarget.partIndex !== 0) {
    await revertOptimisticEdit(
      db,
      admittedTarget.messageGuid,
      restoreText,
      previous.dateEdited,
      now,
      previous.attributedBody,
      args.newText,
      commitGuard,
    );
    return { status: 'rejected' };
  }

  try {
    // Once the request has started only the account may abort settlement. A capability refresh
    // while it was out says nothing about whether the server applied it: report it unconfirmed.
    const ack = await editMessage(http, {
      chatGuid,
      messageGuid: finalTarget.messageGuid,
      editedMessage: args.newText,
      partIndex: 0,
    });
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    if (serverAuthorization && !serverAuthorization.isCurrent()) {
      return { status: 'outcome-unknown' };
    }
    return ack.guid === finalTarget.messageGuid
      ? { status: 'accepted' }
      : { status: 'outcome-unknown' };
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError) throw error;
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    if (serverAuthorization && !serverAuthorization.isCurrent()) {
      return { status: 'outcome-unknown' };
    }
    if (editOutcomeIsUnknown(error)) return { status: 'outcome-unknown' };
  }

  await revertOptimisticEdit(
    db,
    admittedTarget.messageGuid,
    restoreText,
    previous.dateEdited,
    now,
    previous.attributedBody,
    args.newText,
    commitGuard,
  );
  return { status: 'rejected' };
}

/** Optimistic exact-part-zero edit. The single POST is never automatically retried. */
export function sendEdit(
  db: AppDatabase,
  http: HttpClient,
  args: SendEditArgs,
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<SendEditResult> {
  const messageGuid = args.messageGuid;
  const queuedArgs = { ...args, messageGuid };
  return queueMessageMutation(db, messageGuid, () =>
    sendEditOnce(db, http, queuedArgs, now, commitGuard, serverAuthorization),
  );
}

/** Best-effort: without the note the message simply stays hidden, as it always did. */
async function rememberUnconfirmedUnsend(
  db: AppDatabase,
  messageGuid: string,
  record: UnconfirmedUnsend,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  try {
    await withDbTransaction(
      db,
      (context) => recordUnconfirmedUnsendWithinTransaction(context, messageGuid, record),
      commitGuard,
    );
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError) throw error;
    logger.warn('[unsend] could not remember an unconfirmed unsend', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function sendUnsendOnce(
  db: AppDatabase,
  http: HttpClient,
  args: SendUnsendArgs,
  now: number,
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<SendUnsendResult> {
  requireNarrowUnsendArgs(args);
  const exactTopologyAuthorization = serverAuthorization
    ? Object.freeze({
        allowsLegacyPartZero: false,
        isCurrent: serverAuthorization.isCurrent,
      })
    : undefined;
  const target = {
    chatGuid: args.chatGuid,
    messageGuid: args.messageGuid,
    partIndex: 0,
    partKind: 'text' as const,
    serverAuthorization: exactTopologyAuthorization,
  };
  const targetCommitGuard = messageTargetCommitGuard(commitGuard, serverAuthorization);
  const admission = await withDbTransaction(
    db,
    async (context) => {
      const resolvedTarget = await resolveMessageTargetWithinTransaction(context, target);
      if (!resolvedTarget || resolvedTarget.partIndex !== 0) return null;
      const previous = await applyLocalUnsendWithinTransaction(
        context,
        resolvedTarget.messageGuid,
        now,
        0,
      );
      return previous ? { previous, resolvedTarget } : null;
    },
    targetCommitGuard,
  );
  if (!admission) return { status: 'rejected' };

  const { previous, resolvedTarget: admittedTarget } = admission;
  if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();

  let finalTarget;
  try {
    finalTarget = await resolvePendingUnsendTarget(db, target, targetCommitGuard);
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError && (!commitGuard || commitGuard())) {
      await revertOptimisticUnsend(
        db,
        admittedTarget.messageGuid,
        now,
        previous.dateRetracted,
        previous.retractionState,
        previous.pendingRetractionPartIndex,
        commitGuard,
      );
    }
    throw error;
  }
  if (!finalTarget || finalTarget.partIndex !== 0) {
    await revertOptimisticUnsend(
      db,
      admittedTarget.messageGuid,
      now,
      previous.dateRetracted,
      previous.retractionState,
      previous.pendingRetractionPartIndex,
      commitGuard,
    );
    return { status: 'rejected' };
  }

  let outcomeUnknown = false;
  try {
    // Once the request has started only the account may abort settlement. A capability refresh
    // while it was out says nothing about whether the server applied it: report it unconfirmed.
    const ack = await unsendMessage(http, {
      chatGuid: args.chatGuid,
      messageGuid: finalTarget.messageGuid,
      partIndex: 0,
    });
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    if (
      (!serverAuthorization || serverAuthorization.isCurrent()) &&
      ack.unsent === true &&
      ack.guid === finalTarget.messageGuid
    ) {
      return { status: 'accepted' };
    }
    outcomeUnknown = true;
  } catch (error) {
    if (error instanceof DbCommitGuardRejectedError) throw error;
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    outcomeUnknown =
      (serverAuthorization !== undefined && !serverAuthorization.isCurrent()) ||
      unsendOutcomeIsUnknown(error);
  }
  if (outcomeUnknown) {
    // The message stays hidden (fail closed), and what a later restore needs is remembered so the
    // conversation can say "Unsend not confirmed" instead of "You unsent a message" for good.
    await rememberUnconfirmedUnsend(
      db,
      admittedTarget.messageGuid,
      {
        chatGuid: args.chatGuid,
        appliedAt: now,
        previousDateRetracted: previous.dateRetracted,
        previousRetractionState: previous.retractionState,
      },
      commitGuard,
    );
    return { status: 'outcome-unknown' };
  }

  await revertOptimisticUnsend(
    db,
    admittedTarget.messageGuid,
    now,
    previous.dateRetracted,
    previous.retractionState,
    previous.pendingRetractionPartIndex,
    commitGuard,
  );
  return { status: 'rejected' };
}

export type CheckUnsendResult =
  /** The Mac shows it unsent, or the server's echo already settled it. */
  | { readonly status: 'confirmed' }
  /** It was not unsent and can't be now: the message is shown again. */
  | { readonly status: 'restored' }
  | { readonly status: 'outcome-unknown' };

/** Unsends work only within two minutes of sending, so the message is among the newest. */
const UNSEND_CHECK_RECENT_MESSAGES = 100;

function forgetUnconfirmedUnsend(
  db: AppDatabase,
  messageGuid: string,
  commitGuard?: DbCommitGuard,
): Promise<void> {
  return withDbTransaction(
    db,
    (context) => clearUnconfirmedUnsendWithinTransaction(context, messageGuid),
    commitGuard,
  );
}

/**
 * "Check again" for an unsend whose result is unknown. Asks the Mac for its copy, then finishes it:
 * already unsent → confirmed; not unsent and past Apple's window → the message comes back; still
 * within the window → one more unsend request, settled like the first. If the Mac can't be asked,
 * nothing changes.
 */
export function checkUnconfirmedUnsend(
  db: AppDatabase,
  http: HttpClient,
  args: { chatGuid: string; messageGuid: string },
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<CheckUnsendResult> {
  // Same per-message queue as edit and unsend, so a double tap or a racing unsend takes turns.
  return queueMessageMutation(db, args.messageGuid, () =>
    checkUnconfirmedUnsendOnce(db, http, args, now, commitGuard, serverAuthorization),
  );
}

async function checkUnconfirmedUnsendOnce(
  db: AppDatabase,
  http: HttpClient,
  args: { chatGuid: string; messageGuid: string },
  now: number,
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<CheckUnsendResult> {
  const note = await readUnconfirmedUnsend(db, args.messageGuid);
  if (!note || note.chatGuid !== args.chatGuid) return { status: 'confirmed' };
  const fence = await readMessageUnsendFence(db, args.messageGuid);
  if (!fence || fence.pendingPartIndex !== 0 || fence.dateRetracted !== note.appliedAt) {
    // The server's echo (or another writer) already settled the message; drop the stale note.
    await forgetUnconfirmedUnsend(db, args.messageGuid, commitGuard);
    return { status: 'confirmed' };
  }

  let macCopy;
  try {
    const recent = await chatMessages(http, args.chatGuid, { limit: UNSEND_CHECK_RECENT_MESSAGES });
    macCopy = recent.find((message) => message.guid === args.messageGuid);
  } catch {
    if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
    return { status: 'outcome-unknown' };
  }
  if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
  if (!macCopy) return { status: 'outcome-unknown' };
  if (macCopy.dateRetracted != null) {
    await forgetUnconfirmedUnsend(db, args.messageGuid, commitGuard);
    return { status: 'confirmed' };
  }

  const tooLate =
    macCopy.dateCreated == null || now - macCopy.dateCreated > IMESSAGE_UNSEND_WINDOW_MS;
  if (!tooLate) {
    try {
      const ack = await unsendMessage(http, {
        chatGuid: args.chatGuid,
        messageGuid: args.messageGuid,
        partIndex: 0,
      });
      if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
      if (
        (!serverAuthorization || serverAuthorization.isCurrent()) &&
        ack.unsent === true &&
        ack.guid === args.messageGuid
      ) {
        await forgetUnconfirmedUnsend(db, args.messageGuid, commitGuard);
        return { status: 'confirmed' };
      }
      return { status: 'outcome-unknown' };
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();
      if (
        (serverAuthorization !== undefined && !serverAuthorization.isCurrent()) ||
        unsendOutcomeIsUnknown(error)
      ) {
        return { status: 'outcome-unknown' };
      }
      // The Mac shows it not unsent, so even "invalid target" is a definite refusal: restore below.
    }
  }

  // Not unsent on the Mac and it can't be now: show the message again, as before the unsend.
  const restored = await revertOptimisticUnsend(
    db,
    args.messageGuid,
    note.appliedAt,
    note.previousDateRetracted,
    note.previousRetractionState,
    null,
    commitGuard,
  );
  await forgetUnconfirmedUnsend(db, args.messageGuid, commitGuard);
  return { status: restored ? 'restored' : 'confirmed' };
}

/** Optimistic exact-part-zero unsend. The single POST is never automatically retried. */
export function sendUnsend(
  db: AppDatabase,
  http: HttpClient,
  args: SendUnsendArgs,
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<SendUnsendResult> {
  const messageGuid = args.messageGuid;
  const queuedArgs = { ...args, messageGuid };
  return queueMessageMutation(db, messageGuid, () =>
    sendUnsendOnce(db, http, queuedArgs, now, commitGuard, serverAuthorization),
  );
}
