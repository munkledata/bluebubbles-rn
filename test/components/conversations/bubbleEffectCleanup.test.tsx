/**
 * BubbleEffectView send-effect cleanup on FlashList recycle (AGENTS.md: "Always `return () =>
 * anim.stop()` from the `useEffect` — MessageBubble lives in a recycling FlashList, so an uncleaned
 * animation bleeds transform state onto a recycled row").
 *
 * MessageBubble's effect coverage lives in messageBubble.test.tsx (via the bubble). THIS suite
 * targets BubbleEffectView directly and covers motion preference plus two DIFFERENT effect kinds:
 *   - 'slam'  → AnimatedEntrance: a one-shot Animated.parallel started on mount; its useEffect
 *              cleanup must call `.stop()` on unmount (else the animation keeps ticking on a row
 *              FlashList has already recycled).
 *   - 'invisibleInk' → InvisibleInk: NO mount animation (content hides behind a tap-to-reveal
 *              overlay); the reveal starts an Animated.parallel, and unmounting mid-reveal must
 *              `.stop()` it.
 *
 * Reduce Motion keeps entrance content visible and static, cancels active entrances, and makes an
 * invisible-ink reveal instant without removing its conceal/reveal control. Preference events win
 * over stale initial queries, and a consumed entrance never replays merely because the setting is
 * later disabled.
 *
 * We assert start/stop contracts directly by spying on `Animated.parallel` and checking its returned
 * handle — the same cleanup-contract approach as typingBubble.test.tsx. (We do NOT assert
 * `getTimerCount() === 0`: the jest-expo Animated mock leaves residual frame timers regardless.)
 */
import React from 'react';
import { AccessibilityInfo, Animated, Text } from 'react-native';
import type { BubbleEffect } from '@core/effects';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';
import { BubbleEffectView } from '@ui/conversations/effects/BubbleEffectView';

interface CompositeHandle {
  start: jest.Mock;
  stop: jest.Mock;
  reset: jest.Mock;
}

type EntranceEffect = Exclude<BubbleEffect, 'invisibleInk'>;

const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

let reduceMotionListener: ((enabled: boolean) => void) | undefined;
let removeReduceMotionListener: jest.Mock;

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

function spySequence(): { handles: CompositeHandle[]; restore: () => void } {
  const handles: CompositeHandle[] = [];
  const spy = jest.spyOn(Animated, 'sequence').mockImplementation(() => {
    const handle: CompositeHandle = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
    handles.push(handle);
    return handle as unknown as Animated.CompositeAnimation;
  });
  return { handles, restore: () => spy.mockRestore() };
}

function spyMotionFactories(): {
  timing: jest.SpyInstance;
  spring: jest.SpyInstance;
  restore: () => void;
} {
  const timing = jest.spyOn(Animated, 'timing');
  const spring = jest.spyOn(Animated, 'spring');
  return {
    timing,
    spring,
    restore: () => {
      timing.mockRestore();
      spring.mockRestore();
    },
  };
}

