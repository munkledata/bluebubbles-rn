/**
 * BubbleEffectView send-effect cleanup on FlashList recycle (AGENTS.md: "Always `return () =>
 * anim.stop()` from the `useEffect` — MessageBubble lives in a recycling FlashList, so an uncleaned
 * animation bleeds transform state onto a recycled row").
 *
 * MessageBubble's effect coverage lives in messageBubble.test.tsx (via the bubble). THIS suite
 * targets BubbleEffectView directly and covers two DIFFERENT effect kinds:
 *   - 'slam'  → AnimatedEntrance: a one-shot Animated.parallel started on mount; its useEffect
 *              cleanup must call `.stop()` on unmount (else the animation keeps ticking on a row
 *              FlashList has already recycled).
 *   - 'invisibleInk' → InvisibleInk: NO mount animation (content hides behind a tap-to-reveal
 *              overlay); the reveal starts an Animated.parallel, and unmounting mid-reveal must
 *              `.stop()` it.
 *
 * We assert the start/stop contract directly by spying on `Animated.parallel` (the top-level
 * composite both effects build) and checking the returned handle is started as expected and stopped
 * on unmount — the same cleanup-contract approach as typingBubble.test.tsx. (We do NOT assert
 * `getTimerCount() === 0`: the jest-expo Animated mock leaves residual frame timers regardless.)
 */
import React from 'react';
import { Animated, Text } from 'react-native';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';
import { BubbleEffectView } from '@ui/conversations/effects/BubbleEffectView';

interface CompositeHandle {
  start: jest.Mock;
  stop: jest.Mock;
  reset: jest.Mock;
}

/** Spy Animated.parallel so every composite it returns exposes start/stop we can assert on. */
function spyParallel(): { handles: CompositeHandle[]; restore: () => void } {
  const handles: CompositeHandle[] = [];
  const spy = jest.spyOn(Animated, 'parallel').mockImplementation(() => {
    const handle: CompositeHandle = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
    handles.push(handle);
    return handle as unknown as Animated.CompositeAnimation;
  });
  return { handles, restore: () => spy.mockRestore() };
}

describe('BubbleEffectView effect cleanup on unmount', () => {
  it("slam: starts the entrance animation on mount and stops it on unmount", async () => {
    const { handles, restore } = spyParallel();
    try {
      const { unmount } = await renderWithTheme(
        <BubbleEffectView effect="slam">
          <Text>content</Text>
        </BubbleEffectView>,
      );
      expect(screen.getByText('content')).toBeTruthy();

      // The mount effect built + started exactly one top-level parallel animation.
      expect(handles).toHaveLength(1);
      const [anim] = handles;
      expect(anim?.start).toHaveBeenCalledTimes(1);
      expect(anim?.stop).not.toHaveBeenCalled();

      // Unmount mid-animation (FlashList recycles the row) → the cleanup must stop the animation.
      await act(async () => {
        unmount();
      });
      expect(anim?.stop).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('invisibleInk: no mount animation; tap-to-reveal starts one and unmount stops it', async () => {
    const { handles, restore } = spyParallel();
    try {
      const { unmount } = await renderWithTheme(
        <BubbleEffectView effect="invisibleInk">
          <Text>secret</Text>
        </BubbleEffectView>,
      );
      // Content sits behind the tap-to-reveal overlay; no animation runs until the user taps.
      expect(screen.getByText('secret')).toBeTruthy();
      expect(screen.getByText('✨ Tap to reveal')).toBeTruthy();
      expect(handles).toHaveLength(0);

      // Tap to reveal → starts the reveal animation.
      await act(async () => {
        fireEvent.press(screen.getByText('secret'));
      });
      expect(handles).toHaveLength(1);
      const [anim] = handles;
      expect(anim?.start).toHaveBeenCalledTimes(1);
      // Overlay is gone once revealed.
      expect(screen.queryByText('✨ Tap to reveal')).toBeNull();

      // Unmount mid-reveal → the InvisibleInk cleanup must stop the reveal animation.
      await act(async () => {
        unmount();
      });
      expect(anim?.stop).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});
