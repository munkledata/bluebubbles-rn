import { sendReaction } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import { insertOutgoingReactionWithinTransaction } from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';
import { generateTempGuid } from './sendService';

export interface SendReactionArgs {
  chatGuid: string;
  targetGuid: string;
  /** 'love' | 'like' | … or '-love' etc. to remove; 'emoji'/'-emoji' for an arbitrary emoji. */
  reaction: string;
  /** The glyph for an 'emoji'/'-emoji' tapback (required then, absent for classic types). */
  emoji?: string;
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
): Promise<{ tempGuid: string }> {
  const tempGuid = generateTempGuid();
  await withDbTransaction(
    db,
    (context) =>
      insertOutgoingReactionWithinTransaction(context, {
        tempGuid,
        chatGuid: args.chatGuid,
        targetGuid: args.targetGuid,
        reaction: args.reaction,
        emoji: args.emoji,
        selectedMessageText: args.selectedMessageText,
        now,
      }),
    commitGuard,
  );

  // The owner may have committed just before Disconnect retired this account. Do not let that old
  // continuation start a request with the next account's live credential boundary.
  if (commitGuard && !commitGuard()) throw new DbCommitGuardRejectedError();

  try {
    const server = await sendReaction(http, {
      chatGuid: args.chatGuid,
      selectedMessageGuid: args.targetGuid,
      reaction: args.reaction,
      emoji: args.emoji,
    });
    // Reactions require the Private API, so the ack carries the real GUID on success.
    await reconcileSendOutcome(db, tempGuid, server, now, commitGuard);
  } catch (e) {
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
