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
  const rows = await db.all<{ name: string }>(
    sql`SELECT COALESCE(display_name, address) AS name FROM handles WHERE address = ${address} LIMIT 1`,
  );
  return rows[0]?.name ?? null;
}

/** Upsert handles by address; returns address → row id. */
export async function upsertHandles(
  db: AppDatabase,
  items: Handle[],
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  const deduped = dedupeBy(
    items.filter((h) => !!h?.address),
    (h) => h.address,
  );
  if (deduped.length === 0) return map;

  const rows = await db
    .insert(handles)
    .values(
      deduped.map((h) => ({
        address: h.address,
        originalRowId: h.originalROWID ?? null,
        service: h.service ?? null,
        country: h.country ?? null,
        color: h.color ?? null,
        displayName: h.displayName ?? null,
        serverDisplayName: h.displayName ?? null,
      })),
    )
    .onConflictDoUpdate({
      target: handles.address,
      set: {
        // A contact match (contact_id set) wins: keep the contact's name on a
        // server re-sync. avatar + contact_id are owned by the contacts matcher.
        displayName: sql`CASE WHEN ${handles.contactId} IS NULL
                              THEN excluded.display_name ELSE ${handles.displayName} END`,
        // ALWAYS track the latest server name so the matcher can revert to it if
        // the device contact is later removed.
        serverDisplayName: sql`excluded.display_name`,
        service: sql`excluded.service`,
        color: sql`excluded.color`,
      },
    })
    .returning({ id: handles.id, address: handles.address });

  for (const r of rows) map.set(r.address, r.id);

  // Contact-link-on-ingestion: opportunistically claim these handles for any
  // already-synced device contact (pure DB match, no native call) so the contact
  // name/avatar wins immediately — without waiting for the next contacts sync.
  // No-op when the contacts table is empty.
  await linkHandlesToContacts(db, [...map.keys()]);

  return map;
}
