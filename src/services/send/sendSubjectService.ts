import {
  isDefiniteIMessageSubjectError,
  requireIMessageSubjectContent,
  sendText,
} from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import { canSendRestoredIMessageSubject, restoredChatKind } from '@core/models';
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
import type { Queryable, ReadDb } from '@db/types';
import { isProvenIMessageGroupChat, isProvenOneToOneIMessageChat } from '@utils';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';
import { generateTempGuid } from './sendService';
import { pinSendTransport } from './sendTransport';

export interface SendSubjectArgs {
  /** An existing one-to-one iMessage chat or all-iMessage group. */
  chatGuid: string;
  text: string;
  /** One nonblank line of at most 1 KiB, shown in bold above the text. */
  subject: string;
}

export type SendSubjectResult =
  | { readonly status: 'accepted'; readonly tempGuid: string }
  | { readonly status: 'rejected'; readonly tempGuid?: string }
  | { readonly status: 'outcome-unknown'; readonly tempGuid: string };

/** Subject sends are destructive one-shot work: never queue two attempts for one chat. */
const activeSubjectSends = new WeakMap<Queryable, Set<string>>();

function claimSubjectSend(db: Queryable, chatGuid: string): boolean {
  let active = activeSubjectSends.get(db);
  if (!active) {
    active = new Set();
    activeSubjectSends.set(db, active);
  }
  if (active.has(chatGuid)) return false;
  active.add(chatGuid);
  return true;
}

function releaseSubjectSend(db: Queryable, chatGuid: string): void {
  const active = activeSubjectSends.get(db);
  active?.delete(chatGuid);
  if (active?.size === 0) activeSubjectSends.delete(db);
}

/**
 * The stored row proves this exact iMessage chat: one-to-one, or a group whose members are all
 * iMessage (an `any;+;` guid alone also fits SMS and RCS groups).
 */
function exactSubjectTargetWithinTransaction(
  context: DbTransactionContext,
  chatGuid: string,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const header = await getChatHeader(db, chatGuid);
    if (header?.guid !== chatGuid) return false;
    return restoredChatKind(chatGuid) === 'group'
      ? isProvenIMessageGroupChat(header, { allowAnyGroupPrefix: true })
      : isProvenOneToOneIMessageChat(header);
  });
}

async function discardDefiniteAttempt(
  db: ReadDb,
  tempGuid: string,
  now: number,
  commitGuard: DbCommitGuard,
): Promise<void> {
  await withDbTransaction(
    db,
    (db, context) => discardOutgoingMessageWithinTransaction(context, tempGuid, now),
    commitGuard,
  );
}

class SubjectTargetRejectedError extends Error {
  constructor() {
    super('The exact iMessage subject target is unavailable.');
    this.name = 'SubjectTargetRejectedError';
  }
}

/**
 * FP-006: admit, dispatch and settle one text with a subject line, with no automatic replay. The
 * server routes it to the restored subject command only while `supports_imessage_subject` is on;
 * with the switch off it would send the text without its subject, so the switch is checked from a
 * fresh capability read before admission and the request is never retried. A definite refusal
 * removes the bubble; an unknown outcome keeps it as "may have been delivered".
 */
export async function sendIMessageSubject(
  db: ReadDb,
  http: HttpClient,
  args: SendSubjectArgs,
  now: number = Date.now(),
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<SendSubjectResult> {
  requireIMessageSubjectContent(args);
  const request: SendSubjectArgs = {
    chatGuid: args.chatGuid,
    text: args.text,
    subject: args.subject,
  };
  if (!claimSubjectSend(db, request.chatGuid)) return { status: 'rejected' };

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
    if (!canSendRestoredIMessageSubject(capability.serverInfo, request.chatGuid)) {
      return { status: 'rejected' };
    }

    const tempGuid = generateTempGuid();
    try {
      await withDbTransaction(
        db,
        async (db, context) => {
          if (!(await exactSubjectTargetWithinTransaction(context, request.chatGuid))) {
            throw new SubjectTargetRejectedError();
          }
          await insertOutgoingTextWithinTransaction(context, {
            tempGuid,
            chatGuid: request.chatGuid,
            text: request.text,
            subject: request.subject,
            now,
            oneShotSubject: true,
          });
        },
        capabilityGuard,
      );
    } catch (error) {
      if (error instanceof SubjectTargetRejectedError) return { status: 'rejected' };
      throw error;
    }

    const retireOutcomeUnknown = async (error: unknown): Promise<SendSubjectResult> => {
      if (accountSettlementGuard()) {
        try {
          await handleSendFailure(
            db,
            tempGuid,
            error,
            'send-subject',
            request.chatGuid,
            undefined,
            accountSettlementGuard,
            { terminalUncertainKind: 'plain', expectedChatGuid: request.chatGuid },
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
        async (db, context) => {
          const current = await exactSubjectTargetWithinTransaction(context, request.chatGuid);
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
      // capability or connection changed meanwhile. Discard it under the account guard alone.
      try {
        await discardDefiniteAttempt(db, tempGuid, now, accountSettlementGuard);
      } catch (settlementError) {
        if (accountSettlementGuard()) throw settlementError;
      }
      return { status: 'rejected', tempGuid };
    }

    try {
      const ack = await sendText(
        transport.http,
        {
          chatGuid: request.chatGuid,
          tempGuid,
          message: request.text,
          subject: request.subject,
        },
        { restoredSubject: true },
      );
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      await reconcileSendOutcome(db, tempGuid, ack, now, capabilityGuard, {
        expectedChatGuid: request.chatGuid,
      });
      return { status: 'accepted', tempGuid };
    } catch (error) {
      if (!capabilityGuard()) return retireOutcomeUnknown(error);
      if (isDefiniteIMessageSubjectError(error)) {
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
    releaseSubjectSend(db, request.chatGuid);
  }
}
