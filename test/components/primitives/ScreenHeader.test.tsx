/**
 * ScreenHeader (src/ui/primitives/ScreenHeader.tsx): the shared '‹ Back' screen header.
 * Contract exercised here — the title renders; the back button appears ONLY when onBack
 * is provided and fires it on press; the right slot renders custom content.
 */
import React from 'react';
import { Text } from 'react-native';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { ScreenHeader } from '@ui/primitives/ScreenHeader';

// Zero insets so useSafeAreaInsets() resolves without a SafeAreaProvider.
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

describe('ScreenHeader', () => {
  it('renders the title', async () => {
    await renderWithTheme(<ScreenHeader title="Settings" />);
    expect(screen.getByText('Settings')).toBeTruthy();
  });

  it('shows the back button when onBack is provided and fires it on press', async () => {
    const onBack = jest.fn();
    await renderWithTheme(<ScreenHeader title="Settings" onBack={onBack} />);
    fireEvent.press(screen.getByText('‹ Back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders no back button without onBack', async () => {
    await renderWithTheme(<ScreenHeader title="Settings" />);
    expect(screen.queryByText('‹ Back')).toBeNull();
  });

  it('renders the right slot content', async () => {
    await renderWithTheme(<ScreenHeader title="Settings" right={<Text>Edit</Text>} />);
    expect(screen.getByText('Edit')).toBeTruthy();
  });
});
