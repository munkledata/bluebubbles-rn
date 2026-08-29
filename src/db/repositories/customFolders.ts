import { and, eq, inArray, sql } from 'drizzle-orm';
import { customFolderMembers, customFolders } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbCommitGuard,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';

export const MAX_CUSTOM_FOLDERS = 100;
export const MAX_CUSTOM_FOLDER_NAME_CODE_POINTS = 64;
export const MAX_CUSTOM_FOLDER_MEMBERS = 5_000;
export const MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS = 4_096;

const MEMBER_WRITE_CHUNK_SIZE = 400;
const MEMBER_DELETE_CHUNK_SIZE = 500;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

export interface CustomFolderRow {
  readonly id: number;
  readonly name: string;
  readonly sortOrder: number;
  readonly chatCount: number;
}

function requireFolderId(id: number): void {
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new RangeError('Folder id must be a positive safe integer.');
  }
}

/** Normalize one user-visible name once, before it reaches either SQL or a later backup. */
export function normalizeCustomFolderName(input: string): string {
  if (typeof input !== 'string') throw new TypeError('Folder name must be text.');
  const name = input.normalize('NFC').trim();
  if (name.length === 0) throw new RangeError('Folder name cannot be empty.');
  if (Array.from(name).length > MAX_CUSTOM_FOLDER_NAME_CODE_POINTS) {
    throw new RangeError(
      `Folder name cannot exceed ${MAX_CUSTOM_FOLDER_NAME_CODE_POINTS} characters.`,
    );
  }
  if (CONTROL_CHARACTER.test(name)) {
    throw new RangeError('Folder name cannot contain control characters.');
  }
  return name;
}

function normalizeChatGuids(input: readonly string[]): string[] {
  if (!Array.isArray(input)) throw new TypeError('Folder membership must be a list.');
  if (input.length > MAX_CUSTOM_FOLDER_MEMBERS) {
    throw new RangeError(`A folder cannot contain more than ${MAX_CUSTOM_FOLDER_MEMBERS} chats.`);
  }

  const unique = new Set<string>();
  for (const guid of input) {
    if (
      typeof guid !== 'string' ||
      guid.length === 0 ||
      Array.from(guid).length > MAX_CUSTOM_FOLDER_CHAT_GUID_CODE_POINTS ||
      guid.includes('\u0000')
    ) {
      throw new RangeError('Every folder member must have a valid chat GUID.');
    }
    unique.add(guid);
  }
  return [...unique];
}

function normalizeFolderOrder(input: readonly number[]): number[] {
  if (!Array.isArray(input) || input.length > MAX_CUSTOM_FOLDERS) {
    throw new RangeError(`Folder order cannot contain more than ${MAX_CUSTOM_FOLDERS} ids.`);
  }
  const ids = [...input];
  for (const id of ids) requireFolderId(id);
  if (new Set(ids).size !== ids.length)
    throw new RangeError('Folder order cannot contain duplicates.');
  return ids;
}

/** Ordered folders plus the durable membership count, including temporarily absent chats. */
export function listCustomFoldersWithinTransaction(
  context: DbTransactionContext,
): Promise<CustomFolderRow[]> {
  return runInTransactionContext(context, async (db) => {
    const rows = await db.all<CustomFolderRow>(sql`
      SELECT f.id, f.name, f.sort_order AS sortOrder, COUNT(m.chat_guid) AS chatCount
        FROM custom_folders AS f
        LEFT JOIN custom_folder_members AS m ON m.folder_id = f.id
       GROUP BY f.id, f.name, f.sort_order
       ORDER BY f.sort_order ASC, f.id ASC
       LIMIT ${MAX_CUSTOM_FOLDERS + 1}
    `);
    if (rows.length > MAX_CUSTOM_FOLDERS) {
      throw new Error('Custom folder count exceeds its safety bound.');
    }
    return rows;
  });
}

