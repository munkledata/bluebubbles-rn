import React from 'react';
import { StyleSheet } from 'react-native';
import type { TransportHealthStatus } from '@state/transportHealthStore';
import { useTransportHealthStore } from '@state/transportHealthStore';
import { CONNECTION_BANNER_TRANSIENT_DELAY_MS, ConnectionBanner } from '@ui/connection';
import { act, fireEvent, renderWithTheme, screen } from './support/renderWithTheme';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));

function seedStatus(status: TransportHealthStatus): void {
  const store = useTransportHealthStore.getState();
  store.reset();
  if (status === 'idle') return;
  const generation = store.beginLifecycle();
  if (status === 'connecting') return;
  if (status === 'connected') {
    store.setSocketState(generation, 'connected');
    return;
  }
  if (status === 'reconnecting') {
    store.setSocketState(generation, 'connected');
    store.setSocketState(generation, 'reconnecting');
    return;
  }
  if (status === 'offline') {
    store.setNetworkState(generation, 'offline');
    return;
  }
  if (status === 'auth-rejected') {
    store.setSocketState(generation, 'auth-rejected');
    return;
  }
  store.setSocketState(generation, 'error');
}

beforeEach(() => {
  useTransportHealthStore.getState().reset();
});

describe('ConnectionBanner', () => {
  it.each(['idle', 'connected'] as const)('stays hidden while transport is %s', async (status) => {
    seedStatus(status);

    await renderWithTheme(<ConnectionBanner onRetry={jest.fn()} />);

    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it.each([
    ['connecting', 'Connecting…'],
    ['reconnecting', 'Reconnecting…'],
  ] as const)('shows persistent %s only after the transient delay', async (status, label) => {
    jest.useFakeTimers();
    let view: Awaited<ReturnType<typeof renderWithTheme>> | null = null;
    try {
      seedStatus(status);
      view = await renderWithTheme(<ConnectionBanner onRetry={jest.fn()} />);

      expect(screen.queryByRole('alert')).toBeNull();
      await act(async () => {
        jest.advanceTimersByTime(CONNECTION_BANNER_TRANSIENT_DELAY_MS - 1);
      });
      expect(screen.queryByRole('alert')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      const alert = screen.getByRole('alert');
      expect(alert.props.accessibilityLabel).toBe(`Live updates: ${label}`);
      expect(alert.props.accessibilityLiveRegion).toBe('polite');
      expect(screen.getByText(label)).toBeTruthy();
      expect(screen.queryByRole('button')).toBeNull();
    } finally {
      if (view) await act(async () => view?.unmount());
      jest.useRealTimers();
    }
  });

  it('keeps a brief reconnect hidden after the transport recovers', async () => {
    jest.useFakeTimers();
    let view: Awaited<ReturnType<typeof renderWithTheme>> | null = null;
    try {
      seedStatus('connected');
      view = await renderWithTheme(<ConnectionBanner onRetry={jest.fn()} />);
      const store = useTransportHealthStore.getState();

      await act(async () => {
        store.setSocketState(store.generation, 'reconnecting');
      });
      expect(screen.queryByRole('alert')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(CONNECTION_BANNER_TRANSIENT_DELAY_MS - 1);
        store.setSocketState(store.generation, 'connected');
      });
      await act(async () => {
        jest.advanceTimersByTime(CONNECTION_BANNER_TRANSIENT_DELAY_MS);
      });

      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      if (view) await act(async () => view?.unmount());
      jest.useRealTimers();
    }
  });

  it('restarts the delay when the transient status changes', async () => {
    jest.useFakeTimers();
    let view: Awaited<ReturnType<typeof renderWithTheme>> | null = null;
    try {
      seedStatus('connecting');
      view = await renderWithTheme(<ConnectionBanner onRetry={jest.fn()} />);
      const store = useTransportHealthStore.getState();

      await act(async () => {
        jest.advanceTimersByTime(CONNECTION_BANNER_TRANSIENT_DELAY_MS - 1);
        store.setSocketState(store.generation, 'connected');
        store.setSocketState(store.generation, 'reconnecting');
      });
      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.queryByRole('alert')).toBeNull();

      await act(async () => {
        jest.advanceTimersByTime(CONNECTION_BANNER_TRANSIENT_DELAY_MS - 1);
      });
      expect(screen.getByText('Reconnecting…')).toBeTruthy();
    } finally {
      if (view) await act(async () => view?.unmount());
      jest.useRealTimers();
    }
  });

  it.each([
    ['offline', 'Offline'],
    ['error', 'Connection problem'],
  ] as const)('presents %s immediately and accessibly', async (status, label) => {
    seedStatus(status);

    await renderWithTheme(<ConnectionBanner onRetry={jest.fn()} />);

    const alert = screen.getByRole('alert');
    expect(alert.props.accessibilityLabel).toBe(`Live updates: ${label}`);
    expect(alert.props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Retry live updates' })).toBeTruthy();
  });

  it('says the password was rejected and offers Server Management instead of Retry', async () => {
    // Review M118: retrying would only re-send the same rejected credential.
    seedStatus('auth-rejected');
    const onRetry = jest.fn();
    const onManageServer = jest.fn();
    await renderWithTheme(<ConnectionBanner onRetry={onRetry} onManageServer={onManageServer} />);

    expect(screen.getByRole('alert').props.accessibilityLabel).toBe(
      'Live updates: Password rejected',
    );
    expect(screen.queryByRole('button', { name: 'Retry live updates' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Open Server Management' }));
    expect(onManageServer).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('delegates Retry without mutating transport state itself', async () => {
    seedStatus('offline');
    const onRetry = jest.fn(() => true);
    await renderWithTheme(<ConnectionBanner onRetry={onRetry} />);
    const before = useTransportHealthStore.getState();

    fireEvent.press(screen.getByRole('button', { name: 'Retry live updates' }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(useTransportHealthStore.getState()).toBe(before);
  });

  it('uses the global status layer below full-screen call overlays', async () => {
    seedStatus('offline');
    await renderWithTheme(<ConnectionBanner onRetry={jest.fn()} />);

    const root = screen.root;
    if (!root) throw new Error('ConnectionBanner rendered nothing while transport was offline');
    expect(StyleSheet.flatten(root.props.style)).toMatchObject({
      elevation: 8,
      zIndex: 50,
    });
  });

  it('reserves the measured height as text grows and releases it on recovery', async () => {
    seedStatus('offline');
    const onHeightChange = jest.fn();
    await renderWithTheme(<ConnectionBanner onRetry={jest.fn()} onHeightChange={onHeightChange} />);

    for (const height of [44, 88]) {
      await act(async () => {
        fireEvent(screen.getByRole('alert'), 'layout', {
          nativeEvent: { layout: { x: 0, y: 0, width: 240, height } },
        });
      });
      expect(onHeightChange).toHaveBeenLastCalledWith(height + 8);
    }
    await act(async () => {
      const store = useTransportHealthStore.getState();
      store.setNetworkState(store.generation, 'online');
      store.setSocketState(store.generation, 'connected');
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(onHeightChange).toHaveBeenLastCalledWith(0);
  });
});
