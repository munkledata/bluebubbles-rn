export interface TitleInput {
  customName?: string | null;
  displayName: string | null;
  chatIdentifier: string | null;
  style: number | null;
  participantCount: number;
  participantNames: string | null; // "Alice, Bob"
}

/** Chat title resolution: local custom name → server name → participants → id. */
export function resolveTitle(c: TitleInput): string {
  if (c.customName?.trim()) return c.customName.trim();
  if (c.displayName?.trim()) return c.displayName.trim();
  if (c.participantNames?.trim()) return c.participantNames.trim();
  return c.chatIdentifier ?? 'Unknown';
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
