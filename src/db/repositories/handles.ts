import { sql } from 'drizzle-orm';
import { normalizeHandleColor, type Handle } from '@core/models';
import { handles } from '../schema';
import {
  runInTransactionContext,
  withDbTransaction,
  type DbTransactionContext,
} from '../transaction';
import type { AppDatabase } from '../types';
import { linkHandlesToContacts } from './contacts';

/**
 * The display name to show for a handle: the contact-matched name when present, else the
 * raw address. Mirrors the `COALESCE(display_name, address)` every in-app query uses, so a
 * notification shows the SAME name as the conversation list/chat (the event payload's
 * `handle.displayName` is the server name, which has no device-contact name — that's why
 * notifications were showing a bare phone number). Returns null when the handle is unknown.
 */
export async function getHandleName(db: AppDatabase, address: string): Promise<string | null> {
  return (await getHandleProfile(db, address))?.name ?? null;
}

/** A handle's display name + avatar, for the notification's person entry. */
export interface HandleProfile {
  name: string;
  avatar: string | null;
}

/**
 * Name + contact photo for an address. An address can have one row PER SERVICE
 * (iMessage + SMS variants of the same number); prefer a named/photographed row so
 * the notification shows the contact identity when either variant has it.
 */
export async function getHandleProfile(
  db: AppDatabase,
  address: string,
): Promise<HandleProfile | null> {
  const rows = await db.all<HandleProfile>(
    sql`SELECT COALESCE(display_name, address) AS name, avatar FROM handles
        WHERE address = ${address}
        ORDER BY (display_name IS NULL), (avatar IS NULL), id LIMIT 1`,
  );
  return rows[0] ?? null;
}

/**
 * Identity key for the maps `upsertHandles` returns. A handle's identity is
 * (address, service) — Apple keeps SEPARATE handle rows for the same number on
 * iMessage vs SMS, and merging them made incoming traffic flip a chat's badge/
 * bubble colour back and forth. Service-less payloads key (and store) as ''.
 */
export function handleMapKey(h: { address: string; service?: string | null }): string {
  return JSON.stringify([h.address, h.service ?? '']);
}

function prepareHandles(items: Handle[]): Handle[] {
  const byIdentity = new Map<string, Handle>();
  for (const handle of items) {
    if (!handle?.address) continue;
    const key = handleMapKey(handle);
    // Color is a device-owned preference. Never admit a server/debug payload value into the
    // authoritative row; only the explicit local command below may change it.
    byIdentity.set(key, {
      ...handle,
      color: null,
    });
  }
  return [...byIdentity.values()];
}

/**
 * Transaction-context handle-row primitive for callers that ALREADY own the transaction.
 *
 * Contact linking is deliberately excluded: building its index reads the whole device address
 * book, which must not happen while the process-wide write mutex is held. A caller that needs the
 * opportunistic name/photo should invoke the coordinated `linkHandlesToContacts` only AFTER its
 * outer transaction commits.
 */
export function upsertHandlesWithinTransaction(
  context: DbTransactionContext,
  items: Handle[],
): Promise<Map<string, number>> {
  return runInTransactionContext(context, async (db) => {
    const deduped = prepareHandles(items);
    const map = new Map<string, number>();
    if (deduped.length === 0) return map;

    const rows = await db
      .insert(handles)
      .values(
        deduped.map((h) => ({
          address: h.address,
          originalRowId: h.originalROWID ?? null,
          // '' (not NULL) when the payload omits it: NULLs are distinct in SQLite unique
          // indexes, so a NULL service would dodge the (address, service) conflict target.
          service: h.service ?? '',
          country: h.country ?? null,
          // Device-owned. Inbound payload values were stripped by prepareHandles.
          color: null,
          displayName: h.displayName ?? null,
          serverDisplayName: h.displayName ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [handles.address, handles.service],
        set: {
          // A backup restore can create a color-only placeholder before the first server sync.
          // Hydrate server identity metadata when it arrives; a partial payload must not erase it.
          originalRowId: sql`COALESCE(excluded.original_row_id, ${handles.originalRowId})`,
          country: sql`COALESCE(excluded.country, ${handles.country})`,
          // A contact match (contact_id set) wins: keep the contact's name on a
          // server re-sync. avatar + contact_id are owned by the contacts matcher.
          displayName: sql`CASE WHEN ${handles.contactId} IS NULL
                              THEN excluded.display_name ELSE ${handles.displayName} END`,
          // ALWAYS track the latest server name so the matcher can revert to it if
          // the device contact is later removed.
          serverDisplayName: sql`excluded.display_name`,
          // service is part of the row's IDENTITY now — never overwritten on conflict.
        },
      })
      .returning({ id: handles.id, address: handles.address, service: handles.service });

    for (const r of rows) map.set(handleMapKey(r), r.id);

    return map;
  });
}

/**
 * Set or reset one participant's device-local color while proving that the selected handle still
 * belongs to the exact conversation that opened the editor. The handle row is shared by every
 * chat using the same `(address, service)` identity, so all of those surfaces update together.
 */
export function setHandleColorWithinTransaction(
  context: DbTransactionContext,
  chatGuid: string,
  address: string,
  service: string | null,
  color: string | null,
): Promise<boolean> {
  return runInTransactionContext(context, async (db) => {
    if (!chatGuid) throw new RangeError('Chat guid is required.');
    if (!address) throw new RangeError('Handle address is required.');
    const normalized = normalizeHandleColor(color);
    if (color !== null && normalized === null) {
      throw new RangeError('Handle color must be a six-digit hex color.');
    }
    const updated = await db.all<{ id: number }>(sql`
      UPDATE handles
         SET color = ${normalized}
       WHERE address = ${address} AND service = ${service ?? ''}
         AND EXISTS (
           SELECT 1
             FROM chat_handles ch
             JOIN chats c ON c.id = ch.chat_id
            WHERE ch.handle_id = handles.id AND c.guid = ${chatGuid}
         )
      RETURNING id
    `);
    return updated.length === 1;
  });
}

/**
 * Upsert handles by (address, service); returns `handleMapKey(handle)` → row id.
 * The authoritative rows own one short transaction; the potentially unbounded device-contact
 * index is read only after that commit, and each actual contact match owns a separate short write.
 */
export async function upsertHandles(
  db: AppDatabase,
  items: Handle[],
): Promise<Map<string, number>> {
  const deduped = prepareHandles(items);
  if (deduped.length === 0) return new Map();
  const map = await withDbTransaction(db, (context) =>
    upsertHandlesWithinTransaction(context, deduped),
  );

  // Contact-link-on-ingestion: opportunistically claim these handles for any
  // already-synced device contact (pure DB match, no native call) so the contact
  // name/avatar wins immediately — without waiting for the next contacts sync.
  // No-op when the contacts table is empty. Matched by ADDRESS, so a contact
  // claims every service-variant row of their number at once.
  await linkHandlesToContacts(db, [...new Set(deduped.map((h) => h.address))]);

  return map;
}
