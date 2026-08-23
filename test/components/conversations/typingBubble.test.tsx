/**
 * TypingBubble (src/ui/conversations/TypingBubble.tsx): the iOS "…" typing indicator in the
 * composer-area bottom stack. Three dots pulse while motion is allowed; Reduce Motion leaves the
 * same accessible status visible as static dots. The preference listener is registered before the
 * initial query so a newer native event cannot be overwritten by a stale Promise result.
 *
 * We assert start/stop contracts directly by spying on `Animated.loop`. We do not assert the global
 * timer count: the jest-expo Animated mock retains frame timers that do not belong to this component.
 */
import React from 'react';
import { AccessibilityInfo, Animated } from 'react-native';
import { renderWithTheme, screen, act } from '../support/renderWithTheme';
import { TypingBubble } from '@ui/conversations/TypingBubble';

interface LoopHandle {
  start: jest.Mock;
  stop: jest.Mock;
  reset: jest.Mock;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

let reduceMotionListeners: Array<(enabled: boolean) => void>;
let removeReduceMotionListeners: jest.Mock[];

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function spyLoops(): { handles: LoopHandle[]; restore: () => void } {
  const handles: LoopHandle[] = [];
  const spy = jest.spyOn(Animated, 'loop').mockImplementation(() => {
    const handle: LoopHandle = { start: jest.fn(), stop: jest.fn(), reset: jest.fn() };
    handles.push(handle);
    return handle as unknown as Animated.CompositeAnimation;
  });
  return { handles, restore: () => spy.mockRestore() };
}

describe('TypingBubble motion preference and cleanup', () => {
  beforeEach(() => {
    reduceMotionListeners = [];
    removeReduceMotionListeners = [];
    mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
    mockAddEventListener.mockReset().mockImplementation((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      reduceMotionListeners.push(listener as (enabled: boolean) => void);
      const remove = jest.fn();
      removeReduceMotionListeners.push(remove);
      return { remove };
    });
  });

  it('keeps an unresolved typing status accessible, visible, and static', async () => {
    mockIsReduceMotionEnabled.mockReturnValue(new Promise<boolean>(() => undefined));
    const loops = spyLoops();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const view = await renderWithTheme(<TypingBubble />);

      const bubble = screen.getByLabelText('Typing');
      expect(bubble.props.accessible).toBe(true);
      expect(bubble.children).toHaveLength(3);
      expect(loops.handles).toHaveLength(0);
      expect(setValue.mock.calls.slice(-3)).toEqual([[1], [1], [1]]);
      expect(mockAddEventListener.mock.invocationCallOrder[0]).toBeLessThan(
        mockIsReduceMotionEnabled.mock.invocationCallOrder[0]!,
      );

      await act(async () => view.unmount());
      expect(removeReduceMotionListeners[0]).toHaveBeenCalledTimes(1);
    } finally {
      setValue.mockRestore();
      loops.restore();
    }
  });

  it('renders static dots and constructs no loops when Reduce Motion is initially enabled', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const loops = spyLoops();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const view = await renderWithTheme(<TypingBubble />);

      expect(loops.handles).toHaveLength(0);
      expect(setValue.mock.calls.slice(-3)).toEqual([[1], [1], [1]]);

      await act(async () => view.unmount());
    } finally {
      setValue.mockRestore();
      loops.restore();
    }
  });

  it('starts three normal loops when motion is allowed and stops them on unmount', async () => {
    const loops = spyLoops();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const view = await renderWithTheme(<TypingBubble />);

      expect(loops.handles).toHaveLength(3);
      expect(setValue.mock.calls.slice(-3)).toEqual([[0.3], [0.3], [0.3]]);
      for (const handle of loops.handles) {
        expect(handle.start).toHaveBeenCalledTimes(1);
        expect(handle.stop).not.toHaveBeenCalled();
      }

      await act(async () => view.unmount());
      for (const handle of loops.handles) expect(handle.stop).toHaveBeenCalledTimes(1);
      expect(removeReduceMotionListeners[0]).toHaveBeenCalledTimes(1);
    } finally {
      setValue.mockRestore();
      loops.restore();
    }
  });

  it('retains the normal pulse when the native preference query rejects', async () => {
    mockIsReduceMotionEnabled.mockRejectedValue(new Error('preference unavailable'));
    const loops = spyLoops();
    try {
      const view = await renderWithTheme(<TypingBubble />);

      expect(loops.handles).toHaveLength(3);
      for (const handle of loops.handles) expect(handle.start).toHaveBeenCalledTimes(1);

      await act(async () => view.unmount());
    } finally {
      loops.restore();
    }
  });

  it('stops active loops and snaps every dot visible when Reduce Motion becomes enabled', async () => {
    const loops = spyLoops();
    const setValue = jest.spyOn(Animated.Value.prototype, 'setValue');
    try {
      const view = await renderWithTheme(<TypingBubble />);
      expect(loops.handles).toHaveLength(3);

      await act(async () => reduceMotionListeners[0]!(true));

      for (const handle of loops.handles) expect(handle.stop).toHaveBeenCalledTimes(1);
      expect(setValue.mock.calls.slice(-3)).toEqual([[1], [1], [1]]);

      await act(async () => view.unmount());
      for (const handle of loops.handles) expect(handle.stop).toHaveBeenCalledTimes(1);
    } finally {
      setValue.mockRestore();
      loops.restore();
    }
  });

  it('starts one fresh trio when motion is re-enabled without overlapping stopped loops', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const loops = spyLoops();
    try {
      const view = await renderWithTheme(<TypingBubble />);
      expect(loops.handles).toHaveLength(0);

      await act(async () => reduceMotionListeners[0]!(false));
      expect(loops.handles).toHaveLength(3);
      for (const handle of loops.handles) expect(handle.start).toHaveBeenCalledTimes(1);

      await act(async () => reduceMotionListeners[0]!(true));
      for (const handle of loops.handles) expect(handle.stop).toHaveBeenCalledTimes(1);

      await act(async () => reduceMotionListeners[0]!(false));
      expect(loops.handles).toHaveLength(6);
      for (const handle of loops.handles.slice(0, 3)) {
        expect(handle.start).toHaveBeenCalledTimes(1);
        expect(handle.stop).toHaveBeenCalledTimes(1);
      }
      for (const handle of loops.handles.slice(3)) {
        expect(handle.start).toHaveBeenCalledTimes(1);
        expect(handle.stop).not.toHaveBeenCalled();
      }

      await act(async () => view.unmount());
      for (const handle of loops.handles.slice(3)) expect(handle.stop).toHaveBeenCalledTimes(1);
    } finally {
      loops.restore();
    }
  });

  it('keeps a newer preference event authoritative over the initial query', async () => {
    const query = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(query.promise);
    const loops = spyLoops();
    try {
      const view = await renderWithTheme(<TypingBubble />);

      await act(async () => reduceMotionListeners[0]!(false));
      expect(loops.handles).toHaveLength(3);

      await act(async () => {
        query.resolve(true);
        await query.promise;
      });
      expect(loops.handles).toHaveLength(3);
      for (const handle of loops.handles) expect(handle.stop).not.toHaveBeenCalled();

      await act(async () => view.unmount());
    } finally {
      loops.restore();
    }
  });

  it('removes the listener and ignores a late query after unresolved unmount', async () => {
    const query = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(query.promise);
    const loops = spyLoops();
    try {
      const view = await renderWithTheme(<TypingBubble />);
      await act(async () => view.unmount());

      expect(removeReduceMotionListeners[0]).toHaveBeenCalledTimes(1);
      await act(async () => {
        query.resolve(false);
        await query.promise;
      });
      expect(loops.handles).toHaveLength(0);
    } finally {
      loops.restore();
    }
  });

  it('ignores a removed listener and a late rejected query after unmount', async () => {
    const query = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(query.promise);
    const loops = spyLoops();
    try {
      const view = await renderWithTheme(<TypingBubble />);
      const removedListener = reduceMotionListeners[0]!;
      await act(async () => view.unmount());

      await act(async () => {
        removedListener(true);
        query.reject(new Error('late rejection'));
        await query.promise.catch(() => undefined);
      });
      expect(loops.handles).toHaveLength(0);
      expect(removeReduceMotionListeners[0]).toHaveBeenCalledTimes(1);
    } finally {
      loops.restore();
    }
  });

  it('treats a fresh remount as a fresh preference and animation lifecycle', async () => {
    const loops = spyLoops();
    try {
      const first = await renderWithTheme(<TypingBubble />);
      expect(loops.handles).toHaveLength(3);
      await act(async () => first.unmount());

      const second = await renderWithTheme(<TypingBubble />);
      expect(loops.handles).toHaveLength(6);
      expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(2);
      expect(mockAddEventListener).toHaveBeenCalledTimes(2);
      expect(removeReduceMotionListeners[0]).toHaveBeenCalledTimes(1);
      for (const handle of loops.handles.slice(0, 3)) expect(handle.stop).toHaveBeenCalledTimes(1);
      for (const handle of loops.handles.slice(3)) expect(handle.stop).not.toHaveBeenCalled();

      await act(async () => second.unmount());
      expect(removeReduceMotionListeners[1]).toHaveBeenCalledTimes(1);
      for (const handle of loops.handles.slice(3)) expect(handle.stop).toHaveBeenCalledTimes(1);
    } finally {
      loops.restore();
    }
  });
});
