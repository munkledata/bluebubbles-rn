import { useSessionStore } from '@state/sessionStore';
import { DEV_SERVER_ORIGIN, DEV_SERVER_PASSWORD, isDevServer } from '@utils/isDev';

/**
 * `isDevServer()` is the one switch behind every DEV short-circuit (fixture seeding, injected
 * messages, persist-without-drain). Until now every suite that touched it mocked it, so nothing
 * proved the release-build half: with `__DEV__` false it must be false even for the fixture
 * session (fix plan I / scanner triage A2, 2026-11-06).
 */
describe('isDevServer', () => {
  const globalDev = globalThis as { __DEV__?: boolean };
  const previousDev = globalDev.__DEV__;
  const initialState = useSessionStore.getState();

  afterEach(() => {
    useSessionStore.setState(initialState, true);
  });
  afterAll(() => {
    globalDev.__DEV__ = previousDev;
  });

  const fixtureSession = () =>
    useSessionStore.setState({
      status: 'connected',
      origin: DEV_SERVER_ORIGIN,
      password: DEV_SERVER_PASSWORD,
    });

  it('is true only for a connected fixture session in a dev build', () => {
    globalDev.__DEV__ = true;
    fixtureSession();
    expect(isDevServer()).toBe(true);
  });

  it('is false in a release build even for the fixture session', () => {
    globalDev.__DEV__ = false;
    fixtureSession();
    expect(isDevServer()).toBe(false);

    delete globalDev.__DEV__;
    expect(isDevServer()).toBe(false);
  });

  it('is false in a dev build for a real server, a wrong password, or a session that is not connected', () => {
    globalDev.__DEV__ = true;
    useSessionStore.setState({
      status: 'connected',
      origin: 'https://real.example.com',
      password: DEV_SERVER_PASSWORD,
    });
    expect(isDevServer()).toBe(false);

    useSessionStore.setState({ status: 'connected', origin: DEV_SERVER_ORIGIN, password: 'other' });
    expect(isDevServer()).toBe(false);

    useSessionStore.setState({
      status: 'connecting',
      origin: DEV_SERVER_ORIGIN,
      password: DEV_SERVER_PASSWORD,
    });
    expect(isDevServer()).toBe(false);
  });
});
