/**
 * Proves the harness: the same consumer of `useTheme()` renders DIFFERENT colors under two
 * different presets. Expected hex values are taken straight from the preset tokens in
 * src/ui/theme/tokens.ts (darkTheme = 'oled-dark', gatorTheme = 'gator'). Both keys are in
 * PRESET_ORDER, so resolvePreset honors them (a disabled key would fall back to the default).
 */
import React from 'react';
import { Text, View } from 'react-native';
import { renderWithTheme, screen } from './support/renderWithTheme';
import { useTheme } from '@ui/theme/ThemeProvider';
import { darkTheme, gatorTheme } from '@ui/theme/tokens';

/** A minimal component that surfaces theme colors as observable output (text + style). */
function ThemeProbe(): React.JSX.Element {
  const { color } = useTheme();
  return (
    <View>
      <Text testID="tint" style={{ color: color.tint }}>
        {color.tint}
      </Text>
      <Text testID="bg" style={{ color: color.background }}>
        {color.background}
      </Text>
      <Text testID="sender" style={{ color: color.bubble.senderBackground }}>
        {color.bubble.senderBackground}
      </Text>
    </View>
  );
}

describe('renderWithTheme applies the requested preset', () => {
  it("renders the 'oled-dark' preset's colors", async () => {
    await renderWithTheme(<ThemeProbe />, { preset: 'oled-dark' });
    // Rendered text content = the exact token value (user-observable output).
    expect(screen.getByTestId('tint').props.children).toBe(darkTheme.color.tint);
    // And the same value is applied as a style (user-observable colour).
    expect(screen.getByTestId('tint').props.style).toEqual({ color: darkTheme.color.tint });
    expect(screen.getByTestId('bg').props.style).toEqual({ color: darkTheme.color.background });
    expect(screen.getByTestId('sender').props.style).toEqual({
      color: darkTheme.color.bubble.senderBackground,
    });
  });

  it("renders the 'gator' preset's colors", async () => {
    await renderWithTheme(<ThemeProbe />, { preset: 'gator' });
    expect(screen.getByTestId('tint').props.children).toBe(gatorTheme.color.tint);
    expect(screen.getByTestId('tint').props.style).toEqual({ color: gatorTheme.color.tint });
    expect(screen.getByTestId('bg').props.style).toEqual({ color: gatorTheme.color.background });
    expect(screen.getByTestId('sender').props.style).toEqual({
      color: gatorTheme.color.bubble.senderBackground,
    });
  });

  it('the two presets resolve to DIFFERENT colors (recolor is real, not a no-op)', async () => {
    // Guard against a harness that silently ignores the preset option: the token sets
    // must actually diverge, else the two tests above would pass on identical output.
    expect(darkTheme.color.tint).not.toBe(gatorTheme.color.tint);
    expect(darkTheme.color.background).not.toBe(gatorTheme.color.background);

    const first = await renderWithTheme(<ThemeProbe />, { preset: 'oled-dark' });
    const darkTint = screen.getByTestId('tint').props.children;
    await first.unmount();

    await renderWithTheme(<ThemeProbe />, { preset: 'gator' });
    const gatorTint = screen.getByTestId('tint').props.children;

    expect(darkTint).toBe(darkTheme.color.tint);
    expect(gatorTint).toBe(gatorTheme.color.tint);
    expect(darkTint).not.toBe(gatorTint);
  });
});
