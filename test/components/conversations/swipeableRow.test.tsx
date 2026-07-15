/**
 * SwipeableRow (src/ui/conversations/SwipeableRow.tsx): a PanResponder-based swipe-to-reveal row
 * (no gesture-handler/Reanimated — RN Animated only). Gesture drags can't be faithfully simulated
 * in RNTL (PanResponder reads native gesture state), so per the batch plan we DRIVE the exposed
 * surface — the action buttons and the render contract — and accept partial coverage of the
 * drag/snap math rather than faking a gesture.
 *
 * Locked in:
 *   - children always render;
 *   - each provided left/right SwipeAction becomes a labelled button (accessibilityLabel = label);
 *   - pressing an action fires ITS onPress (the `fire` path — snap-closed then invoke);
 *   - with no actions, no action buttons exist (only the child);
 *   - both side panels render when both `left` and `right` are supplied.
 */
import React from 'react';
import { Text } from 'react-native';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { SwipeableRow, type SwipeAction } from '@ui/conversations/SwipeableRow';

function action(over: Partial<SwipeAction> = {}): SwipeAction {
  return {
    key: 'k',
    label: 'Delete',
    icon: 'trash-outline',
    color: '#ff3b30',
    onPress: jest.fn(),
    ...over,
  };
}

describe('SwipeableRow', () => {
  it('renders its children', async () => {
    await renderWithTheme(
      <SwipeableRow resetKey="chat-1">
        <Text>row body</Text>
      </SwipeableRow>,
    );
    expect(screen.getByText('row body')).toBeTruthy();
  });

  it('renders a labelled button for each right action and fires its onPress when tapped', async () => {
    const onDelete = jest.fn();
    const onArchive = jest.fn();
    await renderWithTheme(
      <SwipeableRow
        resetKey="chat-1"
        right={[
          action({ key: 'del', label: 'Delete', onPress: onDelete }),
          action({ key: 'arc', label: 'Archive', icon: 'archive-outline', onPress: onArchive }),
        ]}
      >
        <Text>row body</Text>
      </SwipeableRow>,
    );
    expect(screen.getByLabelText('Delete')).toBeTruthy();
    expect(screen.getByLabelText('Archive')).toBeTruthy();

    fireEvent.press(screen.getByLabelText('Delete'));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('renders left-side actions and fires the correct onPress', async () => {
    const onPin = jest.fn();
    await renderWithTheme(
      <SwipeableRow resetKey="chat-1" left={[action({ key: 'pin', label: 'Pin', onPress: onPin })]}>
        <Text>row body</Text>
      </SwipeableRow>,
    );
    fireEvent.press(screen.getByLabelText('Pin'));
    expect(onPin).toHaveBeenCalledTimes(1);
  });

  it('renders no action buttons when neither left nor right is provided', async () => {
    await renderWithTheme(
      <SwipeableRow resetKey="chat-1">
        <Text>only child</Text>
      </SwipeableRow>,
    );
    expect(screen.getByText('only child')).toBeTruthy();
    expect(screen.queryByLabelText('Delete')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('renders both side panels when left and right actions are supplied', async () => {
    await renderWithTheme(
      <SwipeableRow
        resetKey="chat-1"
        left={[action({ key: 'pin', label: 'Pin' })]}
        right={[action({ key: 'del', label: 'Delete' })]}
      >
        <Text>row body</Text>
      </SwipeableRow>,
    );
    expect(screen.getByLabelText('Pin')).toBeTruthy();
    expect(screen.getByLabelText('Delete')).toBeTruthy();
  });

  it('re-centers without error when resetKey changes (recycled FlashList row)', async () => {
    const view = await renderWithTheme(
      <SwipeableRow resetKey="chat-1" right={[action({ key: 'del', label: 'Delete' })]}>
        <Text>row body</Text>
      </SwipeableRow>,
    );
    // A recycled row gets a new resetKey → the reset effect runs (tx.setValue(0)); nothing throws
    // and the child + actions are still present.
    view.rerender(
      <SwipeableRow resetKey="chat-2" right={[action({ key: 'del', label: 'Delete' })]}>
        <Text>row body</Text>
      </SwipeableRow>,
    );
    expect(screen.getByText('row body')).toBeTruthy();
    expect(screen.getByLabelText('Delete')).toBeTruthy();
  });
});
