import { editMessage, unsendMessage } from '@core/api/endpoints/messages';
import type { HttpClient } from '@core/api/http';
import {
  applyLocalEdit,
  applyLocalUnsend,
  getChatGuidByMessageGuid,
  getMessageTextByGuid,
  revertLocalEdit,
  revertLocalUnsend,
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
      // Compare-and-set, not a blind write: an edit the server DID apply whose response was lost
      // still echoes over the socket, and that echo lands FIRST. Reverting blindly would overwrite
      // it, leaving the message reading the old wording to you and the new one to everyone else.
      // `prev.dateEdited` is passed through rather than `?? 0` — a literal 0 is not "never edited".
      if (prev) await revertLocalEdit(db, args.messageGuid, prev.text ?? '', prev.dateEdited, now);
      return { ok: false };
    }
    return { ok: true };
  } catch {
    // Same compare-and-set as above: a transport failure does NOT prove the edit wasn't applied.
    if (prev) await revertLocalEdit(db, args.messageGuid, prev.text ?? '', prev.dateEdited, now);
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
      // Compare-and-set — the privacy-relevant twin of the edit revert. If the server DID retract
      // the message and only the response was lost, a blind clear puts content the user revoked
      // from everyone back on their own screen. Guarding on our own marker leaves a server-stamped
      // retraction alone.
      await revertLocalUnsend(db, args.messageGuid, now);
      return { ok: false };
    }
    return { ok: true };
  } catch {
    // Same compare-and-set as above: a transport failure does NOT mean the server didn't retract.
    await revertLocalUnsend(db, args.messageGuid, now);
    return { ok: false };
  }
}
