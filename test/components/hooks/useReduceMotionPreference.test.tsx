/**
 * Shared Reduce Motion owner (src/ui/hooks/useReduceMotionPreference.ts).
 *
 * These host tests prove subscription/query ownership and ordering. They do not prove Android's
 * setting delivery. State probes exercise render-time consumers; ref probes exercise high-count
 * gesture rows that need synchronous preference reads without rerendering every row.
 */
import React from 'react';
import { AccessibilityInfo, Text, View } from 'react-native';
import {
  useReduceMotionPreference,
  useReduceMotionPreferenceRef,
  type ReduceMotionChangeHandler,
  type ReduceMotionPreference,
} from '@ui/hooks/useReduceMotionPreference';
import { act, cleanup, renderWithTheme, screen } from '../support/renderWithTheme';

const mockIsReduceMotionEnabled = AccessibilityInfo.isReduceMotionEnabled as jest.MockedFunction<
  typeof AccessibilityInfo.isReduceMotionEnabled
>;
const mockAddEventListener = AccessibilityInfo.addEventListener as jest.Mock;

const stateRenderCounts = new Map<string, number>();
const refRenderCounts = new Map<string, number>();
const preferenceRefs = new Map<string, React.RefObject<ReduceMotionPreference>>();

let nativeListeners: Array<(enabled: boolean) => void>;
let removeNativeListeners: jest.Mock[];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
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

function label(preference: ReduceMotionPreference): string {
  return preference == null ? 'unknown' : String(preference);
}

function StateProbe({ id }: { id: string }): React.JSX.Element {
  const preference = useReduceMotionPreference();
  stateRenderCounts.set(id, (stateRenderCounts.get(id) ?? 0) + 1);
  return <Text testID={`state-${id}`}>{label(preference)}</Text>;
}

function RefProbe({ id }: { id: string }): React.JSX.Element {
  const preferenceRef = useReduceMotionPreferenceRef();
  refRenderCounts.set(id, (refRenderCounts.get(id) ?? 0) + 1);
  preferenceRefs.set(id, preferenceRef);
  return <Text testID={`ref-${id}`}>ref probe</Text>;
}

function CallbackRefProbe({
  id,
  onPreferenceChange,
}: {
  id: string;
  onPreferenceChange: ReduceMotionChangeHandler;
}): React.JSX.Element {
  const preferenceRef = useReduceMotionPreferenceRef(onPreferenceChange);
  refRenderCounts.set(id, (refRenderCounts.get(id) ?? 0) + 1);
  preferenceRefs.set(id, preferenceRef);
  return <Text testID={`ref-${id}`}>callback ref probe</Text>;
}

function Harness({
  stateIds = [],
  refIds = [],
}: {
  stateIds?: string[];
  refIds?: string[];
}): React.JSX.Element {
  return (
    <View>
      {stateIds.map((id) => (
        <StateProbe key={`state-${id}`} id={id} />
      ))}
      {refIds.map((id) => (
        <RefProbe key={`ref-${id}`} id={id} />
      ))}
    </View>
  );
}

