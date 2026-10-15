/**
 * ScheduledEditScreen route (app/(app)/scheduled-edit/[id].tsx): edit a pending scheduled
 * message. This suite locks in the load effect's two exits:
 *   - a resolved read fills the editor (text + fire time) once `loaded` flips;
 *   - a THROWN read (DB closed / bad row) must NOT leave the screen permanently blank —
 *     it shows the inline load error instead of the form (so a blank Save can't overwrite
 *     a row that never loaded).
 */
import React from 'react';
import { renderWithTheme, screen, act, fireEvent, waitFor } from '../support/renderWithTheme';
import type { ScheduledRow } from '@db/repositories';

const mockBack = jest.fn();

// The full `@ui` barrel drags in native/ESM modules; the screen only needs Screen + useTheme.
jest.mock('@ui', () => ({
  ...jest.requireActual('@ui/theme'),
  ...jest.requireActual('@ui/primitives'),
}));
jest.mock('@db/database', () => ({ getDatabase: jest.fn() }));
jest.mock('@db/repositories', () => ({ getScheduledById: jest.fn() }));
jest.mock('@/services/send', () => ({
  ScheduledEditChangedError: class ScheduledEditChangedError extends Error {},
  editScheduled: jest.fn(),
}));
jest.mock('@ui/hooks/useUnsavedChangesGuard', () => ({
  useUnsavedChangesGuard: () => ({ navigateWithoutPrompt: (navigate: () => void) => navigate() }),
}));
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ id: '42' }),
  useRouter: () => ({ back: mockBack }),
}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
// Silence the expected load-failure warn (the redacting logger is exercised elsewhere).
jest.mock('@core/secure', () => ({
  ...jest.requireActual('@core/secure'),
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// eslint-disable-next-line import/first
import ScheduledEditScreen from '../../../app/(app)/scheduled-edit/[id]';
// eslint-disable-next-line import/first
import { getDatabase } from '@db/database';
// eslint-disable-next-line import/first
import { getScheduledById } from '@db/repositories';
// eslint-disable-next-line import/first
// eslint-disable-next-line import/first
import { ApiError } from '@core/api/errors';
import { editScheduled, ScheduledEditChangedError } from '@/services/send';
// eslint-disable-next-line import/first
import { logger } from '@core/secure';
// eslint-disable-next-line import/first
import { useDialogStore } from '@ui/dialog/dialogStore';
// eslint-disable-next-line import/first
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
// eslint-disable-next-line import/first
import { formatChatDate, formatTime } from '@utils';

const mockGetScheduledById = getScheduledById as jest.Mock;
const mockGetDatabase = getDatabase as jest.Mock;
const mockEditScheduled = editScheduled as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;

const TEST_DATABASE = { kind: 'scheduled-edit-screen-test-db' };
const PRIVATE_BODY = 'scheduled-edit-private-body-83af';
const OLD_ACCOUNT_CANARY = 'scheduled-edit-old-account-body-f612';
const SAVE_ERROR_CANARY = 'scheduled-edit-save-error-a614';
const PICKED_TIME = new Date(2035, 6, 15, 9, 15).getTime();
const PICKED_TIME_LABEL = `${formatChatDate(PICKED_TIME)} ${formatTime(PICKED_TIME)}`;
const ORIGINAL_TIME = 1_700_000_000_000;
const ORIGINAL_TIME_LABEL = `${formatChatDate(ORIGINAL_TIME)} ${formatTime(ORIGINAL_TIME)}`;

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

function expectBodyAbsent(tree: unknown, body: string): void {
  expect(JSON.stringify(tree)).not.toContain(body);
  expect(screen.queryByText(body)).toBeNull();
  expect(screen.queryByDisplayValue(body)).toBeNull();
}

// The occurrence makeRow() describes: what Save must target.
const LOADED_OCCURRENCE = {
  id: 42,
  chatGuid: 'iMessage;-;+15551230000',
  serverId: null,
  scheduledFor: 1_700_000_000_000,
};

function makeRow(overrides: Partial<ScheduledRow> = {}): ScheduledRow {
  return {
    id: 42,
    serverId: null,
    chatGuid: 'iMessage;-;+15551230000',
    text: 'Happy birthday!',
    scheduledFor: 1_700_000_000_000,
    status: 'pending',
    ...overrides,
  };
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.clearAllMocks();
  mockGetDatabase.mockReturnValue(TEST_DATABASE);
  mockEditScheduled.mockResolvedValue(undefined);
  useDialogStore.setState({ current: null, queue: [] });
});

afterEach(() => {
  resumeRealtimeDeliveries();
});

describe('ScheduledEditScreen', () => {
  it('loads route id 42 from the current database, renders the row, and goes back', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow());
    await renderWithTheme(<ScheduledEditScreen />);
    expect(await screen.findByDisplayValue('Happy birthday!')).toBeTruthy();
    expect(mockGetScheduledById).toHaveBeenCalledWith(TEST_DATABASE, 42);
    expect(screen.queryByText('Couldn’t load this scheduled message.')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByText('‹ Back'));
    });
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  it('shows the inline load error instead of the form when the read throws', async () => {
    mockGetScheduledById.mockRejectedValue(new Error('Database not initialized'));
    await renderWithTheme(<ScheduledEditScreen />);
    // The screen must not stay blank: loaded still flips, surfacing the error text.
    expect(await screen.findByText('Couldn’t load this scheduled message.')).toBeTruthy();
    expect(screen.queryByPlaceholderText('Message')).toBeNull();
  });

  it('renders the recurrence chips with the loaded cadence selected', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ recurrence: 'weekly' }));
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue('Happy birthday!');
    const weekly = screen.getByLabelText('Repeat weekly');
    expect(weekly.props.accessibilityState?.selected).toBe(true);
    expect(screen.getByLabelText('Repeat none').props.accessibilityState?.selected).toBe(false);
    expect(screen.getByText(/Android background work/)).toBeTruthy();
  });

  it('saves the loaded occurrence with trimmed text and recurrence, keeping its time, through the original lease', async () => {
    mockGetScheduledById.mockResolvedValue(
      makeRow({ text: `  ${PRIVATE_BODY}  `, scheduledFor: ORIGINAL_TIME }),
    );
    mockEditScheduled.mockResolvedValue(undefined);
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(`  ${PRIVATE_BODY}  `);
    // Flush the chip press before Save so Save's closure sees the updated selection.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Repeat daily'));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
    });
    await waitFor(() => expect(mockEditScheduled).toHaveBeenCalledTimes(1));
    const originalLease = mockEditScheduled.mock.calls[0]?.[2];
    expect(originalLease).toEqual(expect.objectContaining({ isCurrent: expect.any(Function) }));
    expect(originalLease.isCurrent()).toBe(true);
    // An unchanged time is not sent, so a text-only edit can never move the schedule.
    expect(mockEditScheduled).toHaveBeenCalledWith(
      LOADED_OCCURRENCE,
      { text: PRIVATE_BODY, recurrence: 'daily' },
      originalLease,
    );
    await waitFor(() => expect(mockBack).toHaveBeenCalled());
  });

  it('saving with None sends recurrence null (clears a previous cadence)', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ recurrence: 'monthly' }));
    mockEditScheduled.mockResolvedValue(undefined);
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue('Happy birthday!');
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Repeat none'));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
    });
    await waitFor(() =>
      expect(mockEditScheduled).toHaveBeenCalledWith(
        LOADED_OCCURRENCE,
        expect.objectContaining({ recurrence: null }),
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
  });
});

