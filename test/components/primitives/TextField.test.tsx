/**
 * TextField accessibility contract: a visual label programmatically names its input, while an
 * explicit accessible name supplied by a caller remains authoritative.
 */
import React from 'react';
import { Text } from 'react-native';
import { TextField } from '@ui/primitives/TextField';
import { renderWithTheme, screen } from '../support/renderWithTheme';

describe('TextField', () => {
  it('associates each visual label with its own input', async () => {
    await renderWithTheme(
      <>
        <TextField label="Server URL" placeholder="https://example.test" />
        <TextField label="Password" placeholder="Server password" />
      </>,
    );

    const urlLabel = screen.getByText('Server URL');
    const passwordLabel = screen.getByText('Password');
    const urlInput = screen.getByPlaceholderText('https://example.test');
    const passwordInput = screen.getByPlaceholderText('Server password');

    expect(urlLabel.props.nativeID).toMatch(/^text-field-label-/);
    expect(passwordLabel.props.nativeID).toMatch(/^text-field-label-/);
    expect(urlLabel.props.nativeID).not.toBe(passwordLabel.props.nativeID);
    expect(urlInput.props.accessibilityLabelledBy).toBe(urlLabel.props.nativeID);
    expect(passwordInput.props.accessibilityLabelledBy).toBe(passwordLabel.props.nativeID);
    expect(urlInput).toHaveAccessibleName('Server URL');
    expect(passwordInput).toHaveAccessibleName('Password');
  });

  it('preserves an explicit accessible name instead of overriding it with the visual label', async () => {
    await renderWithTheme(
      <TextField
        label="Password"
        placeholder="Server password"
        accessibilityLabel="Connection password"
      />,
    );

    const input = screen.getByPlaceholderText('Server password');
    expect(input.props.accessibilityLabel).toBe('Connection password');
    expect(input.props.accessibilityLabelledBy).toBeUndefined();
    expect(input).toHaveAccessibleName('Connection password');
  });

  it('preserves an explicit ARIA label', async () => {
    await renderWithTheme(
      <TextField label="Password" placeholder="Server password" aria-label="ARIA password" />,
    );

    const input = screen.getByPlaceholderText('Server password');
    expect(input.props['aria-label']).toBe('ARIA password');
    expect(input.props.accessibilityLabelledBy).toBeUndefined();
    expect(input).toHaveAccessibleName('ARIA password');
  });

  it('preserves an explicit React Native label relationship', async () => {
    await renderWithTheme(
      <>
        <Text nativeID="external-native-label">External native label</Text>
        <TextField
          label="Server URL"
          placeholder="https://example.test"
          accessibilityLabelledBy="external-native-label"
        />
      </>,
    );

    const input = screen.getByPlaceholderText('https://example.test');
    expect(input.props.accessibilityLabelledBy).toBe('external-native-label');
    expect(input).toHaveAccessibleName('External native label');
  });

  it('preserves an explicit ARIA label relationship', async () => {
    await renderWithTheme(
      <>
        <Text nativeID="external-aria-label">External ARIA label</Text>
        <TextField
          label="Server URL"
          placeholder="https://example.test"
          aria-labelledby="external-aria-label"
        />
      </>,
    );

    const input = screen.getByPlaceholderText('https://example.test');
    expect(input.props['aria-labelledby']).toBe('external-aria-label');
    expect(input.props.accessibilityLabelledBy).toBeUndefined();
    expect(input).toHaveAccessibleName('External ARIA label');
  });
});
