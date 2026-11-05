import React from 'react';
import { Keyboard, StyleSheet, type EmitterSubscription } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { act, fireEvent, renderWithTheme, screen, waitFor } from './support/renderWithTheme';
import { ThemeStudio } from '@ui/theme/ThemeStudio';
import { auditThemeContrast, cloneTokens } from '@ui/theme/editableTokens';
import { gatorTheme, lightTheme } from '@ui/theme/tokens';

let mockKavProps: Record<string, unknown> = {};
// RNTL exposes only the host tree, so capture the composite KeyboardAvoidingView props through a
// small stand-in (as manualSetupScreen.test does). Its native movement remains device-only evidence.
jest.mock('react-native/Libraries/Components/Keyboard/KeyboardAvoidingView', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) => {
      mockKavProps = props;
      return R.createElement(R.Fragment, null, props.children as React.ReactNode);
    },
  };
});

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

  it('lets the contrast sample grow with large text instead of clipping it', async () => {
    await renderWithTheme(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        }}
      >
        <ThemeStudio
          initialTokens={darkThemeWithPrimaryText('#747474')}
          initialName="Large text"
          onApply={jest.fn()}
          onCancel={jest.fn()}
        />
      </SafeAreaProvider>,
      { preset: 'gator' },
    );

    const sampleBox = StyleSheet.flatten(screen.getAllByText('Aa')[0]?.parent?.props.style);
    expect(sampleBox).toEqual(expect.objectContaining({ minWidth: 44, minHeight: 36 }));
    expect(sampleBox.width).toBeUndefined();
    expect(sampleBox.height).toBeUndefined();
  });

  it('requires an in-studio discard choice after theme fields change', async () => {
    const onCancel = jest.fn();
    await renderWithTheme(
      <SafeAreaProvider
        initialMetrics={{
          frame: { x: 0, y: 0, width: 390, height: 844 },
          insets: { top: 0, right: 0, bottom: 0, left: 0 },
        }}
      >
        <ThemeStudio initialTokens={gatorTheme} onApply={jest.fn()} onCancel={onCancel} />
      </SafeAreaProvider>,
    );

    // The backup holds at most 256 UTF-16 units per theme name; never let one be typed longer.
    expect(screen.getByLabelText('Theme name').props.maxLength).toBe(256);
    await act(async () => {
      fireEvent.changeText(screen.getByLabelText('Theme name'), 'Changed theme');
    });
    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Cancel theme changes' }));
    });

    expect(onCancel).not.toHaveBeenCalled();
    expect(screen.getByText('Discard changes?')).toBeTruthy();
    await act(async () => {
      fireEvent.press(screen.getByText('Keep Editing'));
    });
    expect(screen.queryByText('Discard changes?')).toBeNull();

    await act(async () => {
      fireEvent.press(screen.getByRole('button', { name: 'Cancel theme changes' }));
    });
    await act(async () => {
      fireEvent.press(screen.getByText('Discard'));
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
  it('keeps the color fields above the keyboard inside its Modal', async () => {
    const listeners: Record<string, () => void> = {};
    const addListener = jest.spyOn(Keyboard, 'addListener').mockImplementation((event, cb) => {
      listeners[event] = cb as () => void;
      return { remove: jest.fn() } as unknown as EmitterSubscription;
    });
    try {
      await renderWithTheme(
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 390, height: 844 },
            insets: { top: 0, right: 0, bottom: 0, left: 0 },
          }}
        >
          <ThemeStudio
            initialTokens={gatorTheme}
            initialName="Mine"
            onApply={jest.fn()}
            onCancel={jest.fn()}
          />
        </SafeAreaProvider>,
        { preset: 'gator' },
      );
      // The live preview reads as one element, not as sample messages.
      expect(screen.getByLabelText('Theme preview').props.accessible).toBe(true);
      expect(mockKavProps.behavior).toBe('padding');
      expect(mockKavProps.enabled).toBe(false);
      expect(mockKavProps.keyboardVerticalOffset).toBeUndefined();

      await act(async () => {
        listeners['keyboardDidShow']?.();
      });
      expect(mockKavProps.enabled).toBe(true);
    } finally {
      addListener.mockRestore();
    }
  });
});
