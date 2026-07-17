/**
 * useMessageDeletedSupported (src/state/sessionStore.ts) — the reactive twin of the
 * `sessionAccessors.messageDeletedSupported` getter, for the `supports_message_deleted` capability
 * (schema gap 6). Locked-in contract: false until the connected server advertises the flag, and it
 * re-renders live when the session store's serverInfo changes (e.g. a reconnect that gains/loses it).
 */
import { renderHook, act, waitFor } from '../support/renderWithTheme';
import { ServerInfo } from '@core/models';
import { useMessageDeletedSupported, useSessionStore } from '@state/sessionStore';

describe('useMessageDeletedSupported', () => {
  beforeEach(() => useSessionStore.setState({ serverInfo: null }));

  it('starts false and flips true when the server advertises the capability', async () => {
    const { result } = await renderHook(() => useMessageDeletedSupported());
    expect(result.current).toBe(false);

    await act(async () => {
      useSessionStore.setState({
        serverInfo: ServerInfo.parse({ version: '1.9.0', supports_message_deleted: true }),
      });
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('stays false for a server that reports the capability false', async () => {
    useSessionStore.setState({
      serverInfo: ServerInfo.parse({ version: '1.9.0', supports_message_deleted: false }),
    });
    const { result } = await renderHook(() => useMessageDeletedSupported());
    expect(result.current).toBe(false);
  });
});