/** Consistency-sensitive read: queue behind mutations so partial reorder/replacement is invisible. */
export function listCustomFolders(
  db: AppDatabase,
  commitGuard?: DbCommitGuard,
): Promise<CustomFolderRow[]> {
  return withDbTransaction(
    db,
    (context) => listCustomFoldersWithinTransaction(context),
    commitGuard,
  );
}

/** Stable membership identity. Rows remain even while their corresponding chat is absent. */
export function listCustomFolderChatGuidsWithinTransaction(
  context: DbTransactionContext,
  folderId: number,
): Promise<string[]> {
  return runInTransactionContext(context, async (db) => {
    requireFolderId(folderId);
    const rows = (await db.all<{ chatGuid: string }>(sql`
      SELECT chat_guid AS chatGuid
        FROM custom_folder_members
       WHERE folder_id = ${folderId}
       ORDER BY chat_guid ASC
       LIMIT ${MAX_CUSTOM_FOLDER_MEMBERS + 1}
    `)) as { chatGuid: string }[];
    if (rows.length > MAX_CUSTOM_FOLDER_MEMBERS) {
      throw new Error('Custom folder membership exceeds its safety bound.');
    }
    return rows.map((row) => row.chatGuid);
  });
}

/** Consistency-sensitive read: queue behind add-before-prune membership replacement. */
export function listCustomFolderChatGuids(
  db: AppDatabase,
  folderId: number,
  commitGuard?: DbCommitGuard,
): Promise<string[]> {
  return withDbTransaction(
    db,
    (context) => listCustomFolderChatGuidsWithinTransaction(context, folderId),
    commitGuard,
  );
}

export function createCustomFolderWithinTransaction(
  context: DbTransactionContext,
  inputName: string,
): Promise<CustomFolderRow> {
  return runInTransactionContext(context, async (db) => {
    const name = normalizeCustomFolderName(inputName);
    const summary = await db.all<{ count: number; maxSortOrder: number }>(sql`
      SELECT COUNT(*) AS count, COALESCE(MAX(sort_order), -1) AS maxSortOrder
        FROM custom_folders
    `);
    const count = summary[0]?.count ?? 0;
    const maxSortOrder = summary[0]?.maxSortOrder ?? -1;
    if (count >= MAX_CUSTOM_FOLDERS) {
      throw new RangeError(`No more than ${MAX_CUSTOM_FOLDERS} custom folders are allowed.`);
    }
    if (!Number.isSafeInteger(maxSortOrder) || maxSortOrder < -1) {
      throw new Error('Custom folder order is invalid.');
    }
    const duplicate = await db.all<{ id: number }>(
      sql`SELECT id FROM custom_folders WHERE name = ${name} LIMIT 1`,
    );
    if (duplicate.length > 0) throw new Error('A folder with that name already exists.');

    const sortOrder = maxSortOrder + 1;
    const created = await db
      .insert(customFolders)
      .values({ name, sortOrder })
      .returning({ id: customFolders.id });
    return { id: created[0]!.id, name, sortOrder, chatCount: 0 };
  });
}

export function createCustomFolder(
  db: AppDatabase,
  name: string,
  commitGuard?: DbCommitGuard,
): Promise<CustomFolderRow> {
  return withDbTransaction(
    db,
    (context) => createCustomFolderWithinTransaction(context, name),
    commitGuard,
  );
}

export function renameCustomFolderWithinTransaction(
  context: DbTransactionContext,
  folderId: number,
  inputName: string,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    requireFolderId(folderId);
    const name = normalizeCustomFolderName(inputName);
    const duplicate = await db.all<{ id: number }>(sql`
      SELECT id FROM custom_folders WHERE name = ${name} AND id <> ${folderId} LIMIT 1
    `);
    if (duplicate.length > 0) throw new Error('A folder with that name already exists.');
    const updated = await db
      .update(customFolders)
      .set({ name })
      .where(eq(customFolders.id, folderId))
      .returning({ id: customFolders.id });
    return updated.length > 0;
  });
}

export function renameCustomFolder(
  db: AppDatabase,
  folderId: number,
  name: string,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => renameCustomFolderWithinTransaction(context, folderId, name),
    commitGuard,
  );
}

