import { create } from 'zustand';
import {
  retirePrivateApiCapabilities,
  serverSendCapabilityKey,
  type ServerInfo,
} from '@core/models';
import {
  currentRcsProviderEpoch,
  isCurrentRcsAttachmentGuid,
  isCurrentRcsChatGuid,
  isCurrentRcsMessageGuid,
} from '@core/rcs/providerIdentity';

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
  /**
   * Monotonic counter identifying THIS session instance — bumped by every transition that starts
   * or destroys one (`hydrated`, `connected`, `reset`). Long-running work captures it and compares
   * later to answer "am I still the current session?".
   *
   * The origin alone cannot answer that. `sanitizeServerAddress` is deterministic, so reconnecting
   * to the SAME server after a Disconnect restores a byte-identical origin string — and a
   * Disconnect is most often followed by exactly that (a changed password, a rotated tunnel URL, an
   * accidental tap). A run that had been correctly disowned then looked current again: `startSync`
   * handed the new session the DEAD run (so the new one never synced at all) and the dead run's own
   * abort check went false again, letting its closing phases write the pre-wipe snapshot back over
   * the wipe. The counter never repeats, so both halves stay decided.
   *
   * Deliberately NOT bumped by `rotateOrigin`: an approved `new-server` tunnel rotation re-points the SAME
   * session at a new URL, and treating that as a new session would needlessly disown the sync
   * already running against the same account and the same local DB.
   */
  epoch: number;
  /**
   * Monotonic identity for the currently approved HTTP transport. Unlike {@link epoch}, this also
   * changes for an approved same-account origin rotation. Keeping it separate lets account-scoped
   * work survive a tunnel change while transport-scoped work detects A -> B -> A rotations that
   * would otherwise look identical from the URL and password alone.
   */
  transportRevision: number;
  /** Monotonic identity for send-related ServerInfo capabilities on the current transport. */
  sendCapabilityRevision: number;

  /** Result of boot hydration (credentials found or not). */
  hydrated: (creds: { origin: string; password: string } | null) => void;
  beginConnecting: () => void;
  connected: (origin: string, password: string, info: ServerInfo) => void;
  /**
   * Publish an async server-info response only if the exact transport that requested it is still
   * current. Returns false when a newer hydration/connection/origin rotation won the race.
   */
  setServerInfoForTransport: (
    expectedOrigin: string,
    expectedTransportRevision: number,
    info: ServerInfo,
  ) => boolean;
  /**
   * Replace only the credential for this exact connected transport after a durable in-place
   * adoption. The account/DB identity stays the same, while the transport revision changes so
   * every old password-bearing HTTP continuation is retired.
   */
  replaceCredentialForTransport: (
    expectedOrigin: string,
    expectedCredential: string,
    expectedTransportRevision: number,
    credential: string,
  ) => boolean;
  /** Publish an already-validated and durably committed origin rotation without replacing account. */
  rotateOrigin: (origin: string, info: ServerInfo) => void;
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
  epoch: 0,
  transportRevision: 0,
  sendCapabilityRevision: 0,

  hydrated: (creds) =>
    set((s) =>
      creds
        ? {
            status: 'connected',
            origin: creds.origin,
            password: creds.password,
            serverInfo: null,
            error: null,
            epoch: s.epoch + 1,
            transportRevision: s.transportRevision + 1,
            sendCapabilityRevision: s.sendCapabilityRevision + 1,
          }
        : {
            status: 'unauthenticated',
            origin: null,
            password: null,
            serverInfo: null,
            error: null,
            epoch: s.epoch + 1,
            transportRevision: s.transportRevision + 1,
            sendCapabilityRevision: s.sendCapabilityRevision + 1,
          },
    ),
  beginConnecting: () => set({ status: 'connecting', error: null }),
  connected: (origin, password, info) =>
    set((s) => ({
      status: 'connected',
      origin,
      password,
      serverInfo: retirePrivateApiCapabilities(info),
      error: null,
      epoch: s.epoch + 1,
      transportRevision: s.transportRevision + 1,
      sendCapabilityRevision: s.sendCapabilityRevision + 1,
    })),
  setServerInfoForTransport: (expectedOrigin, expectedTransportRevision, info) => {
    let published = false;
    set((s) => {
      if (s.origin !== expectedOrigin || s.transportRevision !== expectedTransportRevision) {
        return s;
      }
      const retiredInfo = retirePrivateApiCapabilities(info);
      published = true;
      return {
        serverInfo: retiredInfo,
        sendCapabilityRevision:
          s.sendCapabilityRevision +
          (serverSendCapabilityKey(s.serverInfo) === serverSendCapabilityKey(retiredInfo) ? 0 : 1),
      };
    });
    return published;
  },
  replaceCredentialForTransport: (
    expectedOrigin,
    expectedCredential,
    expectedTransportRevision,
    credential,
  ) => {
    let replaced = false;
    set((s) => {
      if (
        s.status !== 'connected' ||
        s.origin !== expectedOrigin ||
        s.password !== expectedCredential ||
        s.transportRevision !== expectedTransportRevision
      ) {
        return s;
      }
      replaced = true;
      return {
        password: credential,
        error: null,
        transportRevision: s.transportRevision + 1,
      };
    });
    return replaced;
  },
  rotateOrigin: (origin, info) =>
    set((s) => {
      const retiredInfo = retirePrivateApiCapabilities(info);
      return {
        origin,
        serverInfo: retiredInfo,
        transportRevision: s.transportRevision + 1,
        sendCapabilityRevision:
          s.sendCapabilityRevision +
          (serverSendCapabilityKey(s.serverInfo) === serverSendCapabilityKey(retiredInfo) ? 0 : 1),
      };
    }),
  failed: (message) => set({ status: 'error', error: message }),
  reset: () =>
    set((s) => ({
      status: 'unauthenticated',
      origin: null,
      password: null,
      serverInfo: null,
      error: null,
      epoch: s.epoch + 1,
      transportRevision: s.transportRevision + 1,
      sendCapabilityRevision: s.sendCapabilityRevision + 1,
    })),
}));

