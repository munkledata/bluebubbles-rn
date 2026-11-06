import { sendReaction } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import { canSendRestoredIMessageTapback, restoredChatKind } from '@core/models';
import type { ServerInfo } from '@core/models';
import { parseReactionType } from '@core/reactions/reactionType';
import {
  explicitMessageTargetPart,
  getChatHeader,
  MessageTargetUnavailableError,
  resolveMessageTarget,
  type MessageTargetServerAuthorization,
} from '@db/repositories';
import { DbCommitGuardRejectedError, type DbCommitGuard } from '@db/transaction';
import type { ReadDb } from '@db/types';
import { isProvenIMessageGroupChat, isProvenOneToOneIMessageChat } from '@utils';
import { utf8Encode } from '@utils/bytes';
import { graphemeBoundaries } from '@utils/grapheme';
import { messageTargetCommitGuard } from './rcsAttemptCapability';
import type { SendReactionArgs } from './sendReactionService';
import { generateTempGuid } from './sendService';

/** One emoji tapback glyph: one grapheme cluster, at most 64 UTF-8 bytes, no controls. */
function isSingleTapbackEmoji(value: string | undefined): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;
  if (utf8Encode(value).byteLength > 64) return false;
  // One grapheme cluster has exactly two boundaries: its start and its end.
  return graphemeBoundaries(value).size === 2;
}

/**
 * FP-006 tapback: a group, emoji and/or part > 0 tapback through the server's existing
 * `/message/react` route, which hands it to the restored helper command only while every switch the
 * request needs is on. Like the reviewed one-to-one tapback it has no optimistic row and no retry
 * queue: an acknowledgement-lost tapback may already have been sent.
 *
 * `allowRestoredTapback` re-reads the live capability, so a switch turned off (or an account
 * change) between the tap and the request refuses the send instead of letting the server refuse it.
 */
export async function sendRestoredIMessageReactionMessage(
  db: ReadDb,
  http: HttpClient,
  args: SendReactionArgs,
  commitGuard: DbCommitGuard,
  serverAuthorization: MessageTargetServerAuthorization | undefined,
  currentServerInfo: () => ServerInfo | null | undefined,
): Promise<{ guid: string }> {
  const parsed = parseReactionType(args.reaction);
  const emoji = parsed?.baseType === 'emoji';
  const partIndex = args.partIndex;
  const request = { chatGuid: args.chatGuid, reaction: args.reaction, partIndex: partIndex ?? 0 };
  if (
    !parsed ||
    restoredChatKind(args.chatGuid) === undefined ||
    partIndex === undefined ||
    !Number.isSafeInteger(partIndex) ||
    partIndex < 0 ||
    partIndex > 63 ||
    (emoji ? !isSingleTapbackEmoji(args.emoji) : args.emoji !== undefined) ||
    !canSendRestoredIMessageTapback(currentServerInfo(), request)
  ) {
    throw new Error('This iMessage reaction is unavailable.');
  }
  const targetPart = explicitMessageTargetPart(args.targetGuid, partIndex);
  if (!targetPart) throw new MessageTargetUnavailableError();
  const targetCommitGuard = messageTargetCommitGuard(commitGuard, serverAuthorization);
  const finalTarget = await resolveMessageTarget(
    db,
    {
      chatGuid: args.chatGuid,
      messageGuid: targetPart.messageGuid,
      partIndex: targetPart.partIndex,
      serverAuthorization,
    },
    targetCommitGuard,
  );
  if (!finalTarget || finalTarget.basis !== 'exact-topology') {
    throw new MessageTargetUnavailableError();
  }
  // Re-prove the chat itself, as the restored reply does: an `any;+;` guid alone fits SMS and RCS
  // groups too, so only the stored all-iMessage participant set admits a group tapback.
  const header = await getChatHeader(db, args.chatGuid);
  const provenChat =
    restoredChatKind(args.chatGuid) === 'group'
      ? header?.guid === args.chatGuid &&
        isProvenIMessageGroupChat(header, { allowAnyGroupPrefix: true })
      : isProvenOneToOneIMessageChat(header);
  if (!provenChat) throw new Error('This iMessage reaction is unavailable.');
  if (!canSendRestoredIMessageTapback(currentServerInfo(), request) || !commitGuard()) {
    throw new DbCommitGuardRejectedError();
  }
  const ack = await sendReaction(
    http,
    {
      chatGuid: args.chatGuid,
      selectedMessageGuid: finalTarget.messageGuid,
      reaction: args.reaction,
      ...(emoji ? { emoji: args.emoji } : {}),
      partIndex: finalTarget.partIndex,
      ...(currentServerInfo()?.supports_imessage_reaction_temp_guid === true
        ? { tempGuid: generateTempGuid() }
        : {}),
    },
    { restoredTapback: true },
  );
  if (!ack.guid || ack.guid === finalTarget.messageGuid) {
    throw new Error('Reaction delivery could not be confirmed. Check the conversation.');
  }
  return { guid: ack.guid };
}
