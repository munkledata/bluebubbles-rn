import { requireOptionalNativeModule } from 'expo';
import { logger } from '@core/secure';
import type { InboxRow } from '@db/repositories';
import { participantAvatars } from '@utils/chat';

// NOTE: `@db/database` and `@state/redactedModeStore` are imported LAZILY inside
// `refreshShareShortcuts` on purpose — both pull in op-sqlite at module load, which would drag a
// native dependency into this module's import graph (and break its node-project tests).

/**
 * Android Direct Share bridge. Publishes recent conversations as dynamic "sharing shortcuts" so
 * Gator shows in the share sheet's PRIORITIZED row (tap a chat → share straight into it). All native
 * calls go through the OPTIONAL native module `GatorShareShortcuts` (see
 * `modules/gator-share-shortcuts/`): on a JS bundle running against a build that hasn't linked it yet
 * (pre-rebuild), or under Jest, the lookup returns null and every function below is a safe no-op — so
 * this never crashes the app or the tests. See the delivery side in `ShareIntentNavigator`.
 *
 * NOTE: which MIME types the chips appear for is a NATIVE/manifest decision, not a JS one — see the
 * `<share-target>` in `plugins/withShareTargets.js`. Publishing here is necessary but not sufficient.
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
  /** Added alongside the Direct Share native batch; absent on older builds. */
  reportShortcutUsed?: (id: string) => Promise<void>;
}

/**
 * How many conversations to offer the system. The NATIVE side does the real clamp against
 * `getMaxShortcutCountPerActivity()` (devices typically allow 10-15), so sending a few extra
 * candidates is safe even on a build whose native half still caps lower.
 */
const MAX = 10;

/** Guarded so a build without the native module (pre-rebuild) or Jest just gets null → no-ops. */
function getNative(): GatorShareShortcutsNative | null {
  try {
    return requireOptionalNativeModule<GatorShareShortcutsNative>('GatorShareShortcuts');
  } catch {
    return null;
  }
}

/**
 * The last payload we handed to the system, so repeat publishes are a string compare.
 *
 * This replaces the old "top-4 guids" memo in ConversationListScreen, which never noticed a
 * RENAMED chat or a newly synced contact photo — the shortcut kept its stale label/icon until the
 * chat order happened to change. Keying on the CONTENT fixes that while still making the frequent
 * reactive ticks free.
 */
let lastPublished: string | null = null;

/** Sentinel for "we have already cleared the chips" — distinct from any real serialized payload. */
const CLEARED = 'redacted-cleared';

/**
 * Pure mapping from inbox rows to Direct Share targets.
 *
 * Redacted mode publishes NOTHING: a masked chip ("Contact", no photo) is useless to tap, and the
 * bare existence of N chips still leaks how many conversations there are. Clearing is both more
 * private and simpler than masking.
 */
export function toShareShortcuts(
  rows: InboxRow[],
  opts: { redacted: boolean; max?: number },
): ShareShortcut[] {
  if (opts.redacted) return [];
  return rows.slice(0, opts.max ?? MAX).map((r) => ({
    id: r.guid,
    name: chatTitle(r),
    avatarPath: firstAvatar(r.participantAvatars),
  }));
}

/**
 * Publish the most-recent conversations as Direct Share targets (best-effort, never throws).
 *
 * `redacted` is passed IN rather than read from the store here, so this module needs no
 * store/DB import and the behaviour stays explicit at every call site.
 */
export function publishShareShortcuts(rows: InboxRow[], opts: { redacted: boolean }): void {
  const native = getNative();
  if (!native) return;
  // Redacted mode must actively CLEAR, not merely skip publishing — dynamic shortcuts are
  // PERSISTENT system state that outlives the process, so chips published in an earlier
  // (non-redacted) session are still live on the share sheet after a restart. Guarding on the
  // sentinel (rather than on `lastPublished !== null`) makes the first call after any restart
  // clear exactly once, while later ticks stay free.
  if (opts.redacted) {
    if (lastPublished !== CLEARED) {
      clearShareShortcuts();
      lastPublished = CLEARED;
    }
    return;
  }

  const shortcuts = toShareShortcuts(rows, { redacted: false });
  // An empty inbox is usually "not loaded yet", not "nothing to show" — leave any existing chips
  // alone rather than churning them.
  if (shortcuts.length === 0) return;

  const key = JSON.stringify(shortcuts);
  if (key === lastPublished) return;
  try {
    void native.setShareShortcuts(shortcuts)?.catch?.((err: unknown) => {
      lastPublished = null; // let the next tick retry
      logger.warn(
        `[shortcuts] publish rejected: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    lastPublished = key;
  } catch {
    // best-effort — a failed publish must never break the inbox
  }
}

/**
 * Read the inbox and publish, without needing a mounted list. Safe to call from anywhere, any
 * number of times — the content dedupe makes a redundant call nearly free.
 *
 * Needed because ConversationListScreen is NOT always mounted: opening the app straight into a
 * chat from a notification tap, or a background contact sync landing new avatars, would otherwise
 * leave the system shortcuts stale indefinitely.
 */
export async function refreshShareShortcuts(): Promise<void> {
  if (!getNative()) return;
  try {
    const [{ getDatabase }, { listChatsForInbox }, { useRedactedModeStore }] = await Promise.all([
      import('@db/database'),
      import('@db/repositories'),
      import('@state/redactedModeStore'),
    ]);
    // `getDatabase` throws until the DB is open (e.g. while app-locked at boot) — nothing to
    // publish yet; the inbox screen and the next refresh will catch up.
    const rows = await listChatsForInbox(getDatabase());
    publishShareShortcuts(rows, { redacted: useRedactedModeStore.getState().enabled });
  } catch (err) {
    logger.debug('[shortcuts] refresh skipped', err);
  }
}

/** Remove all published Direct Share targets (e.g. on logout, or when redacted mode turns on). */
export function clearShareShortcuts(): void {
  try {
    getNative()?.clearShareShortcuts();
  } catch {
    // best-effort
  }
  // Reset the dedupe key so the next publish always goes through.
  lastPublished = null;
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

/**
 * Tell Android this conversation was used, so its People Service learns who the user actually
 * messages and ranks the chips accordingly. No-op on a build whose native half predates it.
 */
export function reportChatOpened(chatGuid: string): void {
  if (!chatGuid) return;
  try {
    void getNative()?.reportShortcutUsed?.(chatGuid);
  } catch {
    // best-effort ranking signal only
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

/**
 * First participant avatar as a uri (native falls back to the app icon when absent).
 *
 * MUST use the shared `participantAvatars` parser: the inbox query joins avatars with `'|||'`
 * (`group_concat(COALESCE(h.avatar, ''), '|||')`), NOT `','` — a comma split handed the native
 * side the whole unsplit blob for every group chat (and any single avatar uri containing a
 * comma), so the icon never decoded and every row fell back to the launcher icon.
 */
function firstAvatar(avatars: string | null): string | null {
  // First AVAILABLE avatar, not the first slot — the list has a null per participant without a
  // photo, so a group whose first member has none would otherwise get the launcher icon.
  return participantAvatars(avatars).find((a) => a !== null) ?? null;
}

/** TEST ONLY — reset the publish dedupe between cases. */
export function __resetShareShortcutsCache(): void {
  lastPublished = null;
}
