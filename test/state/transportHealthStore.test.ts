import {
  reduceTransportHealth,
  useTransportHealthStore,
  type TransportHealthSnapshot,
} from '@state/transportHealthStore';

const INITIAL: TransportHealthSnapshot = {
  generation: 0,
  active: false,
  socket: 'idle',
  server: 'unknown',
  network: 'unknown',
  hasConnected: false,
  status: 'idle',
};

describe('transport health state machine', () => {
  it('does not treat a successful server probe as proof of a live socket', () => {
    const connecting = reduceTransportHealth(INITIAL, { type: 'begin' });
    const serverReachable = reduceTransportHealth(connecting, {
      type: 'server',
      generation: connecting.generation,
      server: 'reachable',
    });

    expect(serverReachable).toMatchObject({ status: 'connecting', socket: 'connecting' });

    const connected = reduceTransportHealth(serverReachable, {
      type: 'socket',
      generation: connecting.generation,
      socket: 'connected',
    });
    expect(connected.status).toBe('connected');
  });

  it('maps a drop, retry exhaustion, offline probe, and recovery without changing auth state', () => {
    const connecting = reduceTransportHealth(INITIAL, { type: 'begin' });
    const connected = reduceTransportHealth(connecting, {
      type: 'socket',
      generation: connecting.generation,
      socket: 'connected',
    });
    const reconnecting = reduceTransportHealth(connected, {
      type: 'socket',
      generation: connected.generation,
      socket: 'reconnecting',
    });
    expect(reconnecting.status).toBe('reconnecting');

    const exhausted = reduceTransportHealth(reconnecting, {
      type: 'socket',
      generation: reconnecting.generation,
      socket: 'error',
    });
    expect(exhausted.status).toBe('error');

    const offline = reduceTransportHealth(exhausted, {
      type: 'server',
      generation: exhausted.generation,
      server: 'unreachable',
    });
    expect(offline.status).toBe('offline');

    const serverBack = reduceTransportHealth(offline, {
      type: 'server',
      generation: offline.generation,
      server: 'reachable',
    });
    expect(serverBack.status).toBe('error');

    const recovered = reduceTransportHealth(serverBack, {
      type: 'socket',
      generation: serverBack.generation,
      socket: 'connected',
    });
    expect(recovered.status).toBe('connected');
  });

  it('uses typed server failures for error and explicit transport loss for offline', () => {
    const connecting = reduceTransportHealth(INITIAL, { type: 'begin' });
    const serverError = reduceTransportHealth(connecting, {
      type: 'server',
      generation: connecting.generation,
      server: 'error',
    });
    expect(serverError.status).toBe('error');

    const offline = reduceTransportHealth(serverError, {
      type: 'network',
      generation: serverError.generation,
      network: 'offline',
    });
    expect(offline).toMatchObject({ status: 'offline', server: 'unknown' });

    // A hard link loss overrides Socket.IO's briefly stale connected flag.
    const staleLiveSocket = reduceTransportHealth(offline, {
      type: 'socket',
      generation: offline.generation,
      socket: 'connected',
    });
    expect(staleLiveSocket.status).toBe('offline');

    const linkBack = reduceTransportHealth(staleLiveSocket, {
      type: 'network',
      generation: staleLiveSocket.generation,
      network: 'online',
    });
    expect(linkBack.status).toBe('connected');
  });

  it('invalidates a prior-path server result when an offline network comes back', () => {
    let state = reduceTransportHealth(INITIAL, { type: 'begin' });
    state = reduceTransportHealth(state, {
      type: 'socket',
      generation: state.generation,
      socket: 'reconnecting',
    });
    state = reduceTransportHealth(state, {
      type: 'network',
      generation: state.generation,
      network: 'offline',
    });
    state = reduceTransportHealth(state, {
      type: 'server',
      generation: state.generation,
      server: 'unreachable',
    });
    expect(state.status).toBe('offline');

    state = reduceTransportHealth(state, {
      type: 'network',
      generation: state.generation,
      network: 'online',
    });
    expect(state).toMatchObject({ status: 'reconnecting', server: 'unknown', network: 'online' });
  });

  it('starts a manual retry without carrying forward the prior server failure', () => {
    let state = reduceTransportHealth(INITIAL, { type: 'begin' });
    state = reduceTransportHealth(state, {
      type: 'socket',
      generation: state.generation,
      socket: 'connected',
    });
    state = reduceTransportHealth(state, {
      type: 'socket',
      generation: state.generation,
      socket: 'error',
    });
    state = reduceTransportHealth(state, {
      type: 'server',
      generation: state.generation,
      server: 'unreachable',
    });
    expect(state.status).toBe('offline');

    const retrying = reduceTransportHealth(state, {
      type: 'retry',
      generation: state.generation,
    });
    expect(retrying).toMatchObject({
      status: 'reconnecting',
      socket: 'reconnecting',
      server: 'unknown',
      network: 'unknown',
      hasConnected: true,
    });

    expect(
      reduceTransportHealth(retrying, {
        type: 'retry',
        generation: retrying.generation - 1,
      }),
    ).toBe(retrying);
  });

  it('hides an intentional pause, resumes as reconnecting, and rejects stale callbacks', () => {
    let state = reduceTransportHealth(INITIAL, { type: 'begin' });
    const accountAGeneration = state.generation;
    state = reduceTransportHealth(state, {
      type: 'socket',
      generation: accountAGeneration,
      socket: 'connected',
    });
    state = reduceTransportHealth(state, { type: 'pause' });
    expect(state).toMatchObject({ status: 'idle', active: false, hasConnected: true });

    state = reduceTransportHealth(state, { type: 'begin' });
    expect(state.status).toBe('reconnecting');
    state = reduceTransportHealth(state, {
      type: 'socket',
      generation: state.generation,
      socket: 'connecting',
    });
    expect(state).toMatchObject({ status: 'reconnecting', socket: 'reconnecting' });
    const beforeStaleEvent = state;
    state = reduceTransportHealth(state, {
      type: 'server',
      generation: accountAGeneration,
      server: 'unreachable',
    });
    expect(state).toBe(beforeStaleEvent);

    state = reduceTransportHealth(state, { type: 'reset' });
    expect(state).toMatchObject({ status: 'idle', active: false, hasConnected: false });
  });
});

describe('transport health Zustand owner', () => {
  beforeEach(() => useTransportHealthStore.getState().reset());
  afterEach(() => useTransportHealthStore.getState().reset());

  it('requires the exact returned generation for service publication', () => {
    const accountA = useTransportHealthStore.getState().beginLifecycle();
    useTransportHealthStore.getState().setSocketState(accountA, 'connected');
    expect(useTransportHealthStore.getState().status).toBe('connected');

    useTransportHealthStore.getState().pause();
    const accountB = useTransportHealthStore.getState().beginLifecycle();
    useTransportHealthStore.getState().setServerState(accountA, 'unreachable');
    expect(useTransportHealthStore.getState().status).toBe('reconnecting');

    useTransportHealthStore.getState().setSocketState(accountB, 'connected');
    expect(useTransportHealthStore.getState().status).toBe('connected');
  });

  it('clears a current server failure when the service requests a retry', () => {
    const generation = useTransportHealthStore.getState().beginLifecycle();
    useTransportHealthStore.getState().setServerState(generation, 'error');
    expect(useTransportHealthStore.getState().status).toBe('error');

    useTransportHealthStore.getState().retry(generation);

    expect(useTransportHealthStore.getState()).toMatchObject({
      generation,
      status: 'connecting',
      socket: 'connecting',
      server: 'unknown',
    });
  });
});
