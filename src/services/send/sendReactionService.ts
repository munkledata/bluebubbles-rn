import { ApiError } from '@core/api/errors';
import { sendReaction } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import {
  getChatIdByGuid,
  insertOutgoingReaction,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { generateTempGuid } from './sendService';

export interface SendReactionArgs {
  chatGuid: string;
  targetGuid: string;
  /** 'love' | 'like' | … or '-love' etc. to remove an existing one. */
  reaction: string;
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
): Promise<{ tempGuid: string }> {
  const chatId = await getChatIdByGuid(db, args.chatGuid);
  if (chatId == null) throw new Error(`unknown chat ${args.chatGuid}`);

  const tempGuid = generateTempGuid();
  await insertOutgoingReaction(db, {
    tempGuid,
    chatId,
    chatGuid: args.chatGuid,
    targetGuid: args.targetGuid,
    reaction: args.reaction,
    selectedMessageText: args.selectedMessageText,
    now,
  });

  try {
    const server = await sendReaction(http, {
      chatGuid: args.chatGuid,
      selectedMessageGuid: args.targetGuid,
      selectedMessageText: args.selectedMessageText,
      reaction: args.reaction,
    });
    await reconcileOutgoingSuccess(db, tempGuid, {
      guid: server.guid,
      dateCreated: server.dateCreated ?? now,
      dateDelivered: null,
    });
  } catch (e) {
    const code = e instanceof ApiError && e.status ? e.status : -1;
    await reconcileOutgoingError(db, tempGuid, code);
  }

  return { tempGuid };
}
