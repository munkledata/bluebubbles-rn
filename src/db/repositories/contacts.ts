import { eq, lte, sql } from 'drizzle-orm';
import { emailKey, handleKey, phoneKey } from '@utils/contactMatch';
import { contacts, handles } from '../schema';
import type { AppDatabase } from '../types';
import { chunk } from './_shared';

/** Max addresses per `IN (...)` list — well under SQLite's ~999 bound-variable limit. */
const HANDLE_IN_CHUNK = 500;

/** Contacts per multi-row INSERT — 7 bound values each, so ~700 per statement. */
const CONTACT_INSERT_CHUNK = 100;

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

/**
 * Replace-all upsert of device contacts (the device is the source of truth).
 *
 * ADD-THEN-PRUNE, never truncate-then-refill. This runs on every boot, reconnect and
 * pull-to-refresh, and every statement here commits on its own and wakes the reactive readers, so
 * an intermediate state is genuinely observed: emptying the table first left a 1-2k-entry address
 * book GONE for seconds at a time, during which a notification shows the raw phone number instead
 * of the contact (`getHandleProfile` falls back to the address), a first message from a
 * newly-added contact is DROPPED entirely under "Filter Unknown Senders" (a one-shot decision with
 * no retry — the DB self-heals seconds later, the missed notification doesn't), and the recipient
 * picker comes up blank.
 *
 * The generation cutoff is what makes it work without an upsert: `contacts.source_id` carries no
 * unique index, so `onConflictDoUpdate({ target: contacts.sourceId })` would raise "ON CONFLICT
 * clause does not match any PRIMARY KEY or UNIQUE constraint". Instead we note the highest id
 * BEFORE writing, insert the whole new generation above it in batches, and delete everything at or
 * below the cutoff in ONE statement. `contacts.id` is AUTOINCREMENT, so ids are never reused and
 * the cutoff can never match a row this call just wrote. The worst observable state is a brief
 * window where BOTH generations are present — duplicates, which every reader tolerates (the match
 * index is keyed by phone/email so a duplicate collapses; `searchContactAddresses` de-dupes) — and
 * the table is never empty.
 *
 * An EMPTY `items` still clears the table: that is the device honestly reporting an empty address
 * book, not a missing read. Readers that must not act on emptiness guard it themselves (see
 * `matchContactsToHandles`).
 */
export async function upsertContacts(db: AppDatabase, items: DeviceContact[]): Promise<number> {
  const before = await db.all<{ cutoff: number | null }>(
    sql`SELECT MAX(id) AS cutoff FROM contacts`,
  );
  const cutoff = before[0]?.cutoff ?? null;

  // Batched inserts, not one statement per contact: the old row-at-a-time loop was thousands of
  // sequential round trips on the single shared connection, which is what made the window seconds
  // long rather than milliseconds.
  for (const batch of chunk(items, CONTACT_INSERT_CHUNK)) {
    await db.insert(contacts).values(
      batch.map((c) => ({
        sourceId: c.sourceId,
        displayName: c.displayName,
        givenName: c.givenName,
        familyName: c.familyName,
        phones: JSON.stringify(c.phones),
        emails: JSON.stringify(c.emails),
        avatar: c.avatar,
      })),
    );
  }

  if (cutoff != null) await db.delete(contacts).where(lte(contacts.id, cutoff));
  return items.length;
}

export interface ContactPick {
  name: string;
  address: string;
}

/**
 * Flattened (name, address) pairs from synced device contacts, filtered by name or
 * address substring — for the new-chat recipient picker. Empty query → first `limit`.
 *
 * De-duped TWICE, and the order matters. `upsertContacts` writes the new generation before pruning
 * the old one, so mid-sync every contact is present TWICE:
 *  - `SELECT DISTINCT` collapses the duplicate generation IN SQL, i.e. BEFORE the row cap. A
 *    JS-only de-dupe runs on rows the `LIMIT` has already truncated, so during that window the
 *    cap of 1000 rows meant only ~500 distinct people, and a search matching someone in the second
 *    half of the address book came back empty. The two generations project byte-identical values
 *    on all three selected columns, so DISTINCT removes exactly one of them.
 *  - the `seen` set below then collapses a contact who lists the SAME number under two labels
 *    (home/mobile), and any generation pair whose values did change — neither of which DISTINCT
 *    can catch, since they differ per row.
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
    sql`SELECT DISTINCT display_name AS displayName, phones, emails FROM contacts ORDER BY display_name LIMIT 1000`,
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
  const seen = new Set<string>();
  for (const r of rows) {
    const name = r.displayName ?? '';
    for (const address of [...parse(r.phones), ...parse(r.emails)]) {
      if (!q || name.toLowerCase().includes(q) || address.toLowerCase().includes(q)) {
        // NUL-joined so a name containing the separator can't forge a collision with another pair.
        const key = `${name}\u0000${address}`;
        if (seen.has(key)) continue;
        seen.add(key);
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
  // An empty contacts read means "we don't know", not "every contact was deleted". Without this
  // the revert branch below walks EVERY linked handle and writes display_name = serverDisplayName
  // — which this server never sends (the wire handle DTO carries only address / country /
  // uncanonicalizedId / service), so it writes NULL and the whole inbox degrades to raw phone
  // numbers, one committed write at a time. `upsertContacts` no longer empties the table on its
  // way to refilling it, but a device read can still come back empty on its own — a permission
  // revoked between the prompt and the read, or a profile with no address book at all. Mirrors
  // linkHandlesToContacts. TRADE-OFF: a user who deletes their ENTIRE address book keeps the old
  // handle names until at least one contact exists again — a stale name is far cheaper than
  // blanking every name on the device.
  if (index.size === 0) return 0;

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
export async function handlesNeedingAvatar(
  db: AppDatabase,
): Promise<{ id: number; address: string }[]> {
  return db.all<{ id: number; address: string }>(
    sql`SELECT id, address FROM handles WHERE avatar IS NULL AND address <> ''`,
  );
}

/**
 * Write a server-sourced avatar uri onto a handle (only the photo — not display_name /
 * contact_id, which stay device-contact-owned). Used by the server-avatar backfill for
 * handles a device contact didn't supply a photo for.
 */
export async function setHandleServerAvatar(
  db: AppDatabase,
  handleId: number,
  uri: string,
): Promise<void> {
  await db.update(handles).set({ avatar: uri }).where(eq(handles.id, handleId));
}
