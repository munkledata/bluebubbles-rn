import { editMessage, unsendMessage } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import {
  applyLocalEdit,
  applyLocalUnsend,
  clearLocalUnsend,
  getChatGuidByMessageGuid,
  getMessageTextByGuid,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';

export interface SendEditArgs {
  messageGuid: string;
  newText: string;
  /** Chat the message lives in (server-required). Resolved from the DB row when omitted. */
  chatGuid?: string;
}

/**
 * Optimistic edit: snapshot the prior text, apply locally (UI shows the new text
 * + "Edited"), POST, and revert on failure so the bubble never lies. Pure
 * orchestration (no RN imports) → Node-testable against better-sqlite3.
 */
export async function sendEdit(
  db: AppDatabase,
  http: HttpClient,
  args: SendEditArgs,
  now: number = Date.now(),
): Promise<{ ok: boolean }> {
  // The edit route requires chatGuid; resolve from the message's DB row when not supplied.
  const chatGuid = args.chatGuid ?? (await getChatGuidByMessageGuid(db, args.messageGuid));
  if (!chatGuid) return { ok: false }; // unknown chat → can't satisfy the server contract
  const prev = await getMessageTextByGuid(db, args.messageGuid);
  await applyLocalEdit(db, args.messageGuid, args.newText, now);
  try {
    // The server returns the sender's send ack `{ guid? }`. A present guid is the
    // Private-API confirmation that the edit went through; treat its absence as a
    // soft failure and revert (edits require the Private API, so no guid = no edit).
    const ack = await editMessage(http, {
      chatGuid,
      messageGuid: args.messageGuid,
      editedMessage: args.newText,
      backwardsCompatibilityMessage: `Edited to: “${args.newText}”`,
      partIndex: 0,
    });
    if (!ack.guid) {
      if (prev) await applyLocalEdit(db, args.messageGuid, prev.text ?? '', prev.dateEdited ?? 0);
      return { ok: false };
    }
    return { ok: true };
  } catch {
    if (prev) await applyLocalEdit(db, args.messageGuid, prev.text ?? '', prev.dateEdited ?? 0);
    return { ok: false };
  }
}

export interface SendUnsendArgs {
  messageGuid: string;
  /** Chat the message lives in (server-required). Resolved from the DB row when omitted. */
  chatGuid?: string;
}

/** Optimistic unsend: mark retracted locally, POST, clear the mark on failure. */
export async function sendUnsend(
  db: AppDatabase,
  http: HttpClient,
  args: SendUnsendArgs,
  now: number = Date.now(),
): Promise<{ ok: boolean }> {
  // The unsend route requires chatGuid; resolve from the message's DB row when not supplied.
  const chatGuid = args.chatGuid ?? (await getChatGuidByMessageGuid(db, args.messageGuid));
  if (!chatGuid) return { ok: false }; // unknown chat → can't satisfy the server contract
  await applyLocalUnsend(db, args.messageGuid, now);
  try {
    // The server returns a status object `{ unsent: true }`; derive ok from it (a
    // 2xx that didn't actually unsend → revert the local retraction).
    const ack = await unsendMessage(http, {
      chatGuid,
      messageGuid: args.messageGuid,
      partIndex: 0,
    });
    if (ack.unsent === false) {
      await clearLocalUnsend(db, args.messageGuid);
      return { ok: false };
    }
    return { ok: true };
  } catch {
    await clearLocalUnsend(db, args.messageGuid);
    return { ok: false };
  }
}