async function settleInitialQuery(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function emitNative(index: number, enabled: boolean): Promise<void> {
  expect(nativeListeners[index]).toBeDefined();
  await act(async () => nativeListeners[index]?.(enabled));
}

function expectState(id: string, expected: ReduceMotionPreference): void {
  expect(screen.getByTestId(`state-${id}`).props.children).toBe(label(expected));
}

describe('shared Reduce Motion preference owner', () => {
  beforeEach(() => {
    stateRenderCounts.clear();
    refRenderCounts.clear();
    preferenceRefs.clear();
    nativeListeners = [];
    removeNativeListeners = [];
    mockIsReduceMotionEnabled.mockReset().mockResolvedValue(false);
    mockAddEventListener.mockReset().mockImplementation((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      // Every earlier owner has one query; this owner must register before adding its next one.
      expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(nativeListeners.length);
      nativeListeners.push(listener as (enabled: boolean) => void);
      const remove = jest.fn();
      removeNativeListeners.push(remove);
      return { remove };
    });
  });

  afterEach(async () => {
    await cleanup();
    jest.restoreAllMocks();
  });

  it('shares one native owner, updates refs without row rerenders, and removes only after the last consumer', async () => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const view = await renderWithTheme(<Harness stateIds={['a', 'b']} refIds={['c', 'd']} />);

    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
    expectState('a', null);
    expectState('b', null);
    expect(preferenceRefs.get('c')?.current).toBeNull();
    expect(preferenceRefs.get('d')?.current).toBeNull();
    const refCRenders = refRenderCounts.get('c');
    const refDRenders = refRenderCounts.get('d');

    await emitNative(0, true);
    expectState('a', true);
    expectState('b', true);
    expect(preferenceRefs.get('c')?.current).toBe(true);
    expect(preferenceRefs.get('d')?.current).toBe(true);
    expect(refRenderCounts.get('c')).toBe(refCRenders);
    expect(refRenderCounts.get('d')).toBe(refDRenders);

    const removedRef = preferenceRefs.get('d');
    await act(async () => {
      view.rerender(<Harness stateIds={['a']} refIds={['c']} />);
    });
    expect(removeNativeListeners[0]).not.toHaveBeenCalled();
    expect(removedRef?.current).toBeNull();

    const retainedRef = preferenceRefs.get('c');
    await view.unmount();
    expect(removeNativeListeners[0]).toHaveBeenCalledTimes(1);
    expect(retainedRef?.current).toBeNull();

    await act(async () => {
      nativeListeners[0]?.(false);
      preference.resolve(false);
      await preference.promise;
    });
    expect(retainedRef?.current).toBeNull();
  });

  it('registers before querying and keeps a synchronous registration event authoritative', async () => {
    const preference = deferred<boolean>();
    const onPreferenceChange = jest.fn((enabled: boolean) => {
      expect(preferenceRefs.get('a')?.current).toBe(enabled);
    });
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    mockAddEventListener.mockImplementationOnce((event, listener) => {
      expect(event).toBe('reduceMotionChanged');
      expect(mockIsReduceMotionEnabled).not.toHaveBeenCalled();
      nativeListeners.push(listener as (enabled: boolean) => void);
      const remove = jest.fn();
      removeNativeListeners.push(remove);
      listener(true);
      return { remove };
    });

    const view = await renderWithTheme(
      <CallbackRefProbe id="a" onPreferenceChange={onPreferenceChange} />,
    );
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
    expect(preferenceRefs.get('a')?.current).toBe(true);
    expect(onPreferenceChange).toHaveBeenCalledTimes(1);
    expect(onPreferenceChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      preference.resolve(false);
      await preference.promise;
    });
    expect(preferenceRefs.get('a')?.current).toBe(true);
    expect(onPreferenceChange).toHaveBeenCalledTimes(1);
    await view.unmount();
  });

  it('lets ref-only consumers establish one owner and receive an initial true result', async () => {
    mockIsReduceMotionEnabled.mockResolvedValue(true);
    const view = await renderWithTheme(<Harness refIds={['a', 'b']} />);
    const aRenders = refRenderCounts.get('a');
    const bRenders = refRenderCounts.get('b');
    await settleInitialQuery();

    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
    expect(preferenceRefs.get('a')?.current).toBe(true);
    expect(preferenceRefs.get('b')?.current).toBe(true);
    expect(refRenderCounts.get('a')).toBe(aRenders);
    expect(refRenderCounts.get('b')).toBe(bRenders);
    await view.unmount();
    expect(removeNativeListeners[0]).toHaveBeenCalledTimes(1);
  });

  it('uses the latest change callback without rerendering and stops delivery after cleanup', async () => {
    const firstChange = jest.fn((enabled: boolean) => {
      expect(preferenceRefs.get('a')?.current).toBe(enabled);
    });
    const secondChange = jest.fn((enabled: boolean) => {
      expect(preferenceRefs.get('a')?.current).toBe(enabled);
    });
    const view = await renderWithTheme(
      <CallbackRefProbe id="a" onPreferenceChange={firstChange} />,
    );
    const initialRenders = refRenderCounts.get('a');

    await settleInitialQuery();
    expect(firstChange).toHaveBeenCalledTimes(1);
    expect(firstChange).toHaveBeenLastCalledWith(false);
    expect(refRenderCounts.get('a')).toBe(initialRenders);
    await emitNative(0, false);
    expect(firstChange).toHaveBeenCalledTimes(1);

    await act(async () => {
      view.rerender(<CallbackRefProbe id="a" onPreferenceChange={secondChange} />);
    });
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(1);
    expect(removeNativeListeners[0]).not.toHaveBeenCalled();
    const rendersAfterPropChange = refRenderCounts.get('a');
    await emitNative(0, true);
    expect(firstChange).toHaveBeenCalledTimes(1);
    expect(secondChange).toHaveBeenCalledTimes(1);
    expect(secondChange).toHaveBeenLastCalledWith(true);
    expect(refRenderCounts.get('a')).toBe(rendersAfterPropChange);
    await emitNative(0, true);
    expect(secondChange).toHaveBeenCalledTimes(1);

    await view.unmount();
    expect(removeNativeListeners[0]).toHaveBeenCalledTimes(1);
    expect(preferenceRefs.get('a')?.current).toBeNull();
    await act(async () => nativeListeners[0]?.(false));
    expect(secondChange).toHaveBeenCalledTimes(1);
  });

  it('uses the normal-motion fallback after query rejection and deduplicates repeated values', async () => {
    mockIsReduceMotionEnabled.mockRejectedValue(new Error('motion preference unavailable'));
    const view = await renderWithTheme(<Harness stateIds={['a']} refIds={['b']} />);
    await settleInitialQuery();

    expectState('a', false);
    expect(preferenceRefs.get('b')?.current).toBe(false);
    const stateRenders = stateRenderCounts.get('a');
    await emitNative(0, false);
    expect(stateRenderCounts.get('a')).toBe(stateRenders);

    await emitNative(0, true);
    expectState('a', true);
    expect(preferenceRefs.get('b')?.current).toBe(true);
    await view.unmount();
  });

  it.each([
    ['false event over a stale true query', false, true],
    ['true event over a stale false query', true, false],
  ] as const)('keeps the %s authoritative', async (_label, eventValue, staleQueryValue) => {
    const preference = deferred<boolean>();
    mockIsReduceMotionEnabled.mockReturnValue(preference.promise);
    const view = await renderWithTheme(<Harness stateIds={['a']} refIds={['b']} />);

    await emitNative(0, eventValue);
    await act(async () => {
      preference.resolve(staleQueryValue);
      await preference.promise;
    });

    expectState('a', eventValue);
    expect(preferenceRefs.get('b')?.current).toBe(eventValue);
    await view.unmount();
  });

  it('resets to unknown for a new owner and rejects the old generation’s event and query', async () => {
    const oldPreference = deferred<boolean>();
    const newPreference = deferred<boolean>();
    const oldChange = jest.fn();
    const newChange = jest.fn();
    mockIsReduceMotionEnabled
      .mockReturnValueOnce(oldPreference.promise)
      .mockReturnValueOnce(newPreference.promise);

    const oldView = await renderWithTheme(
      <View>
        <StateProbe id="old" />
        <CallbackRefProbe id="old" onPreferenceChange={oldChange} />
      </View>,
    );
    const oldRef = preferenceRefs.get('old');
    await oldView.unmount();
    expect(removeNativeListeners[0]).toHaveBeenCalledTimes(1);
    expect(oldRef?.current).toBeNull();

    const newView = await renderWithTheme(
      <View>
        <StateProbe id="new" />
        <CallbackRefProbe id="new" onPreferenceChange={newChange} />
      </View>,
    );
    expect(mockAddEventListener).toHaveBeenCalledTimes(2);
    expect(mockIsReduceMotionEnabled).toHaveBeenCalledTimes(2);
    expectState('new', null);
    expect(preferenceRefs.get('new')?.current).toBeNull();
    expect(oldChange).not.toHaveBeenCalled();
    expect(newChange).not.toHaveBeenCalled();

    await act(async () => {
      nativeListeners[0]?.(true);
      oldPreference.resolve(true);
      await oldPreference.promise;
    });
    expectState('new', null);
    expect(preferenceRefs.get('new')?.current).toBeNull();
    expect(oldChange).not.toHaveBeenCalled();
    expect(newChange).not.toHaveBeenCalled();

    await act(async () => {
      newPreference.resolve(false);
      await newPreference.promise;
    });
    expectState('new', false);
    expect(preferenceRefs.get('new')?.current).toBe(false);
    expect(newChange).toHaveBeenCalledTimes(1);
    expect(newChange).toHaveBeenLastCalledWith(false);

    await emitNative(0, true);
    expectState('new', false);
    expect(newChange).toHaveBeenCalledTimes(1);
    await emitNative(1, true);
    expectState('new', true);
    expect(newChange).toHaveBeenCalledTimes(2);
    expect(newChange).toHaveBeenLastCalledWith(true);
    await newView.unmount();
    expect(removeNativeListeners[1]).toHaveBeenCalledTimes(1);
  });
});
