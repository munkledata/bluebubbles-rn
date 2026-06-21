import type { MessageRow } from '@db/repositories';
import { formatTime } from './date';

/**
 * Status label shown under the newest OUTGOING message only. Returns null for
 * received messages (and so the caller renders nothing). Mirrors iMessage:
 * Sending… → Sent → Delivered → Read HH:MM, or "Not Delivered" on error.
 */
export function statusFor(msg: MessageRow): string | null {
  if (!msg.isFromMe) return null;
  if (msg.sendState === 'sending') return 'Sending…';
  if (msg.sendState === 'error' || msg.error) return 'Not Delivered';
  if (msg.dateRead) return `Read ${formatTime(msg.dateRead)}`;
  if (msg.dateDelivered) return 'Delivered';
  return 'Sent';
}
