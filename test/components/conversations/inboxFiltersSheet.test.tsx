/**
 * InboxFiltersSheet keeps edits in a local draft until Apply. This suite exercises the real sheet
 * boundary so a visual refactor cannot silently change the five-axis contract:
 *   - every axis is exposed as one radio group of accessible choices with its supplied selection;
 *   - Apply emits one complete draft, while Cancel/backdrop never emit partial edits;
 *   - Reset affects the draft only until Apply;
 *   - the legacy Unknown Senders policy visibly locks Sender to Known and clears the hidden saved
 *     sender choice when the user applies.
 *
 * The sheet renders in a React Native Modal, so every render and interaction is awaited under
 * React 19/RNTL 14. Safe-area insets are the only native dependency needed by this component.
 */
import React from 'react';
import { DEFAULT_INBOX_FILTERS, type InboxFilters } from '@core/models';
import { fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// eslint-disable-next-line import/first
import { InboxFiltersSheet } from '@ui/conversations/InboxFiltersSheet';

const SELECTED_FILTERS: InboxFilters = {
  read: 'unread',
  sender: 'unknown',
  kind: 'group',
  mute: 'muted',
  service: 'rcs',
};

async function renderSheet({
  filters = SELECTED_FILTERS,
  senderLocked = false,
}: {
  filters?: InboxFilters;
  senderLocked?: boolean;
} = {}): Promise<{ onApply: jest.Mock; onClose: jest.Mock }> {
  const onApply = jest.fn();
  const onClose = jest.fn();
  await renderWithTheme(
    <InboxFiltersSheet
      filters={filters}
      senderLocked={senderLocked}
      onApply={onApply}
      onClose={onClose}
    />,
  );
  await screen.findByText('Filters');
  return { onApply, onClose };
}

function radio(name: string): ReturnType<typeof screen.getByRole> {
  return screen.getByRole('radio', { name });
}

describe('InboxFiltersSheet', () => {
  it('renders five radio groups, all 15 accessible choices, and the supplied selections', async () => {
    await renderSheet();

    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(15);
    const groups = new Set(radios.map((choice) => choice.parent));
    expect(groups.size).toBe(5);
    for (const group of groups) {
      expect(group?.props.accessibilityRole).toBe('radiogroup');
    }
    expect(radios.filter((choice) => choice.props.accessibilityState?.selected)).toHaveLength(5);

    for (const label of [
      'Read status, Unread',
      'Sender, Unknown',
      'Conversation, Group',
      'Notifications, Muted',
      'Service, RCS',
    ]) {
      expect(radio(label).props.accessibilityState).toMatchObject({ selected: true });
    }
  });

  it('keeps all five edits in draft and applies the exact complete selection once', async () => {
    const { onApply, onClose } = await renderSheet({ filters: DEFAULT_INBOX_FILTERS });

    for (const label of [
      'Read status, Unread',
      'Sender, Unknown',
      'Conversation, Group',
      'Notifications, Muted',
      'Service, RCS',
    ]) {
      await fireEvent.press(radio(label));
    }
    expect(onApply).not.toHaveBeenCalled();

    await fireEvent.press(screen.getByRole('button', { name: 'Apply conversation filters' }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(SELECTED_FILTERS);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([
    ['Cancel', () => screen.getByRole('button', { name: 'Cancel conversation filters' })],
    ['backdrop', () => screen.getByTestId('inbox-filter-backdrop')],
  ])('%s closes without applying draft edits', async (_name, target) => {
    const { onApply, onClose } = await renderSheet();
    await fireEvent.press(radio('Service, SMS'));

    await fireEvent.press(target());

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it('resets only the draft, then applies the defaults', async () => {
    const { onApply, onClose } = await renderSheet();

    await fireEvent.press(screen.getByRole('button', { name: 'Reset conversation filters' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    for (const label of [
      'Read status, All',
      'Sender, All',
      'Conversation, All',
      'Notifications, All',
      'Service, All',
    ]) {
      expect(radio(label).props.accessibilityState).toMatchObject({ selected: true });
    }

    await fireEvent.press(screen.getByRole('button', { name: 'Apply conversation filters' }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(DEFAULT_INBOX_FILTERS);
  });

  it('locks Sender to Known and clears only the hidden sender choice on Apply', async () => {
    const { onApply } = await renderSheet({ senderLocked: true });

    expect(radio('Sender, Known').props.accessibilityState).toEqual({
      selected: true,
      disabled: true,
    });
    expect(radio('Sender, All').props.accessibilityState).toEqual({
      selected: false,
      disabled: true,
    });
    expect(radio('Sender, Unknown').props.accessibilityState).toEqual({
      selected: false,
      disabled: true,
    });
    expect(
      screen.getByText(
        'Known senders are enforced by Filter Unknown Senders in Settings. Applying changes clears any saved sender filter.',
      ),
    ).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Apply conversation filters' }));

    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith({ ...SELECTED_FILTERS, sender: 'any' });
  });
});
