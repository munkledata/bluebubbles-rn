/**
 * Pure math for the message-row horizontal swipe gesture (React-free, node-tested):
 *  - drag LEFT reveals the message's timestamp (peek; springs back on release)
 *  - drag RIGHT past a threshold sets the message as the reply target (iMessage swipe-to-reply)
 * The component (`MessageSwipeWrapper`) feeds raw `dx` through these.
 */

/** How far left a row can slide to reveal its timestamp. */
export const TIMESTAMP_REVEAL_MAX = 88;
/** Translated distance at which releasing a rightward drag triggers reply. */
export const REPLY_TRIGGER_PX = 56;
/** Rightward pull resistance + cap (the row follows the finger at ~half speed). */
const REPLY_PULL_FACTOR = 0.55;
const REPLY_PULL_MAX = 72;

/** Raw gesture dx → the row's clamped translateX. */
export function swipeTranslate(dx: number, replyEnabled: boolean): number {
  if (dx < 0) return Math.max(dx, -TIMESTAMP_REVEAL_MAX);
  if (!replyEnabled) return 0; // no rightward pull when reply isn't available
  return Math.min(dx * REPLY_PULL_FACTOR, REPLY_PULL_MAX);
}

/** True when releasing at `dx` should fire the reply action. */
export function isReplyTrigger(dx: number, replyEnabled: boolean): boolean {
  return replyEnabled && swipeTranslate(dx, true) >= REPLY_TRIGGER_PX;
}
