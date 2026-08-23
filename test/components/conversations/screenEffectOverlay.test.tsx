/**
 * ScreenEffectOverlay (src/ui/conversations/effects/ScreenEffectOverlay.tsx): the full-screen
 * iMessage send-effect — JS particles driven by ONE Animated value, floating over the chat and
 * auto-dismissing.
 *
 * The behaviours locked in here:
 *   1. pointerEvents="none" on the overlay — the single most important assertion (AGENTS.md: a
 *      touch-catching overlay would freeze chat scrolling for ~2.6s). Also absoluteFill layout.
 *   2. Particle count per effect kind: balloons → 16, everything else → 36; exercising all three
 *      buildParticles branches (confetti/celebration fall, balloons rise, centre burst incl. the
 *      'love' specialisation).
 *   3. Auto-dismiss contract: the mount effect starts an Animated.timing whose completion callback
 *      fires onDone only when `finished` (not for a superseded/stopped run).
 *   4. Cleanup: unmounting stops the animation (recycling-list safety) and a late completion after
 *      unmount does NOT fire onDone (the `cancelled` guard).
 *   5. Reduce Motion: no particles or animation before preference resolution or while enabled;
 *      live enablement stops and completes an active effect exactly once.
 *   6. Effect generations: prop transitions get independent completion state, stale native
 *      callbacks cannot clear replacements, and callback-identity changes do not restart motion.
 *
 * We assert 3–6 by spying on Animated.timing (deterministic) rather than draining the real frame
 * loop under fake timers — same start/stop-contract approach as bubbleEffectCleanup.test.tsx, and
 * it avoids the jest-expo residual-frame-timer artifact (AGENTS.md: never assert getTimerCount()).
 */
import React from 'react';
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native';
import type { ScreenEffect } from '@core/effects';
import { renderWithTheme, act, type RenderResult } from '../support/renderWithTheme';
import { ScreenEffectOverlay } from '@ui/conversations/effects/ScreenEffectOverlay';

type StartCb = (result: { finished: boolean }) => void;

const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

let reduceMotionListener: ((enabled: boolean) => void) | undefined;
let removeReduceMotionListener: jest.Mock;

function EffectCommitHarness({
  effect,
  onDone,
  onEffectCommit,
}: {
  effect: ScreenEffect;
  onDone: () => void;
  onEffectCommit: () => void;
}): React.JSX.Element {
  const previousEffect = React.useRef(effect);

  React.useLayoutEffect(() => {
    if (previousEffect.current === effect) return;
    previousEffect.current = effect;
    onEffectCommit();
  }, [effect, onEffectCommit]);

  return <ScreenEffectOverlay effect={effect} onDone={onDone} />;
}

/** `root` is typed nullable, but a rendered tree always has one — narrow it. */
function rootOf(r: RenderResult): NonNullable<RenderResult['root']> {
  if (!r.root) throw new Error('no rendered root');
  return r.root;
}

/** Spy Animated.timing so we control when/how its completion callback runs. */
function spyTiming(): {
  getStartCb: () => StartCb | undefined;
  stop: jest.Mock;
  restore: () => void;
} {
  let captured: StartCb | undefined;
  const stop = jest.fn();
  const spy = jest.spyOn(Animated, 'timing').mockImplementation(
    () =>
      ({
        start: (cb?: StartCb) => {
          captured = cb;
        },
        stop,
        reset: jest.fn(),
      }) as unknown as Animated.CompositeAnimation,
  );
  return { getStartCb: () => captured, stop, restore: () => spy.mockRestore() };
}

