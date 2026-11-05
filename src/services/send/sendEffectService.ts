import { sendEffect } from '@core/api/endpoints/messages';
import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { isSupportedIMessageEffectId } from '@core/effects';
import { canUseRestoredIMessageGroupFeature, restoredChatKind } from '@core/models';
import type { ServerInfo } from '@core/models';
import {
  discardOutgoingMessageWithinTransaction,
  getChatHeader,
  insertOutgoingTextWithinTransaction,
} from '@db/repositories';
import { DbCommitGuardRejectedError, withDbTransaction, type DbCommitGuard } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import { isProvenIMessageGroupChat, isProvenOneToOneIMessageChat } from '@utils';
import { utf8Decode, utf8Encode } from '@utils/bytes';
import {
  resolveRcsAttemptOwnership,
  sendCapabilityCommitGuard,
  type RcsCapabilitySource,
} from './rcsAttemptCapability';
import { handleSendFailure, reconcileSendOutcome } from './sendOutcome';
import { generateTempGuid } from './sendService';
import { pinSendTransport } from './sendTransport';

const EFFECT_TEXT_MAX_BYTES = 65_536;
const EFFECT_ID_MAX_BYTES = 1_024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const DEFINITE_EFFECT_FAILURES = new Set([
  'imessage_effect_invalid_target',
  'imessage_effect_unavailable',
  'imessage_effect_rejected',
]);

export interface SendEffectArgs {
  /** An existing one-to-one iMessage chat, or (FP-006) an all-iMessage group. */
  chatGuid: string;
  text: string;
  effectId: string;
}

export type SendEffectResult =
  | { readonly status: 'accepted'; readonly tempGuid: string }
  | { readonly status: 'rejected'; readonly tempGuid?: string }
  | { readonly status: 'outcome-unknown'; readonly tempGuid: string };

/** Effect sends are destructive one-shot work: never queue a second call behind an active one. */
const activeEffects = new WeakMap<AppDatabase, Set<string>>();

function claimEffect(db: AppDatabase, chatGuid: string): boolean {
  let active = activeEffects.get(db);
  if (!active) {
    active = new Set();
    activeEffects.set(db, active);
  }
  if (active.has(chatGuid)) return false;
  active.add(chatGuid);
  return true;
}

function releaseEffect(db: AppDatabase, chatGuid: string): void {
  const active = activeEffects.get(db);
  active?.delete(chatGuid);
  if (active?.size === 0) activeEffects.delete(db);
}

function requireEffectArgs(args: SendEffectArgs): void {
  const textBytes = utf8Encode(args.text);
  const chatGuidBytes = utf8Encode(args.chatGuid);
  if (
    !/^(?:iMessage|any);[+-];.+$/u.test(args.chatGuid) ||
    args.chatGuid.trim() !== args.chatGuid ||
    CONTROL_CHARACTER.test(args.chatGuid) ||
    chatGuidBytes.byteLength === 0 ||
    chatGuidBytes.byteLength > EFFECT_ID_MAX_BYTES ||
    utf8Decode(chatGuidBytes) !== args.chatGuid ||
    args.text.trim().length === 0 ||
    args.text.includes('\u0000') ||
    textBytes.byteLength > EFFECT_TEXT_MAX_BYTES ||
    utf8Decode(textBytes) !== args.text ||
    !isSupportedIMessageEffectId(args.effectId)
  ) {
    throw new Error('This text cannot be sent with an iMessage effect.');
  }
}

/**
 * The stored row proves this exact chat: one-to-one with one participant, or (FP-006) an
 * all-iMessage group. An `any;+;` guid alone also fits SMS and RCS groups, so the participant set
 * decides, as for the restored tapback and reply.
 */
function isExactEffectChat(
  header: Awaited<ReturnType<typeof getChatHeader>>,
  chatGuid: string,
): boolean {
  if (header?.guid !== chatGuid) return false;
  if (restoredChatKind(chatGuid) === 'group') {
    return isProvenIMessageGroupChat(header, { allowAnyGroupPrefix: true });
  }
  return header.participantCount === 1 && isProvenOneToOneIMessageChat(header);
}

/** A group effect needs the group switch; a one-to-one effect needs the reviewed switch. */
function effectSwitchOn(info: ServerInfo | null | undefined, chatGuid: string): boolean {
  return restoredChatKind(chatGuid) === 'group'
    ? canUseRestoredIMessageGroupFeature(info, chatGuid, 'supports_imessage_group_effects')
    : info?.supports_imessage_effects === true;
}

function isDefiniteEffectFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.serverErrorType != null &&
    DEFINITE_EFFECT_FAILURES.has(error.serverErrorType)
  );
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

/**
 * Admit exactly one optimistic effect row, issue exactly one non-retrying POST, then either promote
 * it, remove a definitely-unsent attempt, or retain an unretryable delivery-unknown row.
 */
export async function sendIMessageEffect(
  db: AppDatabase,
  http: HttpClient,
  args: SendEffectArgs,
  now: number = Date.now(),
  accountGuard?: DbCommitGuard,
  capabilitySource?: RcsCapabilitySource,
): Promise<SendEffectResult> {
  requireEffectArgs(args);
  if (!claimEffect(db, args.chatGuid)) return { status: 'rejected' };

  try {
    const transport = pinSendTransport(http, accountGuard);
    // Capability and transport identity govern admission/network start. Once the one-shot request
    // starts, only the owning account may settle an uncertain result: a capability refresh or
    // origin rotation must not turn a possibly-dispatched effect into a retryable rejection.
    const accountSettlementGuard: DbCommitGuard = () => accountGuard?.() ?? true;
    const capability = await resolveRcsAttemptOwnership(
      transport.http,
      args.chatGuid,
      transport.admissionGuard,
      capabilitySource,
      { requireServerInfo: true },
    );
    const capabilityGuard = sendCapabilityCommitGuard(transport.admissionGuard, capabilitySource);
    if (!effectSwitchOn(capability.serverInfo, args.chatGuid)) {
      return { status: 'rejected' };
    }

    const header = await getChatHeader(db, args.chatGuid);
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    if (!isExactEffectChat(header, args.chatGuid)) return { status: 'rejected' };

    const tempGuid = generateTempGuid();
    await withDbTransaction(
      db,
      (context) =>
        insertOutgoingTextWithinTransaction(context, {
          tempGuid,
          chatGuid: args.chatGuid,
          text: args.text,
          effectId: args.effectId,
          now,
          oneShotEffect: true,
        }),
      capabilityGuard,
    );

    // Re-prove the existing exact target after DB admission, immediately before network dispatch.
    let currentHeader: Awaited<ReturnType<typeof getChatHeader>>;
    try {
      currentHeader = await getChatHeader(db, args.chatGuid);
    } catch {
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      await discardDefiniteAttempt(db, tempGuid, now, capabilityGuard);
      return { status: 'rejected', tempGuid };
    }
    if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    if (!isExactEffectChat(currentHeader, args.chatGuid)) {
      await discardDefiniteAttempt(db, tempGuid, now, capabilityGuard);
      return { status: 'rejected', tempGuid };
    }

    try {
      transport.assertNetworkCurrent();
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
    } catch (error) {
      if (error instanceof DbCommitGuardRejectedError) throw error;
      await discardDefiniteAttempt(db, tempGuid, now, capabilityGuard);
      return { status: 'rejected', tempGuid };
    }

    const retireOutcomeUnknown = async (error: unknown): Promise<SendEffectResult> => {
      if (accountSettlementGuard()) {
        try {
          await handleSendFailure(
            db,
            tempGuid,
            error,
            'send-effect',
            args.chatGuid,
            undefined,
            accountSettlementGuard,
            { terminalUncertainKind: 'effect', expectedChatGuid: args.chatGuid },
          );
        } catch {
          // The durable one-shot marker remains authoritative. Recovery retires it without replay;
          // never turn a post-dispatch settlement failure into a definitely-unsent UI result.
        }
      }
      return { status: 'outcome-unknown', tempGuid };
    };

    try {
      // All endpoint validation was already proved above. From this boundary onward, conservatively
      // assume the pinned request may have reached the server even if the await rejects immediately.
      const ack = await sendEffect(
        transport.http,
        {
          chatGuid: args.chatGuid,
          tempGuid,
          message: args.text,
          effectId: args.effectId,
        },
        { restoredGroup: restoredChatKind(args.chatGuid) === 'group' },
      );
      if (!capabilityGuard()) throw new DbCommitGuardRejectedError();
      await reconcileSendOutcome(db, tempGuid, ack, now, capabilityGuard, {
        expectedChatGuid: args.chatGuid,
      });
      return { status: 'accepted', tempGuid };
    } catch (error) {
      if (!capabilityGuard()) return retireOutcomeUnknown(error);
      if (isDefiniteEffectFailure(error)) {
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
    releaseEffect(db, args.chatGuid);
  }
}
