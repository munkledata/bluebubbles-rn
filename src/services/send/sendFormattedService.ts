import {
  isDefiniteIMessageFormattedError,
  requireIMessageFormattedContent,
  sendFormatted,
  type IMessageTextFormattingRange,
} from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import {
  discardOutgoingMessageWithinTransaction,
  getChatHeader,
  insertOutgoingTextWithinTransaction,
} from '@db/repositories';
import {
  DbCommitGuardRejectedError,
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isProvenOneToOneIMessageChat } from '@utils';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';
import { generateTempGuid } from './sendService';
import { pinSendTransport } from './sendTransport';

export interface SendFormattedArgs {
  chatGuid: string;
  text: string;
  textFormatting: readonly IMessageTextFormattingRange[];
}

export type SendFormattedResult =
  | { readonly status: 'accepted'; readonly tempGuid: string }
  | { readonly status: 'rejected'; readonly tempGuid?: string }
  | { readonly status: 'outcome-unknown'; readonly tempGuid: string };

/** Formatted sends are destructive one-shot work: never queue two attempts for one chat. */
const activeFormattedSends = new WeakMap<AppDatabase, Set<string>>();

function claimFormattedSend(db: AppDatabase, chatGuid: string): boolean {
  let active = activeFormattedSends.get(db);
  if (!active) {
    active = new Set();
    activeFormattedSends.set(db, active);
  }
  if (active.has(chatGuid)) return false;
  active.add(chatGuid);
  return true;
}

function releaseFormattedSend(db: AppDatabase, chatGuid: string): void {
  const active = activeFormattedSends.get(db);
  active?.delete(chatGuid);
  if (active?.size === 0) activeFormattedSends.delete(db);
}

function exactFormattedTargetWithinTransaction(
  context: DbTransactionContext,
  chatGuid: string,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const header = await getChatHeader(db, chatGuid);
    return header?.guid === chatGuid && isProvenOneToOneIMessageChat(header);
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

class FormattedTargetRejectedError extends Error {
  constructor() {
    super('The exact formatted iMessage target is unavailable.');
    this.name = 'FormattedTargetRejectedError';
  }
}

/** Admit, dispatch, and settle one bounded formatted message without any automatic replay. */
export async function sendIMessageFormatted(
  db: AppDatabase,
  http: HttpClient,
  args: SendFormattedArgs,
  now: number = Date.now(),
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<SendFormattedResult> {
  requireIMessageFormattedContent(args.chatGuid, args.text, args.textFormatting);
  const request: SendFormattedArgs = {
    chatGuid: args.chatGuid,
    text: args.text,
    textFormatting: args.textFormatting.map((range) => ({
      ...range,
      styles: [...range.styles],
    })),
  };
  if (!claimFormattedSend(db, request.chatGuid)) return { status: 'rejected' };

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
    if (capability.serverInfo?.supports_imessage_formatted_messages !== true) {
      return { status: 'rejected' };
    }

    const tempGuid = generateTempGuid();
    try {
      await withDbTransaction(
        db,
        async (context) => {
          if (!(await exactFormattedTargetWithinTransaction(context, request.chatGuid))) {
            throw new FormattedTargetRejectedError();
          }
          await insertOutgoingTextWithinTransaction(context, {
            tempGuid,
            chatGuid: request.chatGuid,
            text: request.text,
            textFormatting: request.textFormatting.map((range) => ({
              ...range,
              styles: [...range.styles],
            })),
            now,
            oneShotFormatted: true,
          });
        },
        capabilityGuard,
      );
    } catch (error) {
      if (error instanceof FormattedTargetRejectedError) return { status: 'rejected' };
      throw error;
    }

    const retireOutcomeUnknown = async (error: unknown): Promise<SendFormattedResult> => {
      if (accountSettlementGuard()) {
        try {
          await handleSendFailure(
            db,
            tempGuid,
            error,
            'send-formatted',
            request.chatGuid,
            undefined,
            accountSettlementGuard,
            { terminalUncertainKind: 'formatted', expectedChatGuid: request.chatGuid },
          );
        } catch {
          // The durable one-shot marker remains authoritative for crash recovery.
        }
      }
      return { status: 'outcome-unknown', tempGuid };
    };

    try {
      const targetCurrent = await withDbTransaction(
        db,
        async (context) => {
          const current = await exactFormattedTargetWithinTransaction(context, request.chatGuid);
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
    } catch (error) {
      if (!capabilityGuard() || error instanceof DbCommitGuardRejectedError) {
        return retireOutcomeUnknown(error);
      }
      try {
        await discardDefiniteAttempt(db, tempGuid, now, capabilityGuard);
        return { status: 'rejected', tempGuid };
      } catch (settlementError) {
        if (!capabilityGuard()) return retireOutcomeUnknown(settlementError);
        throw settlementError;
      }
    }

    try {
      const ack = await sendFormatted(transport.http, {
        chatGuid: request.chatGuid,
        tempGuid,
        message: request.text,
        textFormatting: request.textFormatting.map((range) => ({
          ...range,
          styles: [...range.styles],
        })),
      });
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      await reconcileSendOutcome(db, tempGuid, ack, now, capabilityGuard, {
        expectedChatGuid: request.chatGuid,
      });
      return { status: 'accepted', tempGuid };
    } catch (error) {
      if (!capabilityGuard()) return retireOutcomeUnknown(error);
      if (isDefiniteIMessageFormattedError(error)) {
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
    releaseFormattedSend(db, request.chatGuid);
  }
}
