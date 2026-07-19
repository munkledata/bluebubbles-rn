import { requireOptionalNativeModule } from 'expo';
import type { InboxRow } from '@db/repositories';

/**
 * Android Direct Share bridge. Publishes recent conversations as dynamic "sharing shortcuts" so
 * Gator shows in the share sheet's PRIORITIZED row (tap a chat → share straight into it). All native
 * calls go through the OPTIONAL native module `GatorShareShortcuts` (see
 * `modules/gator-share-shortcuts/`): on a JS bundle running against a build that hasn't linked it yet
 * (pre-rebuild), or under Jest, the lookup returns null and every function below is a safe no-op — so
 * this never crashes the app or the tests. See the delivery side in `ShareIntentNavigator`.
 */

export interface ShareShortcut {
  id: string;
  name: string;
  avatarPath?: string | null;
}

interface GatorShareShortcutsNative {
  setShareShortcuts: (items: ShareShortcut[]) => Promise<void>;
  clearShareShortcuts: () => void;
  getLaunchShortcutId: () => string | null;
}

// The most-recent conversations to surface (Android caps dynamic shortcuts around 4-5).
const MAX = 4;

/** Guarded so a build without the native module (pre-rebuild) or Jest just gets null → no-ops. */
function getNative(): GatorShareShortcutsNative | null {
  try {
    return requireOptionalNativeModule<GatorShareShortcutsNative>('GatorShareShortcuts');
  } catch {
    return null;
  }
}

/** Publish the most-recent conversations as Direct Share targets (best-effort, never throws). */
export function publishShareShortcuts(rows: InboxRow[]): void {
  const native = getNative();
  if (!native) return;
  const shortcuts: ShareShortcut[] = rows.slice(0, MAX).map((r) => ({
    id: r.guid,
    name: chatTitle(r),
    avatarPath: firstAvatar(r.participantAvatars),
  }));
  try {
    void native.setShareShortcuts(shortcuts);
  } catch {
    // best-effort — a failed publish must never break the inbox
  }
}

/** Remove all published Direct Share targets (e.g. on logout). */
export function clearShareShortcuts(): void {
  try {
    getNative()?.clearShareShortcuts();
  } catch {
    // best-effort
  }
}

/**
 * The chat guid of the Direct Share target the user just tapped, or null for a plain share. Consumed
 * once per share by the navigator to route to that chat instead of the new-message picker.
 */
export function getLaunchShortcutId(): string | null {
  try {
    return getNative()?.getLaunchShortcutId() ?? null;
  } catch {
    return null;
  }
}

/** Best display name for a shortcut label (mirrors the inbox tile's title resolution). */
function chatTitle(r: InboxRow): string {
  return (
    r.customName?.trim() ||
    r.displayName?.trim() ||
    r.participantNames?.split(',')[0]?.trim() ||
    r.chatIdentifier ||
    'Conversation'
  );
}

/** First participant avatar as a local path (native falls back to the app icon when absent). */
function firstAvatar(participantAvatars: string | null): string | null {
  if (!participantAvatars) return null;
  const first = participantAvatars.split(',')[0]?.trim();
  return first && first.length > 0 ? first : null;
}