describe('BubbleEffectView motion preference and cleanup', () => {
  beforeEach(() => {
    reduceMotionListener = undefined;
    removeReduceMotionListener = jest.fn();
    mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
    mockAddEventListener.mockReset().mockImplementation((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      reduceMotionListener = listener as (enabled: boolean) => void;
      return { remove: removeReduceMotionListener };
    });
  });

  it('keeps entrance content visible and static while the preference is unresolved', async () => {
    mockIsReduceMotionEnabled.mockReturnValue(new Promise<boolean>(() => undefined));
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    const motion = spyMotionFactories();
    try {
      await renderWithTheme(
        <BubbleEffectView effect="slam">
          <Text>content</Text>
        </BubbleEffectView>,
      );

      expect(screen.getByText('content')).toBeTruthy();
      expect(motion.timing).not.toHaveBeenCalled();
      expect(motion.spring).not.toHaveBeenCalled();
      expect(setValue.mock.calls.slice(-2)).toEqual([[1], [1]]);
    } finally {
      motion.restore();
      setValue.mockRestore();
    }
  });

  it.each<EntranceEffect>(['slam', 'loud', 'gentle'])(
    '%s: suppresses the entrance and leaves content static when Reduce Motion is enabled',
    async (effect) => {
      mockIsReduceMotionEnabled.mockResolvedValue(true);
      const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
      const motion = spyMotionFactories();
      try {
        await renderWithTheme(
          <BubbleEffectView effect={effect}>
            <Text>{effect}</Text>
          </BubbleEffectView>,
        );

        expect(screen.getByText(effect)).toBeTruthy();
        expect(motion.timing).not.toHaveBeenCalled();
        expect(motion.spring).not.toHaveBeenCalled();
        expect(setValue.mock.calls.slice(-2)).toEqual([[1], [1]]);
      } finally {
        motion.restore();
        setValue.mockRestore();
      }
    },
  );

  it('slam: starts the entrance animation on mount and stops it on unmount', async () => {
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

  it('loud: retains its normal one-shot sequence and cleanup when motion is allowed', async () => {
    const { handles, restore } = spySequence();
    try {
      const { unmount } = await renderWithTheme(
        <BubbleEffectView effect="loud">
          <Text>content</Text>
        </BubbleEffectView>,
      );

      expect(handles).toHaveLength(1);
      expect(handles[0]?.start).toHaveBeenCalledTimes(1);
      await act(async () => {
        unmount();
      });
      expect(handles[0]?.stop).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('falls back to the existing entrance when the native preference query fails', async () => {
    mockIsReduceMotionEnabled.mockRejectedValue(new Error('native preference unavailable'));
    const { handles, restore } = spyParallel();
    try {
      const { unmount } = await renderWithTheme(
        <BubbleEffectView effect="gentle">
          <Text>content</Text>
        </BubbleEffectView>,
      );

      expect(handles).toHaveLength(1);
      expect(handles[0]?.start).toHaveBeenCalledTimes(1);
      await act(async () => {
        unmount();
      });
      expect(handles[0]?.stop).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('stops and snaps an active entrance, then does not replay it when motion is re-enabled', async () => {
    const { handles, restore } = spyParallel();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const { unmount } = await renderWithTheme(
        <BubbleEffectView effect="slam">
          <Text>content</Text>
        </BubbleEffectView>,
      );
      expect(handles).toHaveLength(1);

      await act(async () => {
        reduceMotionListener!(true);
      });
      expect(handles[0]?.stop).toHaveBeenCalledTimes(1);
      expect(setValue.mock.calls.slice(-2)).toEqual([[1], [1]]);

      await act(async () => {
        reduceMotionListener!(false);
      });
      expect(handles).toHaveLength(1);

      await act(async () => {
        unmount();
      });
      expect(handles[0]?.stop).toHaveBeenCalledTimes(1);
    } finally {
      setValue.mockRestore();
      restore();
    }
  });

  it('stops and statically consumes an in-place effect replacement without replaying', async () => {
    const { handles, restore } = spyParallel();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const view = await renderWithTheme(
        <BubbleEffectView effect="slam">
          <Text>content</Text>
        </BubbleEffectView>,
      );
      expect(handles).toHaveLength(1);

      await view.rerender(
        <BubbleEffectView effect="gentle">
          <Text>content</Text>
        </BubbleEffectView>,
      );

      expect(handles[0]?.stop).toHaveBeenCalledTimes(1);
      expect(handles).toHaveLength(1);
      expect(setValue.mock.calls.slice(-2)).toEqual([[1], [1]]);

      await act(async () => {
        view.unmount();
      });
      expect(handles[0]?.stop).toHaveBeenCalledTimes(1);
    } finally {
      setValue.mockRestore();
      restore();
    }
  });

  it('keeps a newer preference event authoritative over the initial query', async () => {
    let resolveInitialPreference: ((enabled: boolean) => void) | undefined;
    mockIsReduceMotionEnabled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveInitialPreference = resolve;
      }),
    );
    const { handles, restore } = spyParallel();
    try {
      const { unmount } = await renderWithTheme(
        <BubbleEffectView effect="slam">
          <Text>content</Text>
        </BubbleEffectView>,
      );

      await act(async () => {
        reduceMotionListener!(true);
        resolveInitialPreference!(false);
      });
      expect(handles).toHaveLength(0);

      await act(async () => {
        reduceMotionListener!(false);
      });
      expect(handles).toHaveLength(0);

      await act(async () => {
        unmount();
      });
      expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('ignores a late initial query after unmount', async () => {
    let resolveInitialPreference: ((enabled: boolean) => void) | undefined;
    mockIsReduceMotionEnabled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveInitialPreference = resolve;
      }),
    );
    const { handles, restore } = spyParallel();
    try {
      const { unmount } = await renderWithTheme(
        <BubbleEffectView effect="slam">
          <Text>content</Text>
        </BubbleEffectView>,
      );

      await act(async () => {
        unmount();
      });
      expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveInitialPreference!(false);
      });
      expect(handles).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('treats a fresh remount as a fresh entrance run', async () => {
    const { handles, restore } = spyParallel();
    try {
      const first = await renderWithTheme(
        <BubbleEffectView effect="slam">
          <Text>first</Text>
        </BubbleEffectView>,
      );
      expect(handles).toHaveLength(1);
      await act(async () => {
        first.unmount();
      });
      expect(handles[0]?.stop).toHaveBeenCalledTimes(1);

      await renderWithTheme(
        <BubbleEffectView effect="slam">
          <Text>second</Text>
        </BubbleEffectView>,
      );
      expect(handles).toHaveLength(2);
      expect(handles[1]?.start).toHaveBeenCalledTimes(1);
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

  it('invisibleInk: an unresolved preference keeps concealment but reveals instantly', async () => {
    mockIsReduceMotionEnabled.mockReturnValue(new Promise<boolean>(() => undefined));
    const { handles, restore } = spyParallel();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const { unmount } = await renderWithTheme(
        <BubbleEffectView effect="invisibleInk">
          <Text>secret</Text>
        </BubbleEffectView>,
      );
      expect(screen.getByText('✨ Tap to reveal')).toBeTruthy();

      await act(async () => {
        fireEvent.press(screen.getByText('secret'));
      });
      expect(handles).toHaveLength(0);
      expect(screen.queryByText('✨ Tap to reveal')).toBeNull();
      expect(setValue.mock.calls).toEqual(expect.arrayContaining([[1], [0]]));

      await act(async () => {
        unmount();
      });
      expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
    } finally {
      setValue.mockRestore();
      restore();
    }
  });

  it('invisibleInk: Reduce Motion preserves concealment and makes reveal instant', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const { handles, restore } = spyParallel();
    try {
      await renderWithTheme(
        <BubbleEffectView effect="invisibleInk">
          <Text>secret</Text>
        </BubbleEffectView>,
      );
      expect(screen.getByText('✨ Tap to reveal')).toBeTruthy();

      await act(async () => {
        fireEvent.press(screen.getByText('secret'));
      });
      expect(handles).toHaveLength(0);
      expect(screen.queryByText('✨ Tap to reveal')).toBeNull();
    } finally {
      restore();
    }
  });

  it('invisibleInk: live Reduce Motion stops an active reveal and does not replay it', async () => {
    const { handles, restore } = spyParallel();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const { unmount } = await renderWithTheme(
        <BubbleEffectView effect="invisibleInk">
          <Text>secret</Text>
        </BubbleEffectView>,
      );
      await act(async () => {
        fireEvent.press(screen.getByText('secret'));
      });
      expect(handles).toHaveLength(1);

      await act(async () => {
        reduceMotionListener!(true);
      });
      expect(handles[0]?.stop).toHaveBeenCalledTimes(1);
      expect(setValue.mock.calls.slice(-2)).toEqual([[1], [0]]);

      await act(async () => {
        reduceMotionListener!(false);
      });
      expect(handles).toHaveLength(1);

      await act(async () => {
        unmount();
      });
      expect(handles[0]?.stop).toHaveBeenCalledTimes(1);
    } finally {
      setValue.mockRestore();
      restore();
    }
  });
});
