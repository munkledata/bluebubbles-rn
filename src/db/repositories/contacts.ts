import { eq, sql } from 'drizzle-orm';
import { emailKey, handleKey, phoneKey } from '@utils/contactMatch';
import { contacts, handles } from '../schema';
import type { AppDatabase } from '../types';

// ---- Contacts sync ---------------------------------------------------------

export interface DeviceContact {
  sourceId: string;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  phones: string[];
  emails: string[];
  avatar: string | null; // file:// uri (small) — not base64
}

/** Replace-all upsert of device contacts (the device is the source of truth). */
export async function upsertContacts(db: AppDatabase, items: DeviceContact[]): Promise<number> {
  await db.delete(contacts);
  if (items.length === 0) return 0;
  for (const c of items) {
    await db.insert(contacts).values({
      sourceId: c.sourceId,
      displayName: c.displayName,
      givenName: c.givenName,
      familyName: c.familyName,
      phones: JSON.stringify(c.phones),
      emails: JSON.stringify(c.emails),
      avatar: c.avatar,
    });
  }
  return items.length;
}

export interface ContactPick {
  name: string;
  address: string;
}

/**
 * Flattened (name, address) pairs from synced device contacts, filtered by name or
 * address substring — for the new-chat recipient picker. Empty query → first `limit`.
 */
export async function searchContactAddresses(
  db: AppDatabase,
  query: string,
  limit = 50,
): Promise<ContactPick[]> {
  const rows = await db.all<{
    displayName: string | null;
    phones: string | null;
    emails: string | null;
  }>(
    sql`SELECT display_name AS displayName, phones, emails FROM contacts ORDER BY display_name LIMIT 1000`,
  );
  const q = query.trim().toLowerCase();
  const parse = (s: string | null): string[] => {
    if (!s) return [];
    try {
      const a: unknown = JSON.parse(s);
      return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const out: ContactPick[] = [];
  for (const r of rows) {
    const name = r.displayName ?? '';
    for (const address of [...parse(r.phones), ...parse(r.emails)]) {
      if (!q || name.toLowerCase().includes(q) || address.toLowerCase().includes(q)) {
        out.push({ name, address });
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

/**
 * Match every handle's address to a contact (by normalized phone/email) and
 * write the contact's display_name + avatar + contact_id onto the handle. The
 * contact name then wins everywhere (all titles resolve via h.display_name) and
 * the reactive 'handles' watchers re-render. Returns the count updated.
 */
export async function matchContactsToHandles(db: AppDatabase): Promise<number> {
  const contactRows = await db.all<{
    id: number;
    displayName: string | null;
    phones: string | null;
    emails: string | null;
    avatar: string | null;
  }>(sql`SELECT id, display_name AS displayName, phones, emails, avatar FROM contacts`);

  const index = new Map<
    string,
    { id: number; displayName: string | null; avatar: string | null }
  >();
  for (const c of contactRows) {
    const phones: string[] = c.phones ? JSON.parse(c.phones) : [];
    const emails: string[] = c.emails ? JSON.parse(c.emails) : [];
    const val = { id: c.id, displayName: c.displayName, avatar: c.avatar };
    for (const p of phones) {
      const k = phoneKey(p);
      if (k) index.set(k, val);
    }
    for (const e of emails) {
      const k = emailKey(e);
      if (k) index.set(k, val);
    }
  }

  const handleRows = await db.all<{
    id: number;
    address: string;
    contactId: number | null;
    serverDisplayName: string | null;
  }>(
    sql`SELECT id, address, contact_id AS contactId, server_display_name AS serverDisplayName FROM handles`,
  );
  let updated = 0;
  for (const h of handleRows) {
    const match = index.get(handleKey(h.address));
    const useful = match && (match.displayName || match.avatar);
    if (useful) {
      // Always claim the handle (avatar + contact_id) but only overwrite the
      // display name when the contact actually has one — otherwise a photo-only
      // contact would blank out the server-provided name (COALESCE then falls
      // back to the raw address).
      const set: { avatar: string | null; contactId: number; displayName?: string } = {
        avatar: match.avatar,
        contactId: match.id,
      };
      if (match.displayName) set.displayName = match.displayName;
      await db.update(handles).set(set).where(eq(handles.id, h.id));
      updated += 1;
    } else if (h.contactId != null) {
      // Previously matched, but the device contact is gone now → revert to the
      // server name (or the raw address if the server never sent one) + clear avatar.
      await db
        .update(handles)
        .set({ displayName: h.serverDisplayName, avatar: null, contactId: null })
        .where(eq(handles.id, h.id));
      updated += 1;
    }
  }
  return updated;
}
