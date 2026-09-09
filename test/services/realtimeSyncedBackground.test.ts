/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockInspectBackgroundSession = jest.fn<Promise<unknown>, []>();
const mockFixedCredentialClient = jest.fn<unknown, [string, string, (() => boolean)?]>();
const mockPinTransport = jest.fn<unknown, []>();
let mockAccountCurrent = true;
let mockMarkerState: 'clear' | 'revoked' | 'unavailable' = 'clear';
let mockPinnedCurrent = true;
let mockFixedCurrentGuard: (() => boolean) | undefined;
let mockSession = {
  status: 'loading',
  origin: null as string | null,
  password: null as string | null,
  transportRevision: 0,
};

const mockPinnedHttp = {
  snapshotTransport: jest.fn(() => ({
    origin: mockSession.origin ?? '',
    password: mockSession.password ?? undefined,
    transportRevision: mockSession.transportRevision,
  })),
  isTransportCurrent: jest.fn(() => mockPinnedCurrent),
};
const mockFixedHttp = {
  isTransportCurrent: jest.fn(() => mockFixedCurrentGuard?.() ?? true),
};

jest.mock('@core/secure', () => ({
  readAccountRevocationState: jest.fn(() => mockMarkerState),
}));
jest.mock('@state/sessionStore', () => ({
  useSessionStore: { getState: () => mockSession },
}));
jest.mock('@/services/background/backgroundSyncOrchestrator', () => ({
  inspectBackgroundSession: mockInspectBackgroundSession,
}));
jest.mock('@/services/clients', () => ({
  accountRevocationMarker: {},
  vault: {},
  http: { pinTransport: mockPinTransport },
  fixedCredentialClient: mockFixedCredentialClient,
}));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: jest.fn(() => ({
    generation: 73,
    isCurrent: () => mockAccountCurrent,
  })),
}));
import { resolveAuthorizedRealtimeTransport } from '@/services/background/authorizedRealtimeTransport';

describe('authorized realtime transport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccountCurrent = true;
    mockMarkerState = 'clear';
    mockPinnedCurrent = true;
    mockFixedCurrentGuard = undefined;
    mockSession = {
      status: 'loading',
      origin: null,
      password: null,
      transportRevision: 0,
    };
    mockPinTransport.mockReturnValue(mockPinnedHttp);
    mockFixedCredentialClient.mockImplementation(
      (_origin: string, _password: string, isCurrent?: () => boolean) => {
        mockFixedCurrentGuard = isCurrent;
        return mockFixedHttp;
      },
    );
  });

  it('rejects detached work from a replaced account generation', async () => {
    await expect(resolveAuthorizedRealtimeTransport(72)).resolves.toBeUndefined();
    expect(mockPinTransport).not.toHaveBeenCalled();
    expect(mockInspectBackgroundSession).not.toHaveBeenCalled();
  });

  it('pins the exact connected foreground transport and revokes it on rotation', async () => {
    mockSession = {
      status: 'connected',
      origin: 'https://warm.example',
      password: 'warm-password',
      transportRevision: 9,
    };
    const transport = await resolveAuthorizedRealtimeTransport(73);

    expect(mockInspectBackgroundSession).not.toHaveBeenCalled();
    expect(transport?.http).toBe(mockPinnedHttp);
    const lease = transport?.lease;
    if (!lease) throw new Error('warm transport was not resolved');
    expect(lease.isCurrent()).toBe(true);
    mockSession = { ...mockSession, transportRevision: 10 };
    expect(lease.isCurrent()).toBe(false);
  });

  it('uses the authorized durable tuple in a fresh process and revokes it fail-closed', async () => {
    mockInspectBackgroundSession.mockResolvedValue({
      kind: 'ready',
      session: { origin: 'https://cold.example', password: 'cold-password' },
    });
    const transport = await resolveAuthorizedRealtimeTransport(73);

    expect(mockFixedCredentialClient).toHaveBeenCalledWith(
      'https://cold.example',
      'cold-password',
      expect.any(Function),
    );
    expect(transport?.http).toBe(mockFixedHttp);
    const lease = transport?.lease;
    if (!lease) throw new Error('cold transport was not resolved');
    expect(lease.isCurrent()).toBe(true);
    mockMarkerState = 'revoked';
    expect(lease.isCurrent()).toBe(false);
    expect(mockFixedHttp.isTransportCurrent()).toBe(false);
  });
});
