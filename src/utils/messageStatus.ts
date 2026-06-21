import type { MessageRow } from '@db/repositories';
import { formatTime } from './date';

/**
 * Client-side send error codes (Flutter `ClientMessageError`). Codes start at
 * 10000 to avoid colliding with server-generated codes (HTTP status values or
 * values < 1000). Kept in sync with lib/helpers/types/constants.dart.
 */
export const ClientErrorCode = {
  clientError: 10001,
  badGateway: 10002,
  gatewayTimeout: 10003,
  connectionRefused: 10004,
  notFound: 10005,
  editFailed: 10006,
  unsendFailed: 10007,
  userCanceled: 10008,
} as const;

/** Friendly title per client error code (mirrors ClientMessageErrorExtension.friendlyTitles). */
const CLIENT_ERROR_TITLES: Record<number, string> = {
  [ClientErrorCode.clientError]: 'Client Error',
  [ClientErrorCode.badGateway]: 'Bad Gateway',
  [ClientErrorCode.gatewayTimeout]: 'Network Timed Out',
  [ClientErrorCode.connectionRefused]: 'Connection Refused',
  [ClientErrorCode.notFound]: 'Not Found',
  [ClientErrorCode.editFailed]: 'Edit Failed',
  [ClientErrorCode.unsendFailed]: 'Unsend Failed',
  [ClientErrorCode.userCanceled]: 'Manually Canceled',
};

/**
 * Map a numeric send-error code to a user-friendly title (Flutter
 * ErrorHelper.getErrorTitle). Client-side codes (≥10000) get their specific
 * label; positive server codes fall back to "iMessage Error (Code N)"; zero or
 * an unrecognised/negative code uses the generic "Message Failed to Send".
 */
export function errorTitleForCode(code: number | null | undefined): string {
  if (code == null) return 'Message Failed to Send';
  const client = CLIENT_ERROR_TITLES[code];
  if (client) return client;
  if (code > 0) return `iMessage Error (Code ${code})`;
  return 'Message Failed to Send';
}

/**
 * Status label shown under the newest OUTGOING message only. Returns null for
 * received messages (and so the caller renders nothing). Mirrors iMessage:
 * Sending… → Sent → Delivered → Read HH:MM, or "Not Delivered" on error.
 *
 * "Delivered" tiers: when the server reports the message was delivered without
 * notifying the recipient (wasDeliveredQuietly && !didNotifyRecipient), show
 * "Delivered Quietly" — matching Apple's "Delivered Quietly" indicator.
 */
export function statusFor(msg: MessageRow): string | null {
  if (!msg.isFromMe) return null;
  if (msg.sendState === 'sending') return 'Sending…';
  if (msg.sendState === 'error' || msg.error) return 'Not Delivered';
  if (msg.dateRead) return `Read ${formatTime(msg.dateRead)}`;
  if (msg.dateDelivered) return deliveredQuietly(msg) ? 'Delivered Quietly' : 'Delivered';
  return 'Sent';
}

/**
 * True when iMessage delivered the message without notifying the recipient —
 * surfaced as "Delivered Quietly". Mirrors the Flutter delivered_indicator:
 * `wasDeliveredQuietly && !didNotifyRecipient`.
 */
export function deliveredQuietly(
  msg: Pick<MessageRow, 'wasDeliveredQuietly' | 'didNotifyRecipient'>,
): boolean {
  return !!msg.wasDeliveredQuietly && !msg.didNotifyRecipient;
}