describe('ScheduledEditScreen — occurrence changed while editing', () => {
  it('says the edit was not saved when the occurrence already went out', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
    mockEditScheduled.mockRejectedValue(new ScheduledEditChangedError());
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
    });

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Scheduled'));
    expect(useDialogStore.getState().current?.message).toContain('your edit was not saved');
    expect(mockBack).not.toHaveBeenCalled();
  });
});

describe('ScheduledEditScreen — picker and account ownership', () => {
  async function chooseTime(): Promise<void> {
    await fireEvent.changeText(screen.getByLabelText('Schedule date'), '2035-07-15');
    await fireEvent.changeText(screen.getByLabelText('Schedule time'), '09:15');
  }

  it('confirms a themed local time, then persists it only through Save', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);
    await fireEvent.press(screen.getByRole('button', { name: 'Reschedule' }));
    expect(screen.getByRole('header', { name: 'Reschedule message' })).toBeTruthy();
    expect(screen.queryByRole('radio', { name: 'Repeat daily' })).toBeNull();
    await chooseTime();
    await fireEvent.press(screen.getByRole('button', { name: 'Use this time' }));
    expect(screen.getByText(PICKED_TIME_LABEL)).toBeTruthy();
    expect(mockEditScheduled).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(mockEditScheduled).toHaveBeenCalledWith(
      LOADED_OCCURRENCE,
      { text: PRIVATE_BODY, scheduledFor: PICKED_TIME, recurrence: null },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
  });

  it('Cancel discards picker changes and preserves the existing time and editor text', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);
    await fireEvent.press(screen.getByRole('button', { name: 'Reschedule' }));
    await chooseTime();
    await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByText(ORIGINAL_TIME_LABEL)).toBeTruthy();
    expect(screen.getByDisplayValue(PRIVATE_BODY)).toBeTruthy();
    expect(mockEditScheduled).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByRole('button', { name: 'Reschedule' }));
    expect(screen.getByLabelText('Schedule date').props.value).not.toBe('2035-07-15');
  });

  it('rejects a retained confirmation after unmount', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
    const view = await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);
    await fireEvent.press(screen.getByRole('button', { name: 'Reschedule' }));
    await chooseTime();
    const confirm = retainConfiguredPress(screen.getByRole('button', { name: 'Use this time' }));
    await view.unmount();
    await act(async () => confirm());
    expect(mockEditScheduled).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('rejects an account-A picker after retirement, but a fresh B editor can reschedule', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
    const view = await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);
    const saveA = retainConfiguredPress(screen.getByRole('button', { name: 'Save' }));
    const rescheduleA = retainConfiguredPress(screen.getByRole('button', { name: 'Reschedule' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Reschedule' }));
    await chooseTime();
    const confirmA = retainConfiguredPress(screen.getByRole('button', { name: 'Use this time' }));
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await act(async () => {
      confirmA();
      saveA();
      rescheduleA();
    });
    expect(screen.getByText(ORIGINAL_TIME_LABEL)).toBeTruthy();
    expect(screen.queryByText(PICKED_TIME_LABEL)).toBeNull();
    expect(mockEditScheduled).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();

    await view.unmount();
    mockGetScheduledById.mockResolvedValue(makeRow({ text: 'new-account-draft' }));
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue('new-account-draft');
    await fireEvent.press(screen.getByRole('button', { name: 'Reschedule' }));
    await chooseTime();
    await fireEvent.press(screen.getByRole('button', { name: 'Use this time' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    expect(mockEditScheduled).toHaveBeenCalledWith(
      LOADED_OCCURRENCE,
      { text: 'new-account-draft', scheduledFor: PICKED_TIME, recurrence: null },
      expect.objectContaining({ isCurrent: expect.any(Function) }),
    );
    expect(mockEditScheduled.mock.calls[0]?.[2].isCurrent()).toBe(true);
  });

  it('shows fixed copy when the current Save rejects', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
    mockEditScheduled.mockRejectedValue(new Error(SAVE_ERROR_CANARY));
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    });

    await waitFor(() =>
      expect(useDialogStore.getState().current).toEqual(
        expect.objectContaining({
          title: 'Scheduled',
          message: 'Couldn’t save your edit. Try again.',
        }),
      ),
    );
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue(PRIVATE_BODY)).toBeTruthy();
    expect(JSON.stringify(useDialogStore.getState().current)).not.toContain(SAVE_ERROR_CANARY);
  });

  it.each([
    [
      'cannot reach the server',
      () => new ApiError('no_connection', 'offline'),
      'Couldn’t update — the server is unreachable.',
    ],
    [
      'gets a refusal from the server',
      () => new ApiError('server_error', 'refused', 500),
      'The server didn’t accept this change, so your edit was not saved.',
    ],
  ] as const)('says when Save %s', async (_label, makeError, message) => {
    mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
    mockEditScheduled.mockRejectedValue(makeError());
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Save' }));
    });

    await waitFor(() =>
      expect(useDialogStore.getState().current).toEqual(
        expect.objectContaining({ title: 'Scheduled', message }),
      ),
    );
  });

  it.each(['row', 'error'] as const)(
    'disowns a delayed old-account %s result without mounting account A state',
    async (outcome) => {
      const response = deferred<ScheduledRow | null>();
      mockGetScheduledById.mockReturnValueOnce(response.promise);
      const view = await renderWithTheme(<ScheduledEditScreen />);
      await waitFor(() => expect(mockGetScheduledById).toHaveBeenCalledWith(TEST_DATABASE, 42));

      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
      await act(async () => {
        if (outcome === 'row') {
          response.resolve(makeRow({ text: OLD_ACCOUNT_CANARY }));
          await response.promise;
        } else {
          response.reject(new Error(OLD_ACCOUNT_CANARY));
          await response.promise.catch(() => undefined);
        }
        await Promise.resolve();
      });

      expectBodyAbsent(view.toJSON(), OLD_ACCOUNT_CANARY);
      expect(screen.queryByText('Couldn’t load this scheduled message.')).toBeNull();
      expect(screen.queryByPlaceholderText('Message')).toBeNull();
      if (outcome === 'error') expect(mockLoggerWarn).not.toHaveBeenCalled();
    },
  );

  it.each(['success', 'error'] as const)(
    'suppresses an admitted account-A Save %s after account B is admitted',
    async (outcome) => {
      const saveResponse = deferred<void>();
      mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
      mockEditScheduled.mockReturnValueOnce(saveResponse.promise);
      await renderWithTheme(<ScheduledEditScreen />);
      await screen.findByDisplayValue(PRIVATE_BODY);

      await act(async () => {
        fireEvent.press(screen.getByRole('button', { name: 'Save' }));
      });
      await waitFor(() => expect(mockEditScheduled).toHaveBeenCalledTimes(1));
      const accountALease = mockEditScheduled.mock.calls[0]?.[2];
      expect(accountALease.isCurrent()).toBe(true);

      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
      await act(async () => {
        if (outcome === 'success') {
          saveResponse.resolve(undefined);
          await saveResponse.promise;
        } else {
          saveResponse.reject(new Error(SAVE_ERROR_CANARY));
          await saveResponse.promise.catch(() => undefined);
        }
        await Promise.resolve();
      });

      expect(accountALease.isCurrent()).toBe(false);
      expect(mockBack).not.toHaveBeenCalled();
      expect(useDialogStore.getState().current).toBeNull();
      expect(JSON.stringify(useDialogStore.getState())).not.toContain(SAVE_ERROR_CANARY);
    },
  );
});
