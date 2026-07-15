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
 *
 * We assert 3 & 4 by spying on Animated.timing (deterministic) rather than draining the real frame
 * loop under fake timers — same start/stop-contract approach as bubbleEffectCleanup.test.tsx, and
 * it avoids the jest-expo residual-frame-timer artifact (AGENTS.md: never assert getTimerCount()).
 */
import React from 'react';
import { Animated, StyleSheet } from 'react-native';
import type { ScreenEffect } from '@core/effects';
import { renderWithTheme, act, type RenderResult } from '../support/renderWithTheme';
import { ScreenEffectOverlay } from '@ui/conversations/effects/ScreenEffectOverlay';

type StartCb = (result: { finished: boolean }) => void;

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
