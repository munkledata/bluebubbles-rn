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
