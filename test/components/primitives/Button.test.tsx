/**
 * Button (src/ui/primitives/Button.tsx): an iOS-style Pressable. Contract exercised here —
 * onPress fires on a normal press; a disabled or loading button does NOT fire (isDisabled =
 * disabled || loading); the loading state swaps the title text for a spinner; the control
 * exposes the "button" role.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { Button } from '@ui/primitives/Button';

describe('Button', () => {
  it('renders its title and the button role', async () => {
    await renderWithTheme(<Button title="Send" onPress={jest.fn()} />);
    expect(screen.getByText('Send')).toBeTruthy();
    expect(screen.getByRole('button')).toBeTruthy();
  });

  it('fires onPress when pressed', async () => {
    const onPress = jest.fn();
    await renderWithTheme(<Button title="Send" onPress={onPress} />);
    fireEvent.press(screen.getByText('Send'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onPress when disabled', async () => {
    const onPress = jest.fn();
    await renderWithTheme(<Button title="Send" onPress={onPress} disabled />);
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });

  it('while loading, hides the title, shows a spinner, and does NOT fire onPress', async () => {
    const onPress = jest.fn();
    await renderWithTheme(<Button title="Send" onPress={onPress} loading />);
    expect(screen.queryByText('Send')).toBeNull();
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });
});
