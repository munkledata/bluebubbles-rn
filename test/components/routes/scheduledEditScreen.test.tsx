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
import { getScheduledById } from '@db/repositories';
// eslint-disable-next-line import/first
import { editScheduled } from '@/services/send';

const mockGetScheduledById = getScheduledById as jest.Mock;
const mockEditScheduled = editScheduled as jest.Mock;

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
  jest.clearAllMocks();
});

describe('ScheduledEditScreen', () => {
  it('loads the row into the editor', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow());
    await renderWithTheme(<ScheduledEditScreen />);
    expect(await screen.findByDisplayValue('Happy birthday!')).toBeTruthy();
    expect(screen.queryByText('Couldn’t load this scheduled message.')).toBeNull();
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
  });

  it('saving passes the picked recurrence to editScheduled', async () => {
    mockGetScheduledById.mockResolvedValue(makeRow());
    mockEditScheduled.mockResolvedValue(undefined);
    await renderWithTheme(<ScheduledEditScreen />);
    await screen.findByDisplayValue('Happy birthday!');
    // Flush the chip press before Save so Save's closure sees the updated selection.
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Repeat daily'));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Save'));
    });
    await waitFor(() =>
      expect(mockEditScheduled).toHaveBeenCalledWith(
        42,
        expect.objectContaining({ text: 'Happy birthday!', recurrence: 'daily' }),
      ),
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
      ),
    );
  });
});