export interface SessionTransportLease {
  readonly origin: string | null;
  readonly revision: number;
  isCurrent(): boolean;
}

/** Capture the exact approved transport without turning a same-account rotation into a logout. */
export function captureSessionTransportLease(): SessionTransportLease {
  const { origin, transportRevision: revision } = useSessionStore.getState();
  return Object.freeze({
    origin,
    revision,
    isCurrent: (): boolean => {
      const current = useSessionStore.getState();
      return current.origin === origin && current.transportRevision === revision;
    },
  });
}

/** Synchronous accessors for non-React code (the HttpClient auth hooks). */
export const sessionAccessors = {
  getOrigin: (): string => useSessionStore.getState().origin ?? '',
  /** The current session instance's id — see {@link SessionState.epoch}. */
  getEpoch: (): number => useSessionStore.getState().epoch,
  /** The current HTTP transport id; also changes on approved same-account origin rotation. */
  getTransportRevision: (): number => useSessionStore.getState().transportRevision,
  getPassword: (): string | undefined => useSessionStore.getState().password ?? undefined,
  /** Immutable-by-convention capability snapshot for platform-free ingestion admission. */
  getServerInfo: (): ServerInfo | null => useSessionStore.getState().serverInfo,
  /** Whether the connected server's Gator RCS bridge is enabled (absent/false → off). */
  rcsEnabled: (): boolean => !!useSessionStore.getState().serverInfo?.rcs,
  /** Current persisted Google pairing epoch, or null until the qualified-id contract is live. */
  rcsProviderEpoch: (): string | null =>
    currentRcsProviderEpoch(useSessionStore.getState().serverInfo),
  /** Only an exact current-epoch RCS conversation may start a server mutation. */
  acceptsRcsChat: (chatGuid: string): boolean =>
    isCurrentRcsChatGuid(useSessionStore.getState().serverInfo, chatGuid),
  /** Only an exact current-epoch RCS message may be used as a remote action target. */
  acceptsRcsMessage: (messageGuid: string): boolean =>
    isCurrentRcsMessageGuid(useSessionStore.getState().serverInfo, messageGuid),
  /** Only an exact current-epoch RCS attachment may start or finish a remote/native fetch. */
  acceptsRcsAttachment: (attachmentGuid: string): boolean =>
    isCurrentRcsAttachmentGuid(useSessionStore.getState().serverInfo, attachmentGuid),
  /** Narrow helper capability; independent of the retired broad Private API flag. */
  imessageNewChatEnabled: (): boolean =>
    useSessionStore.getState().serverInfo?.supports_imessage_new_chat === true,
  /** Existing one-to-one iMessage typing only; does not depend on broad Private API. */
  imessageTypingEnabled: (): boolean =>
    useSessionStore.getState().serverInfo?.supports_imessage_typing === true,
  /** Existing one-to-one iMessage read state only; absent/false always fails closed. */
  imessageReadStateEnabled: (): boolean =>
    useSessionStore.getState().serverInfo?.supports_imessage_read_state === true,
  /** Whether this server supplies exact RCS success/error attempt correlation. */
  rcsSendAttemptOwnershipSupported: (): boolean =>
    useSessionStore.getState().serverInfo?.supports_rcs_send_attempt_ownership === true,
  /** Whether the connected server accepts client error-report uploads. */
  errorLogUploadSupported: (): boolean =>
    !!useSessionStore.getState().serverInfo?.supports_error_log_upload,
};

/** React hook for RCS actions; legacy/stale conversations remain visible but read-only. */
export const useRcsMutationEnabled = (chatGuid?: string): boolean =>
  useSessionStore((s) =>
    chatGuid === undefined
      ? currentRcsProviderEpoch(s.serverInfo) !== null
      : isCurrentRcsChatGuid(s.serverInfo, chatGuid),
  );

/** React hook: can global search include bounded message-text matches from the Mac? */
export const useMessageSearchSupported = (): boolean =>
  useSessionStore((s) => !!s.serverInfo?.supports_message_search);

/** Can this exact chat service send one attachment and its text as a single message? */
export const useSendAttachmentTextSupported = (service: string | null | undefined): boolean =>
  useSessionStore((s) => {
    if (service === 'RCS') {
      return (
        currentRcsProviderEpoch(s.serverInfo) !== null &&
        s.serverInfo?.supports_rcs_text_with_attachment === true
      );
    }
    if (service === 'iMessage') {
      return (
        s.serverInfo?.supports_imessage_attachment_upload === true &&
        s.serverInfo.supports_imessage_attachment_caption_upload === true
      );
    }
    return false;
  });
