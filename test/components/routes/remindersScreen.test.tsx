/**
 * RemindersScreen route: exact reminder previews and row actions, with picker results and
 * callbacks bound to the account generation that mounted them.
 */
import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import type { Reminder } from '@core/models';

const mockBack = jest.fn();

jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ReactLib = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { View } = require('react-native');
  const asNode = (component: unknown): unknown => {
    if (component == null) return null;
    if (ReactLib.isValidElement(component)) return component;
    if (typeof component === 'function') {
      return ReactLib.createElement(component as React.ComponentType);
    }
    return component;
  };
  const FlashList = ReactLib.forwardRef(function FlashList(
    props: {
      data?: unknown[];
      renderItem?: (args: { item: unknown; index: number }) => unknown;
      keyExtractor?: (item: unknown) => string;
      ListEmptyComponent?: unknown;
    },
    _ref: unknown,
  ) {
    const { data = [], renderItem, keyExtractor, ListEmptyComponent } = props;
    const body =
      data.length === 0
        ? asNode(ListEmptyComponent)
        : data.map((item: unknown, index: number) =>
            ReactLib.createElement(
              View,
              { key: keyExtractor ? keyExtractor(item) : String(index) },
              renderItem ? renderItem({ item, index }) : null,
            ),
          );
    return ReactLib.createElement(View, null, body);
  });
  return { FlashList };
});

// Avoid loading the full native/ESM UI barrel in this host-rendered route suite.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('@db/useReactiveQuery', () => ({ useReactiveQuery: jest.fn() }));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@db/repositories', () => ({ listReminders: jest.fn() }));
jest.mock('@/services/notifications/remindersService', () => ({
  cancelReminder: jest.fn(),
  rescheduleReminder: jest.fn(),
}));
jest.mock('@ui/conversations/pickReminderTime', () => ({ pickReminderTime: jest.fn() }));
jest.mock('expo-router', () => ({ useRouter: () => ({ back: mockBack }) }));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import RemindersScreen from '../../../app/(app)/reminders';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { useReactiveQuery } from '@db/useReactiveQuery';
// eslint-disable-next-line import/first
import { cancelReminder, rescheduleReminder } from '@/services/notifications/remindersService';
// eslint-disable-next-line import/first
import { pickReminderTime } from '@ui/conversations/pickReminderTime';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { reminderSubtitle } from '@utils';

const mockGetDatabase = getDatabase as jest.Mock;
const mockUseReactiveQuery = useReactiveQuery as jest.Mock;
const mockCancelReminder = cancelReminder as jest.Mock;
const mockRescheduleReminder = rescheduleReminder as jest.Mock;
const mockPickReminderTime = pickReminderTime as jest.Mock;

const TEST_DATABASE = { kind: 'reminders-screen-test-db' };
const PRIVATE_PREVIEW = 'reminder-private-preview-4f2b';
const SECOND_PRIVATE_PREVIEW = 'reminder-private-preview-a91c';
const PICKER_ERROR_CANARY = 'reminder-picker-error-0dc7';
const SERVICE_ERROR_CANARY = 'reminder-service-error-b728';
const PICKED_TIME = 1_900_000_000_000;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function retainConfiguredPress(node: { props: Record<string, unknown> }): () => void {
  const responder = node.props.onStartShouldSetResponder;
  if (typeof responder !== 'function') {
    throw new Error('Expected an accessible Pressable responder callback');
  }
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig?: () => { onPress?: (event: object) => void };
    }
  ).testOnly_pressabilityConfig;
  if (typeof readConfig !== 'function') {
    throw new Error('Expected React Native test-only Pressability configuration');
  }
  const onPress = readConfig().onPress;
  if (typeof onPress !== 'function') throw new Error('Expected configured Pressable onPress');
  return () => onPress({ nativeEvent: {} });
}

