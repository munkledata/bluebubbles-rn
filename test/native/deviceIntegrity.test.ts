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
import { logger } from '@core/secure';

describe('checkDeviceIntegrity', () => {
  beforeEach(() => {
    mockJailBroken = false;
    mockMockLocation = false;
    mockThrows = false;
  });

  it('flags a jailbroken device', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    mockJailBroken = true;
    expect(await checkDeviceIntegrity()).toEqual({ compromised: true });
    expect(warn).toHaveBeenCalledWith(
      '[security] device appears rooted/compromised — at-rest secrets are at higher risk',
    );
    warn.mockRestore();
  });

  it('flags mock-location capability', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    mockMockLocation = true;
    expect(await checkDeviceIntegrity()).toEqual({ compromised: true });
    expect(warn).toHaveBeenCalledWith(
      '[security] device appears rooted/compromised — at-rest secrets are at higher risk',
    );
    warn.mockRestore();
  });

  it('reports clean on a normal device', async () => {
    expect(await checkDeviceIntegrity()).toEqual({ compromised: false });
  });

  it('degrades to clean (never throws) when the native module is missing', async () => {
    mockThrows = true;
    await expect(checkDeviceIntegrity()).resolves.toEqual({ compromised: false });
  });
});
