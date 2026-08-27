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
jest.mock('@/services/send', () => ({ editScheduled: jest.fn() }));
jest.mock('@ui/conversations/pickDateTime', () => ({ pickFutureDateTime: jest.fn() }));
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
import { editScheduled } from '@/services/send';
// eslint-disable-next-line import/first
import { pickFutureDateTime } from '@ui/conversations/pickDateTime';
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
const mockPickFutureDateTime = pickFutureDateTime as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;

const TEST_DATABASE = { kind: 'scheduled-edit-screen-test-db' };
const PRIVATE_BODY = 'scheduled-edit-private-body-83af';
const OLD_ACCOUNT_CANARY = 'scheduled-edit-old-account-body-f612';
const PICKER_ERROR_CANARY = 'scheduled-edit-picker-error-09bd';
const SAVE_ERROR_CANARY = 'scheduled-edit-save-error-a614';
const PICKED_TIME = 1_800_000_000_000;
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
  mockPickFutureDateTime.mockResolvedValue(null);
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

  it('saves id 42 with trimmed text, exact time and recurrence through the original lease', async () => {
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
    expect(mockEditScheduled).toHaveBeenCalledWith(
      42,
      { text: PRIVATE_BODY, scheduledFor: ORIGINAL_TIME, recurrence: 'daily' },
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
        42,
        expect.objectContaining({ recurrence: null }),
        expect.objectContaining({ isCurrent: expect.any(Function) }),
      ),
    );
  });
});

describe('ScheduledEditScreen — picker and account ownership', () => {
  it('adopts the exact current picker date through the accessible Reschedule control', async () => {
    mockGetScheduledById.mockResolvedValue(
      makeRow({ text: PRIVATE_BODY, scheduledFor: ORIGINAL_TIME }),
    );
    mockPickFutureDateTime.mockResolvedValue(PICKED_TIME);
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Reschedule' }));
    });

    expect(mockPickFutureDateTime).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(PICKED_TIME_LABEL)).toBeTruthy();
    expect(screen.queryByText(ORIGINAL_TIME_LABEL)).toBeNull();
  });

  it('keeps the current date when the picker is canceled', async () => {
    mockGetScheduledById.mockResolvedValue(
      makeRow({ text: PRIVATE_BODY, scheduledFor: ORIGINAL_TIME }),
    );
    mockPickFutureDateTime.mockResolvedValue(null);
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Reschedule' }));
      await Promise.resolve();
    });

    expect(mockPickFutureDateTime).toHaveBeenCalledTimes(1);
    expect(screen.getByText(ORIGINAL_TIME_LABEL)).toBeTruthy();
    expect(useDialogStore.getState().current).toBeNull();
  });

  it('shows fixed copy when the current picker rejects', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
    mockPickFutureDateTime.mockRejectedValue(new Error(PICKER_ERROR_CANARY));
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Reschedule' }));
    });

    await waitFor(() =>
      expect(useDialogStore.getState().current).toEqual(
        expect.objectContaining({
          title: 'Scheduled',
          message: 'Couldn’t open the date picker.',
        }),
      ),
    );
    expect(JSON.stringify(useDialogStore.getState().current)).not.toContain(PICKER_ERROR_CANARY);
  });

  it.each(['success', 'error'] as const)(
    'disowns a deferred account-A picker %s after account B is admitted',
    async (outcome) => {
      const pickerResponse = deferred<number | null>();
      mockGetScheduledById.mockResolvedValue(
        makeRow({ text: PRIVATE_BODY, scheduledFor: ORIGINAL_TIME }),
      );
      mockPickFutureDateTime.mockReturnValueOnce(pickerResponse.promise);
      await renderWithTheme(<ScheduledEditScreen />);
      await screen.findByDisplayValue(PRIVATE_BODY);
      const startReschedule = retainConfiguredPress(screen.getByLabelText('Reschedule'));

      await act(async () => {
        startReschedule();
        await Promise.resolve();
      });
      await waitFor(() => expect(mockPickFutureDateTime).toHaveBeenCalledTimes(1));

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

      expect(screen.getByText(ORIGINAL_TIME_LABEL)).toBeTruthy();
      expect(screen.queryByText(PICKED_TIME_LABEL)).toBeNull();
      expect(useDialogStore.getState().current).toBeNull();
      expect(JSON.stringify(useDialogStore.getState())).not.toContain(PICKER_ERROR_CANARY);
    },
  );

  it('runs configured Save and Reschedule controls while current, then blocks them after A retires', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow({ text: PRIVATE_BODY }));
    mockPickFutureDateTime.mockResolvedValue(PICKED_TIME);
    const accountAView = await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(PRIVATE_BODY);
    const retainedSave = retainConfiguredPress(screen.getByRole('button', { name: 'Save' }));
    const retainedReschedule = retainConfiguredPress(screen.getByLabelText('Reschedule'));

    await act(async () => {
      retainedSave();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockEditScheduled).toHaveBeenCalledTimes(1));
    const accountALease = mockEditScheduled.mock.calls[0]?.[2];
    expect(accountALease.isCurrent()).toBe(true);
    expect(mockEditScheduled).toHaveBeenCalledWith(
      42,
      { text: PRIVATE_BODY, scheduledFor: ORIGINAL_TIME, recurrence: null },
      accountALease,
    );
    await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));

    await act(async () => {
      retainedReschedule();
      await Promise.resolve();
    });
    expect(await screen.findByText(PICKED_TIME_LABEL)).toBeTruthy();
    mockEditScheduled.mockClear();
    mockPickFutureDateTime.mockClear();
    mockBack.mockClear();

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    expect(accountALease.isCurrent()).toBe(false);
    await act(async () => {
      retainedSave();
      retainedReschedule();
      await Promise.resolve();
    });
    expect(mockEditScheduled).not.toHaveBeenCalled();
    expect(mockPickFutureDateTime).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();

    await accountAView.unmount();
    const accountBBody = `${PRIVATE_BODY}-account-b`;
    const accountBTime = PICKED_TIME + 1_000;
    mockGetScheduledById.mockResolvedValue(makeRow({ text: accountBBody }));
    mockPickFutureDateTime.mockResolvedValue(accountBTime);
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue(accountBBody);
    const freshReschedule = retainConfiguredPress(screen.getByLabelText('Reschedule'));
    await act(async () => {
      freshReschedule();
      await Promise.resolve();
    });
    expect(
      await screen.findByText(`${formatChatDate(accountBTime)} ${formatTime(accountBTime)}`),
    ).toBeTruthy();
    const freshSave = retainConfiguredPress(screen.getByRole('button', { name: 'Save' }));
    await act(async () => {
      freshSave();
      await Promise.resolve();
    });
    await waitFor(() => expect(mockEditScheduled).toHaveBeenCalledTimes(1));
    const accountBLease = mockEditScheduled.mock.calls[0]?.[2];
    expect(accountBLease.isCurrent()).toBe(true);
    expect(mockEditScheduled).toHaveBeenCalledWith(
      42,
      { text: accountBBody, scheduledFor: accountBTime, recurrence: null },
      accountBLease,
    );
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
          message: 'Couldn’t update — the server is unreachable.',
        }),
      ),
    );
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue(PRIVATE_BODY)).toBeTruthy();
    expect(JSON.stringify(useDialogStore.getState().current)).not.toContain(SAVE_ERROR_CANARY);
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
