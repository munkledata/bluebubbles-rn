import { useEffect } from 'react';
import { useShareIntentStore } from '@state/shareIntentStore';

/**
 * Mark the held share batch as shown by this screen while it is mounted. The share navigator
 * reopens a held batch only when no screen owns it, so a screen that adopted the batch must
 * register here. `batchId` is the batch this screen owns, or null when it owns none.
 */
export function useShareBatchOwnership(batchId: string | null): void {
  useEffect(() => {
    if (batchId === null) return undefined;
    return useShareIntentStore.getState().adopt(batchId);
  }, [batchId]);
}
