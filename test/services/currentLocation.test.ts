import {
  acquireCurrentLocation,
  prepareCurrentLocationPermission,
  CURRENT_LOCATION_TIMEOUT_MS,
  type CurrentLocationFix,
  type CurrentLocationSubscription,
  type ExpoLocationAdapter,
  type ForegroundLocationPermission,
} from '@/services/location/currentLocation';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const FIX: CurrentLocationFix = {
  coords: {
    latitude: 39.7392,
    longitude: -104.9903,
    altitude: 1_609,
    accuracy: 25,
    altitudeAccuracy: 50,
    heading: null,
    speed: null,
  },
  timestamp: 1_795_000_000_000,
  mocked: false,
};

const GRANTED: ForegroundLocationPermission = { granted: true, canAskAgain: true };

function makeAdapter(overrides: Partial<ExpoLocationAdapter> = {}): ExpoLocationAdapter {
  return {
    Accuracy: { Balanced: 3 },
    hasServicesEnabledAsync: jest.fn().mockResolvedValue(true),
    getForegroundPermissionsAsync: jest.fn().mockResolvedValue(GRANTED),
    requestForegroundPermissionsAsync: jest.fn().mockResolvedValue(GRANTED),
    watchPositionAsync: jest.fn(),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe('acquireCurrentLocation', () => {
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('checks an existing foreground grant and resolves the first balanced-accuracy fix', async () => {
    const remove = jest.fn();
    let publishFix!: (fix: CurrentLocationFix) => void;
    const adapter = makeAdapter({
      watchPositionAsync: jest.fn(async (options, callback) => {
        expect(options).toEqual({ accuracy: 3 });
        publishFix = callback;
        return { remove };
      }),
    });

    const pending = acquireCurrentLocation(adapter);
    await settle();
    publishFix(FIX);

    await expect(pending).resolves.toEqual({ status: 'success', location: FIX });
    expect(adapter.hasServicesEnabledAsync).toHaveBeenCalledTimes(1);
    expect(adapter.getForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(adapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(adapter.watchPositionAsync).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('refuses missing permission without opening native UI during acquisition', async () => {
    const adapter = makeAdapter({
      getForegroundPermissionsAsync: jest
        .fn()
        .mockResolvedValue({ granted: false, canAskAgain: true }),
      requestForegroundPermissionsAsync: jest
        .fn()
        .mockResolvedValue({ granted: false, canAskAgain: false }),
    });

    await expect(acquireCurrentLocation(adapter)).resolves.toEqual({
      status: 'denied',
      canAskAgain: true,
    });
    expect(adapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(adapter.watchPositionAsync).not.toHaveBeenCalled();
  });

  it('does not re-request a permanently denied foreground permission', async () => {
    const adapter = makeAdapter({
      getForegroundPermissionsAsync: jest
        .fn()
        .mockResolvedValue({ granted: false, canAskAgain: false }),
    });

    await expect(acquireCurrentLocation(adapter)).resolves.toEqual({
      status: 'denied',
      canAskAgain: false,
    });
    expect(adapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(adapter.watchPositionAsync).not.toHaveBeenCalled();
  });

  it('reports disabled location services without opening a permission prompt or watch', async () => {
    const adapter = makeAdapter({
      hasServicesEnabledAsync: jest.fn().mockResolvedValue(false),
    });

    await expect(acquireCurrentLocation(adapter)).resolves.toEqual({ status: 'services-off' });
    expect(adapter.getForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(adapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(adapter.watchPositionAsync).not.toHaveBeenCalled();
  });

  it('removes the live subscription when Expo reports a watch error', async () => {
    const remove = jest.fn();
    let publishError!: (reason: string) => void;
    const adapter = makeAdapter({
      watchPositionAsync: jest.fn(async (_options, _callback, errorHandler) => {
        publishError = errorHandler;
        return { remove };
      }),
    });

    const pending = acquireCurrentLocation(adapter);
    await settle();
    publishError('provider unavailable');

    await expect(pending).resolves.toEqual({ status: 'error' });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('times out after exactly 15 seconds and removes a subscription that returns late', async () => {
    jest.useFakeTimers();
    const lateSubscription = deferred<CurrentLocationSubscription>();
    const remove = jest.fn();
    const adapter = makeAdapter({
      watchPositionAsync: jest.fn(() => lateSubscription.promise),
    });
    const observed = jest.fn();

    const pending = acquireCurrentLocation(adapter);
    void pending.then(observed);
    await settle();

    await jest.advanceTimersByTimeAsync(CURRENT_LOCATION_TIMEOUT_MS - 1);
    expect(observed).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ status: 'timeout' });
    expect(remove).not.toHaveBeenCalled();

    lateSubscription.resolve({ remove });
    await settle();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('foreground/account abort removes the watch and ignores a late fix', async () => {
    const controller = new AbortController();
    const remove = jest.fn();
    let publishFix!: (fix: CurrentLocationFix) => void;
    const adapter = makeAdapter({
      watchPositionAsync: jest.fn(async (_options, callback) => {
        publishFix = callback;
        return { remove };
      }),
    });

    const pending = acquireCurrentLocation(adapter, { signal: controller.signal });
    await settle();
    controller.abort();

    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(remove).toHaveBeenCalledTimes(1);

    publishFix(FIX);
    await settle();
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('removes a subscription that returns after account abort already cancelled the request', async () => {
    const controller = new AbortController();
    const lateSubscription = deferred<CurrentLocationSubscription>();
    const remove = jest.fn();
    const adapter = makeAdapter({
      watchPositionAsync: jest.fn(() => lateSubscription.promise),
    });

    const pending = acquireCurrentLocation(adapter, { signal: controller.signal });
    await settle();
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'cancelled' });

    lateSubscription.resolve({ remove });
    await settle();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('removes a subscription that returns after the first fix already settled the request', async () => {
    const lateSubscription = deferred<CurrentLocationSubscription>();
    const remove = jest.fn();
    let publishFix!: (fix: CurrentLocationFix) => void;
    const adapter = makeAdapter({
      watchPositionAsync: jest.fn((_options, callback) => {
        publishFix = callback;
        return lateSubscription.promise;
      }),
    });

    const pending = acquireCurrentLocation(adapter);
    await settle();
    publishFix(FIX);
    await expect(pending).resolves.toEqual({ status: 'success', location: FIX });

    lateSubscription.resolve({ remove });
    await settle();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('cancels during a pending permission check and ignores its late result', async () => {
    const controller = new AbortController();
    const permission = deferred<ForegroundLocationPermission>();
    const adapter = makeAdapter({
      getForegroundPermissionsAsync: jest.fn(() => permission.promise),
    });

    const pending = acquireCurrentLocation(adapter, { signal: controller.signal });
    await settle();
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'cancelled' });

    permission.resolve(GRANTED);
    await settle();
    expect(adapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(adapter.watchPositionAsync).not.toHaveBeenCalled();
  });

  it('maps a native setup rejection to error without leaking the rejected promise', async () => {
    const adapter = makeAdapter({
      watchPositionAsync: jest.fn().mockRejectedValue(new Error('native setup failed')),
    });

    await expect(acquireCurrentLocation(adapter)).resolves.toEqual({ status: 'error' });
  });
});

describe('prepareCurrentLocationPermission', () => {
  const options = (controller = new AbortController()) => ({
    signal: controller.signal,
    isCurrent: () => true,
    beforePrompt: jest.fn(() => true),
  });

  it.each([true, false])(
    'returns an existing grant=%s without prompting or starting a watch',
    async (granted) => {
      const adapter = makeAdapter({
        getForegroundPermissionsAsync: jest.fn().mockResolvedValue({ granted, canAskAgain: false }),
      });
      const owner = options();
      await expect(prepareCurrentLocationPermission(adapter, owner)).resolves.toEqual(
        granted ? { status: 'granted', prompted: false } : { status: 'denied', canAskAgain: false },
      );
      expect(owner.beforePrompt).not.toHaveBeenCalled();
      expect(adapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
      expect(adapter.watchPositionAsync).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])(
    'returns a prompted grant=%s as permission-only feedback',
    async (granted) => {
      const adapter = makeAdapter({
        getForegroundPermissionsAsync: jest
          .fn()
          .mockResolvedValue({ granted: false, canAskAgain: true }),
        requestForegroundPermissionsAsync: jest
          .fn()
          .mockResolvedValue({ granted, canAskAgain: true }),
      });
      const owner = options();
      await expect(prepareCurrentLocationPermission(adapter, owner)).resolves.toEqual(
        granted ? { status: 'granted', prompted: true } : { status: 'denied', canAskAgain: true },
      );
      expect(owner.beforePrompt).toHaveBeenCalledTimes(1);
      expect(adapter.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
      expect(adapter.watchPositionAsync).not.toHaveBeenCalled();
    },
  );

  it('stops before permission when services are off', async () => {
    const adapter = makeAdapter({ hasServicesEnabledAsync: jest.fn().mockResolvedValue(false) });
    await expect(prepareCurrentLocationPermission(adapter, options())).resolves.toEqual({
      status: 'services-off',
    });
    expect(adapter.getForegroundPermissionsAsync).not.toHaveBeenCalled();
    expect(adapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('rejects a retired lifetime before opening the native prompt', async () => {
    let current = true;
    const permission = deferred<ForegroundLocationPermission>();
    const adapter = makeAdapter({
      getForegroundPermissionsAsync: jest.fn(() => permission.promise),
    });
    const pending = prepareCurrentLocationPermission(adapter, {
      ...options(),
      isCurrent: () => current,
    });
    await settle();
    current = false;
    permission.resolve({ granted: false, canAskAgain: true });
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    expect(adapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('honors the last foreground check immediately before native UI', async () => {
    const adapter = makeAdapter({
      getForegroundPermissionsAsync: jest
        .fn()
        .mockResolvedValue({ granted: false, canAskAgain: true }),
    });
    await expect(
      prepareCurrentLocationPermission(adapter, { ...options(), beforePrompt: () => false }),
    ).resolves.toEqual({ status: 'cancelled' });
    expect(adapter.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });

  it('settles on owner abort while the native prompt is pending and discards a late grant', async () => {
    const controller = new AbortController();
    const permission = deferred<ForegroundLocationPermission>();
    const adapter = makeAdapter({
      getForegroundPermissionsAsync: jest
        .fn()
        .mockResolvedValue({ granted: false, canAskAgain: true }),
      requestForegroundPermissionsAsync: jest.fn(() => permission.promise),
    });
    const pending = prepareCurrentLocationPermission(adapter, options(controller));
    await settle();
    expect(adapter.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    controller.abort();
    await expect(pending).resolves.toEqual({ status: 'cancelled' });
    permission.resolve(GRANTED);
    await settle();
    expect(adapter.watchPositionAsync).not.toHaveBeenCalled();
  });
});
