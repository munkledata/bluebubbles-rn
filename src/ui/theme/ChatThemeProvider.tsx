import React, { useMemo, type ReactNode } from 'react';
import { getDatabase } from '@db/database';
import { getChatTheme } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { ThemeContext, useTheme } from './ThemeProvider';
import { safeParseTokens, type ThemeTokens } from './tokens';

interface ChatThemeProviderProps {
  guid: string;
  children: ReactNode;
}

/** Reactive raw per-chat theme row (theme tokens JSON + local & synced background uris + luminance). */
function useChatTheme(guid: string): {
  themeTokens: string | null;
  backgroundUri: string | null;
  syncedBackgroundUri: string | null;
  backgroundIsLight: boolean | null;
} {
  const { data } = useReactiveQuery(() => getChatTheme(getDatabase(), guid), ['chats'], [guid]);
  return {
    themeTokens: data?.themeTokens ?? null,
    backgroundUri: data?.backgroundUri ?? null,
    syncedBackgroundUri: data?.syncedBackgroundUri ?? null,
    // Raw column is 0/1/null (getChatTheme uses raw SQL, bypassing drizzle's boolean coercion).
    backgroundIsLight: data?.backgroundIsLight == null ? null : data.backgroundIsLight === 1,
  };
}

/**
 * The effective chat-background image uri (null → none). Reactive. The user's own local pick
 * (`backgroundUri`) wins; otherwise the macOS 26 synced background downloaded from the server
 * (`syncedBackgroundUri`). A background set by an iMessage participant shows up here without any
 * change to the render site.
 */
export function useChatBackgroundUri(guid: string): string | null {
  const { backgroundUri, syncedBackgroundUri } = useChatTheme(guid);
  return backgroundUri ?? syncedBackgroundUri;
}

/**
 * Whether the effective wallpaper reads as LIGHT or DARK; `null` when unknown or no wallpaper.
 * Reactive. Currently unconsumed: overlay labels moved from luminance-picked halo text to frosted
 * pills (`overlayPillStyle`), which are legible regardless of the image. Kept (with the
 * `background_is_light` column + luminance sampling) for future wallpaper-aware UI, e.g. status
 * bar icon styling.
 */
export function useChatBackgroundIsLight(guid: string): boolean | null {
  return useChatTheme(guid).backgroundIsLight;
}

/**
 * Overrides the active theme for one conversation. If the chat has a valid stored
 * theme-tokens blob, a nested ThemeContext.Provider makes `useTheme()` inside the
 * conversation return it; otherwise children inherit the global theme unchanged.
 * Corrupt tokens fall back to the global theme (never crash).
 */
export function ChatThemeProvider({ guid, children }: ChatThemeProviderProps): React.JSX.Element {
  const globalTheme = useTheme();
  const { themeTokens } = useChatTheme(guid);
  const chatTokens = useMemo<ThemeTokens | null>(() => safeParseTokens(themeTokens), [themeTokens]);
  const value = useMemo(() => ({ theme: chatTokens ?? globalTheme }), [chatTokens, globalTheme]);

  // No per-chat theme → pass children through untouched (inherit the global provider).
  if (!chatTokens) return <>{children}</>;
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
