export interface TitleInput {
  customName?: string | null;
  displayName: string | null;
  chatIdentifier: string | null;
  style: number | null;
  participantCount: number;
  participantNames: string | null; // "Alice, Bob"
}

/**
 * Whether a string is a usable human NAME, vs server "names" that are really junk: a raw
 * iMessage chat-guid identifier ("chat947991747861991169") or a phone-number list
 * ("(209) 430-4494, (215) 954-8728, …"). For those we'd rather fall through to the
 * contact-resolved participant names than echo a guid/number-blob back at the user.
 */
function isMeaningfulName(s: string | null | undefined): boolean {
  const t = s?.trim();
  if (!t) return false;
  if (/^chat[0-9]+$/i.test(t)) return false; // raw chat-guid identifier
  if (/^[\s\d()+\-.,;]+$/.test(t)) return false; // only phone-number characters → not a real name
  return true;
}

/**
 * Chat title resolution: local custom name → a REAL server name → contact-resolved
 * participants → a non-junk identifier. A junk server name (raw chat-guid or a phone-number
 * list) is skipped in favor of the participant names; a group with nothing usable shows
 * "Group" rather than a raw `chat<digits>` id.
 */
export function resolveTitle(c: TitleInput): string {
  if (c.customName?.trim()) return c.customName.trim();
  if (isMeaningfulName(c.displayName)) return c.displayName!.trim();
  if (c.participantNames?.trim()) return c.participantNames.trim();
  if (c.displayName?.trim()) return c.displayName.trim(); // last resort: a number-list beats a raw id
  const id = c.chatIdentifier?.trim();
  if (id && !/^chat[0-9]+$/i.test(id)) return id; // a phone/email identifier is a usable 1:1 fallback
  return isGroupRow(c) ? 'Group' : (id ?? 'Unknown');
}

/** A valid 6-digit hex color (e.g. "#1982FC"), used for per-chat accent colors. */
export function isHexColor(s: string | null | undefined): s is string {
  return !!s && /^#[0-9a-f]{6}$/i.test(s);
}

/**
 * The accent for own-message bubbles: a valid per-chat custom color when set,
 * otherwise the theme default. Received/SMS bubbles ignore the accent.
 */
export function resolveBubbleColor(
  customColor: string | null | undefined,
  fallback: string,
): string {
  return isHexColor(customColor) ? customColor : fallback;
}

/** True group chat → render GroupAvatar; else a single Avatar. */
export function isGroupRow(c: { style: number | null; participantCount: number }): boolean {
  return c.style === 45 || c.participantCount > 1;
}

function firstParticipant(names: string | null): string | null {
  if (!names) return null;
  const first = names.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}

/** Name used to seed a single Avatar's initials + color (1:1 uses the other party). */
export function avatarSeed(c: TitleInput): string {
  if (!isGroupRow(c)) return firstParticipant(c.participantNames) ?? c.chatIdentifier ?? '?';
  return c.displayName?.trim() || c.participantNames || '?';
}

/** Participant display names as an array (for the stacked GroupAvatar). */
export function participantList(names: string | null): string[] {
  if (!names) return [];
  return names
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0);
}

/** Pipe-delimited contact-avatar uris (from a query), positionally aligned with names. */
export function participantAvatars(s: string | null): (string | null)[] {
  if (!s) return [];
  return s.split('|||').map((u) => (u && u.length > 0 ? u : null));
}
