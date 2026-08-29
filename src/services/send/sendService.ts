import type { HttpClient } from '@core/api/http';
import { sendText, type MessageMention } from '@core/api/endpoints/messages';
import {
  handoverScheduledTextToOutgoing,
  insertOutgoingTextWithinTransaction,
  type ScheduledTextHandoverTransition,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { sessionAccessors } from '@state/sessionStore';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';

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
  onQueued?: () => Promise<void> | void,
  scheduledHandover?: ScheduledTextHandover,
  ordinaryCommitGuard?: DbCommitGuard,
): Promise<{ tempGuid: string }> {
  const tempGuid = generateTempGuid();
  const outgoing = {
    tempGuid,
    chatGuid: args.chatGuid,
    text: args.text,
    now,
    selectedMessageGuid: args.selectedMessageGuid,
    partIndex: args.selectedMessageGuid ? args.partIndex : undefined,
    // A reply targets the selected message; persist it locally so the optimistic
    // bubble shows its quote before the server echo.
    threadOriginatorGuid: args.selectedMessageGuid,
    effectId: args.effectId,
    // Persist the subject so the optimistic bubble shows it before the server echo.
    subject: args.subject,
    // Into the queue payload only, so a crash-recovery resend keeps the spans.
    mentions: args.mentions,
  };
  const effectiveCommitGuard = scheduledHandover?.commitGuard ?? ordinaryCommitGuard;
  if (scheduledHandover) {
    await handoverScheduledTextToOutgoing(
      db,
      {
        scheduledId: scheduledHandover.scheduledId,
        transition: scheduledHandover.transition,
        outgoing,
      },
      scheduledHandover.commitGuard,
    );
  } else {
    await withDbTransaction(
      db,
      (context) => insertOutgoingTextWithinTransaction(context, outgoing),
      effectiveCommitGuard,
    );
  }
  await onQueued?.();

  // The guarded handoff may have committed just before Disconnect revoked this account. Re-check
  // synchronously at the network boundary so account A's text can never start a request using
  // account B's newly-live client configuration. There is no await between this check and the
  // call into HttpClient, so JavaScript cannot interleave a session change inside that gap.
  if (effectiveCommitGuard && !effectiveCommitGuard()) {
    throw new DbCommitGuardRejectedError();
  }

  try {
    // Subject lines + mentions, like replies/effects, are Private-API-only features.
    const method = chooseSendMethod(
      !!args.selectedMessageGuid || !!args.effectId || !!args.subject || !!args.mentions?.length,
      sessionAccessors.privateApiEnabled(),
    );
    const server = await sendText(http, {
      chatGuid: args.chatGuid,
      tempGuid,
      message: args.text,
      selectedMessageGuid: args.selectedMessageGuid,
      partIndex: args.selectedMessageGuid ? args.partIndex : undefined,
      effectId: args.effectId,
      subject: args.subject,
      mentions: args.mentions,
      method,
    });
    await reconcileSendOutcome(db, tempGuid, server, now, effectiveCommitGuard);
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
    );
  }

  return { tempGuid };
}
