const mockCaptureError = jest.fn();

jest.mock('@/services/errors/errorReportSink', () => ({ captureError: mockCaptureError }));

interface ErrorUtilsTestShape {
  getGlobalHandler?: () => ((error: unknown, isFatal?: boolean) => void) | undefined;
  setGlobalHandler?: (handler: (error: unknown, isFatal?: boolean) => void) => void;
}

interface HermesOptions {
  allRejections: boolean;
  onUnhandled?: (id: number, error: unknown) => void;
  onHandled?: (id: number) => void;
}

interface HandlerGlobals {
  ErrorUtils?: ErrorUtilsTestShape;
  HermesInternal?: { enablePromiseRejectionTracker?: (options: HermesOptions) => void };
}

function loadHandlers(): typeof import('@/services/errors/globalErrorHandlers') {
  // A fresh module gives each test fresh idempotency flags while keeping the capture mock stable.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/services/errors/globalErrorHandlers');
}

describe('global error-handler privacy boundary', () => {
  const globals = globalThis as unknown as HandlerGlobals;
  let priorErrorUtils: ErrorUtilsTestShape | undefined;
  let priorHermes: HandlerGlobals['HermesInternal'];

  beforeEach(() => {
    jest.resetModules();
    mockCaptureError.mockReset();
    priorErrorUtils = globals.ErrorUtils;
    priorHermes = globals.HermesInternal;
    delete globals.ErrorUtils;
    delete globals.HermesInternal;
  });

  afterEach(() => {
    jest.useRealTimers();
    globals.ErrorUtils = priorErrorUtils;
    globals.HermesInternal = priorHermes;
  });

  it('installs each hook once, preserves strict capture, and chains RN with a synthetic Error', () => {
    const previous = jest.fn();
    let installed: ((error: unknown, isFatal?: boolean) => void) | undefined;
    let rejectionOptions: HermesOptions | undefined;
    const setGlobalHandler = jest.fn((handler: (error: unknown, isFatal?: boolean) => void) => {
      installed = handler;
    });
    const enablePromiseRejectionTracker = jest.fn((options: HermesOptions) => {
      rejectionOptions = options;
    });
    globals.ErrorUtils = { getGlobalHandler: () => previous, setGlobalHandler };
    globals.HermesInternal = { enablePromiseRejectionTracker };
    const { installGlobalErrorHandlers } = loadHandlers();
    const raw = new TypeError('private response for alice@example.com');
    raw.stack = 'TypeError: private\n at AlicePassport.ts:3035550:199';

    installGlobalErrorHandlers();
    installGlobalErrorHandlers();
    installed?.(raw, true);
    rejectionOptions?.onUnhandled?.(7, raw);

    expect(setGlobalHandler).toHaveBeenCalledTimes(1);
    expect(enablePromiseRejectionTracker).toHaveBeenCalledTimes(1);
    expect(rejectionOptions?.allRejections).toBe(true);
    expect(mockCaptureError).toHaveBeenNthCalledWith(1, raw, 'fatal', { fatal: true });
    expect(mockCaptureError).toHaveBeenNthCalledWith(2, raw, 'unhandledRejection');
    expect(previous).toHaveBeenCalledTimes(1);
    const [safe, fatal] = previous.mock.calls[0] as [Error, boolean];
    expect(fatal).toBe(true);
    expect(safe).not.toBe(raw);
    expect(safe).toMatchObject({
      name: 'TypeError',
      message: 'runtime.fatal [TypeError]',
      stack: 'at gator.site.s9b2ygxnbx',
    });
    expect(
      JSON.stringify({ name: safe.name, message: safe.message, stack: safe.stack }),
    ).not.toMatch(/alice@example\.com|AlicePassport|3035550199|private response/);
  });

  it('does not skip Hermes and automatically retries a throwing ErrorUtils hook once', () => {
    jest.useFakeTimers();
    let installed: ((error: unknown, isFatal?: boolean) => void) | undefined;
    const setGlobalHandler: jest.MockedFunction<
      NonNullable<ErrorUtilsTestShape['setGlobalHandler']>
    > = jest.fn();
    setGlobalHandler
      .mockImplementationOnce(() => {
        throw new Error('transient native setup failure');
      })
      .mockImplementation((handler) => {
        installed = handler;
      });
    const enablePromiseRejectionTracker = jest.fn();
    globals.ErrorUtils = { setGlobalHandler };
    globals.HermesInternal = { enablePromiseRejectionTracker };
    const { installGlobalErrorHandlers } = loadHandlers();

    expect(() => installGlobalErrorHandlers()).not.toThrow();
    expect(installed).toBeUndefined();
    expect(setGlobalHandler).toHaveBeenCalledTimes(1);
    expect(enablePromiseRejectionTracker).toHaveBeenCalledTimes(1);

    jest.runOnlyPendingTimers();

    expect(setGlobalHandler).toHaveBeenCalledTimes(2);
    expect(enablePromiseRejectionTracker).toHaveBeenCalledTimes(1);
    expect(installed).toEqual(expect.any(Function));
  });

  it('does not skip ErrorUtils and never loops when the Hermes retry also throws', () => {
    jest.useFakeTimers();
    const setGlobalHandler = jest.fn();
    const enablePromiseRejectionTracker = jest.fn(() => {
      throw new Error('persistent native setup failure');
    });
    globals.ErrorUtils = { setGlobalHandler };
    globals.HermesInternal = { enablePromiseRejectionTracker };
    const { installGlobalErrorHandlers } = loadHandlers();

    expect(() => installGlobalErrorHandlers()).not.toThrow();
    expect(setGlobalHandler).toHaveBeenCalledTimes(1);
    expect(enablePromiseRejectionTracker).toHaveBeenCalledTimes(1);

    jest.runOnlyPendingTimers();
    jest.runOnlyPendingTimers();

    expect(setGlobalHandler).toHaveBeenCalledTimes(1);
    expect(enablePromiseRejectionTracker).toHaveBeenCalledTimes(2);
  });

  it('can install later when the RN globals were absent on the first call', () => {
    jest.useFakeTimers();
    const { installGlobalErrorHandlers } = loadHandlers();
    expect(() => installGlobalErrorHandlers()).not.toThrow();
    const setGlobalHandler = jest.fn();
    globals.ErrorUtils = { setGlobalHandler };

    // Absence is an ordinary headless/Jest condition, not a failed installation that starts a timer.
    jest.runOnlyPendingTimers();
    expect(setGlobalHandler).not.toHaveBeenCalled();

    installGlobalErrorHandlers();

    expect(setGlobalHandler).toHaveBeenCalledTimes(1);
  });

  it('keeps an independent one-retry budget for a hook that appears later', () => {
    jest.useFakeTimers();
    const setGlobalHandler = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('ErrorUtils first attempt failed');
      })
      .mockImplementation(() => undefined);
    globals.ErrorUtils = { setGlobalHandler };
    const { installGlobalErrorHandlers } = loadHandlers();

    installGlobalErrorHandlers();
    jest.runOnlyPendingTimers();
    expect(setGlobalHandler).toHaveBeenCalledTimes(2);

    const enablePromiseRejectionTracker = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('Hermes first attempt failed');
      })
      .mockImplementation(() => undefined);
    globals.HermesInternal = { enablePromiseRejectionTracker };

    installGlobalErrorHandlers();
    expect(enablePromiseRejectionTracker).toHaveBeenCalledTimes(1);
    jest.runOnlyPendingTimers();
    expect(enablePromiseRejectionTracker).toHaveBeenCalledTimes(2);
  });

  it('builds a safe non-fatal fallback without copying arbitrary thrown prose', () => {
    const { privacySafeGlobalError } = loadHandlers();
    const safe = privacySafeGlobalError('private account 3035550199', false);
    expect(safe).toMatchObject({
      name: 'GatorDiagnostic',
      message: 'runtime.uncaught',
      stack: 'at gator.site.sfdpe2gt2k',
    });
    expect(
      JSON.stringify({ name: safe.name, message: safe.message, stack: safe.stack }),
    ).not.toContain('3035550199');
  });
});
