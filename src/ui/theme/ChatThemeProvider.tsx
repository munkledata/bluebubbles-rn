import React, { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { getDatabase } from '@db/database';
import { getChatTheme } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import {
  captureRealtimeDeliveryLease,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { ThemeContext, useTheme } from './ThemeProvider';
import { darkThemeOrFallback, safeParseTokens, type ThemeTokens } from './tokens';

interface ChatThemeProviderProps {
  guid: string;
  children: ReactNode;
}

interface ChatBackgroundValue {
  backgroundUri: string | null;
  backgroundIsLight: boolean | null;
}

// Wallpaper facts for the ambient chat. ChatThemeProvider owns the SINGLE reactive chat-theme
// subscription and publishes these; the hooks below are plain context reads (no second query).
const ChatBackgroundContext = createContext<ChatBackgroundValue>({
  backgroundUri: null,
  backgroundIsLight: null,
});

/** Reactive raw per-chat theme row (theme tokens JSON + local & synced background uris + luminance). */
function useChatTheme(
  guid: string,
  accountLease: RealtimeDeliveryLease,
): {
  themeTokens: string | null;
  backgroundUri: string | null;
  syncedBackgroundUri: string | null;
  backgroundIsLight: boolean | null;
} {
  const { data } = useReactiveQuery(
    async () => {
      // Reactive callbacks can outlive account teardown briefly. Check on both sides of the read:
      // a query admitted for A may settle only after B has opened the shared DB handle, and its row
      // must never become the old provider's UI state.
      if (!accountLease.isCurrent()) return null;
      const row = await getChatTheme(getDatabase(), guid);
      return accountLease.isCurrent() ? row : null;
    },
    ['chats'],
    [guid, accountLease.generation],
    { enabled: accountLease.isCurrent() },
  );
  // `isCurrent()` is deliberately checked again during render. Account teardown normally unmounts
  // the route, but any unrelated render in that short handoff window must immediately stop using
  // an already-resolved A row too.
  const ownedData = accountLease.isCurrent() ? data : null;
  return {
    themeTokens: ownedData?.themeTokens ?? null,
    backgroundUri: ownedData?.backgroundUri ?? null,
    syncedBackgroundUri: ownedData?.syncedBackgroundUri ?? null,
    // Raw column is 0/1/null (getChatTheme uses raw SQL, bypassing drizzle's boolean coercion).
    backgroundIsLight:
      ownedData?.backgroundIsLight == null ? null : ownedData.backgroundIsLight === 1,
  };
}

/**
 * The effective chat-background image uri (null → none). Reactive (via the enclosing
 * ChatThemeProvider's single subscription — a plain context read here, so callers don't open a
 * duplicate reactive query). The user's own local pick (`backgroundUri`) wins; otherwise the
 * macOS 26 synced background downloaded from the server (`syncedBackgroundUri`). A background set
 * by an iMessage participant shows up here without any change to the render site. Must be called
 * under the ChatThemeProvider for the same chat (the guid param is kept for signature stability).
 */
export function useChatBackgroundUri(_guid: string): string | null {
  return useContext(ChatBackgroundContext).backgroundUri;
}

/**
 * Whether the effective wallpaper reads as LIGHT or DARK; `null` when unknown or no wallpaper.
 * Reactive (context read — see useChatBackgroundUri). Currently unconsumed: overlay labels moved
 * from luminance-picked halo text to frosted pills (`overlayPillStyle`), which are legible
 * regardless of the image. Kept (with the `background_is_light` column + luminance sampling) for
 * future wallpaper-aware UI, e.g. status bar icon styling.
 */
export function useChatBackgroundIsLight(_guid: string): boolean | null {
  return useContext(ChatBackgroundContext).backgroundIsLight;
}

/**
 * Overrides the active theme for one conversation. If the chat has a valid stored
 * dark theme-tokens blob, a nested ThemeContext.Provider makes `useTheme()` inside the
 * conversation return it; otherwise children inherit the global theme unchanged.
 * Corrupt or legacy light tokens fall back to the global theme (never crash or switch
 * the currently dark-only product to a light surface).
 */
export function ChatThemeProvider({ guid, children }: ChatThemeProviderProps): React.JSX.Element {
  const globalTheme = useTheme();
  const [accountLease] = useState(() => captureRealtimeDeliveryLease());
  const { themeTokens, backgroundUri, syncedBackgroundUri, backgroundIsLight } = useChatTheme(
    guid,
    accountLease,
  );
  const chatTokens = useMemo<ThemeTokens | null>(() => safeParseTokens(themeTokens), [themeTokens]);
  const value = useMemo(
    () => ({ theme: darkThemeOrFallback(chatTokens, globalTheme) }),
    [chatTokens, globalTheme],
  );
  const background = useMemo<ChatBackgroundValue>(
    () => ({ backgroundUri: backgroundUri ?? syncedBackgroundUri, backgroundIsLight }),
    [backgroundUri, syncedBackgroundUri, backgroundIsLight],
  );

  // ALWAYS one element type: chatTokens arrives async (reactive query, null on first render),
  // and flipping Fragment→Provider when it lands would remount the whole chat subtree (wiping
  // composer draft/scroll). `value` already falls back to the global theme when there's no
  // per-chat override, so unthemed chats behave identically.
  return (
    <ThemeContext.Provider value={value}>
      <ChatBackgroundContext.Provider value={background}>{children}</ChatBackgroundContext.Provider>
    </ThemeContext.Provider>
  );
}
