import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { act, fireEvent, renderWithTheme, screen, waitFor } from './support/renderWithTheme';

const mockApproveNewServerUrl = jest.fn();
const mockShowToast = jest.fn();
jest.mock('@/services/realtimeControl', () => ({
  approveNewServerUrl: (...args: unknown[]) => mockApproveNewServerUrl(...args),
}));
jest.mock('@ui/toast/toastStore', () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));
jest.mock('@ui/hooks/useReduceMotionPreference', () => ({
  useReduceMotionPreference: () => true,
}));

// Jest mocks must be registered before the component imports its service boundary.
/* eslint-disable import/first */
import { ServerRotationApprovalHost } from '@ui/server-rotation/ServerRotationApprovalHost';
import { serverRotationCoordinator } from '@/services/realtime/serverRotationCoordinator';
/* eslint-enable import/first */

type AppStateHandler = (state: AppStateStatus) => void;
let appStateHandler: AppStateHandler | null = null;
const originalCurrentStateDescriptor = Object.getOwnPropertyDescriptor(AppState, 'currentState');

const lease = { generation: 0, isCurrent: () => true };

function offer(
  candidateOrigin = 'https://next.example',
  currentOrigin = 'https://current.example',
): number {
  const result = serverRotationCoordinator.offer(
    candidateOrigin,
    currentOrigin,
    9,
    lease,
    () => true,
  );
  expect(result).toBe('offered');
  return serverRotationCoordinator.getSnapshot()!.id;
}

function approveButton(): ReturnType<typeof screen.getByRole> {
  return screen.getByRole('button', { name: 'Approve server change' });
}

function passwordInput(): ReturnType<typeof screen.getByPlaceholderText> {
  const input = screen.getByPlaceholderText('Re-enter current password');
  expect(input).toHaveAccessibleName('Server password');
  return input;
}

beforeEach(() => {
  jest.clearAllMocks();
  serverRotationCoordinator.cancel();
  appStateHandler = null;
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    value: 'active',
  });
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((
    _type,
    handler: AppStateHandler,
  ) => {
    appStateHandler = handler;
    return { remove: jest.fn() };
  }) as typeof AppState.addEventListener);
  mockApproveNewServerUrl.mockResolvedValue({ ok: true });
});

afterEach(() => {
  serverRotationCoordinator.cancel();
  jest.restoreAllMocks();
  if (originalCurrentStateDescriptor) {
    Object.defineProperty(AppState, 'currentState', originalCurrentStateDescriptor);
  }
});

