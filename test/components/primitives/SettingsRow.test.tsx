/**
 * The SettingsRow family (src/ui/primitives/SettingsRow.tsx). Contracts exercised here —
 *   InfoRow: renders label + value.
 *   SwitchRow: valueChange fires the handler; `disabled` reaches the Switch.
 *   NavRow: press fires onPress; disclosure chevron by default, hidden with
 *     chevron={false}; a disabled row does NOT fire.
 *   CheckRow: checkmark only when checked (exposed as the selected state); a loading
 *     row swaps the checkmark for a spinner; a disabled row does NOT fire.
 *   StepperRow: − / + fire their handlers; an exhausted side is disabled.
 *   NoteRow: renders its caption.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';
import {
  CheckRow,
  InfoRow,
  NavRow,
  NoteRow,
  StepperRow,
  SwitchRow,
} from '@ui/primitives/SettingsRow';

describe('InfoRow', () => {
  it('renders the label and the value', async () => {
    await renderWithTheme(<InfoRow label="Server" value="example.com" />);
    expect(screen.getByText('Server')).toBeTruthy();
    expect(screen.getByText('example.com')).toBeTruthy();
  });
});

describe('SwitchRow', () => {
  it('fires onValueChange from the switch', async () => {
    const onValueChange = jest.fn();
    await renderWithTheme(
      <SwitchRow
        label="App Lock"
        value={false}
        onValueChange={onValueChange}
        accessibilityLabel="Toggle app lock"
      />,
    );
    fireEvent(screen.getByLabelText('Toggle app lock'), 'valueChange', true);
    expect(onValueChange).toHaveBeenCalledWith(true);
  });

  it('passes disabled through to the switch', async () => {
    await renderWithTheme(
      <SwitchRow
        label="Gated"
        value={false}
        onValueChange={jest.fn()}
        disabled
        accessibilityLabel="Gated toggle"
      />,
    );
    expect(screen.getByLabelText('Gated toggle').props.disabled).toBe(true);
  });
});

describe('NavRow', () => {
  it('fires onPress and shows the disclosure chevron by default', async () => {
    const onPress = jest.fn();
    await renderWithTheme(<NavRow label="Server Health…" onPress={onPress} />);
    expect(screen.getByText('›')).toBeTruthy();
    fireEvent.press(screen.getByText('Server Health…'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('hides the chevron with chevron={false}', async () => {
    await renderWithTheme(<NavRow label="Disconnect" chevron={false} onPress={jest.fn()} />);
    expect(screen.queryByText('›')).toBeNull();
  });

  it('does NOT fire onPress when disabled', async () => {
    const onPress = jest.fn();
    await renderWithTheme(<NavRow label="Sync Contacts" disabled onPress={onPress} />);
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('CheckRow', () => {
  it('shows the checkmark when checked and exposes the selected state', async () => {
    await renderWithTheme(<CheckRow label="OLED Dark" checked onPress={jest.fn()} />);
    expect(screen.getByText('✓')).toBeTruthy();
    expect(screen.getByRole('button', { selected: true })).toBeTruthy();
  });

  it('hides the checkmark when unchecked and fires onPress', async () => {
    const onPress = jest.fn();
    await renderWithTheme(<CheckRow label="Bright White" checked={false} onPress={onPress} />);
    expect(screen.queryByText('✓')).toBeNull();
    fireEvent.press(screen.getByText('Bright White'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('swaps the checkmark for a spinner while loading', async () => {
    await renderWithTheme(<CheckRow label="a@icloud.com" checked loading onPress={jest.fn()} />);
    expect(screen.queryByText('✓')).toBeNull();
  });

  it('does NOT fire onPress when disabled', async () => {
    const onPress = jest.fn();
    await renderWithTheme(
      <CheckRow label="b@icloud.com" checked={false} disabled onPress={onPress} />,
    );
    fireEvent.press(screen.getByRole('button'));
    expect(onPress).not.toHaveBeenCalled();
  });
});

describe('StepperRow', () => {
  it('shows the value and fires the − / + handlers', async () => {
    const onDecrement = jest.fn();
    const onIncrement = jest.fn();
    await renderWithTheme(
      <StepperRow
        label="Parallel Downloads"
        value={2}
        onDecrement={onDecrement}
        onIncrement={onIncrement}
        canDecrement
        canIncrement
        decrementLabel="Fewer parallel downloads"
        incrementLabel="More parallel downloads"
      />,
    );
    expect(screen.getByText('2')).toBeTruthy();
    // Two presses in one test: await each act scope (an un-awaited pair overlaps act()
    // under React 19 and corrupts every later test in the file — see AGENTS.md).
    await act(async () => {
      fireEvent.press(screen.getByLabelText('Fewer parallel downloads'));
    });
    await act(async () => {
      fireEvent.press(screen.getByLabelText('More parallel downloads'));
    });
    expect(onDecrement).toHaveBeenCalledTimes(1);
    expect(onIncrement).toHaveBeenCalledTimes(1);
  });

  it('an exhausted side is disabled and does NOT fire', async () => {
    const onDecrement = jest.fn();
    await renderWithTheme(
      <StepperRow
        label="Messages per Chat"
        value="All"
        onDecrement={onDecrement}
        onIncrement={jest.fn()}
        canDecrement={false}
        canIncrement
        decrementLabel="Fewer messages per chat"
        incrementLabel="More messages per chat"
      />,
    );
    fireEvent.press(screen.getByLabelText('Fewer messages per chat'));
    expect(onDecrement).not.toHaveBeenCalled();
  });
});

describe('NoteRow', () => {
  it('renders its caption', async () => {
    await renderWithTheme(<NoteRow text="Caps the initial sync per chat." />);
    expect(screen.getByText('Caps the initial sync per chat.')).toBeTruthy();
  });
});
