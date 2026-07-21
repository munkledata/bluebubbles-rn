/**
 * Pure state machine for the chat list's "pinned to the newest message" behavior (React-free,
 * node-tested). While pinned, every content-size change re-scrolls the list to the end — a
 * convergence loop that self-heals late row-height changes (URL-preview cards, image bubbles)
 * instead of relying on one-shot corrective scrolls. `MessageList` feeds scroll/drag events
 * through these transitions.
 *
 * Invariants:
 *  - Only a USER drag can unpin. `onScrollBeginDrag` is the one signal programmatic scrolls never
 *    emit (Android fires momentum events even for animated `scrollToEnd`), so a short-landing
 *    programmatic scroll can never unpin the list out from under itself.
 *  - Arriving near the bottom re-pins, whatever moved the list there.
 *  - Unchanged transitions return the SAME object (identity-stable, like the row reconciler), so
 *    callers can cheaply detect a flip.
 */

/** Within this distance (px) of the bottom, any scroll re-pins the list to follow the newest. */
export const REPIN_DISTANCE = 60;
/** A user drag/fling ending up further than this (px) from the bottom unpins. ~2 message rows. */
export const UNPIN_DISTANCE = 160;

export interface ScrollPinState {
  /** Follow the newest message: content growth re-scrolls to the end. */
  pinned: boolean;
  /** A drag session (the drag + its momentum) is in progress — scrolls are user-attributable. */
  userScrolling: boolean;
}

export function initialPinState(pinned: boolean): ScrollPinState {
  return { pinned, userScrolling: false };
}

/** The user put a finger down and started dragging (`onScrollBeginDrag`). */
export function pinOnDragStart(s: ScrollPinState): ScrollPinState {
  return s.userScrolling ? s : { ...s, userScrolling: true };
}

/**
 * Any scroll frame (`onScroll`). Unpins only during a user drag session; re-pins whenever the
 * list is at the bottom; in between (the hysteresis band) nothing changes.
 */
export function pinOnScroll(s: ScrollPinState, distFromBottom: number): ScrollPinState {
  if (distFromBottom <= REPIN_DISTANCE) {
    return s.pinned ? s : { ...s, pinned: true };
  }
  if (s.userScrolling && distFromBottom > UNPIN_DISTANCE) {
    return s.pinned ? { ...s, pinned: false } : s;
  }
  return s;
}

/**
 * A fling settled (`onMomentumScrollEnd`) — the drag session is over. May re-pin (the fling ended
 * at the bottom) but never unpins: Android emits momentum events for animated programmatic
 * scrolls too, and those must not be able to unpin.
 */
export function pinOnMomentumEnd(s: ScrollPinState, distFromBottom: number): ScrollPinState {
  const pinned = s.pinned || distFromBottom <= REPIN_DISTANCE;
  if (pinned === s.pinned && !s.userScrolling) return s;
  return { pinned, userScrolling: false };
}

/** Deliberate re-pin (scroll-to-bottom button, own send, keyboard follow). Clears the drag
 *  session FIRST so the animated scroll's own events can't immediately unpin again. */
export function pinExplicitly(s: ScrollPinState): ScrollPinState {
  return s.pinned && !s.userScrolling ? s : { pinned: true, userScrolling: false };
}

/** Deliberate unpin (jump to a reply's original, entering an anchored/search window). */
export function unpinExplicitly(s: ScrollPinState): ScrollPinState {
  return !s.pinned && !s.userScrolling ? s : { pinned: false, userScrolling: false };
}
