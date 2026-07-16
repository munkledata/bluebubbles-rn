/**
 * useKeyboardVisible (src/ui/hooks/useKeyboardVisible.ts): the shared keyboard-up flag that gates
 * KeyboardAvoidingView `enabled` on Android edge-to-edge screens. Locks in:
 *   - starts false (keyboard down);
 *   - flips true on keyboardDidShow and back to false on keyboardDidHide;
 *   - removes BOTH listeners on unmount (a leaked listener keeps flipping state on a dead tree).
 *
 * Keyboard.addListener is spied so the test can capture and fire the callbacks directly — jest
 * has no native keyboard to raise the real events.
 */
import React from 'react';
import { Keyboard, Text, type EmitterSubscription } from 'react-native';
import { renderWithTheme, screen, act } from '../support/renderWithTheme';
import { useKeyboardVisible } from '@ui/hooks/useKeyboardVisible';

function Probe(): React.JSX.Element {
  const visible = useKeyboardVisible();
  return <Text testID="kb">{visible ? 'up' : 'down'}</Text>;
}

describe('useKeyboardVisible', () => {
  const listeners: Record<string, () => void> = {};
  const removeSpies: jest.Mock[] = [];

  beforeEach(() => {
    for (const key of Object.keys(listeners)) delete listeners[key];
    removeSpies.length = 0;
    jest.spyOn(Keyboard, 'addListener').mockImplementation((event, cb) => {
      listeners[event] = cb as () => void;
      const remove = jest.fn();
      removeSpies.push(remove);
      return { remove } as unknown as EmitterSubscription;
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('tracks keyboardDidShow/keyboardDidHide and cleans up on unmount', async () => {
    const view = await renderWithTheme(<Probe />);
    expect(screen.getByTestId('kb').props.children).toBe('down');

    await act(async () => {
      listeners['keyboardDidShow']?.();
    });
    expect(screen.getByTestId('kb').props.children).toBe('up');

    await act(async () => {
      listeners['keyboardDidHide']?.();
    });
    expect(screen.getByTestId('kb').props.children).toBe('down');

    await act(async () => {
      view.unmount();
    });
    // Both subscriptions (show + hide) are removed.
    expect(removeSpies).toHaveLength(2);
    for (const remove of removeSpies) expect(remove).toHaveBeenCalledTimes(1);
  });
});
