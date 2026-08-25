import React from 'react';
import { StyleSheet } from 'react-native';
import type { TransportHealthStatus } from '@state/transportHealthStore';
import { useTransportHealthStore } from '@state/transportHealthStore';
import { ConnectionBanner } from '@ui/connection';
import { fireEvent, renderWithTheme, screen } from './support/renderWithTheme';

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
    ['connecting', 'Connecting…', false],
    ['reconnecting', 'Reconnecting…', false],
    ['offline', 'Offline', true],
    ['error', 'Connection problem', true],
  ] as const)('presents %s truthfully and accessibly', async (status, label, retryable) => {
    seedStatus(status);

    await renderWithTheme(<ConnectionBanner onRetry={jest.fn()} />);

    const alert = screen.getByRole('alert');
    expect(alert.props.accessibilityLabel).toBe(`Live updates: ${label}`);
    expect(alert.props.accessibilityLiveRegion).toBe('polite');
    expect(screen.getByText(label)).toBeTruthy();
    if (retryable) {
      expect(screen.getByRole('button', { name: 'Retry live updates' })).toBeTruthy();
    } else {
      expect(screen.queryByRole('button')).toBeNull();
    }
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
});
