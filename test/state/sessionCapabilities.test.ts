import { ServerInfo } from '@core/models';
import { sessionAccessors, useSessionStore } from '@state/sessionStore';

/**
 * The `supports_message_deleted` capability (schema gap 6). No UI gates on it yet — DbEventSink
 * applies deletions unconditionally — so this locks in only the boolean accessor's semantics: it is
 * true ONLY when the connected server advertised the flag, and safely false in every other shape
 * (no server info, flag omitted, or explicitly false).
 */
describe('sessionAccessors.messageDeletedSupported', () => {
  beforeEach(() => useSessionStore.setState({ serverInfo: null }));

  it('is false when there is no server info', () => {
    expect(sessionAccessors.messageDeletedSupported()).toBe(false);
  });

  it('is false when the server omits the flag', () => {
    useSessionStore.setState({ serverInfo: ServerInfo.parse({ version: '1.9.0' }) });
    expect(sessionAccessors.messageDeletedSupported()).toBe(false);
  });

  it('is false when the server reports it false', () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: '1.9.0', supports_message_deleted: false }),
    });
    expect(sessionAccessors.messageDeletedSupported()).toBe(false);
  });

  it('is true only when the server advertises the capability', () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: '1.9.0', supports_message_deleted: true }),
    });
    expect(sessionAccessors.messageDeletedSupported()).toBe(true);
  });
});

describe('sessionAccessors.messageSearchSupported', () => {
  beforeEach(() => useSessionStore.setState({ serverInfo: null }));

  it('is false unless the connected server explicitly advertises bounded search', () => {
    expect(sessionAccessors.messageSearchSupported()).toBe(false);
    useSessionStore.setState({ serverInfo: ServerInfo.parse({ version: '1.9.0' }) });
    expect(sessionAccessors.messageSearchSupported()).toBe(false);
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: '1.9.0', supports_message_search: true }),
    });
    expect(sessionAccessors.messageSearchSupported()).toBe(true);
  });
});

describe('sessionAccessors.messagePartTopologySupported', () => {
  beforeEach(() => useSessionStore.setState({ serverInfo: null }));

  it('is true only when the server explicitly advertises exact part topology', () => {
    expect(sessionAccessors.messagePartTopologySupported()).toBe(false);
    useSessionStore.setState({ serverInfo: ServerInfo.parse({ version: '1.9.0' }) });
    expect(sessionAccessors.messagePartTopologySupported()).toBe(false);
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({
        version: '1.9.0',
        supports_message_part_topology: true,
      }),
    });
    expect(sessionAccessors.messagePartTopologySupported()).toBe(true);
  });
});

/**
 * The `supports_icloud_account` capability (iMessage-account F#8). The Settings "iMessage Account"
 * row gates on this accessor; false in every shape except a server that explicitly advertises it.
 */
describe('sessionAccessors.icloudAccountSupported', () => {
  beforeEach(() => useSessionStore.setState({ serverInfo: null }));

  it('is false when there is no server info', () => {
    expect(sessionAccessors.icloudAccountSupported()).toBe(false);
  });

  it('is false when the server omits the flag', () => {
    useSessionStore.setState({ serverInfo: ServerInfo.parse({ version: '1.9.0' }) });
    expect(sessionAccessors.icloudAccountSupported()).toBe(false);
  });

  it('is false when the server reports it false', () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: '1.9.0', supports_icloud_account: false }),
    });
    expect(sessionAccessors.icloudAccountSupported()).toBe(false);
  });

  it('is true only when the server advertises the capability', () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: '1.9.0', supports_icloud_account: true }),
    });
    expect(sessionAccessors.icloudAccountSupported()).toBe(true);
  });
});

describe('session transport-scoped server info', () => {
  it('rejects an A -> B -> A stale result, accepts the current revision, and clears info on hydration', () => {
    const originalInfo = ServerInfo.parse({ version: '1.0.0' });
    const rotatedInfo = ServerInfo.parse({ version: '2.0.0' });
    const returnedInfo = ServerInfo.parse({ version: '3.0.0' });
    const staleInfo = ServerInfo.parse({ version: 'stale' });
    const currentInfo = ServerInfo.parse({ version: 'current' });

    useSessionStore.getState().connected('https://a.example', 'password', originalInfo);
    const staleRevision = useSessionStore.getState().transportRevision;

    useSessionStore.getState().rotateOrigin('https://b.example', rotatedInfo);
    useSessionStore.getState().rotateOrigin('https://a.example', returnedInfo);
    const currentRevision = useSessionStore.getState().transportRevision;

    expect(
      useSessionStore
        .getState()
        .setServerInfoForTransport('https://a.example', staleRevision, staleInfo),
    ).toBe(false);
    expect(useSessionStore.getState().serverInfo).toBe(returnedInfo);

    expect(
      useSessionStore
        .getState()
        .setServerInfoForTransport('https://a.example', currentRevision, currentInfo),
    ).toBe(true);
    expect(useSessionStore.getState().serverInfo).toBe(currentInfo);

    useSessionStore.getState().hydrated({ origin: 'https://a.example', password: 'password' });
    expect(useSessionStore.getState().serverInfo).toBeNull();
  });
});
