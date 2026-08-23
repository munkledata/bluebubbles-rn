/**
 * SwipeableRow (src/ui/conversations/SwipeableRow.tsx): structure plus its JS gesture and automatic
 * snap state machine. The suite captures PanResponder callbacks and drives synthetic gesture state.
 * This proves policy, targets, action ordering, animation ownership, and cleanup; it cannot prove
 * native touch feel, native-driver pixels, or Samsung/FlashList arbitration on device.
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
import { act, cleanup, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';
import { SwipeableRow, type SwipeAction } from '@ui/conversations/SwipeableRow';

// Render icon glyphs synchronously (no deferred font-load setState -> no act noise).
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

function spySnapAnimations({
  finishSynchronously = false,
}: {
  finishSynchronously?: boolean;
} = {}): { spring: jest.SpyInstance; handles: TrackedAnimation[] } {
  const handles: TrackedAnimation[] = [];
  const spring = jest.spyOn(Animated, 'spring').mockImplementation((_value) => {
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
    return tracked as Animated.CompositeAnimation;
  });
  return { spring, handles };
}

function action(over: Partial<SwipeAction> = {}): SwipeAction {
  return {
    key: 'k',
    label: 'Delete',
    icon: 'trash-outline',
    color: '#ff3b30',
    onPress: jest.fn(),
    ...over,
  };
}

function gesture(dx = 0, dy = 0): PanResponderGestureState {
  return { dx, dy } as PanResponderGestureState;
}

const EVENT = {} as GestureResponderEvent;

describe('SwipeableRow', () => {
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

  async function mount({
    resetKey = 'chat-1',
    left,
    right,
  }: {
    resetKey?: string;
    left?: SwipeAction[];
    right?: SwipeAction[];
  } = {}) {
    return renderWithTheme(
      <SwipeableRow resetKey={resetKey} left={left} right={right}>
        <Text>row body</Text>
      </SwipeableRow>,
    );
  }

  function expectExistingSpringConfig(
    spring: jest.SpyInstance,
    index: number,
    toValue: number,
  ): void {
    expect(spring.mock.calls[index]?.[1]).toEqual({
      toValue,
      useNativeDriver: true,
      bounciness: 0,
      speed: 20,
    });
  }

  it('always renders its child and renders no action buttons without actions', async () => {
    await mount();
    expect(screen.getByText('row body')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders each labelled action on both sides and fires the selected actions', async () => {
    const onPin = jest.fn();
    const onDelete = jest.fn();
    const onArchive = jest.fn();
    await mount({
      left: [action({ key: 'pin', label: 'Pin', onPress: onPin })],
      right: [
        action({ key: 'del', label: 'Delete', onPress: onDelete }),
        action({ key: 'arc', label: 'Archive', icon: 'archive-outline', onPress: onArchive }),
      ],
    });

    expect(screen.getByLabelText('Pin')).toBeTruthy();
    expect(screen.getByLabelText('Delete')).toBeTruthy();
    expect(screen.getByLabelText('Archive')).toBeTruthy();
    await drive(() => fireEvent.press(screen.getByLabelText('Archive')));
    expect(onPin).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onArchive).toHaveBeenCalledTimes(1);

    await drive(() => fireEvent.press(screen.getByLabelText('Pin')));
    expect(onPin).toHaveBeenCalledTimes(1);
    expect(onDelete).not.toHaveBeenCalled();
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('keeps direct movement clamped to the latest action widths with one responder', async () => {
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    const view = await mount({
      left: [action({ key: 'pin', label: 'Pin' })],
      right: [action({ key: 'delete', label: 'Delete' })],
    });

    expect(config().onStartShouldSetPanResponder(EVENT, gesture())).toBe(false);
    expect(config().onMoveShouldSetPanResponder(EVENT, gesture(40, 5))).toBe(true);
    expect(config().onMoveShouldSetPanResponderCapture(EVENT, gesture(40, 5))).toBe(true);
    expect(config().onMoveShouldSetPanResponder(EVENT, gesture(5, 60))).toBe(false);
    expect(config().onPanResponderTerminationRequest(EVENT, gesture(40, 5))).toBe(false);
    expect(config().onShouldBlockNativeResponder(EVENT, gesture(40, 5))).toBe(true);

    setValue.mockClear();
    await drive(() => config().onPanResponderMove(EVENT, gesture(200)));
    await drive(() => config().onPanResponderMove(EVENT, gesture(-200)));
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([76, -76]);

    await act(async () => {
      view.rerender(
        <SwipeableRow
          resetKey="chat-1"
          left={[action({ key: 'pin', label: 'Pin' }), action({ key: 'mute', label: 'Mute' })]}
        >
          <Text>row body</Text>
        </SwipeableRow>,
      );
    });
    setValue.mockClear();
    await drive(() => config().onPanResponderMove(EVENT, gesture(200)));
    await drive(() => config().onPanResponderMove(EVENT, gesture(-200)));
    // Preserve the existing clamp's JavaScript signed zero when no right panel exists.
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([152, -0]);
    expect(PanResponder.create).toHaveBeenCalledTimes(1);
  });

  it('retains every existing release and termination target under known false', async () => {
    const animations = spySnapAnimations();
    await mount({
      left: [action({ key: 'pin', label: 'Pin' }), action({ key: 'mute', label: 'Mute' })],
      right: [action({ key: 'delete', label: 'Delete' })],
    });
    await settleInitialMotionPreference();

    await drive(() => config().onPanResponderRelease(EVENT, gesture(-41)));
    animations.handles[0]?.finish();
    await drive(() => config().onPanResponderTerminate(EVENT, gesture()));
    animations.handles[1]?.finish();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(41)));
    animations.handles[2]?.finish();
    await drive(() => config().onPanResponderTerminate(EVENT, gesture()));
    animations.handles[3]?.finish();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(39)));

    expect(animations.spring).toHaveBeenCalledTimes(5);
    expectExistingSpringConfig(animations.spring, 0, -76);
    expectExistingSpringConfig(animations.spring, 1, 0);
    expectExistingSpringConfig(animations.spring, 2, 152);
    expectExistingSpringConfig(animations.spring, 3, 0);
    expectExistingSpringConfig(animations.spring, 4, 0);
    expect(animations.handles[4]?.start).toHaveBeenCalledTimes(1);
  });

  it('snaps an unresolved release without replay and springs only after false resolves', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const animations = spySnapAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ right: [action()] });
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);

    setValue.mockClear();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-41)));
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([-76]);
    expect(animations.spring).not.toHaveBeenCalled();

    await act(async () => {
      preference.resolve(false);
      await preference.promise;
    });
    expect(animations.spring).not.toHaveBeenCalled();

    await drive(() => config().onPanResponderRelease(EVENT, gesture()));
    expect(animations.spring).toHaveBeenCalledTimes(1);
    expectExistingSpringConfig(animations.spring, 0, -76);
  });

  it('snaps future targets when Reduce Motion is initially enabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const animations = spySnapAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ left: [action({ key: 'pin', label: 'Pin' })] });
    await settleInitialMotionPreference();

    setValue.mockClear();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(41)));
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([76]);
    expect(animations.spring).not.toHaveBeenCalled();
  });

  it('keeps the exact existing spring after a native preference query failure', async () => {
    mockIsReduceMotionEnabled.mockRejectedValue(new Error('motion preference unavailable'));
    const animations = spySnapAnimations();
    await mount({ right: [action()] });
    await settleInitialMotionPreference();

    await drive(() => config().onPanResponderRelease(EVENT, gesture(-41)));
    expect(animations.spring).toHaveBeenCalledTimes(1);
    expectExistingSpringConfig(animations.spring, 0, -76);
  });

  it('stops and finishes an active snap on live enablement without replaying on false', async () => {
    const animations = spySnapAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ right: [action()] });
    await settleInitialMotionPreference();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-41)));
    const first = animations.handles[0];

    setValue.mockClear();
    await emitReduceMotion(true);
    expect(first?.stop).toHaveBeenCalledTimes(1);
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([-76]);

    setValue.mockClear();
    await emitReduceMotion(false);
    expect(animations.spring).toHaveBeenCalledTimes(1);
    expect(setValue).not.toHaveBeenCalled();

    await drive(() => config().onPanResponderTerminate(EVENT, gesture()));
    expect(animations.spring).toHaveBeenCalledTimes(2);
    expectExistingSpringConfig(animations.spring, 1, 0);
  });

  it('clears synchronous completion ownership so later true has nothing to stop', async () => {
    const animations = spySnapAnimations({ finishSynchronously: true });
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ right: [action()] });
    await settleInitialMotionPreference();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-41)));

    setValue.mockClear();
    await emitReduceMotion(true);
    expect(animations.handles[0]?.stop).not.toHaveBeenCalled();
    expect(setValue).not.toHaveBeenCalled();
  });

  it('hands an active snap to a fresh gesture and rejects its stale completion', async () => {
    const animations = spySnapAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ right: [action()] });
    await settleInitialMotionPreference();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-41)));
    const first = animations.handles[0];

    setValue.mockClear();
    await drive(() => config().onPanResponderGrant(EVENT, gesture()));
    expect(first?.stop).toHaveBeenCalledTimes(1);
    expect(setValue).not.toHaveBeenCalled();
    await drive(() => config().onPanResponderMove(EVENT, gesture(50)));
    expect(setValue).toHaveBeenLastCalledWith(-26);
    await drive(() => config().onPanResponderRelease(EVENT, gesture(50)));
    const second = animations.handles[1];
    expect(second).toBeDefined();
    expectExistingSpringConfig(animations.spring, 1, 0);

    await drive(() => first?.finish());
    setValue.mockClear();
    await emitReduceMotion(true);
    expect(second?.stop).toHaveBeenCalledTimes(1);
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([0]);
  });

  it('does not move a held direct swipe when Reduce Motion becomes enabled', async () => {
    const animations = spySnapAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    await mount({ left: [action({ key: 'pin', label: 'Pin' })] });
    await settleInitialMotionPreference();

    await drive(() => config().onPanResponderGrant(EVENT, gesture()));
    await drive(() => config().onPanResponderMove(EVENT, gesture(50)));
    setValue.mockClear();
    await emitReduceMotion(true);
    expect(setValue).not.toHaveBeenCalled();

    await drive(() => config().onPanResponderRelease(EVENT, gesture(50)));
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([76]);
    expect(animations.spring).not.toHaveBeenCalled();
  });

  it('stops an active snap and re-centers immediately when a row is recycled', async () => {
    const animations = spySnapAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    const right = [action()];
    const view = await mount({ right });
    await settleInitialMotionPreference();
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-41)));
    const active = animations.handles[0];

    setValue.mockClear();
    await act(async () => {
      view.rerender(
        <SwipeableRow resetKey="chat-2" right={right}>
          <Text>row body</Text>
        </SwipeableRow>,
      );
    });
    expect(active?.stop).toHaveBeenCalledTimes(1);
    expect(setValue.mock.calls.map((call) => call[0])).toEqual([0]);
    expect(PanResponder.create).toHaveBeenCalledTimes(1);

    await drive(() => active?.finish());
    setValue.mockClear();
    await emitReduceMotion(true);
    expect(setValue).not.toHaveBeenCalled();
  });

  it('uses the latest action callback after starting the close snap', async () => {
    const animations = spySnapAnimations();
    const first = jest.fn();
    const latest = jest.fn();
    const view = await mount({ right: [action({ onPress: first })] });
    await settleInitialMotionPreference();
    await act(async () => {
      view.rerender(
        <SwipeableRow resetKey="chat-1" right={[action({ onPress: latest })]}>
          <Text>row body</Text>
        </SwipeableRow>,
      );
    });

    await drive(() => fireEvent.press(screen.getByLabelText('Delete')));
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expectExistingSpringConfig(animations.spring, 0, 0);
    expect(animations.handles[0]?.start).toHaveBeenCalledTimes(1);
    expect(animations.handles[0]!.start.mock.invocationCallOrder[0]).toBeLessThan(
      latest.mock.invocationCallOrder[0]!,
    );
    expect(PanResponder.create).toHaveBeenCalledTimes(1);
  });

  it('shares one native preference owner across rows until the final unmount', async () => {
    const view = await renderWithTheme(
      <>
        <SwipeableRow resetKey="chat-1">
          <Text>first row</Text>
        </SwipeableRow>
        <SwipeableRow resetKey="chat-2">
          <Text>second row</Text>
        </SwipeableRow>
      </>,
    );
    await settleInitialMotionPreference();
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(
        <SwipeableRow resetKey="chat-2">
          <Text>second row</Text>
        </SwipeableRow>,
      );
    });
    expect(removeReduceMotionListener).not.toHaveBeenCalled();
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(removeReduceMotionListener).toHaveBeenCalledTimes(1);
  });

  it('stops on unmount and ignores late preference, query, and completion work', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const animations = spySnapAnimations();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    const view = await mount({ right: [action()] });
    const latePreferenceListener = reduceMotionListener;
    await emitReduceMotion(false);
    await drive(() => config().onPanResponderRelease(EVENT, gesture(-41)));
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
