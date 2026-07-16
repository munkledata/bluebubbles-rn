/**
 * ActionListRow (src/ui/primitives/ActionListRow.tsx): the shared "title + subtitle +
 * trailing action" list row (Reminders / Scheduled). Contract exercised here — the body
 * fires onPress (unless disabled), the trailing action always stays pressable, and the
 * accessibility labels land on the right targets.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';
import { ActionListRow } from '@ui/primitives/ActionListRow';

describe('ActionListRow', () => {
  const makeAction = (over: Partial<Parameters<typeof ActionListRow>[0]['action']> = {}) => ({
    label: 'Delete',
    color: '#f00',
    onPress: jest.fn(),
    ...over,
  });

  it('renders the title, subtitle, and action label', async () => {
    await renderWithTheme(
      <ActionListRow
        title="Buy milk"
        subtitle="Today · 9:00"
        onPress={jest.fn()}
        action={makeAction()}
      />,
    );
    expect(screen.getByText('Buy milk')).toBeTruthy();
    expect(screen.getByText('Today · 9:00')).toBeTruthy();
    expect(screen.getByText('Delete')).toBeTruthy();
  });

  it('fires onPress from the row body and the action independently', async () => {
    const onPress = jest.fn();
    const action = makeAction();
    await renderWithTheme(
      <ActionListRow title="Buy milk" subtitle="Today" onPress={onPress} action={action} />,
    );
    await act(async () => {
      fireEvent.press(screen.getByText('Buy milk'));
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(action.onPress).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(screen.getByText('Delete'));
    });
    expect(action.onPress).toHaveBeenCalledTimes(1);
  });

  it('disabled blocks the body press but keeps the action live', async () => {
    const onPress = jest.fn();
    const action = makeAction({ label: 'Clear' });
    await renderWithTheme(
      <ActionListRow
        title="Sent one"
        subtitle="✓ Sent"
        disabled
        onPress={onPress}
        action={action}
      />,
    );
    await act(async () => {
      fireEvent.press(screen.getByText('Sent one'));
    });
    expect(onPress).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(screen.getByText('Clear'));
    });
    expect(action.onPress).toHaveBeenCalledTimes(1);
  });

  it('applies the accessibility labels to the body and action', async () => {
    await renderWithTheme(
      <ActionListRow
        title="Edit me"
        subtitle="Tomorrow"
        onPress={jest.fn()}
        accessibilityLabel="Edit scheduled message: Edit me"
        action={makeAction({ label: 'Clear', accessibilityLabel: 'Remove from history' })}
      />,
    );
    expect(screen.getByLabelText('Edit scheduled message: Edit me')).toBeTruthy();
    expect(screen.getByLabelText('Remove from history')).toBeTruthy();
  });
});
