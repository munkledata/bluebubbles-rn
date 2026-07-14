/**
 * TypingBubble (src/ui/conversations/TypingBubble.tsx): the iOS "…" typing indicator — a
 * received-style bubble with three pulsing dots. Each dot pulses via an `Animated.loop`
 * sequence started in a mount effect; the effect's cleanup calls `.stop()` on every loop.
 *
 * The behaviour worth locking in: it renders an accessible "Typing" bubble with three dots, and
 * — critically for a component that lives in a recycling FlashList (AGENTS.md: "an uncleaned
 * animation bleeds transform state onto a recycled row") — unmounting STOPS every animation loop
 * so none leak. We assert that cleanup contract directly by spying on `Animated.loop` and
 * checking each returned loop is started on mount and stopped on unmount.
 *
 * NOTE: we don't assert `jest.getTimerCount() === 0` after unmount — under the jest-expo
 * `Animated` native-driver mock the frame loop leaves ~4 residual timers that persist regardless
 * of unmount (an environment artifact, verified: the count oscillates 6↔4 whether or not the tree
 * is mounted). Spying on `.stop()` tests the component's own cleanup, which is the real
 * regression surface.
 */
import React from 'react';
import { Animated } from 'react-native';
import { renderWithTheme, screen, act } from '../support/renderWithTheme';
import { TypingBubble } from '@ui/conversations/TypingBubble';

interface LoopHandle {
  start: jest.Mock;
  stop: jest.Mock;
  reset: jest.Mock;
}

describe('TypingBubble', () => {
  it('renders an accessible typing bubble with three dots', async () => {
    await renderWithTheme(<TypingBubble />);

    const bubble = screen.getByLabelText('Typing');
    expect(bubble).toBeTruthy();
    // The three animated dots are the bubble's only children.
    expect(bubble.children).toHaveLength(3);
  });

  it('starts three animation loops on mount and stops all of them on unmount', async () => {
    const handles: LoopHandle[] = [];
    const loopSpy = jest.spyOn(Animated, 'loop').mockImplementation(() => {
      const handle: LoopHandle = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
      handles.push(handle);
      return handle as unknown as Animated.CompositeAnimation;
    });

    try {
      const { unmount } = await renderWithTheme(<TypingBubble />);

      // One loop per dot, each started exactly once, none stopped yet.
      expect(handles).toHaveLength(3);
      for (const h of handles) {
        expect(h.start).toHaveBeenCalledTimes(1);
        expect(h.stop).not.toHaveBeenCalled();
      }

      // React 19 flushes unmount effect cleanups inside act().
      await act(async () => {
        unmount();
      });

      // Cleanup must stop every loop so nothing keeps animating on a recycled row.
      for (const h of handles) {
        expect(h.stop).toHaveBeenCalledTimes(1);
      }
    } finally {
      loopSpy.mockRestore();
    }
  });
});