export function deleteCustomFolderWithinTransaction(
  context: DbTransactionContext,
  folderId: number,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    requireFolderId(folderId);
    const deleted = await db
      .delete(customFolders)
      .where(eq(customFolders.id, folderId))
      .returning({ id: customFolders.id });
    return deleted.length > 0;
  });
}

export function deleteCustomFolder(
  db: AppDatabase,
  folderId: number,
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => deleteCustomFolderWithinTransaction(context, folderId),
    commitGuard,
  );
}

/** Replace the complete visible order only when the caller still names the exact folder set. */
export function reorderCustomFoldersWithinTransaction(
  context: DbTransactionContext,
  inputIds: readonly number[],
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    const ids = normalizeFolderOrder(inputIds);
    const current = (await db.all<{ id: number }>(sql`
      SELECT id FROM custom_folders ORDER BY sort_order ASC, id ASC LIMIT ${MAX_CUSTOM_FOLDERS + 1}
    `)) as { id: number }[];
    if (
      current.length > MAX_CUSTOM_FOLDERS ||
      current.length !== ids.length ||
      current.some((row) => !ids.includes(row.id))
    ) {
      return false;
    }
    for (const [sortOrder, id] of ids.entries()) {
      await db.update(customFolders).set({ sortOrder }).where(eq(customFolders.id, id));
    }
    return true;
  });
}

export function reorderCustomFolders(
  db: AppDatabase,
  ids: readonly number[],
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => reorderCustomFoldersWithinTransaction(context, ids),
    commitGuard,
  );
}

/**
 * Add desired memberships before pruning stale rows. The transaction makes the final set atomic;
 * the write order also prevents same-connection observers from seeing a transient empty folder.
 */
export function replaceCustomFolderMembershipWithinTransaction(
  context: DbTransactionContext,
  folderId: number,
  inputChatGuids: readonly string[],
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    requireFolderId(folderId);
    const chatGuids = normalizeChatGuids(inputChatGuids);
    const folder = await db.all<{ id: number }>(
      sql`SELECT id FROM custom_folders WHERE id = ${folderId} LIMIT 1`,
    );
    if (folder.length === 0) return false;

    const existing = (await db.all<{ chatGuid: string }>(sql`
      SELECT chat_guid AS chatGuid
        FROM custom_folder_members
       WHERE folder_id = ${folderId}
       ORDER BY chat_guid ASC
       LIMIT ${MAX_CUSTOM_FOLDER_MEMBERS + 1}
    `)) as { chatGuid: string }[];
    if (existing.length > MAX_CUSTOM_FOLDER_MEMBERS) {
      throw new Error('Custom folder membership exceeds its safety bound.');
    }

    for (let offset = 0; offset < chatGuids.length; offset += MEMBER_WRITE_CHUNK_SIZE) {
      const chunk = chatGuids.slice(offset, offset + MEMBER_WRITE_CHUNK_SIZE);
      await db
        .insert(customFolderMembers)
        .values(chunk.map((chatGuid) => ({ folderId, chatGuid })))
        .onConflictDoNothing();
    }

    const desired = new Set(chatGuids);
    const stale = existing.flatMap((row) => (desired.has(row.chatGuid) ? [] : [row.chatGuid]));
    for (let offset = 0; offset < stale.length; offset += MEMBER_DELETE_CHUNK_SIZE) {
      const chunk = stale.slice(offset, offset + MEMBER_DELETE_CHUNK_SIZE);
      await db
        .delete(customFolderMembers)
        .where(
          and(
            eq(customFolderMembers.folderId, folderId),
            inArray(customFolderMembers.chatGuid, chunk),
          ),
        );
    }
    return true;
  });
}

export function replaceCustomFolderMembership(
  db: AppDatabase,
  folderId: number,
  chatGuids: readonly string[],
  commitGuard?: DbCommitGuard,
): Promise<boolean> {
  return withDbTransaction(
    db,
    (context) => replaceCustomFolderMembershipWithinTransaction(context, folderId, chatGuids),
    commitGuard,
  );
}
