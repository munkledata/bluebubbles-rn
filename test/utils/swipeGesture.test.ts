import {
  isHorizontalSwipe,
  isReplyTrigger,
  REPLY_TRIGGER_PX,
  swipeTranslate,
  TIMESTAMP_REVEAL_MAX,
} from '@utils';

describe('swipeTranslate', () => {
  it('follows a leftward drag, clamped at the timestamp reveal max', () => {
    expect(swipeTranslate(-40, true)).toBe(-40);
    expect(swipeTranslate(-500, true)).toBe(-TIMESTAMP_REVEAL_MAX);
  });

  it('applies resistance + a cap to a rightward (reply) pull', () => {
    expect(swipeTranslate(100, true)).toBeLessThan(100); // resistance
    expect(swipeTranslate(10_000, true)).toBeLessThanOrEqual(72); // cap
  });

  it('ignores a rightward pull when reply is unavailable', () => {
    expect(swipeTranslate(100, false)).toBe(0);
    // Leftward timestamp peek still works without reply.
    expect(swipeTranslate(-40, false)).toBe(-40);
  });
});

describe('isReplyTrigger', () => {
  it('fires only past the translated threshold', () => {
    // Find a raw dx whose translated distance crosses REPLY_TRIGGER_PX.
    expect(isReplyTrigger(REPLY_TRIGGER_PX, true)).toBe(false); // raw dx ≠ translated distance
    expect(isReplyTrigger(200, true)).toBe(true);
  });

  it('never fires when reply is unavailable', () => {
    expect(isReplyTrigger(10_000, false)).toBe(false);
  });
});

describe('isHorizontalSwipe', () => {
  it('claims a mostly-horizontal drag (either direction)', () => {
    expect(isHorizontalSwipe(40, 5)).toBe(true); // right (reply)
    expect(isHorizontalSwipe(-40, 5)).toBe(true); // left (timestamp peek)
  });

  it('ignores a tiny or vertical-dominant drag so the list can scroll', () => {
    expect(isHorizontalSwipe(6, 0)).toBe(false); // below the 10px activation
    expect(isHorizontalSwipe(20, 20)).toBe(false); // diagonal — not clearly horizontal
    expect(isHorizontalSwipe(5, 60)).toBe(false); // a vertical scroll
  });
});
