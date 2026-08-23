/**
 * MessageSwipeWrapper (src/ui/conversations/MessageSwipeWrapper.tsx): structure plus its JS gesture
 * and automatic-reset state machine. The suite captures PanResponder callbacks and drives them with
 * synthetic gesture state. This proves policy, reply ordering, animation ownership, and cleanup; it
 * cannot prove native touch feel, native-driver pixels, or Samsung/FlashList arbitration on device.
 */
import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Text,
  type GestureResponderEvent,
  type PanResponderCallbacks,
  type PanResponderGestureState,
  type PanResponderInstance,
} from 'react-native';
import { REPLY_TRIGGER_PX, swipeTranslate } from '@utils';
import { act, cleanup, renderWithTheme, screen } from '../support/renderWithTheme';
import { MessageSwipeWrapper } from '@ui/conversations/MessageSwipeWrapper';

// Render icon glyphs synchronously (no deferred font-load setState → no act noise).
jest.mock('@expo/vector-icons', () => {
  const r = jest.requireActual<typeof import('react')>('react');
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  return { Ionicons: ({ name }: { name: string }) => r.createElement(RN.Text, null, name) };
});

const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

let responderConfig: PanResponderCallbacks | undefined;
let reduceMotionListener: ((enabled: boolean) => void) | undefined;
let removeReduceMotionListener: jest.Mock;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface TrackedAnimation {
  start: jest.Mock;
  stop: jest.Mock;
  reset: jest.Mock;
  finish(result?: { finished: boolean }): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function spySettleAnimations({
  finishSynchronously = false,
  onCreate,
}: {
  finishSynchronously?: boolean;
  onCreate?: () => void;
} = {}): { spring: jest.SpyInstance; handles: TrackedAnimation[] } {
  const handles: TrackedAnimation[] = [];
  const spring = jest.spyOn(Animated, 'spring').mockImplementation(() => {
    let completion: ((result: { finished: boolean }) => void) | undefined;
    const tracked: TrackedAnimation = {
      start: jest.fn((callback?: (result: { finished: boolean }) => void) => {
        completion = callback;
        if (finishSynchronously) callback?.({ finished: true });
      }),
      stop: jest.fn(),
      reset: jest.fn(),
      finish: (result = { finished: true }) => completion?.(result),
    };
    handles.push(tracked);
    onCreate?.();
    return tracked as Animated.CompositeAnimation;
  });
  return { spring, handles };
}

function gesture(dx = 0, dy = 0): PanResponderGestureState {
  return { dx, dy } as PanResponderGestureState;
}

const EVENT = {} as GestureResponderEvent;

describe('MessageSwipeWrapper', () => {
  beforeEach(() => {
    responderConfig = undefined;
    reduceMotionListener = undefined;
    removeReduceMotionListener = jest.fn();
    mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
    mockAddEventListener.mockReset().mockImplementation((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      reduceMotionListener = listener as (enabled: boolean) => void;
      return { remove: removeReduceMotionListener };
    });
    jest.spyOn(PanResponder, 'create').mockImplementation((config) => {
      responderConfig = config;
      return { panHandlers: {} } as PanResponderInstance;
    });
  });

  afterEach(async () => {
    await cleanup();
    jest.restoreAllMocks();
  });

  function config(): Required<PanResponderCallbacks> {
    if (!responderConfig) throw new Error('PanResponder.create was not called');
    return responderConfig as Required<PanResponderCallbacks>;
  }

  async function drive(callback: () => void): Promise<void> {
    await act(async () => callback());
  }

  async function settleInitialMotionPreference(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
  }

  async function emitReduceMotion(enabled: boolean): Promise<void> {
    expect(reduceMotionListener).toBeDefined();
    await drive(() => reduceMotionListener?.(enabled));
  }

  async function mount(onReply?: () => void) {
    return renderWithTheme(
      <MessageSwipeWrapper timestamp="3:14 PM" onReply={onReply}>
        <Text>bubble content</Text>
      </MessageSwipeWrapper>,
    );
  }

  function expectExistingSpringConfig(spring: jest.SpyInstance, index = 0): void {
    expect(spring.mock.calls[index]?.[1]).toEqual({
      toValue: 0,
      useNativeDriver: true,
      bounciness: 0,
      speed: 20,
    });
  }

  it('renders its children and the reveal-timestamp label', async () => {
    await mount();
    expect(screen.getByText('bubble content')).toBeTruthy();
    expect(screen.getByText('3:14 PM')).toBeTruthy();
  });

  it('shows the reply glyph only when onReply is provided', async () => {
    const { rerender } = await mount();
    expect(screen.queryByText('arrow-undo')).toBeNull();
    await act(async () => {
      rerender(
        <MessageSwipeWrapper timestamp="3:14 PM" onReply={jest.fn()}>
          <Text>bubble content</Text>
        </MessageSwipeWrapper>,
      );
    });
    expect(await screen.findByText('arrow-undo')).toBeTruthy();
  });

  // Config-level regression guard for the S25-Ultra bug: the swipe and the FlashList vertical scroll
  // race for the same finger-drag, and on Samsung One UI the scroll won ~50% of the time. jest can't
  // drive the drag, but it CAN assert the PanResponder is configured to hold the gesture once claimed.
  // If any of these guards is dropped, the flaky-swipe bug silently returns — so pin them here.
  it('hardens the PanResponder so the list scroll cannot steal the swipe', async () => {
    await mount(jest.fn());
    // The key fix: once we own the drag, refuse to surrender it back to the scroll (default is true).
    expect(config().onPanResponderTerminationRequest(EVENT, gesture(40, 0))).toBe(false);
    // Android: block the native scroll once the JS gesture is granted.
    expect(config().onShouldBlockNativeResponder(EVENT, gesture(40, 0))).toBe(true);
    // Claim a mostly-horizontal drag in BOTH the bubble and capture phases…
    expect(config().onMoveShouldSetPanResponder(EVENT, gesture(40, 5))).toBe(true);
    expect(config().onMoveShouldSetPanResponderCapture(EVENT, gesture(40, 5))).toBe(true);
    // …but let a vertical scroll fall through, and never claim on touch-start (taps/long-press pass).
    expect(config().onMoveShouldSetPanResponder(EVENT, gesture(5, 60))).toBe(false);
    expect(config().onStartShouldSetPanResponder(EVENT, gesture())).toBe(false);
  });

  it('fires only the latest reply before retaining the exact existing spring under known false', async () => {
    const order: string[] = [];
    const animations = spySettleAnimations({ onCreate: () => order.push('spring') });
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    const firstReply = jest.fn(() => order.push('first reply'));
    const latestReply = jest.fn(() => order.push('latest reply'));
    const view = await mount(firstReply);
    await settleInitialMotionPreference();
    await act(async () => {
      view.rerender(
        <MessageSwipeWrapper timestamp="3:14 PM" onReply={latestReply}>
          <Text>bubble content</Text>
        </MessageSwipeWrapper>,
      );
    });

    setValue.mockClear();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(REPLY_TRIGGER_PX * 2)));
    expect(firstReply).not.toHaveBeenCalled();
    expect(latestReply).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['latest reply', 'spring']);
    expect(animations.spring).toHaveBeenCalledTimes(1);
    expectExistingSpringConfig(animations.spring);
    expect(animations.handles[0]?.start).toHaveBeenCalledTimes(1);
    expect(setValue).not.toHaveBeenCalled();

    await drive(() => config().onPanResponderGrant(EVENT, gesture()));
    await act(async () => {
      view.rerender(
        <MessageSwipeWrapper timestamp="3:14 PM">
          <Text>bubble content</Text>
        </MessageSwipeWrapper>,
      );
    });
    await drive(() => config().onPanResponderRelease(EVENT, gesture(REPLY_TRIGGER_PX * 2)));
    expect(latestReply).toHaveBeenCalledTimes(1);
    expect(animations.handles[0]?.stop).toHaveBeenCalledTimes(1);
    expect(animations.spring).toHaveBeenCalledTimes(2);
    expect(PanResponder.create).toHaveBeenCalledTimes(1);
  });

  it('never replies below threshold or on termination while still settling both paths', async () => {
    const onReply = jest.fn();
    const animations = spySettleAnimations();
    await mount(onReply);
    await settleInitialMotionPreference();

    await drive(() => config().onPanResponderRelease(EVENT, gesture(REPLY_TRIGGER_PX - 1)));
    expect(onReply).not.toHaveBeenCalled();
    expect(animations.spring).toHaveBeenCalledTimes(1);

    await drive(() => config().onPanResponderTerminate(EVENT, gesture(REPLY_TRIGGER_PX * 10)));
    expect(onReply).not.toHaveBeenCalled();
    expect(animations.handles[0]?.stop).toHaveBeenCalledTimes(1);
    expect(animations.spring).toHaveBeenCalledTimes(2);
    expect(animations.handles[1]?.start).toHaveBeenCalledTimes(1);
  });

  it('snaps an unresolved release without replay and springs only on a later release after false', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const animations = spySettleAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount();
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);

    setValue.mockClear();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-30)));
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([0]);
    expect(animations.spring).not.toHaveBeenCalled();

    await act(async () => {
      preference.resolve(false);
      await preference.promise;
    });
    expect(animations.spring).not.toHaveBeenCalled();

    setValue.mockClear();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-30)));
    expect(setValue).not.toHaveBeenCalled();
    expect(animations.spring).toHaveBeenCalledTimes(1);
    expectExistingSpringConfig(animations.spring);
  });

  it('snaps future releases when Reduce Motion is initially enabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const animations = spySettleAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount();
    await settleInitialMotionPreference();

    setValue.mockClear();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-30)));
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([0]);
    expect(animations.spring).not.toHaveBeenCalled();
  });

  it('retains the exact existing spring for future releases after query failure', async () => {
    mockIsReduceMotionEnabled.mockRejectedValue(new Error('motion preference unavailable'));
    const animations = spySettleAnimations();
    await mount();
    await settleInitialMotionPreference();

    await drive(() => config().onPanResponderRelease(EVENT, gesture(-30)));
    expect(animations.spring).toHaveBeenCalledTimes(1);
    expectExistingSpringConfig(animations.spring);
    expect(animations.handles[0]?.start).toHaveBeenCalledTimes(1);
  });

  it('stops and snaps an active spring on live enablement without replaying on false', async () => {
    const animations = spySettleAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount();
    await settleInitialMotionPreference();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-30)));
    const first = animations.handles[0];
    expect(first).toBeDefined();

    setValue.mockClear();
    await emitReduceMotion(true);
    expect(first?.stop).toHaveBeenCalledTimes(1);
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([0]);

    setValue.mockClear();
    await emitReduceMotion(false);
    expect(animations.spring).toHaveBeenCalledTimes(1);
    expect(setValue).not.toHaveBeenCalled();

    await drive(() => config().onPanResponderRelease(EVENT, gesture(-30)));
    expect(animations.spring).toHaveBeenCalledTimes(2);
    expect(animations.handles[1]?.start).toHaveBeenCalledTimes(1);
  });

  it('clears ownership when start completes synchronously so later true does nothing', async () => {
    const animations = spySettleAnimations({ finishSynchronously: true });
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount();
    await settleInitialMotionPreference();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-30)));
    expect(animations.handles[0]?.start).toHaveBeenCalledTimes(1);

    setValue.mockClear();
    await emitReduceMotion(true);
    expect(animations.handles[0]?.stop).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
  });

  it('hands an active spring to a fresh gesture and rejects its stale completion', async () => {
    const animations = spySettleAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount(jest.fn());
    await settleInitialMotionPreference();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-30)));
    const first = animations.handles[0];

    setValue.mockClear();
    await drive(() => config().onPanResponderGrant(EVENT, gesture()));
    expect(first?.stop).toHaveBeenCalledTimes(1);
    expect(setValue).not.toHaveBeenCalled();
    await drive(() => config().onPanResponderMove(EVENT, gesture(30)));
    expect(setValue).toHaveBeenLastCalledWith(swipeTranslate(30, true));
    await drive(() => config().onPanResponderRelease(EVENT, gesture(30)));
    const second = animations.handles[1];
    expect(second).toBeDefined();

    await drive(() => first?.finish());
    setValue.mockClear();
    await emitReduceMotion(true);
    expect(second?.stop).toHaveBeenCalledTimes(1);
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([0]);
  });

  it('preserves a held direct swipe on live true, then replies and snaps on release', async () => {
    const onReply = jest.fn();
    const animations = spySettleAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount(onReply);
    await settleInitialMotionPreference();

    await drive(() => config().onPanResponderGrant(EVENT, gesture()));
    await drive(() => config().onPanResponderMove(EVENT, gesture(REPLY_TRIGGER_PX * 2)));
    setValue.mockClear();
    await emitReduceMotion(true);
    expect(setValue).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalled();

    await drive(() => config().onPanResponderRelease(EVENT, gesture(REPLY_TRIGGER_PX * 2)));
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([0]);
    expect(animations.spring).not.toHaveBeenCalled();
  });

  it('stops on unmount and ignores late preference/query/completion work without writing', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const animations = spySettleAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    const view = await mount();
    const latePreferenceListener = reduceMotionListener;
    await emitReduceMotion(false);
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-30)));
    const active = animations.handles[0];

    setValue.mockClear();
    await view.unmount();
    expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
    expect(active?.stop).toHaveBeenCalledTimes(1);
    expect(setValue).not.toHaveBeenCalled();

    await act(async () => {
      latePreferenceListener?.(true);
      preference.resolve(true);
      await preference.promise;
      active?.finish();
    });
    expect(active?.stop).toHaveBeenCalledTimes(1);
    expect(setValue).not.toHaveBeenCalled();
  });
});
