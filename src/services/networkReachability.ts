import type { NetworkState, NetworkStateEvent } from 'expo-network';
import { logger } from '@core/secure';
import type { TransportNetworkState } from '@state/transportHealthStore';

interface NetworkSubscription {
  remove: () => void;
}

export interface ExpoNetworkAdapter {
  NetworkStateType: { readonly NONE: string; readonly UNKNOWN: string };
  addNetworkStateListener: (listener: (event: NetworkStateEvent) => void) => NetworkSubscription;
  getNetworkStateAsync: () => Promise<NetworkState>;
}

export type ExpoNetworkLoader = () => Promise<ExpoNetworkAdapter>;

interface ActiveNetworkWatch {
  readonly generation: number;
  readonly onStateChange: (state: TransportNetworkState) => void;
  listenerEvents: number;
  lastState: TransportNetworkState;
  subscription: NetworkSubscription | null;
}

let watchGeneration = 0;
let activeWatch: ActiveNetworkWatch | null = null;

const loadExpoNetwork: ExpoNetworkLoader = async () => import('expo-network');

/**
 * Convert Expo Network's partially-known native snapshot into the finite transport signal.
 * `UNKNOWN` is deliberately not treated as offline even though Android may pair it with
 * `isConnected: false` while the native capability check is still settling.
 */
export function classifyDeviceNetworkState(
  state: NetworkState,
  types: { readonly NONE: string; readonly UNKNOWN: string },
): TransportNetworkState {
  if (state.type === types.UNKNOWN) return 'unknown';
  if (state.type === types.NONE) return 'offline';
  // Gator commonly talks to a LAN server. Android can report `isInternetReachable: false` for a
  // Wi-Fi link that still reaches that server, so only an explicit link loss is hard-offline.
  if (state.isConnected === false) return 'offline';
  if (state.isConnected === true || state.isInternetReachable === true) return 'online';
  return 'unknown';
}

function publish(
  watch: ActiveNetworkWatch,
  state: NetworkState,
  types: { readonly NONE: string; readonly UNKNOWN: string },
): void {
  if (activeWatch !== watch || watch.generation !== watchGeneration) return;
  const next = classifyDeviceNetworkState(state, types);
  if (next === watch.lastState) return;
  watch.lastState = next;
  try {
    watch.onStateChange(next);
  } catch (error) {
    logger.warn('[network] transport-state observer failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

/**
 * Observe Android network changes without statically evaluating the native Expo module in Node.
 * The listener is registered before the initial snapshot; if a newer listener event arrives while
 * that read is pending, the stale snapshot is discarded instead of rolling state backwards.
 */
export function startDeviceNetworkWatch(
  onStateChange: (state: TransportNetworkState) => void,
  loadNetwork: ExpoNetworkLoader = loadExpoNetwork,
): void {
  stopDeviceNetworkWatch();
  const watch: ActiveNetworkWatch = {
    generation: watchGeneration,
    onStateChange,
    listenerEvents: 0,
    lastState: 'unknown',
    subscription: null,
  };
  activeWatch = watch;

  void loadNetwork()
    .then(async (network) => {
      if (activeWatch !== watch || watch.generation !== watchGeneration) return;
      const subscription = network.addNetworkStateListener((event) => {
        if (activeWatch !== watch || watch.generation !== watchGeneration) return;
        watch.listenerEvents += 1;
        publish(watch, event, network.NetworkStateType);
      });
      if (activeWatch !== watch || watch.generation !== watchGeneration) {
        subscription.remove();
        return;
      }
      watch.subscription = subscription;
      const listenerEventsBeforeRead = watch.listenerEvents;
      const initial = await network.getNetworkStateAsync();
      if (
        activeWatch !== watch ||
        watch.generation !== watchGeneration ||
        watch.listenerEvents !== listenerEventsBeforeRead
      ) {
        return;
      }
      publish(watch, initial, network.NetworkStateType);
    })
    .catch((error: unknown) => {
      if (activeWatch !== watch || watch.generation !== watchGeneration) return;
      logger.warn('[network] native reachability unavailable', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    });
}

/** Stop the foreground-owned native listener and invalidate every pending module/read result. */
export function stopDeviceNetworkWatch(): void {
  watchGeneration += 1;
  const watch = activeWatch;
  activeWatch = null;
  try {
    watch?.subscription?.remove();
  } catch (error) {
    logger.warn('[network] native reachability teardown failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}
