import React from 'react';
import { StyleSheet, Text, type TextStyle, type ViewStyle } from 'react-native';
import { ErrorBoundary } from '@ui/ErrorBoundary';
import { SwipeableRow, type SwipeAction } from '@ui/conversations/SwipeableRow';
import { contrastRatio } from '@ui/theme/adaptiveFromImage';
import { render, renderWithTheme, screen } from './support/renderWithTheme';

function Boom(): React.JSX.Element {
  throw new Error('UI-01 fallback fixture');
}

function expectReadable(foreground: unknown, background: unknown): void {
  expect(typeof foreground).toBe('string');
  expect(typeof background).toBe('string');
  expect(contrastRatio(foreground as string, background as string)).toBeGreaterThanOrEqual(4.5);
}

describe('UI-01 rendered control contrast', () => {
  it('keeps the top-level retry label readable against its fixed button background', async () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );

      const buttonStyle = StyleSheet.flatten(
        screen.getByRole('button', { name: 'Try again' }).props.style,
      ) as ViewStyle;
      const labelStyle = StyleSheet.flatten(screen.getByText('Try Again').props.style) as TextStyle;
      expectReadable(labelStyle.color, buttonStyle.backgroundColor);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('keeps every built-in conversation swipe-action label readable', async () => {
    const actions: SwipeAction[] = [
      {
        key: 'read',
        label: 'Read',
        icon: 'mail-open-outline',
        color: '#34C759',
        onPress: jest.fn(),
      },
      {
        key: 'mute',
        label: 'Mute',
        icon: 'notifications-off-outline',
        color: '#FF9500',
        onPress: jest.fn(),
      },
      {
        key: 'archive',
        label: 'Archive',
        icon: 'archive-outline',
        color: '#8E8E93',
        onPress: jest.fn(),
      },
      {
        key: 'delete',
        label: 'Delete',
        icon: 'trash-outline',
        color: '#FF3B30',
        onPress: jest.fn(),
      },
    ];

    await renderWithTheme(
      <SwipeableRow resetKey="ui-01" right={actions}>
        <Text>Conversation</Text>
      </SwipeableRow>,
    );

    for (const action of actions) {
      const buttonStyle = StyleSheet.flatten(
        screen.getByRole('button', { name: action.label }).props.style,
      ) as ViewStyle;
      const labelStyle = StyleSheet.flatten(
        screen.getByText(action.label).props.style,
      ) as TextStyle;
      expectReadable(labelStyle.color, buttonStyle.backgroundColor);
    }
  });
});
