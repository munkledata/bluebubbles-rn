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
import { act, renderWithTheme, screen } from '../support/renderWithTheme';
import { ChatThemeProvider, useChatBackgroundUri } from '@ui/theme/ChatThemeProvider';
import { useTheme } from '@ui/theme/ThemeProvider';
import { gatorTheme, lightTheme } from '@ui/theme/tokens';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { getChatTheme } from '@db/repositories';
import {
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';

// The reactive per-chat theme query. Mocked so the test controls the stored row and no real
// op-sqlite handle is touched. getChatTheme is never called (the run fn isn't executed).
jest.mock('@db/useReactiveQuery', () => ({ useReactiveQuery: jest.fn() }));
jest.mock('@db/repositories', () => ({ getChatTheme: jest.fn() }));

const mockedReactive = useReactiveQuery as jest.Mock;
const mockedGetChatTheme = getChatTheme as jest.Mock;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Feed ChatThemeProvider's useChatTheme() the given raw chat-theme row. */
function seedChatTheme(row: {
  themeTokens: string | null;
  backgroundUri?: string | null;
  syncedBackgroundUri?: string | null;
}): void {
  mockedReactive.mockReturnValue({
    data: {
      themeTokens: row.themeTokens,
      backgroundUri: row.backgroundUri ?? null,
      syncedBackgroundUri: row.syncedBackgroundUri ?? null,
      backgroundIsLight: null,
    },
    isLoading: false,
    error: null,
  });
}

function TintProbe(): React.JSX.Element {
  return <Text>{useTheme().color.tint}</Text>;
}

/** TintProbe that also counts MOUNTS (the mount effect fires again only if the subtree remounts). */
const mountSpy = jest.fn();
function MountProbe(): React.JSX.Element {
  React.useEffect(() => {
    mountSpy();
  }, []);
  return <Text>{useTheme().color.tint}</Text>;
}

// The app default preset (oled-dark) resolves iMessage blue as its tint.
const APP_TINT = '#1982FC';
const CHAT_TINT = '#ABCDEF';

describe('ChatThemeProvider', () => {
  beforeEach(() => {
    resumeRealtimeDeliveries();
    mockedReactive.mockReset();
    mockedGetChatTheme.mockReset();
    mountSpy.mockClear();
  });

  afterEach(() => {
    resumeRealtimeDeliveries();
  });

  it('applies a valid per-chat tokens blob to a useTheme() consumer below it', async () => {
    const chatTokens = { ...gatorTheme, color: { ...gatorTheme.color, tint: CHAT_TINT } };
    seedChatTheme({ themeTokens: JSON.stringify(chatTokens) });

    await renderWithTheme(
      <ChatThemeProvider guid="g1">
        <TintProbe />
      </ChatThemeProvider>,
    );

    // The nested ThemeContext.Provider wins over the app theme for this subtree.
    expect(screen.getByText(CHAT_TINT)).toBeTruthy();
  });

  it('contains a legacy light per-chat theme and keeps the global dark theme', async () => {
    const chatTokens = { ...lightTheme, color: { ...lightTheme.color, tint: CHAT_TINT } };
    seedChatTheme({ themeTokens: JSON.stringify(chatTokens) });

    await renderWithTheme(
      <ChatThemeProvider guid="legacy-light">
        <TintProbe />
      </ChatThemeProvider>,
    );

    expect(screen.getByText(APP_TINT)).toBeTruthy();
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

  it('does NOT remount the subtree when the per-chat theme lands async (stable element type)', async () => {
    // First render: the reactive row hasn't loaded yet — exactly what happens on chat open.
    seedChatTheme({ themeTokens: null });
    const view = await renderWithTheme(
      <ChatThemeProvider guid="g4">
        <MountProbe />
      </ChatThemeProvider>,
    );
    expect(screen.getByText(APP_TINT)).toBeTruthy();
    expect(mountSpy).toHaveBeenCalledTimes(1);

    // The per-chat row arrives (reactive query resolves) → the provider re-renders with tokens.
    const chatTokens = { ...gatorTheme, color: { ...gatorTheme.color, tint: CHAT_TINT } };
    seedChatTheme({ themeTokens: JSON.stringify(chatTokens) });
    await act(async () => {
      view.rerender(
        <ChatThemeProvider guid="g4">
          <MountProbe />
        </ChatThemeProvider>,
      );
    });

    // The chat theme applied WITHOUT remounting the child. A remount here (Fragment→Provider
    // element-type flip) would wipe composer draft/scroll — the AGENTS.md async-flag gotcha.
    expect(screen.getByText(CHAT_TINT)).toBeTruthy();
    expect(mountSpy).toHaveBeenCalledTimes(1);
  });

  it('discards an account-A row when its DB read resolves after the account is retired', async () => {
    let runRead!: () => Promise<unknown>;
    mockedReactive.mockImplementation((run: () => Promise<unknown>) => {
      runRead = run;
      return { data: null, isLoading: true, error: null };
    });
    const oldRow = deferred<{
      themeTokens: string;
      backgroundUri: string;
      syncedBackgroundUri: null;
      backgroundIsLight: number;
    }>();
    mockedGetChatTheme.mockReturnValueOnce(oldRow.promise);
    await renderWithTheme(
      <ChatThemeProvider guid="account-a-chat">
        <TintProbe />
      </ChatThemeProvider>,
    );

    const pending = runRead();
    expect(mockedGetChatTheme).toHaveBeenCalledTimes(1);
    // Reactive reads have no durable side effect, so they do not hold Disconnect open. Their
    // captured generation instead makes the eventual result unusable.
    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    oldRow.resolve({
      themeTokens: JSON.stringify({
        ...gatorTheme,
        color: { ...gatorTheme.color, tint: CHAT_TINT },
      }),
      backgroundUri: 'file://account-a.jpg',
      syncedBackgroundUri: null,
      backgroundIsLight: 0,
    });

    await expect(pending).resolves.toBeNull();
  });

  it('stops rendering an already-resolved account-A theme on the first handoff rerender', async () => {
    const chatTokens = { ...gatorTheme, color: { ...gatorTheme.color, tint: CHAT_TINT } };
    seedChatTheme({ themeTokens: JSON.stringify(chatTokens) });
    const view = await renderWithTheme(
      <ChatThemeProvider guid="account-a-chat">
        <TintProbe />
      </ChatThemeProvider>,
    );
    expect(screen.getByText(CHAT_TINT)).toBeTruthy();

    await pauseRealtimeDeliveries();
    resumeRealtimeDeliveries();
    await act(async () => {
      view.rerender(
        <ChatThemeProvider guid="account-a-chat">
          <TintProbe />
        </ChatThemeProvider>,
      );
    });

    expect(screen.getByText(APP_TINT)).toBeTruthy();
    expect(screen.queryByText(CHAT_TINT)).toBeNull();
  });
});

/** Reads the wallpaper uri the way the chat screen does. */
function BackgroundProbe(): React.JSX.Element {
  return <Text>{useChatBackgroundUri('g1') ?? 'no-wallpaper'}</Text>;
}

describe('useChatBackgroundUri — context read off the provider’s single subscription', () => {
  beforeEach(() => {
    mockedReactive.mockReset();
  });

  it('a child sees the LOCAL wallpaper pick, which wins over the synced one', async () => {
    seedChatTheme({
      themeTokens: null,
      backgroundUri: 'file://local.jpg',
      syncedBackgroundUri: 'file://synced.jpg',
    });
    await renderWithTheme(
      <ChatThemeProvider guid="g1">
        <BackgroundProbe />
      </ChatThemeProvider>,
    );
    expect(screen.getByText('file://local.jpg')).toBeTruthy();
  });

  it('falls back to the synced (macOS 26) background when there is no local pick', async () => {
    seedChatTheme({ themeTokens: null, syncedBackgroundUri: 'file://synced.jpg' });
    await renderWithTheme(
      <ChatThemeProvider guid="g1">
        <BackgroundProbe />
      </ChatThemeProvider>,
    );
    expect(screen.getByText('file://synced.jpg')).toBeTruthy();
  });

  it('does NOT run its own reactive query: outside a provider it reads the null default', async () => {
    // The reactive mock WOULD return a wallpaper — if the hook subscribed itself (the old
    // duplicate-subscription shape), the probe would render it. A context read renders the default.
    seedChatTheme({ themeTokens: null, backgroundUri: 'file://local.jpg' });
    await renderWithTheme(<BackgroundProbe />);
    expect(screen.getByText('no-wallpaper')).toBeTruthy();
  });
});
