import {
  ERROR_DIAGNOSTIC_SITES,
  isVerboseLocalLoggingEnabled,
  projectCapturedErrorDiagnostic,
} from '@core/secure';

/** The exact fields React Native 0.86 passes to its native ExceptionsManager module. */
export interface ReactNativeExceptionData {
  message?: unknown;
  originalMessage?: unknown;
  name?: unknown;
  componentStack?: unknown;
  stack?: unknown;
  id?: unknown;
  isFatal?: unknown;
  extraData?: unknown;
  [key: string]: unknown;
}

interface ReactNativeExceptionsManager {
  unstable_setExceptionDecorator(
    decorator: (data: ReactNativeExceptionData) => ReactNativeExceptionData,
  ): void;
}

interface MutableRuntimeConsole {
  error: (...values: unknown[]) => unknown;
  warn: (...values: unknown[]) => unknown;
}

interface InstallOptions {
  /** Tests inject the exact RN seam; production resolves the pinned RN 0.86 implementation. */
  exceptionsManager?: ReactNativeExceptionsManager;
  runtimeConsole?: MutableRuntimeConsole;
  release?: boolean;
}

const OUTPUT_METHODS_TO_SUPPRESS = [
  'assert',
  'clear',
  'count',
  'countReset',
  'debug',
  'dir',
  'dirxml',
  'group',
  'groupCollapsed',
  'groupEnd',
  'info',
  'log',
  'profile',
  'profileEnd',
  'table',
  'time',
  'timeEnd',
  'timeLog',
  'timeStamp',
  'trace',
] as const;

const installedManagers = new WeakSet<object>();
const installedConsoles = new WeakSet<object>();