describe('ServerRotationApprovalHost', () => {
  it('renders only a canonical non-secret proposal and keeps approval disabled initially', async () => {
    offer();
    const view = await renderWithTheme(<ServerRotationApprovalHost />);

    expect(screen.getByText('Approve server change?')).toBeTruthy();
    expect(screen.getByText('https://current.example')).toBeTruthy();
    expect(screen.getByText('https://next.example')).toBeTruthy();
    expect(passwordInput().props.value).toBe('');
    expect(approveButton().props.accessibilityState).toEqual({ disabled: true, busy: false });
    expect(JSON.stringify(view.toJSON())).not.toContain('correct-password');
  });

  it('requires a fresh password and shows a retryable validation error without retaining it', async () => {
    const requestId = offer();
    mockApproveNewServerUrl.mockResolvedValue({
      ok: false,
      kind: 'validation-failed',
      message: 'Could not validate that server.',
      terminal: false,
    });
    const view = await renderWithTheme(<ServerRotationApprovalHost />);

    await fireEvent.changeText(passwordInput(), 'fresh-password');
    expect(approveButton().props.accessibilityState.disabled).toBe(false);
    await fireEvent.press(approveButton());

    expect(mockApproveNewServerUrl).toHaveBeenCalledWith(requestId, 'fresh-password', false);
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not validate that server.');
    expect(passwordInput().props.value).toBe('');
    expect(JSON.stringify(view.toJSON())).not.toContain('fresh-password');
  });

  it('requires the separate cleartext switch for an already-cleartext session', async () => {
    offer('http://next.lan:1234', 'http://current.lan:1234');
    await renderWithTheme(<ServerRotationApprovalHost />);

    await fireEvent.changeText(passwordInput(), 'fresh-password');
    expect(approveButton().props.accessibilityState.disabled).toBe(true);
    await act(async () => {
      fireEvent(
        screen.getByRole('switch', { name: 'Allow insecure server change' }),
        'valueChange',
        true,
      );
    });
    expect(approveButton().props.accessibilityState.disabled).toBe(false);
    expect(screen.getByText(/does not encrypt your password or messages/)).toBeTruthy();
  });

  // Review item 800: a stray tap beside the card cancelled the change, and a lost prompt never came
  // back. Only the explicit Cancel button or Android Back may cancel.
  it('ignores taps outside the card', async () => {
    offer();
    await renderWithTheme(<ServerRotationApprovalHost />);
    expect(screen.getByText('Approve server change?')).toBeTruthy();

    // Every pressable host element that is not one of the two labelled buttons.
    type HostNode = { props: Record<string, unknown>; children: Array<HostNode | string> };
    const stray: HostNode[] = [];
    const collect = (node: HostNode): void => {
      const role = node.props.accessibilityRole ?? node.props.role;
      if (typeof node.props.onClick === 'function' && role !== 'button') stray.push(node);
      for (const child of node.children) if (typeof child !== 'string') collect(child);
    };
    collect(screen.root as unknown as HostNode);
    for (const node of stray) await fireEvent.press(node as never);

    expect(serverRotationCoordinator.getSnapshot()).not.toBeNull();
    expect(screen.getByText('Approve server change?')).toBeTruthy();
  });

  // A long or QR-provided password used to mean leaving Gator to copy it, which cancels the prompt.
  it('lets a password manager fill the password in place', async () => {
    offer();
    await renderWithTheme(<ServerRotationApprovalHost />);

    expect(passwordInput().props.autoComplete).toBe('password');
    expect(passwordInput().props.importantForAutofill).toBe('yes');
  });

  it('treats Android Back as cancellation and clears the local password', async () => {
    offer();
    const view = await renderWithTheme(<ServerRotationApprovalHost />);
    await fireEvent.changeText(passwordInput(), 'fresh-password');

    const root = screen.root;
    if (!root) throw new Error('Expected the server-change modal to be mounted');
    fireEvent(root, 'requestClose');

    await waitFor(() => expect(screen.queryByText('Approve server change?')).toBeNull());
    expect(serverRotationCoordinator.getSnapshot()).toBeNull();
    expect(mockApproveNewServerUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(view.toJSON())).not.toContain('fresh-password');
  });

  it('revokes the prompt and local password when the app loses foreground authority', async () => {
    offer();
    const view = await renderWithTheme(<ServerRotationApprovalHost />);
    await fireEvent.changeText(passwordInput(), 'fresh-password');

    await act(async () => {
      appStateHandler?.('background');
    });

    expect(screen.queryByText('Approve server change?')).toBeNull();
    expect(serverRotationCoordinator.getSnapshot()).toBeNull();
    expect(JSON.stringify(view.toJSON())).not.toContain('fresh-password');
  });

  it('reports success only after the approval operation resolves', async () => {
    const requestId = offer();
    mockApproveNewServerUrl.mockImplementation(async (id: number) => {
      expect(id).toBe(requestId);
      serverRotationCoordinator.claim(id);
      return { ok: true };
    });
    await renderWithTheme(<ServerRotationApprovalHost />);
    await fireEvent.changeText(passwordInput(), 'fresh-password');

    await fireEvent.press(approveButton());

    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Server connection updated.'));
    expect(screen.queryByText('Approve server change?')).toBeNull();
  });
});
