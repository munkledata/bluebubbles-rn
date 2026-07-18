import { create } from 'zustand';
import type { ServerInfo } from '@core/models';

export type ConnectionStatus =
  | 'loading' // hydrating credentials from the vault at boot
  | 'unauthenticated' // no stored credentials → show setup
  | 'connecting' // validating against the server
  | 'connected' // validated
  | 'error';

interface SessionState {
  status: ConnectionStatus;
  /** Server origin, e.g. https://abc.ngrok.io. */
  origin: string | null;
  /** Server password — in-memory mirror of the vault; never persisted by zustand. */
  password: string | null;
  serverInfo: ServerInfo | null;
  error: string | null;

  /** Result of boot hydration (credentials found or not). */
  hydrated: (creds: { origin: string; password: string } | null) => void;
  beginConnecting: () => void;
  connected: (origin: string, password: string, info: ServerInfo) => void;
  /** Refresh just the cached server info (e.g. on a hydrated boot, where `connected` never ran). */
  setServerInfo: (info: ServerInfo) => void;
  /** Point the session at a new origin (e.g. the server's `new-server` tunnel-URL rotation). */
  setOrigin: (origin: string) => void;
  failed: (message: string) => void;
  /** Clear the session (logout / forget connection). */
  reset: () => void;
}

export const useSessionStore = create<SessionState>((set) => ({
  status: 'loading',
  origin: null,
  password: null,
  serverInfo: null,
  error: null,

  hydrated: (creds) =>
    set(
      creds
        ? { status: 'connected', origin: creds.origin, password: creds.password, error: null }
        : { status: 'unauthenticated', origin: null, password: null, error: null },
    ),
  beginConnecting: () => set({ status: 'connecting', error: null }),
  connected: (origin, password, info) =>
    set({ status: 'connected', origin, password, serverInfo: info, error: null }),
  setServerInfo: (info) => set({ serverInfo: info }),
  setOrigin: (origin) => set({ origin }),
  failed: (message) => set({ status: 'error', error: message }),
  reset: () =>
    set({ status: 'unauthenticated', origin: null, password: null, serverInfo: null, error: null }),
}));

/** Synchronous accessors for non-React code (the HttpClient auth hooks). */
export const sessionAccessors = {
  getOrigin: (): string => useSessionStore.getState().origin ?? '',
  getPassword: (): string | undefined => useSessionStore.getState().password ?? undefined,
  /** Whether the connected server has the Gator Private API enabled. */
  privateApiEnabled: (): boolean => !!useSessionStore.getState().serverInfo?.private_api,
  /** Whether the connected server's Gator RCS bridge is enabled (absent/false → off). */
  rcsEnabled: (): boolean => !!useSessionStore.getState().serverInfo?.rcs,
  /**
   * Whether the connected server can emit `message-deleted` (macOS "Recently Deleted"; schema gap
   * 6). Absent/false on older servers. Informational for now — the DbEventSink tombstones deletions
   * unconditionally (an old server never sends the event); this is for future deletion affordances.
   */
  messageDeletedSupported: (): boolean =>
    !!useSessionStore.getState().serverInfo?.supports_message_deleted,
  /** Whether the connected server can build + send a contact card (`send-contact`). */
  sendContactSupported: (): boolean =>
    !!useSessionStore.getState().serverInfo?.supports_send_contact,
  /** Whether the connected server exposes the iMessage-account endpoints (`icloud/account`). */
  icloudAccountSupported: (): boolean =>
    !!useSessionStore.getState().serverInfo?.supports_icloud_account,
};

/** React hook: is the server's RCS bridge enabled? (Gate RCS-specific UI on this.) */
export const useRcsEnabled = (): boolean => useSessionStore((s) => !!s.serverInfo?.rcs);

/** React hook: can the server emit `message-deleted`? (For future deletion affordances.) */
export const useMessageDeletedSupported = (): boolean =>
  useSessionStore((s) => !!s.serverInfo?.supports_message_deleted);

/** React hook: can the server send a contact card? (Gate the composer's "Contact" affordance.) */
export const useSendContactSupported = (): boolean =>
  useSessionStore((s) => !!s.serverInfo?.supports_send_contact);

/** React hook: does the server expose the iMessage-account endpoints? (Gate the Settings row.) */
export const useIcloudAccountSupported = (): boolean =>
  useSessionStore((s) => !!s.serverInfo?.supports_icloud_account);
