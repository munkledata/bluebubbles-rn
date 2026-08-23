/**
 * ZoomableImage (src/ui/attachments/ZoomableImage.tsx): pinch-to-zoom + pan-while-zoomed built on
 * RN's PanResponder + Animated. Real native drags can't be simulated in RNTL (same constraint as
 * swipeableRow.test.tsx), so this suite CAPTURES the PanResponder config via a `create` spy and
 * drives the gesture callbacks directly with synthetic touch events — the zoom state machine
 * (claim rules, pinch math, pan clamping, spring-back, terminate commit, page-change reset) is
 * pure JS over refs, so it is fully exercisable this way. `onZoomChange` is the observable output.
 *
 * In-file mock: `expo-image` (marker View forwarding source/placeholder, mirrors
 * imageAttachment.test.tsx).
 */
import React from 'react';
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  type GestureResponderEvent,
  type PanResponderCallbacks,
  type PanResponderInstance,
  type PanResponderGestureState,
} from 'react-native';
import { renderWithTheme, screen, act } from '../support/renderWithTheme';

jest.mock('expo-image', () => {
  const RN = jest.requireActual<typeof import('react-native')>('react-native');
  const r = jest.requireActual<typeof import('react')>('react');
  const MockView = RN.View as unknown as React.ComponentType<Record<string, unknown>>;
  return {
    Image: (props: Record<string, unknown>) =>
      r.createElement(MockView, {
        testID: 'expo-image',
        source: props.source,
        placeholder: props.placeholder,
      }),
  };
});

// eslint-disable-next-line import/first
import { ZoomableImage } from '@ui/attachments/ZoomableImage';

const WIDTH = 300;
const HEIGHT = 600;
const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

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

function spyResetAnimations(): {
  spring: jest.SpyInstance;
  parallel: jest.SpyInstance;
  handles: TrackedAnimation[];
} {
  const childHandle = (): Animated.CompositeAnimation =>
    ({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() }) as Animated.CompositeAnimation;
  const spring = jest.spyOn(Animated, 'spring').mockImplementation(childHandle);
  const handles: TrackedAnimation[] = [];
  const parallel = jest.spyOn(Animated, 'parallel').mockImplementation(() => {
    let completion: ((result: { finished: boolean }) => void) | undefined;
    const tracked: TrackedAnimation = {
      start: jest.fn((callback?: (result: { finished: boolean }) => void) => {
        completion = callback;
      }),
      stop: jest.fn(),
      reset: jest.fn(),
      finish: (result = { finished: true }) => completion?.(result),
    };
    handles.push(tracked);
    return tracked as Animated.CompositeAnimation;
  });
  return { spring, parallel, handles };
}

/** Synthetic responder event carrying only what the component reads (touches). */
function evt(touches: Array<{ pageX: number; pageY: number }>): GestureResponderEvent {
  return { nativeEvent: { touches } } as unknown as GestureResponderEvent;
}

/** Two touches `dist` apart along x. */
function pinch(dist: number): GestureResponderEvent {
  return evt([
    { pageX: 0, pageY: 0 },
    { pageX: dist, pageY: 0 },
  ]);
}

const ONE_TOUCH = evt([{ pageX: 10, pageY: 10 }]);
const NO_TOUCH = evt([]);

function gst(dx = 0, dy = 0): PanResponderGestureState {
  return { dx, dy } as PanResponderGestureState;
}

