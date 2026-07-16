import { sql } from 'drizzle-orm';
import type { Handle } from '@core/models';
import { handles } from '../schema';
import type { AppDatabase } from '../types';
import { dedupeBy } from './_shared';
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

/** Upsert handles by (address, service); returns `handleMapKey(handle)` → row id. */
export async function upsertHandles(
  db: AppDatabase,
  items: Handle[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const deduped = dedupeBy(
    items.filter((h) => !!h?.address),
    handleMapKey,
  );
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
        color: h.color ?? null,
        displayName: h.displayName ?? null,
        serverDisplayName: h.displayName ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: [handles.address, handles.service],
      set: {
        // A contact match (contact_id set) wins: keep the contact's name on a
        // server re-sync. avatar + contact_id are owned by the contacts matcher.
        displayName: sql`CASE WHEN ${handles.contactId} IS NULL
                              THEN excluded.display_name ELSE ${handles.displayName} END`,
        // ALWAYS track the latest server name so the matcher can revert to it if
        // the device contact is later removed.
        serverDisplayName: sql`excluded.display_name`,
        // service is part of the row's IDENTITY now — never overwritten on conflict.
        color: sql`excluded.color`,
      },
    })
    .returning({ id: handles.id, address: handles.address, service: handles.service });

  for (const r of rows) map.set(handleMapKey(r), r.id);

  // Contact-link-on-ingestion: opportunistically claim these handles for any
  // already-synced device contact (pure DB match, no native call) so the contact
  // name/avatar wins immediately — without waiting for the next contacts sync.
  // No-op when the contacts table is empty. Matched by ADDRESS, so a contact
  // claims every service-variant row of their number at once.
  await linkHandlesToContacts(db, [...new Set(deduped.map((h) => h.address))]);

  return map;
}
