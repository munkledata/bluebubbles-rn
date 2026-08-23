/* eslint-disable import/first -- the focus-hook mock must exist before importing the hook. */
import type { EffectCallback } from 'react';

let focusEffect: EffectCallback | undefined;
jest.mock('expo-router', () => ({
  useFocusEffect: (effect: EffectCallback) => {
    focusEffect = effect;
  },
}));

import React from 'react';
import { act, render } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import {
  FIND_MY_REFRESH_INTERVAL_MS,
  useFindMyPolling,
} from '@/features/findmy/use-find-my-polling';

function Harness({ refresh }: { refresh: () => Promise<void> }): null {
  useFindMyPolling(refresh);
  return null;
}

describe('useFindMyPolling', () => {
  const originalCurrentState = Object.getOwnPropertyDescriptor(AppState, 'currentState');
  let appStateHandler: ((state: AppStateStatus) => void) | undefined;

  const setCurrentState = (state: AppStateStatus): void => {
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      writable: true,
      value: state,
    });
  };

  beforeEach(() => {
    jest.useFakeTimers();
    focusEffect = undefined;
    setCurrentState('active');
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((_event, handler) => {
      appStateHandler = handler;
      return { remove: jest.fn(() => (appStateHandler = undefined)) };
    }) as typeof AppState.addEventListener);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
    if (originalCurrentState) Object.defineProperty(AppState, 'currentState', originalCurrentState);
  });

  it('polls only while focused and active, refreshing immediately on resume and refocus', async () => {
    const refresh = jest.fn(async () => undefined);
    const view = await render(<Harness refresh={refresh} />);
    expect(focusEffect).toBeDefined();

    let blur: ReturnType<EffectCallback> = undefined;
    await act(async () => {
      blur = focusEffect!();
    });
    expect(refresh).not.toHaveBeenCalled(); // initial load belongs to the screen

    await act(async () => {
      jest.advanceTimersByTime(FIND_MY_REFRESH_INTERVAL_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      setCurrentState('background');
      appStateHandler?.('background');
      jest.advanceTimersByTime(FIND_MY_REFRESH_INTERVAL_MS * 2);
    });
    expect(refresh).toHaveBeenCalledTimes(1);

    await act(async () => {
      setCurrentState('active');
      appStateHandler?.('active');
    });
    expect(refresh).toHaveBeenCalledTimes(2); // immediate resume

    await act(async () => {
      if (typeof blur === 'function') blur();
      jest.advanceTimersByTime(FIND_MY_REFRESH_INTERVAL_MS * 2);
    });
    expect(refresh).toHaveBeenCalledTimes(2);

    await act(async () => {
      blur = focusEffect!();
    });
    expect(refresh).toHaveBeenCalledTimes(3); // immediate return to the route

    await act(async () => {
      if (typeof blur === 'function') blur();
      view.unmount();
    });
  });
});