describe('ScreenEffectOverlay', () => {
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

  it('renders nothing and starts no animation while the motion preference is unresolved', async () => {
    mockIsReduceMotionEnabled.mockReturnValue(new Promise<boolean>(() => undefined));
    const onDone = jest.fn();
    const { restore } = spyTiming();
    try {
      const r = await renderWithTheme(<ScreenEffectOverlay effect="confetti" onDone={onDone} />);

      expect(r.toJSON()).toBeNull();
      expect(Animated.timing).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('skips decorative particles and completes once when Reduce Motion is initially enabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const onDone = jest.fn();
    const { restore } = spyTiming();
    try {
      const r = await renderWithTheme(<ScreenEffectOverlay effect="love" onDone={onDone} />);

      expect(r.toJSON()).toBeNull();
      expect(Animated.timing).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('falls back to the existing animation when the native preference query fails', async () => {
    mockIsReduceMotionEnabled.mockRejectedValue(new Error('native preference unavailable'));
    const { restore } = spyTiming();
    try {
      const r = await renderWithTheme(
        <ScreenEffectOverlay effect="fireworks" onDone={jest.fn()} />,
      );

      expect(rootOf(r).props.pointerEvents).toBe('none');
      expect(Animated.timing).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('stops a running animation and completes once when Reduce Motion becomes enabled', async () => {
    const onDone = jest.fn();
    const { getStartCb, stop, restore } = spyTiming();
    try {
      const r = await renderWithTheme(<ScreenEffectOverlay effect="lasers" onDone={onDone} />);
      const cb = getStartCb();
      expect(cb).toBeDefined();

      await act(async () => {
        reduceMotionListener!(true);
      });

      expect(r.toJSON()).toBeNull();
      expect(stop).toHaveBeenCalledTimes(1);
      expect(onDone).toHaveBeenCalledTimes(1);

      await act(async () => {
        cb!({ finished: true });
      });
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('does not complete twice when Reduce Motion is enabled after animation completion', async () => {
    const onDone = jest.fn();
    const { getStartCb, restore } = spyTiming();
    try {
      await renderWithTheme(<ScreenEffectOverlay effect="fireworks" onDone={onDone} />);

      await act(async () => {
        getStartCb()!({ finished: true });
      });
      expect(onDone).toHaveBeenCalledTimes(1);

      await act(async () => {
        reduceMotionListener!(true);
      });
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('uses a newer onDone callback without restarting the same effect', async () => {
    const firstOnDone = jest.fn();
    const latestOnDone = jest.fn();
    const { getStartCb, stop, restore } = spyTiming();
    try {
      const r = await renderWithTheme(
        <ScreenEffectOverlay effect="confetti" onDone={firstOnDone} />,
      );
      const cb = getStartCb();

      await r.rerender(<ScreenEffectOverlay effect="confetti" onDone={latestOnDone} />);

      expect(Animated.timing).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      await act(async () => {
        cb!({ finished: true });
      });
      expect(firstOnDone).not.toHaveBeenCalled();
      expect(latestOnDone).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('allows a replacement effect to complete independently', async () => {
    const onDone = jest.fn();
    const { getStartCb, restore } = spyTiming();
    try {
      const r = await renderWithTheme(<ScreenEffectOverlay effect="balloons" onDone={onDone} />);
      await act(async () => {
        getStartCb()!({ finished: true });
      });

      await r.rerender(<ScreenEffectOverlay effect="love" onDone={onDone} />);
      expect(Animated.timing).toHaveBeenCalledTimes(2);
      await act(async () => {
        getStartCb()!({ finished: true });
      });

      expect(onDone).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it('allows an effect name to complete again after an unfinished replacement', async () => {
    const onDone = jest.fn();
    const { getStartCb, restore } = spyTiming();
    try {
      const r = await renderWithTheme(<ScreenEffectOverlay effect="confetti" onDone={onDone} />);
      await act(async () => {
        getStartCb()!({ finished: true });
      });

      await r.rerender(<ScreenEffectOverlay effect="love" onDone={onDone} />);
      const unfinishedLoveCb = getStartCb();
      await r.rerender(<ScreenEffectOverlay effect="confetti" onDone={onDone} />);
      const repeatedConfettiCb = getStartCb();

      await act(async () => {
        unfinishedLoveCb!({ finished: true });
        repeatedConfettiCb!({ finished: true });
      });
      expect(onDone).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it('rejects the previous animation completion during a replacement commit', async () => {
    const onDone = jest.fn();
    const { getStartCb, restore } = spyTiming();
    let previousAnimationCb: StartCb | undefined;
    const completePreviousAnimation = (): void => {
      previousAnimationCb?.({ finished: true });
    };
    try {
      const r = await renderWithTheme(
        <EffectCommitHarness
          effect="confetti"
          onDone={onDone}
          onEffectCommit={completePreviousAnimation}
        />,
      );
      previousAnimationCb = getStartCb();

      await r.rerender(
        <EffectCommitHarness
          effect="love"
          onDone={onDone}
          onEffectCommit={completePreviousAnimation}
        />,
      );

      expect(onDone).not.toHaveBeenCalled();
      await act(async () => {
        getStartCb()!({ finished: true });
      });
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('keeps a newer preference event authoritative and removes the listener on unmount', async () => {
    let resolveInitialPreference: ((enabled: boolean) => void) | undefined;
    mockIsReduceMotionEnabled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveInitialPreference = resolve;
      }),
    );
    const onDone = jest.fn();
    const { restore } = spyTiming();
    try {
      const r = await renderWithTheme(<ScreenEffectOverlay effect="celebration" onDone={onDone} />);

      await act(async () => {
        reduceMotionListener!(true);
        resolveInitialPreference!(false);
      });

      expect(r.toJSON()).toBeNull();
      expect(Animated.timing).not.toHaveBeenCalled();
      expect(onDone).toHaveBeenCalledTimes(1);

      await act(async () => {
        r.unmount();
      });
      expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('ignores the initial preference query if it resolves after unmount', async () => {
    let resolveInitialPreference: ((enabled: boolean) => void) | undefined;
    mockIsReduceMotionEnabled.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveInitialPreference = resolve;
      }),
    );
    const onDone = jest.fn();
    const { restore } = spyTiming();
    try {
      const r = await renderWithTheme(<ScreenEffectOverlay effect="echo" onDone={onDone} />);

      await act(async () => {
        r.unmount();
      });
      expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolveInitialPreference!(false);
      });
      expect(Animated.timing).not.toHaveBeenCalled();
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('pins pointerEvents="none" and absoluteFill on the overlay so it never blocks chat scroll', async () => {
    const r = await renderWithTheme(<ScreenEffectOverlay effect="confetti" onDone={jest.fn()} />);

    // The overlay View is the rendered root.
    const overlay = rootOf(r);
    expect(overlay.props.pointerEvents).toBe('none');
    // absoluteFill = position:absolute, left/right/top/bottom 0 — floats over the whole chat.
    expect(StyleSheet.flatten(overlay.props.style)).toMatchObject(
      StyleSheet.flatten(StyleSheet.absoluteFill),
    );
  });

  it.each<[ScreenEffect, number]>([
    ['confetti', 36],
    ['celebration', 36],
    ['balloons', 16],
    ['love', 36],
    ['fireworks', 36],
    ['echo', 36],
  ])('renders %s as %d particles', async (effect, count) => {
    const r = await renderWithTheme(<ScreenEffectOverlay effect={effect} onDone={jest.fn()} />);
    // Each particle is one Animated.View child of the overlay (one per buildParticles entry).
    expect(rootOf(r).queryAll(() => true)).toHaveLength(count);
  });

  it('fires onDone when the animation finishes', async () => {
    const onDone = jest.fn();
    const { getStartCb, restore } = spyTiming();
    try {
      await renderWithTheme(<ScreenEffectOverlay effect="fireworks" onDone={onDone} />);
      const cb = getStartCb();
      expect(cb).toBeDefined();

      expect(onDone).not.toHaveBeenCalled();
      await act(async () => {
        cb!({ finished: true });
      });
      expect(onDone).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('does NOT fire onDone for an unfinished (superseded) run', async () => {
    const onDone = jest.fn();
    const { getStartCb, restore } = spyTiming();
    try {
      await renderWithTheme(<ScreenEffectOverlay effect="lasers" onDone={onDone} />);
      await act(async () => {
        getStartCb()!({ finished: false });
      });
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('stops the animation on unmount and ignores a late completion (cancelled guard)', async () => {
    const onDone = jest.fn();
    const { getStartCb, stop, restore } = spyTiming();
    try {
      const { unmount } = await renderWithTheme(
        <ScreenEffectOverlay effect="balloons" onDone={onDone} />,
      );
      const cb = getStartCb();
      expect(stop).not.toHaveBeenCalled();

      await act(async () => {
        unmount();
      });
      // Cleanup stops the in-flight animation so it can't tick on a recycled row.
      expect(stop).toHaveBeenCalledTimes(1);

      // A completion that lands after unmount must NOT clear a newer effect via onDone.
      await act(async () => {
        cb!({ finished: true });
      });
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
