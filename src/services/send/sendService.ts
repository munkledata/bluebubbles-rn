import type { HttpClient } from '@core/api/http';
import { sendText, type MessageMention } from '@core/api/endpoints/messages';
import {
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
import { isRcsChatGuid } from '@utils/chat';
import {
  messageTargetCommitGuard,
  messageTargetServerAuthorization,
  resolveRcsAttemptOwnership,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import {
  handleSendFailure,
  reconcileSendOutcome,
  retireUnavailableMessageTarget,
} from './sendOutcome';
import { pinSendTransport } from './sendTransport';

/**
 * Pick the send method (mirrors Flutter http_service): effects/replies/edits REQUIRE the
 * Private API; a plain text send falls back to AppleScript on a stock server (Private API
 * off) instead of failing outright.
 */
export function chooseSendMethod(
  needsPrivateApi: boolean,
  privateApiEnabled: boolean,
): 'private-api' | 'apple-script' {
  return needsPrivateApi || privateApiEnabled ? 'private-api' : 'apple-script';
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
  // The Google Messages bridge sends ordinary RCS text and ignores Apple's reply identity.
  // Reject stale/direct callers before capability lookup, durable admission, or scheduled handoff.
  if (target && isRcsChatGuid(args.chatGuid)) {
    throw new Error('This server cannot send an RCS threaded reply.');
  }
  const tempGuid = generateTempGuid();
  const effectiveCommitGuard = scheduledHandover?.commitGuard ?? ordinaryCommitGuard;
  const transport = pinSendTransport(http, effectiveCommitGuard);
  const capability = await resolveRcsAttemptOwnership(
    transport.http,
    args.chatGuid,
    transport.admissionGuard,
    capabilitySource,
    { requireServerInfo: target != null },
  );
  const authorizedTarget = target
    ? {
        ...target,
        serverAuthorization: messageTargetServerAuthorization(
          capability.serverInfo,
          transport.admissionGuard,
        ),
      }
    : null;
  const targetCommitGuard = messageTargetCommitGuard(
    effectiveCommitGuard,
    authorizedTarget?.serverAuthorization,
  );
  const outgoing = {
    tempGuid,
    chatGuid: args.chatGuid,
    text: args.text,
    now,
    selectedMessageGuid: target?.messageGuid,
    partIndex: target?.partIndex,
    // A reply targets the selected message; persist it locally so the optimistic
    // bubble shows its quote before the server echo.
    threadOriginatorGuid: target?.messageGuid,
    effectId: args.effectId,
    // Persist the subject so the optimistic bubble shows it before the server echo.
    subject: args.subject,
    // Into the queue payload only, so a crash-recovery resend keeps the spans.
    mentions: args.mentions,
    attemptAware: capability.attemptAware,
  };
  const { attemptOwnerToken } = scheduledHandover
    ? await handoverScheduledTextToOutgoing(
        db,
        {
          scheduledId: scheduledHandover.scheduledId,
          transition: scheduledHandover.transition,
          outgoing,
        },
        transport.admissionGuard,
        authorizedTarget?.serverAuthorization,
      )
    : await withDbTransaction(
        db,
        async (context) => {
          const resolvedTarget = authorizedTarget
            ? await resolveMessageTargetWithinTransaction(context, authorizedTarget)
            : null;
          if (authorizedTarget && !resolvedTarget) throw new MessageTargetUnavailableError();
          return insertOutgoingTextWithinTransaction(context, {
            ...outgoing,
            selectedMessageGuid: resolvedTarget?.messageGuid,
            partIndex: resolvedTarget?.partIndex,
            threadOriginatorGuid: resolvedTarget?.messageGuid,
          });
        },
        transport.admissionGuard,
      );
  await onQueued?.(tempGuid);

  // The guarded handoff may have committed just before Disconnect revoked this account. Re-check
  // synchronously at the network boundary so account A's text can never start a request using
  // account B's newly-live client configuration. There is no await between this check and the
  // call into HttpClient, so JavaScript cannot interleave a session change inside that gap.
  if (effectiveCommitGuard && !effectiveCommitGuard()) {
    throw new DbCommitGuardRejectedError();
  }

  try {
    const finalTarget = authorizedTarget
      ? await resolveMessageTarget(db, authorizedTarget, targetCommitGuard)
      : null;
    if (authorizedTarget && !finalTarget) {
      await retireUnavailableMessageTarget(db, tempGuid, targetCommitGuard);
      return { tempGuid };
    }
    transport.assertNetworkCurrent();
    // Subject lines + mentions, like replies/effects, are Private-API-only features.
    const method = chooseSendMethod(
      target != null || !!args.effectId || !!args.subject || !!args.mentions?.length,
      capability.serverInfo?.private_api === true,
    );
    const server = await sendText(transport.http, {
      chatGuid: args.chatGuid,
      tempGuid,
      clientAttemptGeneration: attemptOwnerToken?.generation,
      message: args.text,
      selectedMessageGuid: finalTarget?.messageGuid,
      partIndex: finalTarget?.partIndex,
      effectId: args.effectId,
      subject: args.subject,
      mentions: args.mentions,
      method,
    });
    await reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard, {
      attemptOwnerToken: attemptOwnerToken ?? undefined,
    });
  } catch (e) {
    if (e instanceof DbCommitGuardRejectedError) throw e;
    await handleSendFailure(
      db,
      tempGuid,
      e,
      'send',
      args.chatGuid,
      undefined,
      effectiveCommitGuard,
      { attemptOwnerToken: attemptOwnerToken ?? undefined },
    );
  }

  return { tempGuid };
}