describe('ZoomableImage', () => {
  let config: PanResponderCallbacks | undefined;

  beforeEach(() => {
    config = undefined;
    reduceMotionListener = undefined;
    removeReduceMotionListener = jest.fn();
    mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
    mockAddEventListener.mockReset().mockImplementation((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      reduceMotionListener = listener as (enabled: boolean) => void;
      return { remove: removeReduceMotionListener };
    });
    jest.spyOn(PanResponder, 'create').mockImplementation((c) => {
      config = c;
      return { panHandlers: {} } as PanResponderInstance;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** The captured responder config, with every callback the component installs required. */
  function cfg(): Required<PanResponderCallbacks> {
    if (!config) throw new Error('PanResponder.create was not called');
    return config as Required<PanResponderCallbacks>;
  }

  /** Run a gesture callback inside act() — Animated setValue schedules React updates. */
  async function drive(fn: () => void): Promise<void> {
    await act(async () => {
      fn();
    });
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

  function expectImmediateFitWrites(setValue: jest.SpyInstance): void {
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([1, 0, 0]);
  }

  async function mount(over: Partial<React.ComponentProps<typeof ZoomableImage>> = {}) {
    return renderWithTheme(
      <ZoomableImage uri="file:///photo.jpg" width={WIDTH} height={HEIGHT} {...over} />,
    );
  }

  async function commitTwoXZoom(): Promise<void> {
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(200), gst()));
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
  }

  async function releaseBackAtFit(): Promise<void> {
    await drive(() => cfg().onPanResponderGrant(pinch(200), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(90), gst()));
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
  }

  it('renders the image when a uri is present', async () => {
    await mount();
    const img = screen.getByTestId('expo-image');
    expect(img.props.source).toEqual({ uri: 'file:///photo.jpg' });
  });

  it('renders the blurhash placeholder + hint when not downloaded', async () => {
    await mount({ uri: null, blurhash: 'LKO2?U%2Tw=w' });
    expect(screen.getByText('Not downloaded')).toBeTruthy();
    expect(screen.getByTestId('expo-image').props.placeholder).toEqual({
      blurhash: 'LKO2?U%2Tw=w',
    });
  });

  it('renders only the hint when not downloaded and no blurhash exists', async () => {
    await mount({ uri: null });
    expect(screen.getByText('Not downloaded')).toBeTruthy();
    expect(screen.queryByTestId('expo-image')).toBeNull();
  });

  it('never claims on touch-start and only claims moves for pinches while at 1x', async () => {
    await mount();
    expect(cfg().onStartShouldSetPanResponder(NO_TOUCH, gst())).toBe(false);
    expect(cfg().onMoveShouldSetPanResponder(pinch(100), gst())).toBe(true);
    // One-finger swipe at 1x falls through to the parent pager.
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(false);
  });

  it('pinching out zooms in, reports zoomed, and claims one-finger moves after release', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });

    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(200), gst())); // 2x
    expect(onZoomChange).toHaveBeenCalledWith(true);

    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).toHaveBeenCalledTimes(1); // commit does not re-report

    // Zoomed → a one-finger move is now a pan claim.
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(true);
  });

  it('caps the pinch at 4x', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(pinch(10), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(1000), gst())); // raw 100x → clamped 4x
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).toHaveBeenCalledWith(true);
    // Pinch back down from the committed 4x by the same ratio → still >1 → stays zoomed.
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(50), gst())); // 4x * 0.5 = 2x
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).not.toHaveBeenCalledWith(false);
  });

  it('adopts the first two-finger distance mid-gesture when the grant saw fewer touches', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(ONE_TOUCH, gst())); // touchDistance → 0
    await drive(() => cfg().onPanResponderMove(pinch(100), gst())); // seeds initialDist, no scale yet
    expect(onZoomChange).not.toHaveBeenCalled();
    await drive(() => cfg().onPanResponderMove(pinch(300), gst())); // now a real 3x pinch
    expect(onZoomChange).toHaveBeenCalledWith(true);
  });

  it('pans with one finger while zoomed without throwing or re-reporting zoom', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(200), gst()));
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    onZoomChange.mockClear();

    await drive(() => cfg().onPanResponderGrant(ONE_TOUCH, gst()));
    // Far beyond the clamp bounds ((scale-1)*size/2) in both axes.
    await drive(() => cfg().onPanResponderMove(ONE_TOUCH, gst(10_000, -10_000)));
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).not.toHaveBeenCalled(); // still zoomed; no state flip
  });

  it('springs back to fit when released at ~1x', async () => {
    const onZoomChange = jest.fn();
    const animations = spyResetAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ onZoomChange });
    await settleInitialMotionPreference();
    await commitTwoXZoom();
    expect(onZoomChange).toHaveBeenLastCalledWith(true);

    // Pinch back below the zoom threshold and release.
    await releaseBackAtFit(); // 2x * 0.45 → clamped to 1
    expect(onZoomChange).toHaveBeenLastCalledWith(false);
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(false);
    expect(animations.spring).toHaveBeenCalledTimes(3);
    expect(animations.spring.mock.calls.map((call) => call[1])).toEqual([
      { toValue: 1, useNativeDriver: true, bounciness: 0 },
      { toValue: 0, useNativeDriver: true, bounciness: 0 },
      { toValue: 0, useNativeDriver: true, bounciness: 0 },
    ]);
    expect(animations.parallel).toHaveBeenCalledTimes(1);
    expect(animations.handles[0]?.start).toHaveBeenCalledTimes(1);

    await drive(() => animations.handles[0]?.finish());
    setValue.mockClear();
    await emitReduceMotion(true);
    expect(animations.handles[0]?.stop).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
  });

  it('snaps back immediately when Reduce Motion is initially enabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const onZoomChange = jest.fn();
    const animations = spyResetAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ onZoomChange });
    await settleInitialMotionPreference();
    await commitTwoXZoom();

    await drive(() => cfg().onPanResponderGrant(pinch(200), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(90), gst()));
    setValue.mockClear();
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));

    expect(animations.spring).not.toHaveBeenCalled();
    expect(animations.parallel).not.toHaveBeenCalled();
    expectImmediateFitWrites(setValue);
    expect(onZoomChange).toHaveBeenLastCalledWith(false);
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(false);
  });

  it('snaps an unresolved reset without replay and uses springs only for a later false result', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const animations = spyResetAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount();
    await commitTwoXZoom();

    await drive(() => cfg().onPanResponderGrant(pinch(200), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(90), gst()));
    setValue.mockClear();
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expectImmediateFitWrites(setValue);
    expect(animations.spring).not.toHaveBeenCalled();

    await act(async () => {
      preference.resolve(false);
      await preference.promise;
    });
    expect(animations.spring).not.toHaveBeenCalled();

    await commitTwoXZoom();
    await releaseBackAtFit();
    expect(animations.spring).toHaveBeenCalledTimes(3);
    expect(animations.handles).toHaveLength(1);
  });

  it('retains the existing reset springs for future gestures when the native query rejects', async () => {
    mockIsReduceMotionEnabled.mockRejectedValue(new Error('motion preference unavailable'));
    const animations = spyResetAnimations();
    await mount();
    await settleInitialMotionPreference();

    await commitTwoXZoom();
    await releaseBackAtFit();
    expect(animations.spring).toHaveBeenCalledTimes(3);
    expect(animations.handles[0]?.start).toHaveBeenCalledTimes(1);
  });

  it('stops an active reset on live enablement without replay or stale-completion ownership', async () => {
    const animations = spyResetAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount();
    await settleInitialMotionPreference();
    await commitTwoXZoom();
    await releaseBackAtFit();
    const first = animations.handles[0];
    expect(first).toBeDefined();

    setValue.mockClear();
    await emitReduceMotion(true);
    expect(first?.stop).toHaveBeenCalledTimes(1);
    expectImmediateFitWrites(setValue);

    await emitReduceMotion(false);
    expect(animations.spring).toHaveBeenCalledTimes(3);
    await commitTwoXZoom();
    await releaseBackAtFit();
    const second = animations.handles[1];
    expect(second).toBeDefined();
    expect(animations.spring).toHaveBeenCalledTimes(6);

    await drive(() => first?.finish());
    setValue.mockClear();
    await emitReduceMotion(true);
    expect(second?.stop).toHaveBeenCalledTimes(1);
    expectImmediateFitWrites(setValue);
  });

  it('keeps committed zoom and direct one-finger pan intact when motion becomes reduced', async () => {
    const onZoomChange = jest.fn();
    const animations = spyResetAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ onZoomChange });
    await settleInitialMotionPreference();
    await commitTwoXZoom();
    onZoomChange.mockClear();
    setValue.mockClear();

    await emitReduceMotion(true);
    expect(setValue).not.toHaveBeenCalled();
    expect(onZoomChange).not.toHaveBeenCalled();
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(true);

    await drive(() => cfg().onPanResponderGrant(ONE_TOUCH, gst()));
    await drive(() => cfg().onPanResponderMove(ONE_TOUCH, gst(25, -40)));
    await emitReduceMotion(true);
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(onZoomChange).not.toHaveBeenCalled();
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(true);
    expect(animations.spring).not.toHaveBeenCalled();
  });

  it('hands an active reset to a fresh pinch and rejects the old completion afterward', async () => {
    const onZoomChange = jest.fn();
    const animations = spyResetAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ onZoomChange });
    await settleInitialMotionPreference();
    await commitTwoXZoom();
    await releaseBackAtFit();
    const oldReset = animations.handles[0];
    expect(oldReset).toBeDefined();

    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    expect(oldReset?.stop).toHaveBeenCalledTimes(1);
    await drive(() => cfg().onPanResponderMove(pinch(250), gst()));
    expect(onZoomChange).toHaveBeenLastCalledWith(true);

    await drive(() => oldReset?.finish());
    await drive(() => cfg().onPanResponderRelease(NO_TOUCH, gst()));
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(true);

    setValue.mockClear();
    await emitReduceMotion(true);
    expect(setValue).not.toHaveBeenCalled();
    expect(onZoomChange).toHaveBeenLastCalledWith(true);
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(true);
  });

  it.each([
    ['false event over a stale true query', false, true, 3],
    ['true event over a stale false query', true, false, 0],
  ] as const)(
    'keeps the %s authoritative for the next automatic reset',
    async (_label, eventValue, staleQueryValue, springCount) => {
      const preference = deferred<boolean>();
      mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
      const animations = spyResetAnimations();
      await mount();
      expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);

      await emitReduceMotion(eventValue);
      await act(async () => {
        preference.resolve(staleQueryValue);
        await preference.promise;
      });
      await commitTwoXZoom();
      await releaseBackAtFit();

      expect(animations.spring).toHaveBeenCalledTimes(springCount);
    },
  );

  it('removes the listener, stops its reset, and ignores late event/query callbacks on unmount', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const animations = spyResetAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    const view = await mount();
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);

    await emitReduceMotion(false);
    await commitTwoXZoom();
    await releaseBackAtFit();
    const active = animations.handles[0];
    expect(active).toBeDefined();

    const lateListener = reduceMotionListener;
    await view.unmount();
    expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
    expect(active?.stop).toHaveBeenCalledTimes(1);

    setValue.mockClear();
    await act(async () => {
      lateListener?.(true);
      preference.resolve(true);
      await preference.promise;
    });
    expect(active?.stop).toHaveBeenCalledTimes(1);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('commits the live zoom when the responder is terminated mid-gesture', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(300), gst())); // 3x live
    await drive(() => cfg().onPanResponderTerminate(NO_TOUCH, gst()));
    // Committed → a later one-finger move is claimed as a pan.
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(true);
  });

  it('resets to fit when terminated at ~1x', async () => {
    const onZoomChange = jest.fn();
    await mount({ onZoomChange });
    await drive(() => cfg().onPanResponderGrant(pinch(100), gst()));
    await drive(() => cfg().onPanResponderMove(pinch(101), gst())); // ~1x
    await drive(() => cfg().onPanResponderTerminate(NO_TOUCH, gst()));
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(false);
  });

  it('resets the zoom when the page becomes inactive', async () => {
    const onZoomChange = jest.fn();
    const animations = spyResetAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    const view = await mount({ onZoomChange, active: true });
    await settleInitialMotionPreference();
    await commitTwoXZoom();
    expect(onZoomChange).toHaveBeenLastCalledWith(true);
    await releaseBackAtFit();
    const activeReset = animations.handles[0];
    expect(activeReset).toBeDefined();

    setValue.mockClear();
    await act(async () => {
      view.rerender(
        <ZoomableImage
          uri="file:///photo.jpg"
          width={WIDTH}
          height={HEIGHT}
          active={false}
          onZoomChange={onZoomChange}
        />,
      );
    });
    expect(onZoomChange).toHaveBeenLastCalledWith(false);
    expect(cfg().onMoveShouldSetPanResponder(ONE_TOUCH, gst())).toBe(false);
    expect(animations.spring).toHaveBeenCalledTimes(3);
    expect(activeReset?.stop).toHaveBeenCalledTimes(1);
    expectImmediateFitWrites(setValue);

    setValue.mockClear();
    await drive(() => activeReset?.finish());
    expect(setValue).not.toHaveBeenCalled();
    expect(activeReset?.stop).toHaveBeenCalledTimes(1);
  });
});
