/** The helper-backed iMessage-account capability is permanently false in this release. */
import { renderHook } from '../support/renderWithTheme';
import { useIcloudAccountSupported, useSessionStore } from '@state/sessionStore';

describe('useIcloudAccountSupported', () => {
  beforeEach(() => useSessionStore.setState({ serverInfo: null }));

  it('stays false when legacy capability flags are injected directly', async () => {
    useSessionStore.setState({
      serverInfo: {
        version: 'legacy',
        private_api: true,
        supports_icloud_account: true,
      } as never,
    });
    const { result } = await renderHook(() => useIcloudAccountSupported());

    expect(result.current).toBe(false);
  });

  it('is false without server information', async () => {
    const { result } = await renderHook(() => useIcloudAccountSupported());

    expect(result.current).toBe(false);
  });
});