function read(value: unknown, key: string): unknown {
  try {
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
      return undefined;
    }
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function safeExceptionId(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value < 2 ** 31
    ? value
    : 0;
}

/**
 * Rebuild React Native's exception payload immediately before it crosses the native bridge.
 *
 * This function is intentionally total (it never throws) because RN silently falls back to the
 * original raw payload when an exception decorator throws. No input object is spread or retained.
 */
export function projectReactNativeExceptionData(data: unknown): ReactNativeExceptionData {
  const isFatal = read(data, 'isFatal') === true;
  const id = safeExceptionId(read(data, 'id'));
  try {
    const componentStack = read(data, 'componentStack');
    const event = isFatal
      ? '[fatal] runtime error'
      : typeof componentStack === 'string'
        ? '[ErrorBoundary] render crash'
        : '[uncaught] runtime error';
    const site = isFatal
      ? ERROR_DIAGNOSTIC_SITES.runtimeFatal
      : typeof componentStack === 'string'
        ? ERROR_DIAGNOSTIC_SITES.uiRender
        : ERROR_DIAGNOSTIC_SITES.runtimeUncaught;
    const diagnostic = projectCapturedErrorDiagnostic(
      event,
      {
        errorName: read(data, 'name'),
      },
      site,
    );

    return {
      message: diagnostic.message,
      originalMessage: null,
      name: diagnostic.meta.errorName ?? 'GatorDiagnostic',
      componentStack: null,
      stack:
        diagnostic.stack === undefined
          ? []
          : [
              {
                file: '0.js',
                methodName: diagnostic.stack.slice(3),
                lineNumber: 0,
                column: 0,
              },
            ],
      id,
      isFatal,
      extraData: { schemaVersion: 1 },
    };
  } catch {
    return {
      message: 'diagnostic.unclassified',
      originalMessage: null,
      name: 'GatorDiagnostic',
      componentStack: null,
      stack: [],
      id,
      isFatal,
      extraData: { schemaVersion: 1 },
    };
  }
}

function projectedConsoleArguments(
  values: unknown[],
  fallbackEvent: '[recoverable] runtime warning' | '[uncaught] runtime error',
): [string, Record<string, unknown>] {
  try {
    const first = values[0];
    const isReactWarning = typeof first === 'string' && first.startsWith('Warning: ');
    const diagnostic = projectCapturedErrorDiagnostic(
      typeof first === 'string' ? first : fallbackEvent,
      typeof first === 'string' ? values[1] : first,
      fallbackEvent === '[recoverable] runtime warning'
        ? ERROR_DIAGNOSTIC_SITES.runtimeRecoverable
        : ERROR_DIAGNOSTIC_SITES.runtimeUncaught,
    );
    return [
      isReactWarning ? `Warning: ${diagnostic.message}` : diagnostic.message,
      {
        ...diagnostic.meta,
        ...(diagnostic.stack === undefined ? {} : { stack: diagnostic.stack }),
      },
    ];
  } catch {
    return ['diagnostic.unclassified', { schemaVersion: 1 }];
  }
}

/** Drop arbitrary release console data and forward only finite ERROR/WARN diagnostics. */
function installReleaseConsoleBoundary(runtimeConsole: MutableRuntimeConsole): void {
  if (installedConsoles.has(runtimeConsole)) return;

  let originalError: (...values: unknown[]) => unknown;
  let originalWarn: (...values: unknown[]) => unknown;
  try {
    originalError = runtimeConsole.error;
    originalWarn = runtimeConsole.warn;
    if (typeof originalError !== 'function' || typeof originalWarn !== 'function') {
      throw new Error('missing console methods');
    }

    runtimeConsole.error = (...values: unknown[]): void => {
      const safe = projectedConsoleArguments(values, '[uncaught] runtime error');
      try {
        Reflect.apply(originalError, runtimeConsole, safe);
      } catch {}
    };
    runtimeConsole.warn = (...values: unknown[]): void => {
      const safe = projectedConsoleArguments(values, '[recoverable] runtime warning');
      try {
        Reflect.apply(originalWarn, runtimeConsole, safe);
      } catch {}
    };
    const outputMethods = runtimeConsole as unknown as Record<string, unknown>;
    for (const method of OUTPUT_METHODS_TO_SUPPRESS) {
      if (typeof outputMethods[method] === 'function') {
        outputMethods[method] = (): void => {};
      }
    }
  } catch {
    throw new Error('react-native-console-privacy-boundary-unavailable');
  }

  installedConsoles.add(runtimeConsole);
}

function loadExceptionsManager(): ReactNativeExceptionsManager {
  try {
    // RN 0.86 exposes this internal seam and the exact version is pinned in package.json. The
    // source/build guard fails upgrades if the seam or its pre-native placement moves.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require('react-native/Libraries/Core/ExceptionsManager') as {
      default?: ReactNativeExceptionsManager;
    } & ReactNativeExceptionsManager;
    const manager = loaded.default ?? loaded;
    if (typeof manager.unstable_setExceptionDecorator !== 'function') throw new Error('missing');
    return manager;
  } catch {
    throw new Error('react-native-exception-privacy-boundary-unavailable');
  }
}

/**
 * Install the release-only RN renderer/native exception boundary before the first app render.
 * Development keeps React Native's full RedBox stacks; release keeps fatal behavior but sends only
 * the finite payload from {@link projectReactNativeExceptionData} to native/logcat.
 */
export function installReactNativeExceptionPrivacyBoundary(options: InstallOptions = {}): void {
  const release = options.release ?? !isVerboseLocalLoggingEnabled();
  if (!release) return;

  const runtimeConsole = options.runtimeConsole ?? (console as unknown as MutableRuntimeConsole);
  installReleaseConsoleBoundary(runtimeConsole);

  const manager = options.exceptionsManager ?? loadExceptionsManager();
  if (installedManagers.has(manager)) return;
  try {
    manager.unstable_setExceptionDecorator(projectReactNativeExceptionData);
  } catch {
    throw new Error('react-native-exception-privacy-boundary-unavailable');
  }
  installedManagers.add(manager);
}
