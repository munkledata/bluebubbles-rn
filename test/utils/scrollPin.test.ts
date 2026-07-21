import {
  initialPinState,
  pinExplicitly,
  pinOnDragStart,
  pinOnMomentumEnd,
  pinOnScroll,
  REPIN_DISTANCE,
  UNPIN_DISTANCE,
  unpinExplicitly,
} from '@utils';

describe('scrollPin state machine', () => {
  it('starts pinned for a normal open, unpinned for an anchored (search-hit) open', () => {
    expect(initialPinState(true)).toEqual({ pinned: true, userScrolling: false });
    expect(initialPinState(false)).toEqual({ pinned: false, userScrolling: false });
  });

  describe('unpinning requires a user drag session', () => {
    it('a drag away from the bottom unpins', () => {
      let s = initialPinState(true);
      s = pinOnDragStart(s);
      s = pinOnScroll(s, UNPIN_DISTANCE + 1);
      expect(s.pinned).toBe(false);
    });

    it('scroll events WITHOUT a drag never unpin (programmatic scrolls, autoscroll)', () => {
      let s = initialPinState(true);
      // e.g. a short-landing scrollToEnd reports a big distance mid-flight.
      s = pinOnScroll(s, 900);
      expect(s.pinned).toBe(true);
    });

    it('momentum end never unpins, even far from the bottom (Android emits momentum for animated programmatic scrolls)', () => {
      let s = initialPinState(true);
      s = pinOnMomentumEnd(s, 900);
      expect(s.pinned).toBe(true);
      expect(s.userScrolling).toBe(false);
    });

    it('drags inside the hysteresis band (REPIN..UNPIN) change nothing', () => {
      let s = initialPinState(true);
      s = pinOnDragStart(s);
      const mid = (REPIN_DISTANCE + UNPIN_DISTANCE) / 2;
      expect(pinOnScroll(s, mid).pinned).toBe(true); // small wiggle keeps the pin

      let up = pinOnScroll(s, UNPIN_DISTANCE + 200); // now unpinned…
      up = pinOnScroll(up, mid);
      expect(up.pinned).toBe(false); // …and drifting back into the band does not re-pin
    });
  });

  describe('re-pinning', () => {
    it('reaching the bottom re-pins whatever moved the list there', () => {
      let s = unpinExplicitly(initialPinState(true));
      s = pinOnScroll(s, REPIN_DISTANCE); // no drag session needed
      expect(s.pinned).toBe(true);
    });

    it('a fling that settles at the bottom re-pins and ends the drag session', () => {
      let s = initialPinState(true);
      s = pinOnDragStart(s);
      s = pinOnScroll(s, 600);
      expect(s.pinned).toBe(false);
      s = pinOnMomentumEnd(s, REPIN_DISTANCE - 10);
      expect(s).toEqual({ pinned: true, userScrolling: false });
    });

    it('pinExplicitly pins AND clears the drag session so the follow-up animated scroll cannot unpin', () => {
      let s = pinOnDragStart(initialPinState(true));
      s = pinOnScroll(s, 600);
      s = pinExplicitly(s);
      expect(s).toEqual({ pinned: true, userScrolling: false });
      // The animated scrollToEnd's own scroll frames (still far from bottom) must not unpin.
      expect(pinOnScroll(s, 400).pinned).toBe(true);
    });
  });

  describe('explicit transitions', () => {
    it('unpinExplicitly unpins and clears the session (jumpToReply, entering anchor mode)', () => {
      const s = unpinExplicitly(pinOnDragStart(initialPinState(true)));
      expect(s).toEqual({ pinned: false, userScrolling: false });
    });
  });

  describe('identity stability (unchanged transitions return the same object)', () => {
    it('no-op transitions keep the reference', () => {
      const pinned = initialPinState(true);
      expect(pinOnScroll(pinned, 10)).toBe(pinned); // already pinned, at bottom
      expect(pinOnScroll(pinned, 500)).toBe(pinned); // no drag session — nothing to do
      expect(pinOnMomentumEnd(pinned, 500)).toBe(pinned); // no session to clear, no re-pin flip
      expect(pinExplicitly(pinned)).toBe(pinned);

      const unpinned = initialPinState(false);
      expect(unpinExplicitly(unpinned)).toBe(unpinned);
      const dragging = pinOnDragStart(unpinned);
      expect(pinOnDragStart(dragging)).toBe(dragging);
      const midBand = (REPIN_DISTANCE + UNPIN_DISTANCE) / 2;
      expect(pinOnScroll(dragging, midBand)).toBe(dragging); // hysteresis band no-op
    });
  });
});
