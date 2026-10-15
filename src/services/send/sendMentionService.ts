import {
  isDefiniteIMessageMentionError,
  isExactIMessageMentionAddress,
  requireIMessageMentionContent,
  sendMention,
  type MessageMention,
} from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import {
  discardOutgoingMessageWithinTransaction,
  getChatHeader,
  getChatParticipants,
  insertOutgoingTextWithinTransaction,
  type ChatParticipant,
} from '@db/repositories';
import {
  DbCommitGuardRejectedError,
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isProvenIMessageGroupChat } from '@utils';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';
import { generateTempGuid } from './sendService';
import { pinSendTransport } from './sendTransport';

export interface SendMentionArgs {
  chatGuid: string;
  text: string;
  mentions: readonly MessageMention[];
}

export type SendMentionResult =
  | { readonly status: 'accepted'; readonly tempGuid: string }
  | { readonly status: 'rejected'; readonly tempGuid?: string }
  | { readonly status: 'outcome-unknown'; readonly tempGuid: string };

/** Mention sends are destructive one-shot work: never queue behind another attempt for the chat. */
const activeMentions = new WeakMap<AppDatabase, Set<string>>();

function claimMention(db: AppDatabase, chatGuid: string): boolean {
  let active = activeMentions.get(db);
  if (!active) {
    active = new Set();
    activeMentions.set(db, active);
  }
  if (active.has(chatGuid)) return false;
  active.add(chatGuid);
  return true;
}

function releaseMention(db: AppDatabase, chatGuid: string): void {
  const active = activeMentions.get(db);
  active?.delete(chatGuid);
  if (active?.size === 0) activeMentions.delete(db);
}

function isExactMentionTarget(
  header: Awaited<ReturnType<typeof getChatHeader>>,
  participants: readonly ChatParticipant[],
  chatGuid: string,
  mentions: readonly MessageMention[],
): boolean {
  if (header?.guid !== chatGuid || !isProvenIMessageGroupChat(header)) return false;
  if (
    participants.length !== header.participantCount ||
    participants.length < 2 ||
    participants.some(
      (participant) =>
        participant.service !== 'iMessage' || !isExactIMessageMentionAddress(participant.address),
    )
  ) {
    return false;
  }
  const addresses = new Set(participants.map((participant) => participant.address));
  return (
    addresses.size === participants.length &&
    mentions.every((mention) => addresses.has(mention.address))
  );
}

function exactMentionTargetWithinTransaction(
  context: DbTransactionContext,
  chatGuid: string,
  mentions: readonly MessageMention[],
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const header = await getChatHeader(db, chatGuid);
    const participants = await getChatParticipants(db, chatGuid);
    return isExactMentionTarget(header, participants, chatGuid, mentions);
  });
}

async function discardDefiniteAttempt(
  db: AppDatabase,
  tempGuid: string,
  now: number,
  commitGuard: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (context) => discardOutgoingMessageWithinTransaction(context, tempGuid, now),
    commitGuard,
  );
}

class MentionTargetRejectedError extends Error {
  constructor() {
    super('The exact iMessage mention target is unavailable.');
    this.name = 'MentionTargetRejectedError';
  }
}

/**
 * Admit one marked optimistic group message, issue one non-retrying mention POST, and never replay
 * an attempt whose dispatch outcome is uncertain.
 */
