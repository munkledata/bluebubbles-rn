import { and, eq, isNull, sql } from 'drizzle-orm';
import { chats } from '../schema';
import { runInTransactionContext, type DbTransactionContext } from '../transaction';
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

/** One chat whose group photo may need downloading or clearing. */
export interface GroupPhotoState {
  guid: string;
  /** Server version id; null once the photo was removed. */
  photoGuid: string | null;
  /** The downloaded file, if any. */
  uri: string | null;
}

/**
 * Chats whose stored photo file may not match the server's photo id: a photo id with no file or
 * any file at all (the caller compares the exact expected name). Bounded; groups are few.
 */
export async function listGroupPhotoStates(
  db: AppDatabase,
  limit: number,
): Promise<GroupPhotoState[]> {
  const bounded = Math.min(Math.max(Math.floor(limit), 1), 500);
  return db.all<GroupPhotoState>(sql`
    SELECT guid, group_photo_guid AS photoGuid, group_photo_uri AS uri
      FROM chats
     WHERE group_photo_guid IS NOT NULL OR group_photo_uri IS NOT NULL
     ORDER BY id
     LIMIT ${bounded}
  `);
}

/**
 * Point a chat at a downloaded group photo (or clear it), only if the server's photo id and the
 * stored file are still what the caller read. A sync that changed the photo meanwhile wins.
 */
export function setGroupPhotoUriIfCurrentWithinTransaction(
  context: DbTransactionContext,
  guid: string,
  expectedPhotoGuid: string | null,
  expectedUri: string | null,
  nextUri: string | null,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db
      .update(chats)
      .set({ groupPhotoUri: nextUri })
      .where(
        and(
          eq(chats.guid, guid),
          expectedPhotoGuid == null
            ? isNull(chats.groupPhotoGuid)
            : eq(chats.groupPhotoGuid, expectedPhotoGuid),
          expectedUri == null ? isNull(chats.groupPhotoUri) : eq(chats.groupPhotoUri, expectedUri),
        ),
      )
      .returning({ guid: chats.guid });
    return rows.length > 0;
  });
}

/** True while any chat still shows this photo file (one file per chat today; checked anyway). */
export async function isGroupPhotoUriReferenced(db: AppDatabase, uri: string): Promise<boolean> {
  const rows = await db.all<{ known: number }>(
    sql`SELECT 1 AS known FROM chats WHERE group_photo_uri = ${uri} LIMIT 1`,
  );
  return rows[0]?.known === 1;
}
