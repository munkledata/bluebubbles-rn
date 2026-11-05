/**
 * MessageRow binds its message to the bubble's double-tap (♥), and gives the bubble none while
 * selecting, when the row's own tap toggles membership. MessageBubble is replaced by a probe that
 * records its props (same idea as messageRowSelect.test.tsx).
 */
import React from 'react';
import { renderWithTheme } from '../support/renderWithTheme';
import { mkMessage } from '../hooks/_fixtures';

const mockBubbleProps: Record<string, unknown>[] = [];
jest.mock('@ui/conversations/MessageBubble', () => ({
  MessageBubble: (props: Record<string, unknown>) => {
    mockBubbleProps.push(props);
    return null;
  },
}));

// eslint-disable-next-line import/first
import { MessageRow } from '@ui/conversations/MessageRow';

const base = { older: null, newer: null, isGroup: false, isLastOutgoing: false };

function lastBubbleDoubleTap(): ((target: { kind: 'body' }) => void) | undefined {
  return mockBubbleProps.at(-1)?.onDoubleTap as ((target: { kind: 'body' }) => void) | undefined;
}

beforeEach(() => {
  mockBubbleProps.length = 0;
});

describe('MessageRow — double-tap ♥', () => {
  it('binds the row’s message to a double-tap on its bubble', async () => {
    const onDoubleTap = jest.fn();
    const msg = mkMessage();
    await renderWithTheme(<MessageRow msg={msg} {...base} onDoubleTap={onDoubleTap} />);
    lastBubbleDoubleTap()?.({ kind: 'body' });
    expect(onDoubleTap).toHaveBeenCalledWith(msg, { kind: 'body' });
  });

  it('gives the bubble no double-tap while selecting', async () => {
    await renderWithTheme(
      <MessageRow
        msg={mkMessage()}
        {...base}
        onDoubleTap={jest.fn()}
        selecting
        isSelected={false}
        onToggleSelect={jest.fn()}
      />,
    );
    expect(lastBubbleDoubleTap()).toBeUndefined();
  });

  it('gives the bubble no double-tap when the list passes none', async () => {
    await renderWithTheme(<MessageRow msg={mkMessage()} {...base} />);
    expect(lastBubbleDoubleTap()).toBeUndefined();
  });
});
