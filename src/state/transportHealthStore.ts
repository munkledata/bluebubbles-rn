import { create } from 'zustand';

/** Live socket/server health. This is deliberately separate from saved-session authentication. */
export type TransportHealthStatus =
  'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';

export type TransportSocketState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error';
export type TransportServerState = 'unknown' | 'reachable' | 'unreachable' | 'error';
export type TransportNetworkState = 'unknown' | 'online' | 'offline';

export interface TransportHealthSnapshot {
  readonly generation: number;
  readonly active: boolean;
  readonly socket: TransportSocketState;
  readonly server: TransportServerState;
  readonly network: TransportNetworkState;
  /** Preserved across a background pause so foreground startup can honestly say reconnecting. */
  readonly hasConnected: boolean;
  readonly status: TransportHealthStatus;
}

export type TransportHealthEvent =
  | { readonly type: 'begin' }
  | { readonly type: 'retry'; readonly generation: number }
  | {
      readonly type: 'socket';
      readonly generation: number;
      readonly socket: Exclude<TransportSocketState, 'idle'>;
    }
  | {
      readonly type: 'server';
      readonly generation: number;
      readonly server: Exclude<TransportServerState, 'unknown'>;
    }
  | {
      readonly type: 'network';
      readonly generation: number;
      readonly network: TransportNetworkState;
    }
  | { readonly type: 'pause' }
  | { readonly type: 'reset' };

interface TransportHealthState extends TransportHealthSnapshot {
  /** Start a new foreground owner and return the generation its callbacks must present. */
  beginLifecycle: () => number;
  setSocketState: (generation: number, socket: Exclude<TransportSocketState, 'idle'>) => void;
  setServerState: (generation: number, server: Exclude<TransportServerState, 'unknown'>) => void;
  setNetworkState: (generation: number, network: TransportNetworkState) => void;
  /** A manual retry keeps the owner but discards the server result from the prior attempt. */
  retry: (generation: number) => void;
  /** Intentional background/App-Lock suspension: hide health without forgetting prior recovery. */
  pause: () => void;
  /** Account teardown: discard every signal and the prior-account recovery history. */
  reset: () => void;
}

function deriveTransportHealthStatus(
  state: Omit<TransportHealthSnapshot, 'status'>,
): TransportHealthStatus {
  if (!state.active) return 'idle';

  // A confirmed link loss is stronger than Socket.IO's briefly stale `connected` flag. Native
  // classification deliberately ignores Android's Internet-validation bit, so this does not mark
  // a usable local/LAN server offline merely because the wider Internet is unavailable.
  if (state.network === 'offline') return 'offline';

  // A live socket is the strongest direct server proof. HTTP probes arbitrate only while the
  // socket is down; a transient ping failure must not hide a working live-update channel.
  if (state.socket === 'connected') return 'connected';

  // A fast-failing server probe means the app cannot currently reach its server. A typed
  // HTTP/schema/auth failure is different: the server answered, but the transport cannot be used
  // safely, so surface an error instead.
  if (state.server === 'unreachable') return 'offline';
  if (state.server === 'error' || state.socket === 'error') return 'error';
  if (state.socket === 'reconnecting') return 'reconnecting';
  return 'connecting';
}

function initialSnapshot(generation = 0): TransportHealthSnapshot {
  return {
    generation,
    active: false,
    socket: 'idle',
    server: 'unknown',
    network: 'unknown',
    hasConnected: false,
    status: 'idle',
  };
}

function withDerivedStatus(
  state: Omit<TransportHealthSnapshot, 'status'>,
): TransportHealthSnapshot {
  return { ...state, status: deriveTransportHealthStatus(state) };
}

/** Pure state machine used by the Zustand owner and focused Node tests. */
export function reduceTransportHealth(
  state: TransportHealthSnapshot,
  event: TransportHealthEvent,
): TransportHealthSnapshot {
  if (event.type === 'reset') return initialSnapshot(state.generation + 1);
  if (event.type === 'pause') {
    return {
      ...initialSnapshot(state.generation + 1),
      hasConnected: state.hasConnected,
    };
  }
  if (event.type === 'begin') {
    return withDerivedStatus({
      generation: state.generation + 1,
      active: true,
      socket: state.hasConnected ? 'reconnecting' : 'connecting',
      server: 'unknown',
      network: 'unknown',
      hasConnected: state.hasConnected,
    });
  }

  // Native/socket/promise callbacks must present the exact active owner. Old account, old socket,
  // and pre-background callbacks are ignored even if a caller forgets an outer lifecycle check.
  if (!state.active || event.generation !== state.generation) return state;

  if (event.type === 'retry') {
    return withDerivedStatus({
      ...state,
      socket: state.hasConnected ? 'reconnecting' : 'connecting',
      server: 'unknown',
    });
  }

  if (event.type === 'socket') {
    // A fresh SocketService reports its first attempt as `connecting`, but a foreground lifecycle
    // that was previously live is genuinely reconnecting. Keep that durable-in-memory history at
    // the reducer boundary so no transport adapter can regress the user-facing status.
    const socket =
      event.socket === 'connecting' && state.hasConnected ? 'reconnecting' : event.socket;
    return withDerivedStatus({
      ...state,
      socket,
      hasConnected: state.hasConnected || event.socket === 'connected',
    });
  }
  if (event.type === 'server') {
    return withDerivedStatus({ ...state, server: event.server });
  }

  // A real network transition invalidates a server result observed on the prior path. Unknown →
  // online is merely the initial native snapshot and must not erase an already-finished ping.
  const changedPath =
    event.network !== state.network && (event.network === 'offline' || state.network === 'offline');
  return withDerivedStatus({
    ...state,
    network: event.network,
    server: changedPath ? 'unknown' : state.server,
  });
}

const initial = initialSnapshot();

export const useTransportHealthStore = create<TransportHealthState>((set) => ({
  ...initial,
  beginLifecycle: () => {
    let generation = initial.generation;
    set((state) => {
      const next = reduceTransportHealth(state, { type: 'begin' });
      generation = next.generation;
      return next;
    });
    return generation;
  },
  setSocketState: (generation, socket) =>
    set((state) => reduceTransportHealth(state, { type: 'socket', generation, socket })),
  setServerState: (generation, server) =>
    set((state) => reduceTransportHealth(state, { type: 'server', generation, server })),
  setNetworkState: (generation, network) =>
    set((state) => reduceTransportHealth(state, { type: 'network', generation, network })),
  retry: (generation) =>
    set((state) => reduceTransportHealth(state, { type: 'retry', generation })),
  pause: () => set((state) => reduceTransportHealth(state, { type: 'pause' })),
  reset: () => set((state) => reduceTransportHealth(state, { type: 'reset' })),
}));
