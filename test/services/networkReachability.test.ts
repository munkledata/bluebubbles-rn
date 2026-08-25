import type { NetworkState } from 'expo-network';
import {
  classifyDeviceNetworkState,
  startDeviceNetworkWatch,
  stopDeviceNetworkWatch,
  type ExpoNetworkAdapter,
} from '@/services/networkReachability';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const TYPES = { NONE: 'NONE', UNKNOWN: 'UNKNOWN' } as const;

function networkState(
  type: string | undefined,
  isConnected?: boolean,
  isInternetReachable?: boolean,
): NetworkState {
  return { type, isConnected, isInternetReachable } as NetworkState;
}

function fakeAdapter(initial: Promise<NetworkState>): {
  adapter: ExpoNetworkAdapter;
  emit: (state: NetworkState) => void;
  remove: jest.Mock;
} {
  let listener: ((state: NetworkState) => void) | null = null;
  const remove = jest.fn();
  return {
    adapter: {
      NetworkStateType: TYPES,
      addNetworkStateListener: (nextListener) => {
        listener = nextListener;
        return { remove };
      },
      getNetworkStateAsync: () => initial,
    },
    emit: (state) => listener?.(state),
    remove,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

afterEach(() => {
  stopDeviceNetworkWatch();
  jest.restoreAllMocks();
});

describe('device network reachability', () => {
  it('keeps an unknown native snapshot unknown instead of claiming offline', () => {
    expect(classifyDeviceNetworkState(networkState('UNKNOWN', false, false), TYPES)).toBe(
      'unknown',
    );
    expect(classifyDeviceNetworkState(networkState(undefined), TYPES)).toBe('unknown');
  });

  it('classifies explicit no-network and usable-network snapshots', () => {
    expect(classifyDeviceNetworkState(networkState('NONE', false, false), TYPES)).toBe('offline');
    expect(classifyDeviceNetworkState(networkState('WIFI', true, true), TYPES)).toBe('online');
    // Android may not validate wider Internet access even though a LAN-hosted server is usable.
    expect(classifyDeviceNetworkState(networkState('WIFI', true, false), TYPES)).toBe('online');
    expect(classifyDeviceNetworkState(networkState('WIFI', undefined, false), TYPES)).toBe(
      'unknown',
    );
  });

  it('publishes the initial snapshot when no newer listener event arrived', async () => {
    const fake = fakeAdapter(Promise.resolve(networkState('WIFI', true, true)));
    const onStateChange = jest.fn();

    startDeviceNetworkWatch(onStateChange, async () => fake.adapter);
    await settle();

    expect(onStateChange).toHaveBeenCalledTimes(1);
    expect(onStateChange).toHaveBeenCalledWith('online');
  });

  it('does not let a late initial read overwrite a newer listener event', async () => {
    const initial = deferred<NetworkState>();
    const fake = fakeAdapter(initial.promise);
    const onStateChange = jest.fn();
    startDeviceNetworkWatch(onStateChange, async () => fake.adapter);
    await settle();

    fake.emit(networkState('WIFI', true, true));
    initial.resolve(networkState('NONE', false, false));
    await settle();

    expect(onStateChange.mock.calls.map(([state]) => state)).toEqual(['online']);
  });

  it('ignores a module load that finishes after the watch stopped', async () => {
    const moduleResult = deferred<ExpoNetworkAdapter>();
    const initial = deferred<NetworkState>();
    const fake = fakeAdapter(initial.promise);
    const onStateChange = jest.fn();
    startDeviceNetworkWatch(onStateChange, () => moduleResult.promise);

    stopDeviceNetworkWatch();
    moduleResult.resolve(fake.adapter);
    await settle();

    fake.emit(networkState('WIFI', true, true));
    expect(onStateChange).not.toHaveBeenCalled();
  });

  it('removes account A and ignores its retained listener after account B starts', async () => {
    const accountA = fakeAdapter(Promise.resolve(networkState('WIFI', true, true)));
    const accountB = fakeAdapter(Promise.resolve(networkState('WIFI', true, true)));
    const onAccountA = jest.fn();
    const onAccountB = jest.fn();

    startDeviceNetworkWatch(onAccountA, async () => accountA.adapter);
    await settle();
    startDeviceNetworkWatch(onAccountB, async () => accountB.adapter);
    await settle();
    onAccountA.mockClear();
    onAccountB.mockClear();

    expect(accountA.remove).toHaveBeenCalledTimes(1);
    accountA.emit(networkState('NONE', false, false));
    accountB.emit(networkState('NONE', false, false));

    expect(onAccountA).not.toHaveBeenCalled();
    expect(onAccountB).toHaveBeenCalledWith('offline');
  });
});
