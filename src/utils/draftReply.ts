/**
 * The reply target a chat's draft remembers ("replying to …"), so switching chats and coming back
 * keeps it. Stored next to the draft text as `draft.reply.<chat guid>`: only the message guid and
 * the part number, never message text. An empty value means "no reply target".
 */
export interface DraftReplyTarget {
  readonly guid: string;
  readonly part: number;
}

const MAX_GUID_LENGTH = 512;
const MAX_PART = 1_000;

/** The stored value for a target, or '' to clear it. */
export function serializeDraftReplyTarget(target: DraftReplyTarget | null): string {
  if (!target) return '';
  return JSON.stringify({ v: 1, guid: target.guid, part: target.part });
}

/** Read a stored value back; anything missing, old or malformed means "no target". */
export function parseDraftReplyTarget(raw: string | null | undefined): DraftReplyTarget | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null) return null;
    const { v, guid, part } = value as Record<string, unknown>;
    if (v !== 1 || typeof guid !== 'string' || guid.length === 0) return null;
    if (guid.length > MAX_GUID_LENGTH) return null;
    if (typeof part !== 'number' || !Number.isInteger(part) || part < 0 || part > MAX_PART) {
      return null;
    }
    return { guid, part };
  } catch {
    return null;
  }
}
