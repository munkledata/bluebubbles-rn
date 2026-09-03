/**
 * ChatSearchBar is deliberately controlled by the chat screen. These tests lock in its visible
 * input, progress, result-navigation, and accessibility contract without claiming to cover the
 * screen-owned debounce or message-list navigation.
 */
import React from 'react';
import { ChatSearchBar } from '@ui/conversations/ChatSearchBar';
import { fireEvent, renderWithTheme, screen, type RenderResult } from '../support/renderWithTheme';

jest.mock('@expo/vector-icons', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => React.createElement(Text, null, name) };
});

const mockChangeText = jest.fn();
const mockGoOlder = jest.fn();
const mockGoNewer = jest.fn();

const isSpinner = (node: { type: unknown }): boolean => node.type === 'ActivityIndicator';

function spinners(view: RenderResult): unknown[] {
  if (!view.root) throw new Error('Expected a rendered ChatSearchBar root');
  return view.root.queryAll(isSpinner);
}

function bar(overrides: Partial<React.ComponentProps<typeof ChatSearchBar>> = {}) {
  return (
    <ChatSearchBar
      value="needle"
      onChangeText={mockChangeText}
      status="Result 2 of 7"
      loading
      canGoOlder
      canGoNewer={false}
      onGoOlder={mockGoOlder}
      onGoNewer={mockGoNewer}
      {...overrides}
    />
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

it('exposes the controlled query, live status, progress, clear action, and navigation state', async () => {
  const view = await renderWithTheme(bar());

  expect(screen.getByLabelText('Search messages in this conversation').props.value).toBe('needle');
  expect(screen.getByText('Result 2 of 7').props.accessibilityLiveRegion).toBe('polite');
  expect(spinners(view)).toHaveLength(1);

  await fireEvent.press(screen.getByRole('button', { name: 'Clear conversation search' }));
  expect(mockChangeText).toHaveBeenCalledWith('');

  const older = screen.getByRole('button', { name: 'Older search result' });
  const newer = screen.getByRole('button', { name: 'Newer search result' });
  expect(older.props.accessibilityState).toEqual({ disabled: false });
  expect(newer.props.accessibilityState).toEqual({ disabled: true });

  await fireEvent.press(older);
  await fireEvent.press(newer);
  expect(mockGoOlder).toHaveBeenCalledTimes(1);
  expect(mockGoNewer).not.toHaveBeenCalled();
});

it('forwards typing and updates the optional controls when its parent changes props', async () => {
  const view = await renderWithTheme(bar());
  await view.rerender(
    bar({
      value: '',
      status: 'Type at least 3 characters',
      loading: false,
      canGoOlder: false,
      canGoNewer: true,
    }),
  );

  const input = screen.getByLabelText('Search messages in this conversation');
  await fireEvent.changeText(input, 'query');
  expect(mockChangeText).toHaveBeenCalledWith('query');
  expect(screen.queryByRole('button', { name: 'Clear conversation search' })).toBeNull();
  expect(spinners(view)).toHaveLength(0);

  const older = screen.getByRole('button', { name: 'Older search result' });
  const newer = screen.getByRole('button', { name: 'Newer search result' });
  expect(older.props.accessibilityState).toEqual({ disabled: true });
  expect(newer.props.accessibilityState).toEqual({ disabled: false });

  await fireEvent.press(older);
  await fireEvent.press(newer);
  expect(mockGoOlder).not.toHaveBeenCalled();
  expect(mockGoNewer).toHaveBeenCalledTimes(1);
});
