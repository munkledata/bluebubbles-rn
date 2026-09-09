/** Find My external-map handoff feedback and route/account ownership. */
import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';

const mockBack = jest.fn();

jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual('react') as typeof import('react');
  return {
    useRouter: () => ({ back: mockBack }),
    useFocusEffect: (effect: React.EffectCallback) => ReactLib.useEffect(effect, [effect]),
  };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));

jest.mock('@ui/findmy/FindMyMap', () => {
  const ReactLib = jest.requireActual('react') as typeof import('react');
  const { View } = jest.requireActual('react-native') as typeof import('react-native');
  return {
    FindMyMap: () => ReactLib.createElement(View, { testID: 'find-my-map' }),
  };
});

jest.mock('@/features/findmy/use-find-my-polling', () => ({ useFindMyPolling: jest.fn() }));
jest.mock('@core/api', () => ({ findMyApi: {} }));
jest.mock('@/services/clients', () => ({ http: {} }));
jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }));

// eslint-disable-next-line import/first
import FindMyScreen from '../../../app/(app)/findmy';
// eslint-disable-next-line import/first
import { useFindMyStore } from '@state/findmyStore';
// eslint-disable-next-line import/first
import { safeOpenUrl } from '@utils';
// eslint-disable-next-line import/first
import { useToastStore } from '@ui/toast/toastStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const DEVICE = {
  id: 'private-device-52a1',
  name: 'Private Phone',
  batteryLevel: 0.5,
  latitude: 40.765432,
  longitude: -73.987654,
  address: 'Private location',
};
const EXPECTED_GEO = 'geo:40.765432,-73.987654?q=40.765432,-73.987654(Private%20Phone)';
const SECOND_DEVICE = {
  ...DEVICE,
  id: 'private-device-91b4',
  name: 'Tablet',
  latitude: 39.7392,
  longitude: -104.9903,
};
const EXPECTED_SECOND_GEO = 'geo:39.7392,-104.9903?q=39.7392,-104.9903(Tablet)';

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  (safeOpenUrl as jest.Mock).mockReset().mockResolvedValue(true);
  useToastStore.setState({ current: null, queue: [] });
  useFindMyStore.setState({
    devices: [DEVICE],
    friends: [],
    items: [],
    loading: false,
    refreshing: false,
    error: null,
    load: jest.fn(async () => undefined),
    refresh: jest.fn(async () => undefined),
  });
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('FindMyScreen external map handoff', () => {
  it('opens the exact validated point through the safe URL boundary', async () => {
    await renderWithTheme(<FindMyScreen />);

    await fireEvent.press(screen.getByRole('button', { name: 'Open Private Phone in Maps' }));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledWith(EXPECTED_GEO));
    expect(useToastStore.getState().current).toBeNull();
  });

  it('exposes named refresh, tabs, and unique external-map controls', async () => {
    useFindMyStore.setState({
      devices: [DEVICE, SECOND_DEVICE],
      friends: [
        {
          id: 'private-friend-1',
          name: 'Casey',
          latitude: 47.6062,
          longitude: -122.3321,
          address: 'Location available',
          lastUpdated: null,
        },
      ],
    });
    await renderWithTheme(<FindMyScreen />);

    const refresh = screen.getByRole('button', { name: 'Refresh Find My' });
    expect(refresh.props.accessibilityState).toEqual({ disabled: false, busy: false });
    expect(screen.getByRole('tab', { name: 'Devices' }).props.accessibilityState).toEqual({
      selected: true,
    });
    expect(screen.getByRole('tab', { name: 'Items' }).props.accessibilityState).toEqual({
      selected: false,
    });
    expect(screen.getByRole('button', { name: 'Open Private Phone in Maps' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open Tablet in Maps' })).toBeTruthy();

    await fireEvent.press(screen.getByRole('tab', { name: 'People' }));
    expect(screen.getByRole('tab', { name: 'People' }).props.accessibilityState).toEqual({
      selected: true,
    });
    expect(screen.getByRole('tab', { name: 'Devices' }).props.accessibilityState).toEqual({
      selected: false,
    });
    expect(screen.getByRole('button', { name: 'Open Casey in Maps' })).toBeTruthy();

    await act(async () => {
      useFindMyStore.setState({ refreshing: true });
    });
    expect(
      screen.getByRole('button', { name: 'Refresh Find My' }).props.accessibilityState,
    ).toEqual({ disabled: true, busy: true });
  });

  it('shows one generic toast when Android refuses the current handoff', async () => {
    (safeOpenUrl as jest.Mock).mockResolvedValue(false);
    await renderWithTheme(<FindMyScreen />);

    await fireEvent.press(screen.getByText('Open ↗'));
    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toBe('Couldn’t open this outside Gator.'),
    );
    expect(useToastStore.getState().queue).toHaveLength(0);
  });

  it('serializes map handoffs across different rows and releases the route after settlement', async () => {
    const open = deferred<boolean>();
    (safeOpenUrl as jest.Mock).mockReturnValueOnce(open.promise).mockResolvedValueOnce(true);
    useFindMyStore.setState({ devices: [DEVICE, SECOND_DEVICE] });
    await renderWithTheme(<FindMyScreen />);
    const [firstOpenButton, secondOpenButton] = screen.getAllByText('Open ↗');
    if (!firstOpenButton || !secondOpenButton) {
      throw new Error('expected two located Find My rows');
    }

    await fireEvent.press(firstOpenButton);
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(1));
    await fireEvent.press(firstOpenButton);
    await fireEvent.press(secondOpenButton);
    expect(safeOpenUrl).toHaveBeenCalledTimes(1);

    await act(async () => {
      open.resolve(true);
      await open.promise;
    });
    await fireEvent.press(secondOpenButton);
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(2));
    expect(safeOpenUrl).toHaveBeenNthCalledWith(2, EXPECTED_SECOND_GEO);
  });

  it('drops a delayed failure after the route unmounts', async () => {
    const open = deferred<boolean>();
    (safeOpenUrl as jest.Mock).mockReturnValue(open.promise);
    const view = await renderWithTheme(<FindMyScreen />);
    await fireEvent.press(screen.getByText('Open ↗'));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(1));

    await view.unmount();
    await act(async () => {
      open.resolve(false);
      await open.promise;
    });

    expect(useToastStore.getState().current).toBeNull();
  });

  it('drops a delayed failure after its account lease is retired', async () => {
    const open = deferred<boolean>();
    (safeOpenUrl as jest.Mock).mockReturnValue(open.promise);
    await renderWithTheme(<FindMyScreen />);
    await fireEvent.press(screen.getByText('Open ↗'));
    await waitFor(() => expect(safeOpenUrl).toHaveBeenCalledTimes(1));

    await act(async () => {
      await pauseRealtimeDeliveries();
      open.resolve(false);
      await open.promise;
    });

    expect(useToastStore.getState().current).toBeNull();
  });

  it('does not offer a native handoff for a non-finite point', async () => {
    useFindMyStore.setState({
      devices: [{ ...DEVICE, latitude: Number.NaN }],
    });
    await renderWithTheme(<FindMyScreen />);

    expect(screen.queryByRole('button', { name: 'Open Private Phone in Maps' })).toBeNull();
    expect(safeOpenUrl).not.toHaveBeenCalled();
    expect(useToastStore.getState().current).toBeNull();
  });
});
