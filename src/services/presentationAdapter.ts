import { logger } from '@core/secure';
import type { AutoDownloadOutcome } from './download/autoDownloadAttachments';

export type SessionPresentationSurface = 'auto-download-toast' | 'dialogs' | 'toasts';

/**
 * The small presentation surface supplied by the mounted app. Headless processes deliberately
 * leave it absent: they can perform background work, but have no React hosts to present or reset.
 */
export interface ServicePresentationAdapter {
  presentAutoDownload(outcome: AutoDownloadOutcome): void;
  resetSession(): readonly SessionPresentationSurface[];
}

interface PresentationInstallation {
  readonly id: number;
  readonly adapter: ServicePresentationAdapter;
}

let nextInstallationId = 1;
let activeInstallation: PresentationInstallation | null = null;

function retireAdapter(
  adapter: ServicePresentationAdapter,
  reason: 'replaced' | 'unmounted',
): void {
  try {
    const failed = adapter.resetSession();
    if (failed.length > 0) {
      logger.warn('[presentation] adapter retirement was incomplete', { reason, failed });
    }
  } catch (error) {
    logger.warn('[presentation] adapter retirement failed', { reason, error });
  }
}

/** Install the mounted app's adapter with a unique owner token for React remount safety. */
export function installServicePresentationAdapter(adapter: ServicePresentationAdapter): () => void {
  if (activeInstallation) retireAdapter(activeInstallation.adapter, 'replaced');
  const installation = { id: nextInstallationId++, adapter };
  activeInstallation = installation;
  return () => {
    if (activeInstallation?.id !== installation.id) return;
    retireAdapter(installation.adapter, 'unmounted');
    if (activeInstallation?.id === installation.id) activeInstallation = null;
  };
}

/** Present a typed background-work outcome only when a UI composition is currently mounted. */
export function presentAutoDownloadOutcome(outcome: AutoDownloadOutcome): void {
  if (outcome.savedImages <= 0 || outcome.destination === null) return;
  try {
    activeInstallation?.adapter.presentAutoDownload(outcome);
  } catch (error) {
    logger.warn('[presentation] auto-download notice failed', error);
  }
}

/** Synchronously clear account-owned presentation state before the next account can activate. */
export function resetSessionPresentation(): readonly SessionPresentationSurface[] {
  if (!activeInstallation) return [];
  try {
    return activeInstallation.adapter.resetSession();
  } catch (error) {
    logger.warn('[presentation] session reset adapter failed', error);
    return ['auto-download-toast', 'dialogs', 'toasts'];
  }
}
