import { getDatabase } from '@db/database';
import { searchContactAddresses, type ContactPick } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { contactHandleMatchKey } from '@utils/contactMatch';
import { useMemo } from 'react';

/**
 * Upper bound on contact addresses read for the lookup. `searchContactAddresses` already caps the
 * contact rows it reads; this caps the (contact, address) pairs it returns.
 */
const MAX_CONTACT_ADDRESSES = 5000;

const EMPTY: ContactPick[] = [];

/**
 * Index contact names by the same type-scoped match key chats use (`phone:` last ten digits,
 * `email:` lowercased). When two contacts share an address, the first one keeps it, so the
 * result never depends on render order.
 */
export function buildContactNameIndex(picks: readonly ContactPick[]): ReadonlyMap<string, string> {
  const index = new Map<string, string>();
  for (const pick of picks) {
    const name = pick.name.trim();
    if (!name) continue;
    const key = contactHandleMatchKey(pick.address);
    if (key && !index.has(key)) index.set(key, name);
  }
  return index;
}

/** The phone contact's name for a Find My friend's address, or null when there is no match. */
export function contactNameForHandle(
  index: ReadonlyMap<string, string>,
  handle: string | null | undefined,
): string | null {
  if (!handle) return null;
  const key = contactHandleMatchKey(handle);
  return key ? (index.get(key) ?? null) : null;
}

/**
 * Contact names for Find My friends. Reactive on the `contacts` table, like the New Message
 * suggestions, so names appear as soon as a contacts sync lands. A failed read (for example the DB
 * isn't open yet) gives an empty index, so the screen falls back to the server's name.
 */
export function useFindMyContactNames(): ReadonlyMap<string, string> {
  const { data } = useReactiveQuery<ContactPick[]>(
    () => searchContactAddresses(getDatabase(), '', MAX_CONTACT_ADDRESSES),
    ['contacts'],
    [],
  );
  const picks = data ?? EMPTY;
  return useMemo(() => buildContactNameIndex(picks), [picks]);
}
