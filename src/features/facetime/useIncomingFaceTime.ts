import { useCallback } from 'react';
import { faceTimeApi } from '@core/api';
import { logger } from '@core/secure';
import { http } from '@/services';
import { isDevServer } from '@utils/isDev';
import { useFaceTimeStore, type IncomingFaceTimeCall } from '@state/faceTimeStore';
import { resolveFaceTimeAnswerLink } from './answerLink';

/**
 * Answer/decline an incoming FaceTime call. Answer resolves + validates the join link and
 * hands it to the in-call overlay (`open`); Decline best-effort tells the server to leave.
 * Both stop the ring immediately. Mirrors `useFaceTime` conventions (dev stub, scheme guard).
 */
export function useIncomingFaceTime(): {
  answer: (c: IncomingFaceTimeCall) => Promise<void>;
  decline: (uuid: string) => void;
} {
  const open = useFaceTimeStore((s) => s.open);
  const dismissIncoming = useFaceTimeStore((s) => s.dismissIncoming);

  const answer = useCallback(
    async (c: IncomingFaceTimeCall): Promise<void> => {
      dismissIncoming(c.uuid); // stop the ring immediately (optimistic)
      try {
        const link = await resolveFaceTimeAnswerLink(http, c.uuid);
        // chatGuid is unknown for an incoming call; the in-call overlay only uses `link`.
        open({ link, chatGuid: '', video: !c.isAudio });
      } catch (err) {
        logger.warn('[facetime] failed to answer incoming call', err);
      }
    },
    [open, dismissIncoming],
  );

  const decline = useCallback(
    (uuid: string): void => {
      dismissIncoming(uuid);
      if (isDevServer()) return;
      // Best-effort server-side decline (mirrors the Phase-1 leave path).
      void faceTimeApi
        .leaveFaceTime(http, uuid)
        .catch((e) => logger.debug('[facetime] decline failed', e));
    },
    [dismissIncoming],
  );

  return { answer, decline };
}
