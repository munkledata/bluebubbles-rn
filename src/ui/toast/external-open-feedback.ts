import { showToast } from './toastStore';

/** Fixed, privacy-safe feedback for a foreground handoff the operating system refused. */
export const EXTERNAL_OPEN_FAILURE_MESSAGE = 'Couldn’t open this outside Gator.';

export function showExternalOpenFailure(): void {
  showToast(EXTERNAL_OPEN_FAILURE_MESSAGE);
}
