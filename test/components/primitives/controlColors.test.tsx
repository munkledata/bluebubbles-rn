/**
 * Theme accents on native controls (src/ui/theme/controlColors.ts). Without explicit colors
 * Android draws its system accent (teal) for the text cursor, selection and switches, which
 * clashed with every Gator preset on device.
 */
import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { SwitchRow } from '@ui/primitives/SettingsRow';
import { TextField } from '@ui/primitives/TextField';
import { PRESETS, PRESET_ORDER, withAlpha } from '@ui/theme/tokens';

describe('native control accents', () => {
  it.each(PRESET_ORDER)('tints text fields with the %s accent', async (preset) => {
    await renderWithTheme(<TextField label="Name" placeholder="Your name" />, { preset });
    const { tint } = PRESETS[preset].tokens.color;
    const input = screen.getByPlaceholderText('Your name');
    expect(input.props.cursorColor).toBe(tint);
    expect(input.props.selectionHandleColor).toBe(tint);
    // A see-through highlight keeps the selected text readable.
    expect(input.props.selectionColor).toBe(withAlpha(tint, 0.35));
  });

  it.each(PRESET_ORDER)('colors settings switches with the %s accent', async (preset) => {
    await renderWithTheme(
      <SwitchRow
        label="Typing indicators"
        accessibilityLabel="Typing indicators"
        value
        onValueChange={jest.fn()}
      />,
      {
        preset,
      },
    );
    const { tint, separator } = PRESETS[preset].tokens.color;
    const toggle = screen.getByRole('switch');
    // The host switch receives the resolved colors.
    expect(toggle.props.onTintColor ?? toggle.props.trackColorForTrue).toBe(tint);
    expect(toggle.props.tintColor ?? toggle.props.trackColorForFalse).toBe(separator);
    expect(toggle.props.thumbTintColor ?? toggle.props.thumbColor).toBe('#FFFFFF');
  });
});
