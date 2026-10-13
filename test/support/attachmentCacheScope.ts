import type { AttachmentCacheReservationScope } from '@/services/download/attachmentCacheCoordinator';

/** An account scope that never goes stale, for cache tests that are not about account switches. */
export function alwaysCurrentCacheScope(generation = 7): AttachmentCacheReservationScope {
  return {
    generation,
    isCurrent: () => true,
    runTracked: <T>(task: () => Promise<T>) => task(),
  };
}
