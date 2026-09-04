import { searchMessagesOnServer } from '@core/api/endpoints/messages';
import { getDatabase } from '@db/database';
import type { SearchResultRow } from '@db/repositories';
import { http } from '../clients';
import type { RealtimeDeliveryLease } from '../realtime/deliveryCoordinator';
import { searchAndAdoptServerMessagesWith } from './serverMessageSearchOperation';

/** Fetch one bounded Mac page outside the DB owner, abort on account retirement, then adopt it. */
export async function searchAndAdoptServerMessages(
  query: string,
  lease: RealtimeDeliveryLease,
  callerSignal?: AbortSignal,
): Promise<SearchResultRow[]> {
  return searchAndAdoptServerMessagesWith(
    {
      fetchMessages: (text, signal) => searchMessagesOnServer(http, text, signal),
      getDatabase,
    },
    query,
    lease,
    callerSignal,
  );
}
