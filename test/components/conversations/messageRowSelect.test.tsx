/**
 * MessageRow multi-select mode: the check circle + full-row toggle overlay. MessageBubble is
 * mocked (same pattern as messageRowMemo.test.tsx) to keep its ky/native import graph out.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent } from '../support/renderWithTheme';
import { mkMessage } from '../hooks/_fixtures';

jest.mock('@ui/conversations/MessageBubble', () => ({ MessageBubble: () => null }));

// eslint-disable-next-line import/first
import { MessageRow } from '@ui/conversations/MessageRow';

const base = { older: null, newer: null, isGroup: false, isLastOutgoing: false };

describe('MessageRow — multi-select', () => {
  it('shows no checkbox outside select mode', async () => {
    await renderWithTheme(<MessageRow msg={mkMessage()} {...base} />);
    expect(screen.queryByLabelText('Select message')).toBeNull();
  });

  it('renders an unchecked toggle that fires onToggleSelect with the message', async () => {
    const onToggleSelect = jest.fn();
    const msg = mkMessage();
    await renderWithTheme(
      <MessageRow
        msg={msg}
        {...base}
        selecting
        isSelected={false}
        onToggleSelect={onToggleSelect}
      />,
    );
    const toggle = screen.getByLabelText('Select message');
    expect(toggle.props.accessibilityState).toEqual({ checked: false });
    fireEvent.press(toggle);
    expect(onToggleSelect).toHaveBeenCalledWith(msg);
  });

  it('marks a selected row checked (with the ✓ glyph)', async () => {
    await renderWithTheme(
      <MessageRow msg={mkMessage()} {...base} selecting isSelected onToggleSelect={jest.fn()} />,
    );
    expect(screen.getByLabelText('Deselect message').props.accessibilityState).toEqual({
      checked: true,
    });
    expect(screen.getByText('✓')).toBeTruthy();
  });
});
