/**
 * ChatThemeProvider (src/ui/theme/ChatThemeProvider.tsx): overrides the active theme for one
 * conversation. A valid stored theme-tokens blob makes `useTheme()` inside the chat return the
 * per-chat tokens; a null/absent/corrupt blob falls through to the app theme UNCHANGED — the same
 * structural tree either way (the foundation of the "wallpaper flag arrives async → flip styles,
 * not tree structure" gotcha).
 *
 * The per-chat row arrives via a reactive DB query (useReactiveQuery → getChatTheme). We mock that
 * hook in-file so we can drive the stored tokens directly (the real hook opens op-sqlite, which
 * throws off-device). A probe component below the provider reads useTheme().color.tint and renders
 * it, so we can assert which theme won.
 */
import React from 'react';
import { Text } from 'react-native';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { ChatThemeProvider } from '@ui/theme/ChatThemeProvider';
import { useTheme } from '@ui/theme/ThemeProvider';
import { lightTheme } from '@ui/theme/tokens';
import { useReactiveQuery } from '@db/useReactiveQuery';

// The reactive per-chat theme query. Mocked so the test controls the stored row and no real
// op-sqlite handle is touched. getChatTheme is never called (the run fn isn't executed).
jest.mock('@db/useReactiveQuery', () => ({ useReactiveQuery: jest.fn() }));
jest.mock('@db/repositories', () => ({ getChatTheme: jest.fn() }));

const mockedReactive = useReactiveQuery as jest.Mock;

/** Feed ChatThemeProvider's useChatTheme() the given raw chat-theme row. */
function seedChatTheme(row: { themeTokens: string | null }): void {
  mockedReactive.mockReturnValue({
    data: {
      themeTokens: row.themeTokens,
      backgroundUri: null,
      syncedBackgroundUri: null,
      backgroundIsLight: null,
    },
    isLoading: false,
    error: null,
  });
}

function TintProbe(): React.JSX.Element {
  return <Text>{useTheme().color.tint}</Text>;
}

// The app default preset (oled-dark) resolves iMessage blue as its tint.
const APP_TINT = '#1982FC';
const CHAT_TINT = '#ABCDEF';

describe('ChatThemeProvider', () => {
  beforeEach(() => {
    mockedReactive.mockReset();
  });

  it('applies a valid per-chat tokens blob to a useTheme() consumer below it', async () => {
    const chatTokens = { ...lightTheme, color: { ...lightTheme.color, tint: CHAT_TINT } };
    seedChatTheme({ themeTokens: JSON.stringify(chatTokens) });

    await renderWithTheme(
      <ChatThemeProvider guid="g1">
        <TintProbe />
      </ChatThemeProvider>,
    );

    // The nested ThemeContext.Provider wins over the app theme for this subtree.
    expect(screen.getByText(CHAT_TINT)).toBeTruthy();
  });

  it('falls through to the app theme when there is no per-chat override', async () => {
    seedChatTheme({ themeTokens: null });

    await renderWithTheme(
      <ChatThemeProvider guid="g2">
        <TintProbe />
      </ChatThemeProvider>,
    );

    // No override → children inherit the global provider (default preset tint), unchanged.
    expect(screen.getByText(APP_TINT)).toBeTruthy();
  });

  it('falls through to the app theme when the stored tokens are corrupt (never crashes)', async () => {
    seedChatTheme({ themeTokens: 'not-json{' });

    await renderWithTheme(
      <ChatThemeProvider guid="g3">
        <TintProbe />
      </ChatThemeProvider>,
    );

    expect(screen.getByText(APP_TINT)).toBeTruthy();
  });
});
