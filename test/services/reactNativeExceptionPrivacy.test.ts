import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  installReactNativeExceptionPrivacyBoundary,
  projectReactNativeExceptionData,
  type ReactNativeExceptionData,
} from '@/services/errors/reactNativeExceptionPrivacy';

const rawCanaries = [
  'alice@example.com',
  '+13035550199',
  'https://private.example.test/path?password=secret',
  '/Users/alice/private-message.tsx',
  'raw-body-canary',
];

function rawExceptionData(overrides: ReactNativeExceptionData = {}): ReactNativeExceptionData {
  return {
    message: `TypeError: ${rawCanaries[0]}`,
    originalMessage: rawCanaries[1],
    name: 'TypeError',
    componentStack: `\n at SecretMessage (${rawCanaries[3]}:12:34)`,
    stack: [
      {
        file: rawCanaries[3],
        methodName: rawCanaries[4],
        lineNumber: 12,
        column: 34,
      },
    ],
    id: 42,
    isFatal: false,
    extraData: {
      rawStack: rawCanaries[2],
      cause: { stackSymbols: rawCanaries[4] },
    },
    ...overrides,
  };
}

function expectNoCanaries(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const canary of rawCanaries) expect(serialized).not.toContain(canary);
}

describe('React Native exception privacy boundary', () => {
  it('reconstructs caught renderer data with an exact finite shape', () => {
    const safe = projectReactNativeExceptionData(rawExceptionData());

    expect(Object.keys(safe)).toEqual([
      'message',
      'originalMessage',
      'name',
      'componentStack',
      'stack',
      'id',
      'isFatal',
      'extraData',
    ]);
    expect(safe).toEqual({
      message: 'ui.render_crash [TypeError]',
      originalMessage: null,
      name: 'TypeError',
      componentStack: null,
      stack: [
        {
          file: '0.js',
          methodName: 'gator.ui.render_crash',
          lineNumber: 0,
          column: 0,
        },
      ],
      id: 42,
      isFatal: false,
      extraData: { schemaVersion: 1 },
    });
    expectNoCanaries(safe);
  });

  it('preserves fatal behavior and only an allowlisted error class', () => {
    expect(
      projectReactNativeExceptionData(
        rawExceptionData({ isFatal: true, name: 'PrivateAccountError' }),
      ),
    ).toMatchObject({
      message: 'runtime.fatal [UnknownError]',
      name: 'UnknownError',
      id: 42,
      isFatal: true,
      originalMessage: null,
      componentStack: null,
      extraData: { schemaVersion: 1 },
    });
  });

  it('is total for hostile native data instead of falling back to the raw payload', () => {
    const hostile = new Proxy(
      {},
      {
        get: () => {
          throw new Error(rawCanaries[4]);
        },
      },
    );

    const safe = projectReactNativeExceptionData(hostile);

    expect(safe).toMatchObject({
      message: 'runtime.uncaught',
      originalMessage: null,
      componentStack: null,
      id: 0,
      isFatal: false,
    });
    expectNoCanaries(safe);
  });

  it('installs once and keeps every release console output finite', () => {
    let decorate: ((data: ReactNativeExceptionData) => ReactNativeExceptionData) | undefined;
    const exceptionsManager = {
      unstable_setExceptionDecorator: jest.fn(
        (next: (data: ReactNativeExceptionData) => ReactNativeExceptionData) => {
          decorate = next;
        },
      ),
    };
    const originalError = jest.fn();
    const originalWarn = jest.fn();
    const suppressed = jest.fn();
    const runtimeConsole = {
      error: originalError,
      warn: originalWarn,
      log: suppressed,
      info: suppressed,
      debug: suppressed,
      trace: suppressed,
      dir: suppressed,
      table: suppressed,
      assert: suppressed,
      time: suppressed,
      timeEnd: suppressed,
      count: suppressed,
      countReset: suppressed,
      createTask: jest.fn(() => ({ run: jest.fn() })),
    };

    installReactNativeExceptionPrivacyBoundary({
      exceptionsManager,
      runtimeConsole,
      release: true,
    });
    installReactNativeExceptionPrivacyBoundary({
      exceptionsManager,
      runtimeConsole,
      release: true,
    });

    expect(exceptionsManager.unstable_setExceptionDecorator).toHaveBeenCalledTimes(1);
    expect(decorate?.(rawExceptionData())).toEqual(
      projectReactNativeExceptionData(rawExceptionData()),
    );

    runtimeConsole.error(new TypeError(rawCanaries[0]));
    runtimeConsole.warn(new Error(rawCanaries[1]));
    runtimeConsole.error(`Warning: ${rawCanaries[4]}`);
    runtimeConsole.log(rawCanaries[0]);
    runtimeConsole.table({ private: rawCanaries[1] });
    runtimeConsole.assert(false, rawCanaries[2]);

    expect(originalError).toHaveBeenCalledTimes(2);
    expect(originalError.mock.calls[0]?.[0]).toBe('runtime.uncaught [TypeError]');
    expect(originalError.mock.calls[1]?.[0]).toBe('Warning: diagnostic.unclassified');
    expect(originalWarn).toHaveBeenCalledTimes(1);
    expect(originalWarn.mock.calls[0]?.[0]).toBe('runtime.recoverable [Error]');
    expect(suppressed).not.toHaveBeenCalled();
    expect(runtimeConsole.createTask).toEqual(expect.any(Function));
    expectNoCanaries({ error: originalError.mock.calls, warn: originalWarn.mock.calls });
  });

  it('never lets a failing native console interrupt exception reporting', () => {
    const decorator = jest.fn();
    const runtimeConsole = {
      error: (..._values: unknown[]) => {
        throw new Error(rawCanaries[0]);
      },
      warn: (..._values: unknown[]) => {
        throw new Error(rawCanaries[1]);
      },
    };
    installReactNativeExceptionPrivacyBoundary({
      exceptionsManager: { unstable_setExceptionDecorator: decorator },
      runtimeConsole,
      release: true,
    });

    expect(() => runtimeConsole.error(new Error(rawCanaries[4]))).not.toThrow();
    expect(() => runtimeConsole.warn(new Error(rawCanaries[4]))).not.toThrow();
    expect(decorator).toHaveBeenCalledTimes(1);
  });

  it('leaves full developer diagnostics untouched outside release', () => {
    const originalError = jest.fn();
    const runtimeConsole = { error: originalError, warn: jest.fn(), log: jest.fn() };
    const decorator = jest.fn();

    installReactNativeExceptionPrivacyBoundary({
      exceptionsManager: { unstable_setExceptionDecorator: decorator },
      runtimeConsole,
      release: false,
    });
    runtimeConsole.error(rawCanaries[0]);

    expect(originalError).toHaveBeenCalledWith(rawCanaries[0]);
    expect(decorator).not.toHaveBeenCalled();
  });

  it('pins the RN 0.86 seam and installs it as the first bundle side effect', () => {
    const root = path.resolve(__dirname, '../..');
    const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const exceptionsSource = readFileSync(
      path.join(root, 'node_modules/react-native/Libraries/Core/ExceptionsManager.js'),
      'utf8',
    );
    const rendererSource = readFileSync(
      path.join(root, 'node_modules/react-native/Libraries/ReactNative/RendererImplementation.js'),
      'utf8',
    );
    const entryImports = [
      ...readFileSync(path.join(root, 'index.js'), 'utf8').matchAll(
        /^\s*import\s+['"]([^'"]+)['"];?\s*$/gm,
      ),
    ].map((match) => match[1]);

    expect(packageJson.dependencies?.['react-native']).toBe('0.86.2');
    expect(exceptionsSource).toContain('return userExceptionDecorator(data);');
    expect(exceptionsSource.indexOf('const data = preprocessException({')).toBeLessThan(
      exceptionsSource.indexOf('NativeExceptionsManager.reportException(data);'),
    );
    expect(rendererSource).toContain('onCaughtError,');
    expect(rendererSource).toContain('onUncaughtError,');
    expect(rendererSource).toContain('onRecoverableError,');
    expect(entryImports[0]).toBe('./src/services/errors/registerReactNativeExceptionPrivacy');
    expect(entryImports.at(-1)).toBe('expo-router/entry');
  });
});
