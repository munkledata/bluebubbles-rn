import { and, eq, isNull, sql } from 'drizzle-orm';
import { chats } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';

/** Chat customization, theme, and local/synced background persistence. */

/**
 * Set a chat's local customizations. Pass a field as `undefined` to leave it
 * unchanged, or `null` to clear it (revert to default). Validates the color.
 */
type ChatCustomizationPatch = {
  customName?: string | null;
  customColor?: string | null;
};

function normalizeChatCustomizationPatch(patch: ChatCustomizationPatch): ChatCustomizationPatch {
  const set: ChatCustomizationPatch = {};
  if (patch.customName !== undefined) {
    const trimmed = patch.customName?.trim();
    set.customName = trimmed ? trimmed : null;
  }
  if (patch.customColor !== undefined) {
    if (patch.customColor !== null && !/^#[0-9a-f]{6}$/i.test(patch.customColor)) {
      throw new Error(`invalid custom color: ${patch.customColor}`);
    }
    set.customColor = patch.customColor;
  }
  return set;
}

export async function setChatCustomization(
  db: AppDatabase,
  guid: string,
  patch: ChatCustomizationPatch,
): Promise<void> {
  const set = normalizeChatCustomizationPatch(patch);
  if (Object.keys(set).length === 0) return;
  await withDbTransaction(db, (context) =>
    setChatCustomizationWithinTransaction(context, guid, set),
  );
}

export function setChatCustomizationWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  patch: ChatCustomizationPatch,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const set = normalizeChatCustomizationPatch(patch);
    if (Object.keys(set).length === 0) return;
    await db.update(chats).set(set).where(eq(chats.guid, guid));
  });
}

export interface ChatAppearancePatch {
  themeTokens?: string | null;
  backgroundUri?: string | null;
  backgroundIsLight?: boolean | null;
}

function normalizeChatAppearancePatch(patch: ChatAppearancePatch): ChatAppearancePatch {
  const set: ChatAppearancePatch = {};
  if (patch.themeTokens !== undefined) set.themeTokens = patch.themeTokens;
  if (patch.backgroundUri !== undefined) set.backgroundUri = patch.backgroundUri;
  if (patch.backgroundIsLight !== undefined) set.backgroundIsLight = patch.backgroundIsLight;
  return set;
}

/**
 * Set a chat's per-chat theme override and/or chat-background image. Pass a field
 * as `undefined` to leave it unchanged, or `null` to clear it (revert to the global
 * theme / no background). Device-local — excluded from upsertChats' conflict set.
 */
export async function setChatTheme(
  db: AppDatabase,
  guid: string,
  patch: Pick<ChatAppearancePatch, 'themeTokens' | 'backgroundUri'>,
): Promise<void> {
  const set = normalizeChatAppearancePatch(patch);
  if (Object.keys(set).length === 0) return;
  await withDbTransaction(db, (context) => setChatAppearanceWithinTransaction(context, guid, set));
}

export function setChatAppearanceWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  patch: ChatAppearancePatch,
): Promise<void> {
  return runInTransactionContext(context, async (db) => {
    const set = normalizeChatAppearancePatch(patch);
    if (Object.keys(set).length === 0) return;
    await db.update(chats).set(set).where(eq(chats.guid, guid));
  });
}

/**
 * A chat's per-chat theme override + background uris (null fields → inherit/none). Includes
 * both the device-local `backgroundUri` (the user's pick) and the macOS 26 `syncedBackgroundUri`
 * (downloaded from the server); the UI resolves the effective background as local ?? synced.
 */
