/**
 * Root/jailbreak advisory wiring. The real jail-monkey is a native module Jest can't
 * load; we mock it to verify the advisory logic (compromised when jailbroken OR
 * mock-location, and a safe default when the module isn't linked / throws).
 */
let mockJailBroken = false;
let mockMockLocation = false;
let mockThrows = false;

jest.mock('jail-monkey', () => ({
  __esModule: true,
  default: {
    isJailBroken: () => {
      if (mockThrows) throw new Error('native module not linked');
      return mockJailBroken;
    },
    canMockLocation: () => mockMockLocation,
    trustFall: () => false,
  },
}));

import { checkDeviceIntegrity } from '@native/deviceIntegrity';

describe('checkDeviceIntegrity', () => {
  beforeEach(() => {
    mockJailBroken = false;
    mockMockLocation = false;
    mockThrows = false;
  });

  it('flags a jailbroken device', async () => {
    mockJailBroken = true;
    expect(await checkDeviceIntegrity()).toEqual({ compromised: true });
  });

  it('flags mock-location capability', async () => {
    mockMockLocation = true;
    expect(await checkDeviceIntegrity()).toEqual({ compromised: true });
  });

  it('reports clean on a normal device', async () => {
    expect(await checkDeviceIntegrity()).toEqual({ compromised: false });
  });

  it('degrades to clean (never throws) when the native module is missing', async () => {
    mockThrows = true;
    await expect(checkDeviceIntegrity()).resolves.toEqual({ compromised: false });
  });
});
