import React from 'react';
import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderWithTheme, screen, fireEvent, act, waitFor } from '../support/renderWithTheme';

const mockBack = jest.fn();

jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('@/services', () => ({
  http: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('ky', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@core/api/endpoints/server', () => ({
  ...jest.requireActual('@core/api/endpoints/server'),
  imessageAccountStatus: jest.fn(),
  changeImessageActiveAlias: jest.fn(),
}));

// eslint-disable-next-line import/first
import AccountScreen from '../../../app/(app)/account';
// eslint-disable-next-line import/first
import { serverApi } from '@core/api';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

const accountStatus = serverApi.imessageAccountStatus as jest.Mock;
const changeAlias = serverApi.changeImessageActiveAlias as jest.Mock;
const account = {
  appleId: 'account-a@example.test',
  displayName: 'Account A',
  activeAlias: 'alias-a@example.test',
  aliases: ['alias-a@example.test'],
  vettedAliases: ['alias-a@example.test'],
  loginStatusMessage: null,
};

async function renderScreen(): Promise<void> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  await renderWithTheme(
    <QueryClientProvider client={client}>
      <AccountScreen />
    </QueryClientProvider>,
  );
}

// TanStack delivers observers synchronously through this adapter, including during
// waitFor's temporary act-environment override. Scope the flag to that delivery.
beforeAll(() =>
  notifyManager.setNotifyFunction((callback) => {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = true;
    try {
      React.act(callback);
    } finally {
      environment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
  }),
);
afterAll(() => notifyManager.setNotifyFunction((callback) => callback()));

describe('AccountScreen — narrow read-only status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useDialogStore.getState().reset();
    useSessionStore.setState({
      transportRevision: 1,
      serverInfo: {
        version: 'legacy',
        private_api: true,
        supports_icloud_account: true,
      } as never,
    });
  });
  afterEach(() => resumeRealtimeDeliveries());

  it('does not read for a retired legacy flag alone', async () => {
    await renderScreen();

    expect(screen.getByText(/unavailable on this server/i)).toBeTruthy();
    expect(screen.queryByText('Apple ID')).toBeNull();
    expect(accountStatus).not.toHaveBeenCalled();
  });

  it('shows the signed-in identity and aliases without an edit action', async () => {
    useSessionStore.setState({
      serverInfo: { version: '2.0.15', supports_imessage_account_status: true },
    });
    accountStatus
      .mockResolvedValueOnce(account)
      .mockResolvedValue({ ...account, displayName: 'Account A refreshed' });
    await renderScreen();

    expect(await screen.findByText('account-a@example.test')).toBeTruthy();
    expect(screen.getByText('Enabled aliases: alias-a@example.test')).toBeTruthy();
    expect(screen.getByText(/Changing the send-from alias is not available/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /change alias/i })).toBeNull();
    expect(accountStatus).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByRole('button', { name: 'Refresh iMessage account' }));
    expect(await screen.findByText('Account A refreshed')).toBeTruthy();
    expect(accountStatus).toHaveBeenCalledTimes(2);
  });

  it('hides identity immediately when the owning account is retired', async () => {
    useSessionStore.setState({
      serverInfo: { version: '2.0.15', supports_imessage_account_status: true },
    });
    accountStatus.mockResolvedValue(account);
    await renderScreen();
    expect(await screen.findByText('account-a@example.test')).toBeTruthy();

    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    await waitFor(() => expect(screen.queryByText('account-a@example.test')).toBeNull());
    expect(screen.getByText(/Server account changed/i)).toBeTruthy();
  });

  it('offers a separately gated alias choice but sends only after confirmation', async () => {
    const nextAlias = 'alias-b@example.test';
    useSessionStore.setState({
      serverInfo: {
        version: '2.0.15',
        supports_imessage_account_status: true,
        supports_imessage_alias_change: true,
      },
    });
    accountStatus
      .mockResolvedValueOnce({ ...account, vettedAliases: [account.activeAlias, nextAlias] })
      .mockResolvedValue({
        ...account,
        activeAlias: nextAlias,
        vettedAliases: [account.activeAlias, nextAlias],
      });
    changeAlias.mockResolvedValue({ activeAlias: nextAlias });
    await renderScreen();
    await screen.findByRole('button', { name: `Use ${nextAlias} as send-from alias` });

    await fireEvent.press(
      screen.getByRole('button', { name: `Use ${nextAlias} as send-from alias` }),
    );
    expect(changeAlias).not.toHaveBeenCalled();
    const confirm = useDialogStore
      .getState()
      .current?.buttons.find((button) => button.text === 'Change');
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm?.onPress?.();
    });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: `Use ${account.activeAlias} as send-from alias` }),
      ).toBeEnabled(),
    );
    expect(changeAlias).toHaveBeenCalledTimes(1);
    expect(changeAlias.mock.calls[0]?.[1]).toBe(nextAlias);
  });

  it('discards an alias confirmation after the owning account is retired', async () => {
    const nextAlias = 'alias-b@example.test';
    useSessionStore.setState({
      serverInfo: {
        version: '2.0.15',
        supports_imessage_account_status: true,
        supports_imessage_alias_change: true,
      },
    });
    accountStatus.mockResolvedValue({
      ...account,
      vettedAliases: [account.activeAlias, nextAlias],
    });
    await renderScreen();
    await screen.findByRole('button', { name: `Use ${nextAlias} as send-from alias` });
    await fireEvent.press(
      screen.getByRole('button', { name: `Use ${nextAlias} as send-from alias` }),
    );
    const confirm = useDialogStore
      .getState()
      .current?.buttons.find((button) => button.text === 'Change');
    await act(async () => {
      await pauseRealtimeDeliveries();
    });
    await act(async () => {
      confirm?.onPress?.();
    });
    expect(changeAlias).not.toHaveBeenCalled();
  });

  it('keeps Back available for an unsupported deep link', async () => {
    await renderScreen();

    await fireEvent.press(screen.getByText('‹ Back'));
    expect(mockBack).toHaveBeenCalledTimes(1);
  });
});