function makeReminder(overrides: Partial<Reminder> = {}): Reminder {
  return {
    id: 41,
    messageGuid: 'message-guid-41',
    chatGuid: 'iMessage;-;+15551230000',
    messagePreview: PRIVATE_PREVIEW,
    senderName: 'Private Sender',
    scheduledFor: 1_800_000_000_000,
    notificationId: 'reminder-notification-41',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function setRows(rows: Reminder[]): void {
  mockUseReactiveQuery.mockReturnValue({ data: rows, isLoading: false, error: null });
}

function reminderA11yName(row: Reminder): string {
  return `${row.messagePreview || 'Message'} ${reminderSubtitle(row.scheduledFor)}`;
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  useDialogStore.setState({ current: null, queue: [] });
  mockGetDatabase.mockReturnValue(TEST_DATABASE);
  mockPickReminderTime.mockResolvedValue(null);
  mockRescheduleReminder.mockResolvedValue('replacement-notification-id');
  mockCancelReminder.mockResolvedValue(undefined);
  setRows([]);
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('RemindersScreen', () => {
  it('renders the exact preview and accessibility name, then goes back', async () => {
    const row = makeReminder();
    setRows([row]);
    await renderWithTheme(<RemindersScreen />);

    expect(screen.getByText(PRIVATE_PREVIEW)).toBeTruthy();
    expect(screen.getByText(reminderSubtitle(row.scheduledFor))).toBeTruthy();
    expect(screen.getByRole('button', { name: reminderA11yName(row) })).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('‹ Back'));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('reschedules and cancels the exact row with the same mounted account lease', async () => {
    const first = makeReminder({ id: 50, messageGuid: 'message-guid-50' });
    const row = makeReminder({
      id: 51,
      messageGuid: 'message-guid-51',
      messagePreview: SECOND_PRIVATE_PREVIEW,
    });
    setRows([first, row]);
    mockPickReminderTime.mockResolvedValue(PICKED_TIME);
    await renderWithTheme(<RemindersScreen />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: reminderA11yName(row) }));
    });
    await waitFor(() => expect(mockRescheduleReminder).toHaveBeenCalledTimes(1));
    const originalLease = mockRescheduleReminder.mock.calls[0]?.[4];
    expect(originalLease).toEqual(expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(originalLease.isCurrent()).toBe(true);
    expect(mockRescheduleReminder).toHaveBeenCalledWith(
      TEST_DATABASE,
      row,
      PICKED_TIME,
      undefined,
      originalLease,
    );

    const secondDelete = screen.getAllByRole('button', { name: 'Delete' })[1];
    if (!secondDelete) throw new Error('Expected a second reminder Delete control');

    await act(async () => {
      fireEvent.press(secondDelete);
    });
    await waitFor(() =>
      expect(mockCancelReminder).toHaveBeenCalledWith(TEST_DATABASE, row, undefined, originalLease),
    );
  });

  it('does nothing when the reminder picker is canceled', async () => {
    const row = makeReminder({ id: 52, messageGuid: 'message-guid-52' });
    setRows([row]);
    mockPickReminderTime.mockResolvedValue(null);
    await renderWithTheme(<RemindersScreen />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: reminderA11yName(row) }));
      await Promise.resolve();
    });

    expect(mockPickReminderTime).toHaveBeenCalledTimes(1);
    expect(mockRescheduleReminder).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('shows fixed copy when the current reminder picker rejects', async () => {
    const row = makeReminder({ id: 53, messageGuid: 'message-guid-53' });
    setRows([row]);
    mockPickReminderTime.mockRejectedValue(new Error(PICKER_ERROR_CANARY));
    await renderWithTheme(<RemindersScreen />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: reminderA11yName(row) }));
    });

    await waitFor(() =>
      expect(useDialogStore.getState().current).toEqual(
        expect.objectContaining({
          title: 'Reminder',
          message: 'Couldn’t reschedule the reminder.',
        }),
      ),
    );
    expect(mockRescheduleReminder).not.toHaveBeenCalled();
    expect(JSON.stringify(useDialogStore.getState().current)).not.toContain(PICKER_ERROR_CANARY);
  });

  it('blocks retained account-A actions and lets fresh account-B controls act on B exactly', async () => {
    const accountA = makeReminder({ id: 61, messageGuid: 'message-guid-61' });
    const accountB = makeReminder({
      id: 62,
      messageGuid: 'message-guid-62',
      messagePreview: SECOND_PRIVATE_PREVIEW,
      notificationId: 'reminder-notification-62',
    });
    setRows([accountA]);
    const firstView = await renderWithTheme(<RemindersScreen />);
    const retainedReschedule = retainConfiguredPress(
      screen.getByRole('button', { name: reminderA11yName(accountA) }),
    );
    const retainedCancel = retainConfiguredPress(screen.getByRole('button', { name: 'Delete' }));

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await act(async () => {
      retainedReschedule();
      retainedCancel();
      await Promise.resolve();
    });
    expect(mockPickReminderTime).not.toHaveBeenCalled();
    expect(mockRescheduleReminder).not.toHaveBeenCalled();
    expect(mockCancelReminder).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();

    await firstView.unmount();
    setRows([accountB]);
    mockPickReminderTime.mockResolvedValue(PICKED_TIME + 1_000);
    await renderWithTheme(<RemindersScreen />);
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: reminderA11yName(accountB) }));
    });
    await waitFor(() => expect(mockRescheduleReminder).toHaveBeenCalledTimes(1));
    const accountBLease = mockRescheduleReminder.mock.calls[0]?.[4];
    expect(accountBLease.isCurrent()).toBe(true);
    expect(mockRescheduleReminder).toHaveBeenCalledWith(
      TEST_DATABASE,
      accountB,
      PICKED_TIME + 1_000,
      undefined,
      accountBLease,
    );
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    });
    await waitFor(() =>
      expect(mockCancelReminder).toHaveBeenCalledWith(
        TEST_DATABASE,
        accountB,
        undefined,
        accountBLease,
      ),
    );
  });

  it.each(['success', 'error'] as const)(
    'disowns a deferred account-A picker %s after account B is admitted',
    async (outcome) => {
      const row = makeReminder({ id: 71, messageGuid: 'message-guid-71' });
      const pickerResponse = deferred<number | null>();
      setRows([row]);
      mockPickReminderTime.mockReturnValueOnce(pickerResponse.promise);
      await renderWithTheme(<RemindersScreen />);
      const startReschedule = retainConfiguredPress(
        screen.getByRole('button', { name: reminderA11yName(row) }),
      );

      await act(async () => {
        startReschedule();
        await Promise.resolve();
      });
      await waitFor(() => expect(mockPickReminderTime).toHaveBeenCalledTimes(1));

      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
      await act(async () => {
        if (outcome === 'success') {
          pickerResponse.resolve(PICKED_TIME);
          await pickerResponse.promise;
        } else {
          pickerResponse.reject(new Error(PICKER_ERROR_CANARY));
          await pickerResponse.promise.catch(() => undefined);
        }
        await Promise.resolve();
      });

      expect(mockRescheduleReminder).not.toHaveBeenCalled();
      expect(useDialogStore.getState().current).toBeNull();
      expect(JSON.stringify(useDialogStore.getState())).not.toContain(PICKER_ERROR_CANARY);
    },
  );

  it.each(['reschedule', 'cancel'] as const)(
    'suppresses an admitted account-A %s failure after account B is admitted',
    async (operation) => {
      const row = makeReminder({ id: 72, messageGuid: 'message-guid-72' });
      const serviceResponse = deferred<string | void>();
      setRows([row]);
      if (operation === 'reschedule') {
        mockPickReminderTime.mockResolvedValue(PICKED_TIME);
        mockRescheduleReminder.mockReturnValueOnce(serviceResponse.promise);
      } else {
        mockCancelReminder.mockReturnValueOnce(serviceResponse.promise);
      }
      await renderWithTheme(<RemindersScreen />);

      await act(async () => {
        fireEvent.press(
          operation === 'reschedule'
            ? screen.getByRole('button', { name: reminderA11yName(row) })
            : screen.getByRole('button', { name: 'Delete' }),
        );
      });
      await waitFor(() =>
        expect(
          operation === 'reschedule' ? mockRescheduleReminder : mockCancelReminder,
        ).toHaveBeenCalledTimes(1),
      );

      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
      await act(async () => {
        serviceResponse.reject(new Error(SERVICE_ERROR_CANARY));
        await serviceResponse.promise.catch(() => undefined);
        await Promise.resolve();
      });

      expect(useDialogStore.getState().current).toBeNull();
      expect(JSON.stringify(useDialogStore.getState())).not.toContain(SERVICE_ERROR_CANARY);
    },
  );

  it('cancels the exact current reminder and reports only a generic failure', async () => {
    const row = makeReminder({ id: 81, messageGuid: 'message-guid-81' });
    setRows([row]);
    mockCancelReminder.mockRejectedValue(new Error(PRIVATE_PREVIEW));
    await renderWithTheme(<RemindersScreen />);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Delete' }));
    });

    await waitFor(() => expect(mockCancelReminder).toHaveBeenCalledTimes(1));
    const originalLease = mockCancelReminder.mock.calls[0]?.[3];
    expect(originalLease).toEqual(expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(originalLease.isCurrent()).toBe(true);
    expect(mockCancelReminder).toHaveBeenCalledWith(TEST_DATABASE, row, undefined, originalLease);
    await waitFor(() =>
      expect(useDialogStore.getState().current).toEqual(
        expect.objectContaining({
          title: 'Reminder',
          message: 'Couldn’t cancel the reminder.',
        }),
      ),
    );
    expect(JSON.stringify(useDialogStore.getState().current)).not.toContain(PRIVATE_PREVIEW);
  });
});
