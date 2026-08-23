import { useEffect } from 'react';
import { AppState, Modal, Text } from 'react-native';
import { fireEvent, screen, waitFor, within } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ForegroundLockGate } from '@features/lock/ForegroundLockGate';
import { authenticate } from '@native/biometrics';
import type { BootState } from '@/services/boot/bootStateMachine';
import { renderWithTheme } from './support/renderWithTheme';

jest.mock('@native/biometrics', () => ({ authenticate: jest.fn() }));
const mockAuthenticate = authenticate as jest.MockedFunction<typeof authenticate>;
const originalCurrentStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

const TEST_METRICS = {
  frame: { x: 0, y: 0, width: 400, height: 800 },
  insets: { top: 24, right: 0, bottom: 24, left: 0 },
};

function withSafeArea(child: React.JSX.Element): React.JSX.Element {
  return <SafeAreaProvider initialMetrics={TEST_METRICS}>{child}</SafeAreaProvider>;
}

const READY_BOOT: BootState = {
  status: 'ready',
  mode: 'connected',
  runId: 1,
  issues: [],
};

function gate(
  lockHydrated: boolean,
  locked: boolean,
  child: React.JSX.Element,
  bootState: BootState = READY_BOOT,
  callbacks: {
    onColdUnlock?: (runId: number) => void | Promise<void>;
    onWarmUnlock?: () => void | Promise<void>;
    onRetry?: (runId: number) => void | Promise<void>;
  } = {},
): React.JSX.Element {
  return withSafeArea(
    <ForegroundLockGate
      bootState={bootState}
      lockHydrated={lockHydrated}
      locked={locked}
      onColdUnlock={callbacks.onColdUnlock ?? jest.fn()}
      onWarmUnlock={callbacks.onWarmUnlock ?? jest.fn()}
      onRetry={callbacks.onRetry ?? jest.fn()}
    >
      {child}
    </ForegroundLockGate>,
  );
}

describe('ForegroundLockGate', () => {
  beforeEach(() => {
    Object.defineProperty(AppState, 'currentState', {
      configurable: true,
      value: 'active',
    });
    mockAuthenticate.mockReset().mockImplementation(() => new Promise<boolean>(() => undefined));
  });

  afterAll(() => {
    if (originalCurrentStateDescriptor) {
      Object.defineProperty(AppState, 'currentState', originalCurrentStateDescriptor);
    }
  });

  it('fails closed behind an opaque loading cover until the vault lock choice is known', async () => {
    await renderWithTheme(gate(false, false, <Text>Private route content</Text>));

    expect(screen.queryByText('Private route content')).toBeNull();
    const loading = screen.getByRole('progressbar', { name: 'Loading Gator' });
    expect(loading.props).toEqual(
      expect.objectContaining({
        accessibilityState: { busy: true },
      }),
    );
    expect(screen.queryByText('Gator is locked')).toBeNull();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('keeps route content unavailable and shows biometrics after a locked decision', async () => {
    await renderWithTheme(gate(true, true, <Text>Private route content</Text>));

    expect(screen.queryByText('Private route content')).toBeNull();
    expect(screen.getByText('Gator is locked')).toBeTruthy();
    expect(screen.queryByRole('progressbar', { name: 'Loading Gator' })).toBeNull();
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);
  });

  it('releases route content only after an unlocked decision', async () => {
    await renderWithTheme(gate(true, false, <Text>Private route content</Text>));

    expect(screen.getByText('Private route content')).toBeTruthy();
    expect(screen.queryByRole('progressbar', { name: 'Loading Gator' })).toBeNull();
    expect(screen.queryByText('Gator is locked')).toBeNull();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('unmounts protected content across unknown, unlocked, and warm-locked transitions', async () => {
    const onMount = jest.fn();
    const onUnmount = jest.fn();

    function ProtectedTree(): React.JSX.Element {
      useEffect(() => {
        onMount();
        return onUnmount;
      }, []);
      return <Text>Mounted private state</Text>;
    }

    const result = await renderWithTheme(gate(false, false, <ProtectedTree />));
    expect(onMount).not.toHaveBeenCalled();

    await result.rerender(gate(true, false, <ProtectedTree />));
    expect(screen.getByText('Mounted private state')).toBeTruthy();
    expect(onMount).toHaveBeenCalledTimes(1);

    await result.rerender(gate(true, true, <ProtectedTree />));
    expect(screen.queryByText('Mounted private state')).toBeNull();
    expect(onUnmount).toHaveBeenCalledTimes(1);
  });

  it('removes a protected native Modal before showing the warm-lock screen', async () => {
    const privateModal = (
      <Modal visible>
        <Text>Private modal content</Text>
      </Modal>
    );
    const result = await renderWithTheme(gate(true, false, privateModal));
    expect(screen.getByText('Private modal content')).toBeTruthy();

    await result.rerender(gate(true, true, privateModal));

    expect(screen.queryByText('Private modal content')).toBeNull();
    expect(screen.getByText('Gator is locked')).toBeTruthy();
  });

  it.each(['lock', 'session', 'database', 'settings', 'activate'] as const)(
    'keeps protected content unmounted while the %s stage is loading',
    async (stage) => {
      await renderWithTheme(
        gate(true, false, <Text>Private route content</Text>, {
          status: 'loading',
          stage,
          runId: 8,
          issues: [],
        }),
      );

      expect(screen.queryByText('Private route content')).toBeNull();
      expect(screen.getByRole('progressbar', { name: 'Loading Gator' })).toBeTruthy();
    },
  );

  it('resumes only the rendered cold-lock run after successful biometrics', async () => {
    mockAuthenticate.mockResolvedValueOnce(true);
    const onColdUnlock = jest.fn(async () => undefined);
    await renderWithTheme(
      gate(
        true,
        true,
        <Text>Private route content</Text>,
        { status: 'locked', runId: 41, issues: [] },
        { onColdUnlock },
      ),
    );

    await waitFor(() => expect(onColdUnlock).toHaveBeenCalledWith(41));
    expect(screen.queryByText('Private route content')).toBeNull();
  });

  it('shows safe retryable failure copy and retries the exact run', async () => {
    const onRetry = jest.fn();
    await renderWithTheme(
      gate(
        true,
        false,
        <Text>private-password-sentinel</Text>,
        {
          status: 'failed',
          runId: 12,
          issues: [],
          failure: {
            stage: 'database',
            kind: 'retryable',
            failClosed: false,
            code: 'database-open-failed',
            userMessage: 'Could not open local messages.',
          },
        },
        { onRetry },
      ),
    );

    const alert = screen.getByRole('alert', {
      name: 'Gator startup failed. Could not open local messages.',
    });
    expect(alert).toBeTruthy();
    expect(within(alert).queryByRole('button', { name: 'Try Again' })).toBeNull();
    expect(screen.getByText('Could not open local messages.')).toBeTruthy();
    expect(screen.queryByText('private-password-sentinel')).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Try Again' }));
    expect(onRetry).toHaveBeenCalledWith(12);
  });

  it('keeps a fatal failure gated without offering a dishonest retry', async () => {
    await renderWithTheme(
      gate(true, false, <Text>Private route content</Text>, {
        status: 'failed',
        runId: 3,
        issues: [],
        failure: {
          stage: 'lock',
          kind: 'fatal',
          failClosed: true,
          code: 'invalid-app-lock-setting',
          userMessage: 'The saved lock setting is invalid.',
        },
      }),
    );

    expect(screen.getByText('The saved lock setting is invalid.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Try Again' })).toBeNull();
    expect(screen.queryByText('Private route content')).toBeNull();
  });
});
