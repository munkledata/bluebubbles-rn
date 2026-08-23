/** IPC-01: the shortcut bridge is cleanup-only while inbound Android sharing is disabled. */
import { logger } from '@core/secure';

const native = {
  clearShareShortcuts: jest.fn(),
};
const moduleRef: { current: typeof native | null } = { current: native };

jest.mock('expo', () => ({
  requireOptionalNativeModule: () => moduleRef.current,
}));

// eslint-disable-next-line import/first
import { clearShareShortcuts } from '@/services/shortcuts/shareShortcuts';

describe('share shortcut cleanup-only bridge', () => {
  beforeEach(() => {
    moduleRef.current = native;
    native.clearShareShortcuts.mockReset();
  });

  it('clears persisted shortcuts through the one-way native API', () => {
    expect(clearShareShortcuts()).toBe(true);
    expect(native.clearShareShortcuts).toHaveBeenCalledTimes(1);
  });

  it('gives repeated cleanup attempts strictly increasing safe revisions', () => {
    expect(clearShareShortcuts()).toBe(true);
    expect(clearShareShortcuts()).toBe(true);
    const first = native.clearShareShortcuts.mock.calls[0]?.[0] as number;
    const second = native.clearShareShortcuts.mock.calls[1]?.[0] as number;
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(first).toBeLessThan(second);
  });

  it('returns false and logs when Android rejects the clear', () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    native.clearShareShortcuts.mockImplementationOnce(() => {
      throw new Error('system service unavailable');
    });

    expect(clearShareShortcuts()).toBe(false);
    expect(warn).toHaveBeenCalledWith('[shortcuts] clear failed: system service unavailable');
  });

  it('is a safe no-op on a build without the cleanup module', () => {
    moduleRef.current = null;
    expect(clearShareShortcuts()).toBe(false);
  });
});
