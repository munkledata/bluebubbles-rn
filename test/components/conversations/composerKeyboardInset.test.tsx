/**
 * Composer bottom-inset rule (src/ui/conversations/Composer.tsx) — the fix for the empty band that
 * appeared between the composer and the soft keyboard on Android edge-to-edge.
 *
 * THE RULE: the bar's bottom safe-area reservation is the UNION of the keyboard and the navigation
 * bar, never their SUM. `useSafeAreaInsets().bottom` is the nav-bar inset and does NOT shrink when
 * the keyboard opens (safe-area-context asks for statusBars|displayCutout|navigationBars|captionBar,
 * never `ime()`), while Android's IME inset is measured from the window bottom and already spans
 * that same strip. Reserving both stacks a nav bar's worth of dead space (~32dp gesture, ~56dp
 * 3-button) above the keyboard.
 *
 * The actual gap is device-only — RNTL has no soft keyboard, the KeyboardAvoidingView's padding is
 * always 0 here, and the default insets are all 0 — so this suite tests the one thing that IS
 * node-observable: the arithmetic Composer applies to a NON-ZERO bottom inset in each keyboard
 * state. That is exactly the line that regressed, and exactly the line someone would "tidy" back.
 *
 * The companion invariant (the chat screen's KeyboardAvoidingView must carry NO
 * `keyboardVerticalOffset` counterweight) is locked in routes/chatScreen.test.tsx — the two must
 * change together or the composer ends up BEHIND the keyboard.
 *
 * In-file mocks: `react-native-safe-area-context` (a REAL 48dp bottom inset, unlike the sibling
 * composer suite's zeros — the whole point is that the inset is non-zero); `@ui/hooks/
 * useKeyboardVisible` (a subscribable fake, so a test can drive the keyboard show/hide transition
 * through real state and get past React.memo); AttachmentTray / Ionicons / expo-image / the
 * datetime picker, mirroring composer.test.tsx.
 */
import React from 'react';
import { StyleSheet } from 'react-native';
import { renderWithTheme, screen, fireEvent, act, waitFor } from '../support/renderWithTheme';

const NAV_BAR = 48; // a 3-button navigation bar — the worst case for the double-count

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 48, left: 0, right: 0 }),
}));

// A subscribable stand-in for the real hook. Backed by component state so flipping it re-renders
// the MEMOIZED Composer (a bare `rerender` with identical props would bail out of the memo).
let mockKbVisible = false;
let mockKbSubs: ((v: boolean) => void)[] = [];
jest.mock('@ui/hooks/useKeyboardVisible', () => {
  const R = require('react');
  return {
    useKeyboardVisible: () => {
      const [v, setV] = R.useState(mockKbVisible);
      R.useEffect(() => {
        const fn = (next: boolean): void => setV(next);
        mockKbSubs.push(fn);
        return () => {
          mockKbSubs = mockKbSubs.filter((f: unknown) => f !== fn);
        };
      }, []);
      return v;
    },
  };
});

jest.mock('@expo/vector-icons', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { Ionicons: ({ name }: { name: string }) => R.createElement(Text, null, name) };
});

jest.mock('expo-image', () => {
  const R = require('react');
  const { View } = require('react-native');
  return { Image: (props: Record<string, unknown>) => R.createElement(View, props) };
});

jest.mock('@react-native-community/datetimepicker', () => ({
  DateTimePickerAndroid: { open: jest.fn() },
}));

// The real tray imports expo-image-picker / expo-media-library. A marker stub is enough: this
// suite only cares WHETHER it is mounted.
jest.mock('@ui/conversations/AttachmentTray', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return {
    ATTACHMENT_TRAY_HEIGHT: 104,
    AttachmentTray: () => R.createElement(Text, { testID: 'attachment-tray' }, 'tray'),
  };
});

// eslint-disable-next-line import/first
import { Composer } from '@ui/conversations/Composer';

/** Drive the keyboard show/hide transition through the faked hook's state. */
async function setKeyboardVisible(visible: boolean): Promise<void> {
  mockKbVisible = visible;
  await act(async () => {
    mockKbSubs.forEach((fn) => fn(visible));
  });
}

function composerPaddingBottom(): number {
  const style = StyleSheet.flatten(screen.getByTestId('composer-bar').props.style) as {
    paddingBottom?: number;
  };
  return style.paddingBottom ?? -1;
}

beforeEach(() => {
  mockKbVisible = false;
  mockKbSubs = [];
});

describe('Composer bottom inset — union of keyboard and nav bar, never their sum', () => {
  it('reserves the nav-bar inset (plus breathing room) while the keyboard is DOWN', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    // Nothing is covering the navigation bar, so the bar must clear it itself.
    expect(composerPaddingBottom()).toBe(NAV_BAR + 8);
  });

  it('COLLAPSES the nav-bar inset while the keyboard is UP (the band this fixed)', async () => {
    mockKbVisible = true;
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    // The keyboard already covers the nav-bar strip; reserving it again is what produced the
    // visible empty band. Only the 8dp of breathing room under the input pill survives.
    expect(composerPaddingBottom()).toBe(8);
  });

  it('collapses and restores across a show/hide cycle', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    expect(composerPaddingBottom()).toBe(NAV_BAR + 8);
    await setKeyboardVisible(true);
    await waitFor(() => expect(composerPaddingBottom()).toBe(8));
    // Restoring matters as much as collapsing: a bar left at 8dp with the keyboard down sits
    // under the navigation bar.
    await setKeyboardVisible(false);
    await waitFor(() => expect(composerPaddingBottom()).toBe(NAV_BAR + 8));
  });

  it('keeps the breathing room identical in both states (the bar looks the same either way)', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} />);
    const down = composerPaddingBottom();
    await setKeyboardVisible(true);
    await waitFor(() => expect(composerPaddingBottom()).toBe(down - NAV_BAR));
  });
});

describe('Composer — the attachment tray and the keyboard are mutually exclusive', () => {
  it('closes the tray when the keyboard comes up', async () => {
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={jest.fn()} />);
    fireEvent.press(screen.getByLabelText('Attach photo or file'));
    expect(await screen.findByTestId('attachment-tray')).toBeTruthy();

    // Android's Back closes the IME WITHOUT blurring the input, so tapping the still-focused field
    // reopens the keyboard and fires NO onFocus — the path that let the tray's 104dp stack under
    // the input alongside the keyboard.
    await setKeyboardVisible(true);
    await waitFor(() => expect(screen.queryByTestId('attachment-tray')).toBeNull());
  });

  it('does not fight a tray opened while the keyboard is on its way down', async () => {
    // toggleTray calls Keyboard.dismiss() and opens the tray in the same tick, so the tray is
    // mounted while kbVisible is still true. The guard keys on the TRANSITION, so it must not
    // immediately close it again.
    mockKbVisible = true;
    await renderWithTheme(<Composer onSend={jest.fn()} onSendAttachments={jest.fn()} />);
    fireEvent.press(screen.getByLabelText('Attach photo or file'));
    expect(await screen.findByTestId('attachment-tray')).toBeTruthy();
    // …and it closes once the keyboard has actually gone.
    await setKeyboardVisible(false);
    expect(screen.getByTestId('attachment-tray')).toBeTruthy();
  });
});
