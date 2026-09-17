import { sendReaction } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import {
  explicitMessageTargetPart,
  insertOutgoingReactionWithinTransaction,
  MessageTargetUnavailableError,
  resolveMessageTarget,
  resolveMessageTargetWithinTransaction,
  type MessageTargetServerAuthorization,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isRcsChatGuid } from '@utils/chat';
import {
  handleSendFailure,
  reconcileSendOutcome,
  retireUnavailableMessageTarget,
} from './sendOutcome';
import { messageTargetCommitGuard } from './rcsAttemptCapability';
import { generateTempGuid } from './sendService';

export interface SendReactionArgs {
  chatGuid: string;
  targetGuid: string;
  /** 'love' | 'like' | … or '-love' etc. to remove; 'emoji'/'-emoji' for an arbitrary emoji. */
  reaction: string;
  /** The glyph for an 'emoji'/'-emoji' tapback (required then, absent for classic types). */
  emoji?: string;
  /** Exact target message part. Legacy part zero must still be supplied explicitly. */
  partIndex?: number;
  selectedMessageText?: string;
}

/**
 * Optimistic tapback send: inserts an associated message row (`sending`) + a
 * queue row, POSTs /message/react, then reconciles by tempGuid. Add/remove is
 * just the `reaction` string ('love' vs '-love'); the reactive cluster collapses
 * them. Mirrors sendTextMessage (Node-testable, no RN imports).
 */
export async function sendReactionMessage(
  db: AppDatabase,
  http: HttpClient,
  args: SendReactionArgs,
  now: number = Date.now(),
  commitGuard?: DbCommitGuard,
  serverAuthorization?: MessageTargetServerAuthorization,
): Promise<{ tempGuid: string }> {
  if (!isRcsChatGuid(args.chatGuid)) {
    throw new Error('iMessage reactions were retired with the Private API helper.');
  }
  const targetPart = explicitMessageTargetPart(args.targetGuid, args.partIndex);
  if (!targetPart) throw new MessageTargetUnavailableError();
  const target = {
    chatGuid: args.chatGuid,
    messageGuid: targetPart.messageGuid,
    partIndex: targetPart.partIndex,
    serverAuthorization,
    allowRcsWholeMessage: true,
  };
  const targetCommitGuard = messageTargetCommitGuard(commitGuard, serverAuthorization);
  const tempGuid = generateTempGuid();
  await withDbTransaction(
    db,
    async (context) => {
      const resolvedTarget = await resolveMessageTargetWithinTransaction(context, target);
      if (!resolvedTarget) throw new MessageTargetUnavailableError();
      return insertOutgoingReactionWithinTransaction(context, {
        tempGuid,
        chatGuid: args.chatGuid,
        targetGuid: resolvedTarget.messageGuid,
        reaction: args.reaction,
        emoji: args.emoji,
        partIndex: resolvedTarget.partIndex,
        selectedMessageText: args.selectedMessageText,
        now,
      });
    },
    targetCommitGuard,
  );

  // The owner may have committed just before Disconnect retired this account. Do not let that old
  // continuation start a request with the next account's live credential boundary.
  if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();

  const finalTarget = await resolveMessageTarget(db, target, targetCommitGuard);
  if (!finalTarget) {
    await retireUnavailableMessageTarget(db, tempGuid, targetCommitGuard);
    return { tempGuid };
  }

  try {
    if (serverAuthorization && !serverAuthorization.isCurrent()) {
      throw new DbCommitGuardRejectedError();
    }
    const server = await sendReaction(http, {
      chatGuid: args.chatGuid,
      selectedMessageGuid: finalTarget.messageGuid,
      reaction: args.reaction,
      emoji: args.emoji,
      partIndex: finalTarget.partIndex,
    });
    // RCS reactions return the same send acknowledgement shape as other message writes.
    await reconcileSendOutcome(db, tempGuid, server, now, commitGuard);
  } catch (e) {
    // A revoked success-settlement owner must not be reinterpreted as a transport failure and
    // followed by a second stale-account database write attempt.
    if (e instanceof DbCommitGuardRejectedError) throw e;
    await handleSendFailure(
      db,
      tempGuid,
      e,
      'send-reaction',
      args.chatGuid,
      undefined,
      commitGuard,
    );
  }

  return { tempGuid };
}
