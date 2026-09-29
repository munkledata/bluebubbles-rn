import { requireOptionalNativeModule } from 'expo';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { listChatsForInboxPage, type InboxRow } from '@db/repositories';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { resolveTitle } from '@utils/chat';

const MAX_PUBLISHED_SHORTCUTS = 10;
const MAX_RESOLUTION_CANDIDATES = 256;
const MAX_LABEL_UTF16_UNITS = 80;
const TARGET_TOKEN = /^gator-share-v2-[A-Za-z0-9_-]{43}$/;

export interface ShareShortcutRow {
  guid: string;
  label: string;
}

interface GatorShareShortcutsNative {
  clearLegacyShareShortcuts(revision: number): void;
  clearCurrentShareShortcuts(revision: number): void;
  clearAllShareShortcuts(revision: number): void;
  setShareShortcuts(
    revision: number,
    records: readonly ShareShortcutRow[],
    appLockEnabled: boolean,
  ): void;
  resolveShareShortcutTarget(token: string, candidates: readonly string[]): string | null;
  reportShareShortcutUsed(token: string): void;
}

/**
 * Seed from wall time so a React-context reload in the same Android process advances beyond calls
 * issued by the previous context. Values remain below Number.MAX_SAFE_INTEGER.
 */
const shortcutMutationRevisionBase = Date.now() * 1000;
let shortcutMutationSequence = 0;

function nextShortcutMutationRevision(): number {
  shortcutMutationSequence += 1;
  return shortcutMutationRevisionBase + shortcutMutationSequence;
}

function getNative(): GatorShareShortcutsNative | null {
  try {
    return requireOptionalNativeModule<GatorShareShortcutsNative>('GatorShareShortcuts');
  } catch {
    return null;
  }
}

function runMutation(
  operation: string,
  action: (native: GatorShareShortcutsNative, revision: number) => void,
): boolean {
  const native = getNative();
  if (!native) return false;
  try {
    action(native, nextShortcutMutationRevision());
    return true;
  } catch (error) {
    logger.warn(`[shortcuts] ${operation} failed`, {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return false;
  }
}

/** Remove only shortcuts left by builds predating the owned SHARE-02 namespace. */
export function clearShareShortcuts(): boolean {
  return runMutation('legacy cleanup', (native, revision) => {
    native.clearLegacyShareShortcuts(revision);
  });
}

/** Account teardown: scrub legacy/current labels, then rotate the native opaque-id namespace. */
export function clearAllShareShortcuts(): boolean {
  return runMutation('account cleanup', (native, revision) => {
    native.clearAllShareShortcuts(revision);
  });
}

/** Remove only current-account rows and rotate their opaque-id namespace. */
export function clearCurrentShareShortcuts(): boolean {
  return runMutation('current cleanup', (native, revision) => {
    native.clearCurrentShareShortcuts(revision);
  });
}

function boundedLabel(row: InboxRow): string {
  const label = resolveTitle(row).trim() || 'Conversation';
  // Native validates UTF-16 length too; slice cannot grow it and keeps Binder input bounded.
  return label.slice(0, MAX_LABEL_UTF16_UNITS);
}

/**
 * Publish a bounded recent-chat prefix. App Lock policy intentionally publishes no account labels,
 * even while unlocked; enabling the feature removes existing personalized rows immediately.
 */
export function publishShareShortcuts(rows: readonly InboxRow[], appLockEnabled: boolean): boolean {
  const records = rows.slice(0, MAX_PUBLISHED_SHORTCUTS).map((row) => ({
    guid: row.guid,
    label: boundedLabel(row),
  }));
  return runMutation('publish', (native, revision) => {
    native.setShareShortcuts(revision, records, appLockEnabled);
  });
}

async function listCanonicalShortcutCandidates(): Promise<InboxRow[]> {
  const page = await listChatsForInboxPage(getDatabase(), {
    limit: MAX_RESOLUTION_CANDIDATES,
    archive: 'active',
  });
  return page.rows;
}

/**
 * Refresh Android's rows from the same unfiltered active-chat prefix used for target resolution.
 * This prevents a filtered inbox from publishing a valid chip outside the resolver's universe.
 */
export async function refreshShareShortcuts(
  appLockEnabled: boolean,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<boolean> {
  if (!lease.isCurrent()) return false;
  let published = false;
  try {
    const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
      const rows = appLockEnabled ? [] : await listCanonicalShortcutCandidates();
      if (!activeLease.isCurrent()) return;
      published = publishShareShortcuts(rows, appLockEnabled);
    });
    return status === 'delivered' && lease.isCurrent() && published;
  } catch (error) {
    if (lease.isCurrent()) {
      logger.warn('[shortcuts] refresh failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return false;
  }
}

/**
 * Resolve an opaque Android Direct Share id only against visible chats in this exact account
 * generation. Unknown, stale, deleted, forged, or wrong-account tokens safely become generic.
 */
export async function resolveShareShortcutTarget(
  token: string,
  lease: RealtimeDeliveryLease = captureRealtimeDeliveryLease(),
): Promise<string | null> {
  if (!TARGET_TOKEN.test(token) || !lease.isCurrent()) return null;
  const native = getNative();
  if (!native) return null;
  let target: string | null = null;
  try {
    const status = await runTrackedRealtimeWork(lease, async (activeLease) => {
      const rows = await listCanonicalShortcutCandidates();
      if (!activeLease.isCurrent()) return;
      const candidates = rows.map((row) => row.guid);
      const resolved = native.resolveShareShortcutTarget(token, candidates);
      if (!activeLease.isCurrent() || resolved == null || !candidates.includes(resolved)) return;
      try {
        native.reportShareShortcutUsed(token);
      } catch (error) {
        logger.warn('[shortcuts] usage reporting failed', {
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
      target = resolved;
    });
    return status === 'delivered' && lease.isCurrent() ? target : null;
  } catch (error) {
    if (lease.isCurrent()) {
      logger.warn('[shortcuts] target resolution failed', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    return null;
  }
}
