import { requireOptionalNativeModule } from 'expo';
import { logger } from '@core/secure';

/**
 * IPC-01 one-way cleanup bridge.
 *
 * Older Gator builds published persistent Android Direct Share shortcuts containing conversation
 * names and contact photos. Removing the manifest declaration does not remove that system state,
 * so the root layout keeps this local native module long enough to clear it on every app start.
 *
 * Deliberately expose NO publish, launch-target, or usage-reporting API here. Re-enabling those
 * methods before an owned, bounded inbound-share module exists would recreate a privacy leak and
 * leave useless launcher shortcuts behind even though the candidate accepts no share intents.
 */

interface GatorShareShortcutsCleanupNative {
  clearShareShortcuts: (revision: number) => void;
}

/**
 * Seed from wall time so a React-context reload in the same Android process advances beyond clear
 * revisions issued by the previous context. Values remain below Number.MAX_SAFE_INTEGER.
 */
const shortcutMutationRevisionBase = Date.now() * 1000;
let shortcutMutationSequence = 0;

function nextShortcutMutationRevision(): number {
  shortcutMutationSequence += 1;
  return shortcutMutationRevisionBase + shortcutMutationSequence;
}

function getNative(): GatorShareShortcutsCleanupNative | null {
  try {
    return requireOptionalNativeModule<GatorShareShortcutsCleanupNative>('GatorShareShortcuts');
  } catch {
    return null;
  }
}

/**
 * Remove every shortcut persisted by an older build. Best-effort and synchronous so root startup
 * can sanitize system UI before account/DB boot; false means the optional module was unavailable
 * or Android rejected the clear.
 */
export function clearShareShortcuts(): boolean {
  const native = getNative();
  if (!native) return false;
  try {
    native.clearShareShortcuts(nextShortcutMutationRevision());
    return true;
  } catch (err) {
    logger.warn(`[shortcuts] clear failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