export async function sendIMessageMention(
  db: AppDatabase,
  http: HttpClient,
  args: SendMentionArgs,
  now: number = Date.now(),
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<SendMentionResult> {
  requireIMessageMentionContent(args.chatGuid, args.text, args.mentions);
  const request: SendMentionArgs = {
    chatGuid: args.chatGuid,
    text: args.text,
    mentions: args.mentions.map((mention) => ({ ...mention })),
  };
  if (!claimMention(db, request.chatGuid)) return { status: 'rejected' };

  try {
    const transport = pinSendTransport(http, accountGuard);
    const accountSettlementGuard: DbCommitGuard = () => accountGuard?.() ?? true;
    const capability = await resolveRcsAttemptOwnership(
      transport.http,
      request.chatGuid,
      transport.admissionGuard,
      capabilitySource,
      { requireServerInfo: true },
    );
    const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
    if (capability.serverInfo?.supports_imessage_mentions !== true) {
      return { status: 'rejected' };
    }

    const tempGuid = generateTempGuid();
    try {
      await withDbTransaction(
        db,
        async (context) => {
          if (
            !(await exactMentionTargetWithinTransaction(
              context,
              request.chatGuid,
              request.mentions,
            ))
          ) {
            throw new MentionTargetRejectedError();
          }
          await insertOutgoingTextWithinTransaction(context, {
            tempGuid,
            chatGuid: request.chatGuid,
            text: request.text,
            mentions: [...request.mentions],
            now,
            oneShotMention: true,
          });
        },
        capabilityGuard,
      );
    } catch (error) {
      if (error instanceof MentionTargetRejectedError) return { status: 'rejected' };
      throw error;
    }

    const retireOutcomeUnknown = async (error: unknown): Promise<SendMentionResult> => {
      if (accountSettlementGuard()) {
        try {
          await handleSendFailure(
            db,
            tempGuid,
            error,
            'send-mention',
            request.chatGuid,
            undefined,
            accountSettlementGuard,
            { terminalUncertainKind: 'mention', expectedChatGuid: request.chatGuid },
          );
        } catch {
          // The durable marker remains authoritative. Recovery retires it without replay even when
          // this account-scoped settlement can no longer commit.
        }
      }
      return { status: 'outcome-unknown', tempGuid };
    };

    // Re-prove the full exact participant set after optimistic admission and immediately before the
    // one-shot network boundary. An invalidated target is discarded only under the same live guards.
    try {
      const targetCurrent = await withDbTransaction(
        db,
        async (context) => {
          const current = await exactMentionTargetWithinTransaction(
            context,
            request.chatGuid,
            request.mentions,
          );
          if (!current) {
            await discardOutgoingMessageWithinTransaction(context, tempGuid, now);
          }
          return current;
        },
        capabilityGuard,
      );
      if (!targetCurrent) return { status: 'rejected', tempGuid };
      transport.assertNetworkCurrent();
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    } catch {
      // Nothing has been dispatched yet, so this attempt is definitely unsent even when the
      // capability or connection changed meanwhile. Discard it under the account guard alone: an
      // account teardown keeps ownership of its rows, and the result is still "not sent".
      try {
        await discardDefiniteAttempt(db, tempGuid, now, accountSettlementGuard);
      } catch (settlementError) {
        if (accountSettlementGuard()) throw settlementError;
      }
      return { status: 'rejected', tempGuid };
    }

    try {
      // All request validation is complete. From this call onward a rejected await may still mean
      // the helper dispatched the message, so only an exact acknowledgement can report acceptance.
      const ack = await sendMention(transport.http, {
        chatGuid: request.chatGuid,
        tempGuid,
        message: request.text,
        mentions: [...request.mentions],
      });
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      await reconcileSendOutcome(db, tempGuid, ack, now, capabilityGuard, {
        expectedChatGuid: request.chatGuid,
      });
      return { status: 'accepted', tempGuid };
    } catch (error) {
      if (!capabilityGuard()) return retireOutcomeUnknown(error);
      if (isDefiniteIMessageMentionError(error)) {
        try {
          await discardDefiniteAttempt(db, tempGuid, now, capabilityGuard);
          return { status: 'rejected', tempGuid };
        } catch (settlementError) {
          if (!capabilityGuard()) return retireOutcomeUnknown(settlementError);
          throw settlementError;
        }
      }
      return retireOutcomeUnknown(error);
    }
  } finally {
    releaseMention(db, request.chatGuid);
  }
}
