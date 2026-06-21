import type { MessageRow } from '@db/repositories';

/**
 * Bubble grouping rules (ported from the Flutter Cupertino message view).
 * Operates on a NEWEST-FIRST array (index 0 = newest = visual bottom of the
 * inverted list): `older` is the chronologically previous message (index + 1),
 * `newer` is the chronologically next (index - 1).
 */
export const GROUP_BREAK_MS = 30 * 60_000; // 30 min — also gates a date separator
export const TAIL_GAP_MS = 60_000; // 1 min — tail hides only within this window

export function sameSender(a: MessageRow, b: MessageRow): boolean {
  if (a.isFromMe !== b.isFromMe) return false;
  if (a.isFromMe) return true; // both from me
  return a.handleId === b.handleId; // both received → same handle
}

/** Show the sender name above a received message in a group chat at a group start. */
export function showSenderHeader(
  msg: MessageRow,
  older: MessageRow | null,
  isGroup: boolean,
): boolean {
  if (!isGroup || msg.isFromMe) return false;
  if (!older) return true;
  if (!sameSender(msg, older)) return true;
  return (msg.dateCreated ?? 0) - (older.dateCreated ?? 0) > GROUP_BREAK_MS;
}

/** Tail = last message in a consecutive same-sender run (or the newest message). */
export function showTail(msg: MessageRow, newer: MessageRow | null): boolean {
  if (!newer) return true;
  if (!sameSender(msg, newer)) return true;
  return Math.abs((newer.dateCreated ?? 0) - (msg.dateCreated ?? 0)) > TAIL_GAP_MS;
}

/** Avatar shows at the bottom of a received group (group chats only). */
export function showAvatar(msg: MessageRow, newer: MessageRow | null, isGroup: boolean): boolean {
  return isGroup && !msg.isFromMe && showTail(msg, newer);
}

/** Date separator above `msg` when there's a >30-min gap AND a new calendar day. */
export function showDateSeparator(msg: MessageRow, older: MessageRow | null): boolean {
  if (!older) return true;
  const a = msg.dateCreated ?? 0;
  const b = older.dateCreated ?? 0;
  if (a - b <= GROUP_BREAK_MS) return false;
  return new Date(a).toDateString() !== new Date(b).toDateString();
}
