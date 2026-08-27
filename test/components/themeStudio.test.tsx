import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { fireEvent, renderWithTheme, screen, waitFor } from './support/renderWithTheme';
import { ThemeStudio } from '@ui/theme/ThemeStudio';
import { auditThemeContrast, cloneTokens } from '@ui/theme/editableTokens';
import { gatorTheme, lightTheme } from '@ui/theme/tokens';

function darkThemeWithPrimaryText(color: string): typeof gatorTheme {
  const tokens = cloneTokens(gatorTheme);
  tokens.color.background = '#000000';
  tokens.color.secondaryBackground = '#000000';
  tokens.color.groupedBackground = '#000000';
  tokens.color.label = color;
  return tokens;
}

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

  it('uses the 4.5:1 boundary and auto-fixes every failing text role before save', async () => {
    expect(
      auditThemeContrast(darkThemeWithPrimaryText('#747474')).map((issue) => issue.id),
    ).toContain('primary-text');
    expect(
      auditThemeContrast(darkThemeWithPrimaryText('#757575')).map((issue) => issue.id),
    ).not.toContain('primary-text');

    const onApply = jest.fn();
    await renderWithTheme(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        }}
      >
        <ThemeStudio
          initialTokens={darkThemeWithPrimaryText('#747474')}
          initialName="Low contrast"
          onApply={onApply}
          onCancel={jest.fn()}
        />
      </SafeAreaProvider>,
      { preset: 'gator' },
    );

    expect(screen.getByText('Low contrast')).toBeTruthy();
    expect(screen.getByText('Primary text')).toBeTruthy();
    await fireEvent.press(screen.getByRole('button', { name: 'Auto-fix text colors' }));
    await waitFor(() => expect(screen.queryByText('Low contrast')).toBeNull());

    await fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    const [tokens] = onApply.mock.calls[0] as [typeof gatorTheme, string];
    expect(auditThemeContrast(tokens)).toEqual([]);
  });

  it('requires a separate explicit confirmation to save unresolved low contrast', async () => {
    const onApply = jest.fn();
    await renderWithTheme(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        }}
      >
        <ThemeStudio
          initialTokens={darkThemeWithPrimaryText('#747474')}
          initialName="Confirmed"
          onApply={onApply}
          onCancel={jest.fn()}
        />
      </SafeAreaProvider>,
      { preset: 'gator' },
    );

    await fireEvent.press(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByText(/choose Apply anyway to confirm/)).toBeTruthy();

    await fireEvent.press(screen.getByRole('button', { name: 'Apply unreadable theme anyway' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
  });
});
