import React from 'react';
import { ScheduleSheet, parseScheduleDateTime } from '@ui/conversations/RecurrenceSheet';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 24, left: 0, right: 0 }),
}));

const FUTURE = new Date(2035, 6, 15, 9, 15).getTime();

describe('ScheduleSheet', () => {
  it.each(['In 1 hour', 'Tomorrow morning'])(
    'only fills the fields when choosing %s',
    async (label) => {
      const now = new Date(2035, 6, 15, 23, 30, 20).getTime();
      const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
      try {
        const onConfirm = jest.fn();
        await renderWithTheme(
          <ScheduleSheet initialWhen={FUTURE} onClose={jest.fn()} onConfirm={onConfirm} />,
        );
        await fireEvent.press(screen.getByRole('button', { name: label }));
        expect(onConfirm).not.toHaveBeenCalled();
        expect(screen.getByLabelText('Schedule date').props.value).toBe('2035-07-16');
        expect(screen.getByLabelText('Schedule time').props.value).toBe(
          label === 'In 1 hour' ? '00:31' : '09:00',
        );
        await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
        expect(onConfirm).toHaveBeenCalledWith(
          label === 'In 1 hour'
            ? new Date(2035, 6, 16, 0, 31).getTime()
            : new Date(2035, 6, 16, 9, 0).getTime(),
          null,
        );
      } finally {
        clock.mockRestore();
      }
    },
  );
  it('keeps repeat changes local until explicit confirmation', async () => {
    const onConfirm = jest.fn();
    await renderWithTheme(
      <ScheduleSheet initialWhen={FUTURE} onClose={jest.fn()} onConfirm={onConfirm} />,
    );
    expect(screen.getByLabelText('Schedule date').props.value).toBe('2035-07-15');
    expect(screen.getByLabelText('Schedule time').props.value).toBe('09:15');
    await fireEvent.press(screen.getByRole('radio', { name: 'Repeat weekly' }));
    expect(
      screen.getByRole('radio', { name: 'Repeat weekly' }).props.accessibilityState.checked,
    ).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
    const confirm = screen.getByRole('button', { name: 'Schedule' });
    await fireEvent.press(confirm);
    await fireEvent.press(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(FUTURE, 'weekly');
  });

  it.each(['button', 'backdrop', 'back'] as const)(
    '%s dismisses without confirming and cannot later confirm',
    async (kind) => {
      const onClose = jest.fn(),
        onConfirm = jest.fn();
      await renderWithTheme(
        <ScheduleSheet initialWhen={FUTURE} onClose={onClose} onConfirm={onConfirm} />,
      );
      if (kind === 'button') await fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
      if (kind === 'backdrop') await fireEvent.press(screen.getByTestId('schedule-backdrop'));
      if (kind === 'back') await fireEvent(screen.getByTestId('schedule-modal'), 'requestClose');
      await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(onConfirm).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['2035-02-30', '10:00'],
    ['2035-13-01', '10:00'],
    ['2035-01-01', '24:00'],
    ['2035-01-01', '10:60'],
    ['2035-1-1', '10:00'],
  ])('rejects invalid local fields %s %s', async (date, time) => {
    const onConfirm = jest.fn();
    await renderWithTheme(
      <ScheduleSheet initialWhen={FUTURE} onClose={jest.fn()} onConfirm={onConfirm} />,
    );
    await fireEvent.changeText(screen.getByLabelText('Schedule date'), date);
    await fireEvent.changeText(screen.getByLabelText('Schedule time'), time);
    await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
    expect(screen.getByRole('alert').props.children).toContain('real date');
    expect(onConfirm).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText('Schedule date'), '2036-02-29');
    await fireEvent.changeText(screen.getByLabelText('Schedule time'), '09:15');
    await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
    expect(onConfirm).toHaveBeenCalledWith(new Date(2036, 1, 29, 9, 15).getTime(), null);
  });

  it('revalidates time at confirmation rather than only when opened', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(FUTURE - 60_000);
    try {
      const onConfirm = jest.fn();
      await renderWithTheme(
        <ScheduleSheet initialWhen={FUTURE} onClose={jest.fn()} onConfirm={onConfirm} />,
      );
      now.mockReturnValue(FUTURE);
      await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
      expect(screen.getByText('Choose a time in the future.')).toBeTruthy();
      expect(onConfirm).not.toHaveBeenCalled();
    } finally {
      now.mockRestore();
    }
  });

  it('keeps attachment schedules one-time and supports date-only editor mode', async () => {
    const onConfirm = jest.fn();
    const view = await renderWithTheme(
      <ScheduleSheet
        initialWhen={FUTURE}
        allowRepeat={false}
        onClose={jest.fn()}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getAllByRole('radio')).toHaveLength(1);
    expect(screen.queryByText('Repeat daily')).toBeNull();
    await fireEvent.press(screen.getByRole('button', { name: 'Schedule' }));
    expect(onConfirm).toHaveBeenCalledWith(FUTURE, null);
    await view.unmount();
    await renderWithTheme(
      <ScheduleSheet
        initialWhen={FUTURE}
        showRepeat={false}
        confirmLabel="Use this time"
        onClose={jest.fn()}
        onConfirm={onConfirm}
      />,
    );
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('button', { name: 'Use this time' })).toBeTruthy();
  });

  it('rejects a local DST gap instead of accepting Date normalization', () => {
    // The focused gate runs with TZ=America/Denver. Other zones may have no gap at this instant.
    const normalized = new Date(2035, 2, 11, 2, 30);
    const expected = normalized.getHours() === 2 ? normalized.getTime() : null;
    expect(parseScheduleDateTime('2035-03-11', '02:30')).toBe(expected);
    if (process.env.TZ === 'America/Denver') expect(expected).toBeNull();
  });
});
