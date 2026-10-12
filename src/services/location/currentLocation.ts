export const CURRENT_LOCATION_TIMEOUT_MS = 15_000;

export interface CurrentLocationCoordinates {
  readonly latitude: number;
  readonly longitude: number;
  readonly altitude: number | null;
  readonly accuracy: number | null;
  readonly altitudeAccuracy: number | null;
  readonly heading: number | null;
  readonly speed: number | null;
}

/** The foreground fix shape returned by Expo Location. */
export interface CurrentLocationFix {
  readonly coords: CurrentLocationCoordinates;
  readonly timestamp: number;
  readonly mocked?: boolean;
}

export interface ForegroundLocationPermission {
  readonly granted: boolean;
  readonly canAskAgain: boolean;
}

export interface CurrentLocationSubscription {
  remove(): void;
}

/**
 * The small foreground-only part of `expo-location` used by this adapter.
 *
 * Keeping this interface injected avoids importing the native module here and makes it impossible
 * for this service to accidentally reach geocoding or background-location APIs.
 */
export interface ExpoLocationAdapter {
  readonly Accuracy: {
    readonly Balanced: number;
  };
  hasServicesEnabledAsync(): Promise<boolean>;
  getForegroundPermissionsAsync(): Promise<ForegroundLocationPermission>;
  requestForegroundPermissionsAsync(): Promise<ForegroundLocationPermission>;
  watchPositionAsync(
    options: { readonly accuracy: number; readonly mayShowUserSettingsDialog?: boolean },
    callback: (location: CurrentLocationFix) => void,
    errorHandler: (reason: string) => void,
  ): Promise<CurrentLocationSubscription>;
}

export type CurrentLocationOutcome =
  | { readonly status: 'success'; readonly location: CurrentLocationFix }
  | { readonly status: 'services-off' }
  | { readonly status: 'denied'; readonly canAskAgain: boolean }
  | { readonly status: 'cancelled' }
  | { readonly status: 'timeout' }
  | { readonly status: 'error' };

export interface AcquireCurrentLocationOptions {
  /** The owning account/session signal. Aborting it cancels this acquisition. */
  readonly signal?: AbortSignal;
}

export type CurrentLocationPermissionOutcome =
  | { readonly status: 'granted'; readonly prompted: boolean }
  | { readonly status: 'denied'; readonly canAskAgain: boolean }
  | { readonly status: 'services-off' | 'cancelled' | 'error' };

/** Permission setup never starts a watch. A prompted grant needs a new foreground send intent. */
export function prepareCurrentLocationPermission(
  location: ExpoLocationAdapter,
  options: {
    readonly signal: AbortSignal;
    readonly isCurrent: () => boolean;
    /** Check foreground ownership and mark the permission-only phase immediately before native UI. */
    readonly beforePrompt: () => boolean;
  },
): Promise<CurrentLocationPermissionOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: CurrentLocationPermissionOutcome): void => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ status: 'cancelled' });
    const current = (): boolean => {
      if (settled) return false;
      if (options.signal.aborted || !options.isCurrent()) {
        onAbort();
        return false;
      }
      return true;
    };
    options.signal.addEventListener('abort', onAbort, { once: true });
    const run = async (): Promise<void> => {
      try {
        if (!current()) return;
        const servicesEnabled = await location.hasServicesEnabledAsync();
        if (!current()) return;
        if (!servicesEnabled) {
          finish({ status: 'services-off' });
          return;
        }
        let permission = await location.getForegroundPermissionsAsync();
        if (!current()) return;
        let prompted = false;
        if (!permission.granted && permission.canAskAgain) {
          if (!options.beforePrompt() || !current()) {
            onAbort();
            return;
          }
          prompted = true;
          permission = await location.requestForegroundPermissionsAsync();
          if (!current()) return;
        }
        finish(
          permission.granted
            ? { status: 'granted', prompted }
            : { status: 'denied', canAskAgain: permission.canAskAgain },
        );
      } catch {
        if (current()) finish({ status: 'error' });
      }
    };
    void run();
  });
}

/**
 * Acquire exactly one current position while the app is in the foreground.
 *
 * Permission must already be granted: this send phase never opens Android's permission Activity.
 * The watch uses balanced accuracy, and the live
 * subscription is bounded to 15 seconds. The abort listener is installed before the first native
 * await so a retired account cannot publish a late fix.
 */
export function acquireCurrentLocation(
  location: ExpoLocationAdapter,
  options: AcquireCurrentLocationOptions = {},
): Promise<CurrentLocationOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let subscription: CurrentLocationSubscription | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const removeSubscription = (owned: CurrentLocationSubscription | null): void => {
      if (!owned) return;
      if (subscription === owned) subscription = null;
      try {
        owned.remove();
      } catch {
        // Cleanup must never replace the truthful acquisition outcome.
      }
    };

    const onAbort = (): void => finish({ status: 'cancelled' });

    const finish = (outcome: CurrentLocationOutcome): void => {
      if (settled) return;
      settled = true;
      if (timeout != null) {
        clearTimeout(timeout);
        timeout = null;
      }
      options.signal?.removeEventListener('abort', onAbort);
      removeSubscription(subscription);
      resolve(outcome);
    };

    options.signal?.addEventListener('abort', onAbort, { once: true });
    // Close the check/listener race for injected AbortSignal implementations.
    if (options.signal?.aborted) onAbort();

    const run = async (): Promise<void> => {
      try {
        const servicesEnabled = await location.hasServicesEnabledAsync();
        if (settled) return;
        if (!servicesEnabled) {
          finish({ status: 'services-off' });
          return;
        }

        const permission = await location.getForegroundPermissionsAsync();
        if (settled) return;
        if (!permission.granted) {
          finish({ status: 'denied', canAskAgain: permission.canAskAgain });
          return;
        }

        timeout = setTimeout(() => finish({ status: 'timeout' }), CURRENT_LOCATION_TIMEOUT_MS);

        // Never let Play Services open its "turn on location accuracy" dialog: it pauses this
        // activity, the chat screen treats that as leaving and cancels the send behind it. With
        // network location off, the request ends as an explicit timeout or error instead.
        const pendingSubscription = location.watchPositionAsync(
          { accuracy: location.Accuracy.Balanced, mayShowUserSettingsDialog: false },
          (fix) => finish({ status: 'success', location: fix }),
          () => finish({ status: 'error' }),
        );

        void pendingSubscription.then(
          (nextSubscription) => {
            if (settled) {
              removeSubscription(nextSubscription);
              return;
            }
            subscription = nextSubscription;
          },
          () => finish(options.signal?.aborted ? { status: 'cancelled' } : { status: 'error' }),
        );
      } catch {
        finish(options.signal?.aborted ? { status: 'cancelled' } : { status: 'error' });
      }
    };

    if (!settled) void run();
  });
}
