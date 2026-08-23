import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { fireEvent, renderWithTheme, screen, waitFor } from './support/renderWithTheme';
import { ThemeStudio } from '@ui/theme/ThemeStudio';
import { gatorTheme, lightTheme } from '@ui/theme/tokens';

describe('ThemeStudio dark-only editor', () => {
  it('does not offer a fake light mode and converts a legacy light seed to dark colors', async () => {
    const onApply = jest.fn();
    await renderWithTheme(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        }}
      >
        <ThemeStudio
          initialTokens={lightTheme}
          initialName="Legacy"
          onApply={onApply}
          onCancel={jest.fn()}
        />
      </SafeAreaProvider>,
      { preset: 'gator' },
    );

    expect(screen.queryByText('Light')).toBeNull();
    fireEvent.press(screen.getByText('Apply'));

    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const [tokens, name] = onApply.mock.calls[0] as [typeof gatorTheme, string];
    expect(name).toBe('Legacy');
    expect(tokens.mode).toBe('dark');
    expect(tokens.color.background).toBe(gatorTheme.color.background);
    expect(tokens.color.background).not.toBe(lightTheme.color.background);
  });
});
