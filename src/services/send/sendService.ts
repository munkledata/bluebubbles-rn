import type { HttpClient } from '@core/api/http';
import { ApiError } from '@core/api/errors';
import {
  isRetryableIMessagePlainTextUnavailable,
  requireIMessagePlainTextRequest,
  sendIMessagePlainText,
  sendText,
  type MessageMention,
} from '@core/api/endpoints/messages';
import { MAX_SEND_ATTACHMENT_TEXT_BYTES } from '@core/models/serverInfo';
import {
  getChatHeader,
  handoverScheduledTextToOutgoing,
  insertOutgoingTextWithinTransaction,
  explicitMessageTargetPart,
  MessageTargetUnavailableError,
  resolveMessageTarget,
  resolveMessageTargetWithinTransaction,
  type ScheduledTextHandoverTransition,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isProvenOneToOneIMessageChat, isRcsChatGuid } from '@utils/chat';
import { utf8Decode, utf8Encode } from '@utils/bytes';
import {
  RcsCapabilityUnavailableError,
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import {
  handleSendFailure,
  reconcileSendOutcome,
  retireUnavailableMessageTarget,
} from './sendOutcome';
import { pinSendTransport } from './sendTransport';

/**
 * Pick the only supported iMessage text method in this release. Private API sends are retired
 * unconditionally, including when an old server or stale callback still advertises the helper.
 */
export function chooseSendMethod(needsPrivateApi: boolean): 'apple-script' {
  if (needsPrivateApi) {
    throw new Error('Private API message features were retired in this release.');
  }
  return 'apple-script';
}

/** "temp-{8 lowercase alnum}" — a client-generated id for optimistic sends. */
export function generateTempGuid(): string {
  const s = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `temp-${s}`;
}

export interface SendTextArgs {
  chatGuid: string;
  text: string;
  selectedMessageGuid?: string;
  /** Reply target part. Ignored when there is no selected message. */
  partIndex?: number;
  effectId?: string;
  /** Private-API iMessage subject line (bold header above the body). */
  subject?: string;
  /** @mention spans in `text` (Private API only — the server builds multipart parts). */
  mentions?: MessageMention[];
}

/**
 * Optional ownership transfer used only by the local scheduled-message runner.
 *
 * The scheduled transition and optimistic outgoing rows must share one commit. Otherwise a
 * process kill between their separate commits leaves two durable owners that can send the same
 * occurrence after restart.
 */
export interface ScheduledTextHandover {
  scheduledId: number;
  transition: ScheduledTextHandoverTransition;
  commitGuard?: DbCommitGuard;
}

/**
 * Optimistic text send. Inserts a temp message (`sendState='sending'`) + a queue
 * row, POSTs, then reconciles by tempGuid. On error the bubble flips to
 * `sendState='error'` (the UI signal) — we don't rethrow into render. Pure
 * orchestration (no React Native imports), so it runs in Node tests against
 * better-sqlite3, mirroring the sync engine.
 */
export async function sendTextMessage(
  db: AppDatabase,
  http: HttpClient,
  args: SendTextArgs,
  now: number = Date.now(),
  /**
   * Awaited the instant the optimistic message + queue row are committed — i.e. the instant
   * delivery becomes durable and owned by the outgoing queue rather than by this call. A caller
   * holding its own claim on the work (the scheduled-message ticker) settles it here rather than
   * after the POST, which can run for seconds: an app kill inside that window used to leave BOTH
   * the queue row and a still-'sending' scheduled row alive, and the next launch re-sent one and
   * re-fired the other.
   */
  onQueued?: (tempGuid: string) => Promise<void> | void,
  scheduledHandover?: ScheduledTextHandover,
  ordinaryCommitGuard?: DbCommitGuard,
  /** Explicit provenance for foreground cache data or already-proven task-local server info. */
  capabilitySource?: RcsCapabilitySource,
): Promise<{ tempGuid: string }> {
  const targetPart = explicitMessageTargetPart(args.selectedMessageGuid, args.partIndex);
  const target = targetPart
    ? {
        chatGuid: args.chatGuid,
        messageGuid: targetPart.messageGuid,
        partIndex: targetPart.partIndex,
      }
    : null;
  // The narrow helper command admits only plain-text replies to exact part zero in an existing DM.
  // Reject stale/direct callers before capability lookup, durable admission, or scheduled handoff.
  if (target && isRcsChatGuid(args.chatGuid)) {
    throw new Error('This server cannot send an RCS threaded reply.');
  }
  if (target && target.partIndex !== 0) {
    throw new Error('An iMessage reply needs exact message part zero.');
  }
  if (
    target &&
    (args.text.trim().length === 0 ||
      args.text.includes('\u0000') ||
      utf8Decode(utf8Encode(args.text)) !== args.text ||
      utf8Encode(args.text).byteLength > MAX_SEND_ATTACHMENT_TEXT_BYTES)
  ) {
    throw new Error(
      'An iMessage reply must be nonblank, well-formed text without NUL and no more than 65,536 UTF-8 bytes.',
    );
  }
  if (target && scheduledHandover) {
    throw new Error('Scheduled replies are not supported.');
  }
  const hasRetiredRichFields =
    args.effectId !== undefined ||
    args.subject !== undefined ||
    (target ? args.mentions !== undefined : !!args.mentions?.length);
  if (hasRetiredRichFields) {
    throw new Error('Private API message features were retired in this release.');
  }
  const tempGuid = generateTempGuid();
  const effectiveCommitGuard = scheduledHandover?.commitGuard ?? ordinaryCommitGuard;
  const transport = pinSendTransport(http, effectiveCommitGuard);
  const rcsChat = isRcsChatGuid(args.chatGuid);
  const candidatePlainTextHeader =
    !rcsChat && target == null ? await getChatHeader(db, args.chatGuid) : null;
  const provenPlainTextChat = isProvenOneToOneIMessageChat(candidatePlainTextHeader);
  const capability = await resolveRcsAttemptOwnership(
    transport.http,
    args.chatGuid,
    transport.admissionGuard,
    capabilitySource,
    { requireServerInfo: rcsChat || target != null || provenPlainTextChat },
  );
  const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
  if (rcsChat && capability.serverInfo?.rcs !== true) {
    throw new RcsCapabilityUnavailableError(
      'This server cannot send RCS messages without RCS support.',
    );
  }
  const targetAuthorization = target
    ? Object.freeze({ allowsLegacyPartZero: false, isCurrent: capabilityGuard })
    : undefined;
  const authorizedTarget = target ? { ...target, serverAuthorization: targetAuthorization } : null;
  if (authorizedTarget) {
    if (capability.serverInfo?.supports_imessage_replies !== true) {
      throw new Error('This server cannot send iMessage replies.');
    }
    const header = await getChatHeader(db, args.chatGuid);
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    if (!isProvenOneToOneIMessageChat(header)) {
      throw new Error('A proven existing one-to-one iMessage chat is required.');
    }
  }
  const useIMessagePlainText =
    provenPlainTextChat && capability.serverInfo?.supports_imessage_plain_text === true;
  if (useIMessagePlainText) {
    requireIMessagePlainTextRequest({ chatGuid: args.chatGuid, message: args.text, tempGuid });
  }
  const outgoing = {
    tempGuid,
    chatGuid: args.chatGuid,
    text: args.text,
    now,
    selectedMessageGuid: target?.messageGuid,
    partIndex: target?.partIndex,
    threadOriginatorGuid: target?.messageGuid,
    attemptAware: capability.attemptAware,
    imessagePlainTextV1: useIMessagePlainText,
  };
  const { attemptOwnerToken } = scheduledHandover
    ? await handoverScheduledTextToOutgoing(
        db,
        {
          scheduledId: scheduledHandover.scheduledId,
          transition: scheduledHandover.transition,
          outgoing,
        },
        capabilityGuard,
      )
    : await withDbTransaction(
        db,
        async (context) => {
          const resolvedTarget = authorizedTarget
            ? await resolveMessageTargetWithinTransaction(context, authorizedTarget)
            : null;
          if (authorizedTarget && resolvedTarget?.basis !== 'exact-topology') {
            throw new MessageTargetUnavailableError();
          }
          return insertOutgoingTextWithinTransaction(context, {
            ...outgoing,
            selectedMessageGuid: resolvedTarget?.messageGuid,
            partIndex: resolvedTarget?.partIndex,
            threadOriginatorGuid: resolvedTarget?.messageGuid,
          });
        },
        capabilityGuard,
      );
  await onQueued?.(tempGuid);

  // The guarded handoff may have committed just before Disconnect revoked this account. Re-check
  // synchronously at the network boundary so account A's text can never start a request using
  // account B's newly-live client configuration. There is no await between this check and the
  // call into HttpClient, so JavaScript cannot interleave a session change inside that gap.
  if (effectiveCommitGuard && !effectiveCommitGuard()) {
    throw new DbCommitGuardRejectedError();
  }

  let networkStarted = false;
  try {
    const finalTarget = authorizedTarget
      ? await resolveMessageTarget(db, authorizedTarget, capabilityGuard)
      : null;
    if (authorizedTarget && finalTarget?.basis !== 'exact-topology') {
      await retireUnavailableMessageTarget(db, tempGuid, capabilityGuard);
      return { tempGuid };
    }
    transport.assertNetworkCurrent();
    if (effectiveCommitGuard && !effectiveCommitGuard()) {
      throw new DbCommitGuardRejectedError();
    }
    if (capabilitySource?.kind === 'session' && !capabilitySource.isCurrent()) {
      throw new DbCommitGuardRejectedError();
    }
    const method = target ? undefined : chooseSendMethod(false);
    networkStarted = true;
    const server = useIMessagePlainText
      ? await sendIMessagePlainText(transport.http, {
          chatGuid: args.chatGuid,
          tempGuid,
          message: args.text,
        })
      : await sendText(transport.http, {
          chatGuid: args.chatGuid,
          tempGuid,
          clientAttemptGeneration: attemptOwnerToken?.generation,
          message: args.text,
          selectedMessageGuid: finalTarget?.messageGuid,
          partIndex: finalTarget?.partIndex,
          method,
        });
    if (
      target &&
      (typeof server.guid !== 'string' ||
        server.guid.trim().length === 0 ||
        server.guid.trim() !== server.guid ||
        server.guid === tempGuid ||
        server.guid === finalTarget?.messageGuid ||
        utf8Encode(server.guid).byteLength > 1_024 ||
        utf8Decode(utf8Encode(server.guid)) !== server.guid ||
        server.viaPrivateApi !== true)
    ) {
      throw new ApiError('parse_error', 'iMessage reply acknowledgement was incomplete');
    }
    await reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard, {
      attemptOwnerToken: attemptOwnerToken ?? undefined,
      expectedChatGuid: args.chatGuid,
    });
  } catch (e) {
    if (e instanceof DbCommitGuardRejectedError) {
      if (
        !useIMessagePlainText ||
        networkStarted ||
        (effectiveCommitGuard && !effectiveCommitGuard())
      ) {
        throw e;
      }
    }
    const retrySafePlainText =
      useIMessagePlainText && (!networkStarted || isRetryableIMessagePlainTextUnavailable(e));
    await handleSendFailure(
      db,
      tempGuid,
      e,
      'send',
      args.chatGuid,
      undefined,
      effectiveCommitGuard,
      {
        attemptOwnerToken: attemptOwnerToken ?? undefined,
        ...(retrySafePlainText
          ? { imessagePlainTextRetrySafe: true }
          : useIMessagePlainText
            ? { terminalUncertainKind: 'plain' as const }
            : target
              ? { terminalUncertainKind: 'reply' as const }
              : {}),
      },
    );
  }

  return { tempGuid };
}
