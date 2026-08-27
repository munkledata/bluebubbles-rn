import { useEffect, useRef } from 'react';
import { logger } from '@core/secure';
import {
  fireDueScheduled,
  fireDueScheduledWithDevelopmentSender,
  recoverOutgoing,
} from '@/services/send';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { isDevServer } from '@utils/isDev';
import { devSendFake, devSendFakeReply } from './devSeed';

/** Run scheduled-send catch-up and outgoing recovery while a chat remains mounted. */
export function useChatScheduledCatchup(accountLease: RealtimeDeliveryLease): void {
  const isDev = isDevServer;

  // Fire any scheduled messages that have come due — on open + every 20s while open.
  // The ref is a re-entrancy guard so a slow send (>20s) doesn't let the next tick
  // start a second concurrent run (the DB-level claim is the real lock; this just
  // avoids redundant work).
  const firingRef = useRef(false);
  useEffect(() => {
    const tick = async (): Promise<void> => {
      if (firingRef.current || !accountLease.isCurrent()) return;
      firingRef.current = true;
      try {
        if (isDev()) {
          await fireDueScheduledWithDevelopmentSender(
            (guid, text, selectedMessageGuid) =>
              selectedMessageGuid
                ? devSendFakeReply(guid, text, selectedMessageGuid, undefined, accountLease)
                : devSendFake(guid, text, undefined, accountLease),
            accountLease,
          );
        } else {
          await fireDueScheduled();
          if (!accountLease.isCurrent()) return;
          // Also drain the outgoing retry queue while a chat is open, so a failed send
          // (text or picture) recovers in ~30s instead of waiting for the next home
          // mount / 15-min background tick. next_retry_at backoff + the DB claim gate
          // the actual re-sends; an empty queue is a single indexed SELECT.
          await recoverOutgoing();
        }
      } catch (error) {
        // A revoked DEV ticker throws its ownership sentinel from the DB guards. It belongs to the
        // retired screen; current-account failures remain a quiet, best-effort ticker diagnostic.
        if (accountLease.isCurrent()) logger.debug('[chat] scheduled catch-up failed', error);
      } finally {
        firingRef.current = false;
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 20_000);
    return () => clearInterval(id);
  }, [accountLease, isDev]);
}
