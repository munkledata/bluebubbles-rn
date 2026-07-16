/**
 * SettingsSection (src/ui/primitives/SettingsSection.tsx): the iOS grouped-settings
 * container. Contract exercised here — the optional heading renders; children render
 * inside the group; hairline dividers appear BETWEEN rows only (children − 1 of them,
 * none for a single row) and conditional `null` children don't leave a stray divider.
 */
import React from 'react';
import { Text } from 'react-native';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { SettingsSection } from '@ui/primitives/SettingsSection';

describe('SettingsSection', () => {
  it('renders the heading and its children', async () => {
    await renderWithTheme(
      <SettingsSection label="ABOUT">
        <Text>Server</Text>
        <Text>Version</Text>
      </SettingsSection>,
    );
    expect(screen.getByText('ABOUT')).toBeTruthy();
    expect(screen.getByText('Server')).toBeTruthy();
    expect(screen.getByText('Version')).toBeTruthy();
  });

  it('draws a divider between rows but never before the first', async () => {
    await renderWithTheme(
      <SettingsSection label="GROUP">
        <Text>One</Text>
        <Text>Two</Text>
        <Text>Three</Text>
      </SettingsSection>,
    );
    expect(screen.getAllByTestId('settings-divider')).toHaveLength(2);
  });

  it('renders a bare single-row group with no heading and no divider', async () => {
    await renderWithTheme(
      <SettingsSection>
        <Text>Only row</Text>
      </SettingsSection>,
    );
    expect(screen.getByText('Only row')).toBeTruthy();
    expect(screen.queryAllByTestId('settings-divider')).toHaveLength(0);
  });

  it('skips conditional (null) children when placing dividers', async () => {
    await renderWithTheme(
      <SettingsSection label="GROUP">
        <Text>One</Text>
        {false ? <Text>Hidden</Text> : null}
        <Text>Two</Text>
      </SettingsSection>,
    );
    expect(screen.getAllByTestId('settings-divider')).toHaveLength(1);
  });
});
