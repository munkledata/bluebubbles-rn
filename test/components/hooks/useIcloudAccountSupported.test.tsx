/**
 * useIcloudAccountSupported (src/state/sessionStore.ts) — the reactive twin of the
 * `sessionAccessors.icloudAccountSupported` getter, for the `supports_icloud_account` capability
 * (iMessage-account F#8). The Settings "iMessage Account" row subscribes to this. Contract: false
 * until the connected server advertises the flag, and it re-renders live when serverInfo changes
 * (e.g. a reconnect to a Private-API-on server gains it).
 */
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import { ServerInfo } from '@core/models';
import { useIcloudAccountSupported, useSessionStore } from '@state/sessionStore';

describe('useIcloudAccountSupported', () => {
  beforeEach(() => useSessionStore.setState({ serverInfo: null }));

  it('starts false and flips true when the server advertises the capability', async () => {
    const { result } = await renderHook(() => useIcloudAccountSupported());
    expect(result.current).toBe(false);

    await act(async () => {
      useSessionStore.setState({
        serverInfo: ServerInfo.parse({ version: '1.9.0', supports_icloud_account: true }),
      });
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('stays false for a server that reports the capability false', async () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: '1.9.0', supports_icloud_account: false }),
    });
    const { result } = await renderHook(() => useIcloudAccountSupported());
    expect(result.current).toBe(false);
  });
});
