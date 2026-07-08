import { ApiError } from '@core/api/errors';
import type { HttpClient } from '@core/api/http';
import { sendText } from '@core/api/endpoints/messages';
import { logger } from '@core/secure';
import { sendErrorCode } from '@utils';
import {
  getChatIdByGuid,
  insertOutgoingText,
  markOutgoingSentNoGuid,
  reconcileOutgoingError,
  reconcileOutgoingSuccess,
} from '@db/repositories';
import type { AppDatabase } from '@db/types';
import { sessionAccessors } from '@state/sessionStore';

/**
 * Pick the send method (mirrors Flutter http_service): effects/replies/edits REQUIRE the
 * Private API; a plain text send falls back to AppleScript on a stock server (Private API
 * off) instead of failing outright.
 */
export function chooseSendMethod(
  needsPrivateApi: boolean,
  privateApiEnabled: boolean,
): 'private-api' | 'apple-script' {
  return needsPrivateApi || privateApiEnabled ? 'private-api' : 'apple-script';
}

/** "temp-{8 lowercase alnum}" — a client-generated id for optimistic sends. */
export function generateTempGuid(): string {
  const s = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return `temp-${s}`;
}

export interface SendTextArgs {
  chatGuid: string;
  text: string;
  selectedMessageGuid?: string;
  effectId?: string;
}

/**
 * Optimistic text send. Inserts a temp message (`sendState='sending'`) + a queue
 * row, POSTs, then reconciles by tempGuid. On error the bubble flips to
 * `sendState='error'` (the UI signal) — we don't rethrow into render. Pure
 * orchestration (no React Native imports), so it runs in Node tests against
 * better-sqlite3, mirroring the sync engine.
 */
export async function sendTextMessage(
  db: AppDatabase,
  http: HttpClient,
  args: SendTextArgs,
  now: number = Date.now(),
): Promise<{ tempGuid: string }> {
  const chatId = await getChatIdByGuid(db, args.chatGuid);
  if (chatId == null) throw new Error(`unknown chat ${args.chatGuid}`);

  const tempGuid = generateTempGuid();
  await insertOutgoingText(db, {
    tempGuid,
    chatId,
    chatGuid: args.chatGuid,
    text: args.text,
    now,
    selectedMessageGuid: args.selectedMessageGuid,
    // A reply targets the selected message; persist it locally so the optimistic
    // bubble shows its quote before the server echo.
    threadOriginatorGuid: args.selectedMessageGuid,
    effectId: args.effectId,
  });

  try {
    const method = chooseSendMethod(
      !!args.selectedMessageGuid || !!args.effectId,
      sessionAccessors.privateApiEnabled(),
    );
    const server = await sendText(http, {
      chatGuid: args.chatGuid,
      tempGuid,
      message: args.text,
      selectedMessageGuid: args.selectedMessageGuid,
      effectId: args.effectId,
      method,
    });
    // The server ack carries the real GUID only on the Private-API path. On the
    // AppleScript fallback (stock server, no helper) the guid is ABSENT — flip the optimistic
    // row to 'sent' and drop the queue row (no spurious retry); the live socket `new-message`
    // echo then reconciles it to the real guid by content (Gator emits no tempGuid). Never
    // call reconcileOutgoingSuccess with an undefined guid.
    if (server.guid) {
      await reconcileOutgoingSuccess(db, tempGuid, {
        guid: server.guid,
        dateCreated: now,
        dateDelivered: null,
      });
    } else {
      await markOutgoingSentNoGuid(db, tempGuid);
    }
  } catch (e) {
    // Surface WHY the send failed (status + server message) so a failed bubble is
    // diagnosable from the device log — e.g. an RCS auth-expiry now reads
    // "...Google login expired... refresh cookies on the dashboard" instead of a
    // silent errored bubble. The redacting logger scrubs any secret before sinks.
    const status = e instanceof ApiError ? e.status ?? null : null;
    const code = sendErrorCode(status);
    logger.warn(
      `[send] failed for chat ${args.chatGuid} (code ${code}${status != null ? `, HTTP ${status}` : ''}): ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    await reconcileOutgoingError(db, tempGuid, code);
  }

  return { tempGuid };
}
