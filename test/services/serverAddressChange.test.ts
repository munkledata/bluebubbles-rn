/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockApplyNewServerUrl = jest.fn<Promise<void>, [string]>(async () => undefined);
jest.mock('@/services/realtimeControl', () => ({
  applyNewServerUrl: (url: string) => mockApplyNewServerUrl(url),
}));

import { requestServerAddressChange } from '@/services/serverAddressChange';
import { serverRotationCoordinator } from '@/services/realtime/serverRotationCoordinator';
import { useSessionStore } from '@state/sessionStore';

const lease = { generation: 0, isCurrent: () => true };
const CURRENT_EPOCH = '11111111-1111-4111-8111-111111111111';
const knownServer = { serverInfo: { imessage_provider_epoch: CURRENT_EPOCH } as never };

// Review item 800: a missed or cancelled server-change prompt never came back, and the only other
// way to change the address was Disconnect, which deletes local data. Settings now offers a typed
// address through the same approval prompt.
describe('requestServerAddressChange', () => {
  const previous = useSessionStore.getState();

  beforeEach(() => {
    mockApplyNewServerUrl.mockReset();
    // Stand-in for realtimeControl: a connected foreground account offers the change.
    mockApplyNewServerUrl.mockImplementation(async (url) => {
      serverRotationCoordinator.offer(url, 'https://old.example', 1, lease, () => true);
    });
    useSessionStore.setState({ origin: 'https://old.example', ...knownServer });
  });

  afterEach(() => {
    serverRotationCoordinator.cancel();
    useSessionStore.setState(previous);
  });

  it('offers a typed address through the approval prompt, adding https:// like setup does', async () => {
    await expect(requestServerAddressChange('  new.example ')).resolves.toBe('offered');
    expect(mockApplyNewServerUrl).toHaveBeenCalledWith('https://new.example');
    expect(serverRotationCoordinator.getSnapshot()?.candidateOrigin).toBe('https://new.example');
  });

  it('explains instead of offering an unusable address', async () => {
    await expect(requestServerAddressChange('not a url')).resolves.toBe('invalid');
    await expect(requestServerAddressChange('https://old.example/')).resolves.toBe('same-address');
    await expect(requestServerAddressChange('http://insecure.example')).resolves.toBe(
      'insecure-downgrade',
    );
    expect(mockApplyNewServerUrl).not.toHaveBeenCalled();
  });

  // A typed address could reach a different Mac that accepts the same password. Only a server that
  // reports its Messages-database identity lets the prompt check that it is the same server.
  it('refuses when the current server cannot report its identity', async () => {
    useSessionStore.setState({ serverInfo: null });
    await expect(requestServerAddressChange('https://new.example')).resolves.toBe('unverifiable');
    expect(mockApplyNewServerUrl).not.toHaveBeenCalled();
  });

  it('reports when the change cannot be offered right now', async () => {
    mockApplyNewServerUrl.mockImplementation(async () => undefined);
    await expect(requestServerAddressChange('https://new.example')).resolves.toBe('unavailable');

    useSessionStore.setState({ origin: null });
    await expect(requestServerAddressChange('https://new.example')).resolves.toBe('unavailable');
  });
});
