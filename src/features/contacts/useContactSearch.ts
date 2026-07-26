import { getDatabase } from '@db/database';
import { searchContactAddresses, type ContactPick } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';

/** Stable identity so a null/errored result doesn't hand consumers a fresh array every render. */
const EMPTY: ContactPick[] = [];

/**
 * Contact-address suggestions for a recipient input (new-chat, FaceTime dialer).
 *
 * REACTIVE on the `contacts` table, not a one-shot read. The contacts sync fires at the tail of
 * every sync, so the compose screen is regularly opened while it is mid-write — most sharply on a
 * share-into-Gator cold start, which routes straight to /new-chat at the same moment boot's first
 * contacts sync begins, with the table still genuinely empty. A one-shot read taken at that instant
 * stuck: its effect depended only on [query, limit], so the list stayed empty until the user typed
 * something, which reads as "Gator can't see my contacts".
 *
 * Re-running is cheap (one bounded SELECT) and the subscription is debounced, so the sync's batched
 * inserts collapse into a single re-query. A failed read (e.g. the DB isn't open yet) yields an
 * empty list rather than throwing; stale results are dropped by the hook's own cancellation, so a
 * slower earlier query can never clobber a newer one.
 */
export function useContactSearch(query: string, limit = 30): ContactPick[] {
  const { data } = useReactiveQuery<ContactPick[]>(
    () => searchContactAddresses(getDatabase(), query, limit),
    ['contacts'],
    [query, limit],
  );
  return data ?? EMPTY;
}