export async function getChatTheme(
  db: AppDatabase,
  guid: string,
): Promise<{
  themeTokens: string | null;
  backgroundUri: string | null;
  syncedBackgroundUri: string | null;
  /** 1 = light wallpaper, 0 = dark, null = unknown/none (raw column value). */
  backgroundIsLight: number | null;
} | null> {
  const rows = await db.all<{
    themeTokens: string | null;
    backgroundUri: string | null;
    syncedBackgroundUri: string | null;
    backgroundIsLight: number | null;
  }>(
    sql`SELECT theme_tokens AS themeTokens, background_uri AS backgroundUri,
               synced_background_uri AS syncedBackgroundUri,
               background_is_light AS backgroundIsLight
          FROM chats WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Store the effective wallpaper's luminance (true = light → dark overlay text; null = unknown). */
export async function setBackgroundIsLight(
  db: AppDatabase,
  guid: string,
  isLight: boolean | null,
): Promise<void> {
  await withDbTransaction(db, (context) =>
    setChatAppearanceWithinTransaction(context, guid, { backgroundIsLight: isLight }),
  );
}

/**
 * The macOS 26 synced-background state for a chat: the server's current `channel` (the version)
 * and the `uri` of the local file already downloaded for it. The background-sync service compares
 * them to decide whether to (re)download.
 */
export async function getSyncedBackgroundState(
  db: AppDatabase,
  guid: string,
): Promise<{ channel: string | null; uri: string | null } | null> {
  const rows = await db.all<{ channel: string | null; uri: string | null }>(
    sql`SELECT synced_background_channel AS channel, synced_background_uri AS uri
          FROM chats WHERE guid = ${guid} LIMIT 1`,
  );
  return rows[0] ?? null;
}

/** Set (or clear, with null) the local file path of a chat's downloaded synced background. */
export async function setSyncedBackgroundUri(
  db: AppDatabase,
  guid: string,
  uri: string | null,
): Promise<void> {
  await withDbTransaction(db, () =>
    db.update(chats).set({ syncedBackgroundUri: uri }).where(eq(chats.guid, guid)),
  );
}

/**
 * Move the downloaded-background pointer only while BOTH server channel and prior local URI still
 * match the caller's snapshot. Network/native work stays outside the process-wide DB mutex; only
 * the final bounded compare-and-swap claims the serialized transaction.
 */
export async function setSyncedBackgroundUriIfCurrent(
  db: AppDatabase,
  guid: string,
  expectedChannel: string | null,
  expectedUri: string | null,
  nextUri: string | null,
): Promise<boolean> {
  return withDbTransaction(db, (context) =>
    setSyncedBackgroundUriIfCurrentWithinTransaction(
      context,
      guid,
      expectedChannel,
      expectedUri,
      nextUri,
    ),
  );
}

export function setSyncedBackgroundUriIfCurrentWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  expectedChannel: string | null,
  expectedUri: string | null,
  nextUri: string | null,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db
      .update(chats)
      .set({ syncedBackgroundUri: nextUri })
      .where(
        and(
          eq(chats.guid, guid),
          expectedChannel == null
            ? isNull(chats.syncedBackgroundChannel)
            : eq(chats.syncedBackgroundChannel, expectedChannel),
          expectedUri == null
            ? isNull(chats.syncedBackgroundUri)
            : eq(chats.syncedBackgroundUri, expectedUri),
        ),
      )
      .returning({ guid: chats.guid });
    return rows.length > 0;
  });
}

/**
 * Store luminance only for the exact synced file/channel that was measured, and only while no
 * device-local background has taken precedence. A changed channel, URI replacement, or local pick
 * makes this a no-op rather than letting a stale image overwrite the active theme's contrast.
 */
export async function setSyncedBackgroundLuminanceIfCurrent(
  db: AppDatabase,
  guid: string,
  expectedChannel: string,
  expectedUri: string,
  isLight: boolean,
): Promise<boolean> {
  return withDbTransaction(db, (context) =>
    setSyncedBackgroundLuminanceIfCurrentWithinTransaction(
      context,
      guid,
      expectedChannel,
      expectedUri,
      isLight,
    ),
  );
}

export function setSyncedBackgroundLuminanceIfCurrentWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  expectedChannel: string,
  expectedUri: string,
  isLight: boolean,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db
      .update(chats)
      .set({ backgroundIsLight: isLight })
      .where(
        and(
          eq(chats.guid, guid),
          eq(chats.syncedBackgroundChannel, expectedChannel),
          eq(chats.syncedBackgroundUri, expectedUri),
          isNull(chats.backgroundUri),
        ),
      )
      .returning({ guid: chats.guid });
    return rows.length > 0;
  });
}
