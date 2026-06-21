import { sql } from 'drizzle-orm';
import type { Handle } from '@core/models';
import { handles } from '../schema';
import type { AppDatabase } from '../types';
import { dedupeBy } from './_shared';

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
  return map;
}
