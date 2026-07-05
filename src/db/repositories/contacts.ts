import { eq, sql } from 'drizzle-orm';
import { emailKey, handleKey, phoneKey } from '@utils/contactMatch';
import { contacts, handles } from '../schema';
import type { AppDatabase } from '../types';
import { chunk } from './_shared';

/** Max addresses per `IN (...)` list — well under SQLite's ~999 bound-variable limit. */
const HANDLE_IN_CHUNK = 500;

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

interface ContactMatch {
  id: number;
  displayName: string | null;
  avatar: string | null;
}

/**
 * Best-effort contact display name for a raw address (phone or email), matched by the
 * normalized key (last-10-digits phone / lowercased email) against synced device
 * contacts. Returns null when nothing matches or the matched contact has no name.
 * Used by the device-SMS inbox to name a raw provider address. Reuses the shared
 * `buildContactIndex`, so it matches exactly like the handle matcher.
 */
export async function findContactNameByAddress(
  db: AppDatabase,
  address: string,
): Promise<string | null> {
  const key = handleKey(address);
  if (!key) return null;
  const index = await buildContactIndex(db);
  return index.get(key)?.displayName ?? null;
}

/**
 * Build an address-key → contact index from the local contacts table (phones
 * keyed by last-10-digits, emails lowercased). Shared by the full match pass and
 * the opportunistic per-ingestion link.
 */
async function buildContactIndex(db: AppDatabase): Promise<Map<string, ContactMatch>> {
  const contactRows = await db.all<{
    id: number;
    displayName: string | null;
    phones: string | null;
    emails: string | null;
    avatar: string | null;
  }>(sql`SELECT id, display_name AS displayName, phones, emails, avatar FROM contacts`);

  const index = new Map<string, ContactMatch>();
  for (const c of contactRows) {
    const phones: string[] = c.phones ? JSON.parse(c.phones) : [];
    const emails: string[] = c.emails ? JSON.parse(c.emails) : [];
    const val: ContactMatch = { id: c.id, displayName: c.displayName, avatar: c.avatar };
    for (const p of phones) {
      const k = phoneKey(p);
      if (k) index.set(k, val);
    }
    for (const e of emails) {
      const k = emailKey(e);
      if (k) index.set(k, val);
    }
  }
  return index;
}

/**
 * Write a matched contact's name/avatar onto a single handle. Always claims the
 * handle (avatar + contact_id) but only overwrites display_name when the contact
 * actually has one — otherwise a photo-only contact would blank out the server
 * name (COALESCE then falls back to the raw address). Returns true if it wrote.
 */
async function applyContactMatch(
  db: AppDatabase,
  handleId: number,
  match: ContactMatch,
): Promise<boolean> {
  if (!match.displayName && !match.avatar) return false;
  const set: { avatar: string | null; contactId: number; displayName?: string } = {
    avatar: match.avatar,
    contactId: match.id,
  };
  if (match.displayName) set.displayName = match.displayName;
  await db.update(handles).set(set).where(eq(handles.id, handleId));
  return true;
}

/**
 * Opportunistically link freshly-ingested handles to already-synced device
 * contacts (no native call) so a contact's name/avatar wins immediately on
 * message/chat ingestion — without waiting for the next full contacts sync.
 * Reuses the contactMatch keys (last-10-digits phone, lowercased email). Only
 * touches the given addresses; never reverts (the full pass owns un-linking).
 * Returns the count linked. No-op when there are no contacts.
 */
export async function linkHandlesToContacts(db: AppDatabase, addresses: string[]): Promise<number> {
  if (addresses.length === 0) return 0;
  const index = await buildContactIndex(db);
  if (index.size === 0) return 0;

  // Scope the handles scan to exactly the addresses being ingested, and skip rows that
  // are already linked — in SQL — so this never rebuilds the whole handle index for
  // unrelated chats. The IN-list is chunked to stay under SQLite's bound-variable limit.
  let linked = 0;
  for (const batch of chunk([...new Set(addresses)], HANDLE_IN_CHUNK)) {
    const inList = sql.join(
      batch.map((a) => sql`${a}`),
      sql`, `,
    );
    const handleRows = await db.all<{ id: number; address: string }>(
      sql`SELECT id, address FROM handles WHERE address IN (${inList}) AND contact_id IS NULL`,
    );
    for (const h of handleRows) {
      const match = index.get(handleKey(h.address));
      if (match && (await applyContactMatch(db, h.id, match))) linked += 1;
    }
  }
  return linked;
}

/**
 * Match every handle's address to a contact (by normalized phone/email) and
 * write the contact's display_name + avatar + contact_id onto the handle. The
 * contact name then wins everywhere (all titles resolve via h.display_name) and
 * the reactive 'handles' watchers re-render. Returns the count updated.
 */
export async function matchContactsToHandles(db: AppDatabase): Promise<number> {
  const index = await buildContactIndex(db);

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
    if (match && (await applyContactMatch(db, h.id, match))) {
      updated += 1;
    } else if (h.contactId != null) {
      // No useful match anymore (contact removed, or stripped of name + photo) but
      // the handle is still linked → revert to the server name (or the raw address
      // if the server never sent one) + clear avatar.
      await db
        .update(handles)
        .set({ displayName: h.serverDisplayName, avatar: null, contactId: null })
        .where(eq(handles.id, h.id));
      updated += 1;
    }
  }
  return updated;
}

// ---- Server-avatar backfill (contacts that exist on the Mac but not the phone) --------

/**
 * Handles with NO avatar yet (device sync didn't find a photo) + a non-empty address —
 * candidates for a server-sourced contact avatar. Read-only; never touches device photos.
 */
export async function handlesNeedingAvatar(db: AppDatabase): Promise<{ id: number; address: string }[]> {
  return db.all<{ id: number; address: string }>(
    sql`SELECT id, address FROM handles WHERE avatar IS NULL AND address <> ''`,
  );
}

/**
 * Write a server-sourced avatar uri onto a handle (only the photo — not display_name /
 * contact_id, which stay device-contact-owned). Used by the server-avatar backfill for
 * handles a device contact didn't supply a photo for.
 */
export async function setHandleServerAvatar(db: AppDatabase, handleId: number, uri: string): Promise<void> {
  await db.update(handles).set({ avatar: uri }).where(eq(handles.id, handleId));
}
