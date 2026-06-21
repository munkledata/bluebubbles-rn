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

/** Reactive raw per-chat theme row (theme tokens JSON + background uri). */
function useChatTheme(guid: string): { themeTokens: string | null; backgroundUri: string | null } {
  const { data } = useReactiveQuery(() => getChatTheme(getDatabase(), guid), ['chats'], [guid]);
  return { themeTokens: data?.themeTokens ?? null, backgroundUri: data?.backgroundUri ?? null };
}

/** The chat-background image uri for a chat (null → no background). Reactive. */
export function useChatBackgroundUri(guid: string): string | null {
  return useChatTheme(guid).backgroundUri;
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
