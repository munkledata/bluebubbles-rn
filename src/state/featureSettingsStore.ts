import { create } from 'zustand';
import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';
import {
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  MAX_CONCURRENT_DOWNLOADS_LIMIT,
  setMaxConcurrentDownloads as applyMaxConcurrentDownloads,
} from '@/services/download/downloadService';

/**
 * User-configurable behavior toggles that gate features which were previously hardcoded:
 * Private API client behaviors (typing indicators, read receipts) and attachment auto-download.
 * Persisted in `kv`; each defaults to the app's prior always-on behavior, so an un-hydrated read
 * (before launch hydration) behaves exactly as before. Hydrate at app launch + home mount like the
 * other kv stores (see [[redactedModeStore]] / smartReplyStore).
 *
 * Beyond the boolean FLAGS this store also owns the typed VALUE_SETTINGS (currently the
 * parallel-download cap) — a value carries a parse/clamp, a serialize, and an `apply` side-effect
 * (the download-semaphore push) that runs on hydrate + set. The kv key
 * `downloads.maxConcurrent` is byte-identical to the old standalone downloadSettingsStore, so
 * persisted values survive the merge with zero migration.
 *
 * Non-React consumers (services `sendTyping`/`markRead`) read via `getState()`.
 */
export type FeatureFlag =
  | 'privateApiEnabled'
  | 'sendTypingIndicators'
  | 'sendReadReceipts'
  | 'autoDownloadAttachments'
  | 'autoDownloadOnWifiOnly'
  | 'sendWithReturn'
  | 'showDeliveryTimestamps'
  | 'compactChatList'
  | 'messageNotifications'
  | 'sendSubjectLines'
  | 'filterUnknownSenders'
  | 'errorReportingEnabled';

const FLAGS: Record<FeatureFlag, { key: string; def: boolean }> = {
  privateApiEnabled: { key: 'privateApi.enabled', def: true },
  sendTypingIndicators: { key: 'privateApi.sendTypingIndicators', def: true },
  sendReadReceipts: { key: 'privateApi.sendReadReceipts', def: true },
  autoDownloadAttachments: { key: 'attachments.autoDownload', def: true },
  autoDownloadOnWifiOnly: { key: 'attachments.autoDownloadWifiOnly', def: false },
  sendWithReturn: { key: 'conversation.sendWithReturn', def: false },
  showDeliveryTimestamps: { key: 'conversation.showDeliveryTimestamps', def: true },
  compactChatList: { key: 'chatList.compact', def: false },
  messageNotifications: { key: 'notifications.messages', def: true },
  sendSubjectLines: { key: 'privateApi.sendSubjectLines', def: false },
  filterUnknownSenders: { key: 'chatList.filterUnknownSenders', def: false },
  // Capture app errors + upload them to the server (default ON: capture is cheap and is the point;
  // uploads are additionally gated on the server advertising `supports_error_log_upload`).
  errorReportingEnabled: { key: 'diagnostics.errorReporting', def: true },
};

/** kv key for the parallel-download cap — byte-identical to the pre-merge store (no migration). */
export const MAX_CONCURRENT_DOWNLOADS_KEY = 'downloads.maxConcurrent';
export { MAX_CONCURRENT_DOWNLOADS_LIMIT };

/**
 * Where auto-downloaded images are ADDITIONALLY saved (the app always keeps its own copy to render
 * the bubble). 'app' = in-app only; 'gallery' = also the device gallery; 'album' = the "Gator"
 * Photos album. An enum, so it can't reuse the boolean-only {@link FLAGS} machinery.
 */
export type AutoDownloadDestination = 'app' | 'gallery' | 'album';
export const AUTO_DOWNLOAD_DEST_KEY = 'attachments.autoDownloadDestination';
const AUTO_DOWNLOAD_DEST_DEFAULT: AutoDownloadDestination = 'album';
function parseAutoDownloadDestination(raw: string | null): AutoDownloadDestination {
  return raw === 'app' || raw === 'gallery' || raw === 'album' ? raw : AUTO_DOWNLOAD_DEST_DEFAULT;
}

function clampDownloads(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_MAX_CONCURRENT_DOWNLOADS;
  return Math.max(1, Math.min(MAX_CONCURRENT_DOWNLOADS_LIMIT, Math.floor(n)));
}

/** A non-boolean, kv-backed setting: clamps candidates, (de)serializes, and applies a side-effect. */
interface ValueSetting<T> {
  key: string;
  def: T;
  /** Sanitize a raw candidate from the setter. */
  clamp: (n: number) => T;
  /** Parse a persisted kv string (null → default). */
  parse: (raw: string | null) => T;
  /** Serialize for kv persistence. */
  serialize: (value: T) => string;
  /** Side-effect to run on hydrate + set (e.g. push the cap into the download semaphore). */
  apply: (value: T) => void;
}

const VALUE_SETTINGS = {
  maxConcurrentDownloads: {
    key: MAX_CONCURRENT_DOWNLOADS_KEY,
    def: DEFAULT_MAX_CONCURRENT_DOWNLOADS,
    clamp: clampDownloads,
    parse: (raw) => (raw == null ? DEFAULT_MAX_CONCURRENT_DOWNLOADS : clampDownloads(Number(raw))),
    serialize: (v) => String(v),
    apply: applyMaxConcurrentDownloads,
  },
} satisfies Record<string, ValueSetting<number>>;

type ValueSettingKey = keyof typeof VALUE_SETTINGS;

interface FeatureSettingsState {
  privateApiEnabled: boolean;
  sendTypingIndicators: boolean;
  sendReadReceipts: boolean;
  autoDownloadAttachments: boolean;
  autoDownloadOnWifiOnly: boolean;
  sendWithReturn: boolean;
  showDeliveryTimestamps: boolean;
  compactChatList: boolean;
  messageNotifications: boolean;
  sendSubjectLines: boolean;
  filterUnknownSenders: boolean;
  errorReportingEnabled: boolean;
  maxConcurrentDownloads: number;
  autoDownloadDestination: AutoDownloadDestination;
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setFlag: (flag: FeatureFlag, value: boolean) => Promise<void>;
  setMaxConcurrentDownloads: (n: number) => Promise<void>;
  setAutoDownloadDestination: (dest: AutoDownloadDestination) => Promise<void>;
}

export const useFeatureSettingsStore = create<FeatureSettingsState>((set) => ({
  privateApiEnabled: FLAGS.privateApiEnabled.def,
  sendTypingIndicators: FLAGS.sendTypingIndicators.def,
  sendReadReceipts: FLAGS.sendReadReceipts.def,
  autoDownloadAttachments: FLAGS.autoDownloadAttachments.def,
  autoDownloadOnWifiOnly: FLAGS.autoDownloadOnWifiOnly.def,
  sendWithReturn: FLAGS.sendWithReturn.def,
  showDeliveryTimestamps: FLAGS.showDeliveryTimestamps.def,
  compactChatList: FLAGS.compactChatList.def,
  messageNotifications: FLAGS.messageNotifications.def,
  sendSubjectLines: FLAGS.sendSubjectLines.def,
  filterUnknownSenders: FLAGS.filterUnknownSenders.def,
  errorReportingEnabled: FLAGS.errorReportingEnabled.def,
  maxConcurrentDownloads: VALUE_SETTINGS.maxConcurrentDownloads.def,
  autoDownloadDestination: AUTO_DOWNLOAD_DEST_DEFAULT,
  hydrated: false,
  hydrate: async () => {
    try {
      const db = getDatabase();
      const flagEntries = await Promise.all(
        (Object.keys(FLAGS) as FeatureFlag[]).map(async (f) => {
          const v = await kvGet(db, FLAGS[f].key);
          return [f, v == null ? FLAGS[f].def : v === '1'] as const;
        }),
      );
      const valueEntries = await Promise.all(
        (Object.keys(VALUE_SETTINGS) as ValueSettingKey[]).map(async (k) => {
          const setting = VALUE_SETTINGS[k];
          const value = setting.parse(await kvGet(db, setting.key));
          setting.apply(value); // push the hydrated value into its side-effect (download semaphore)
          return [k, value] as const;
        }),
      );
      const autoDownloadDestination = parseAutoDownloadDestination(
        await kvGet(db, AUTO_DOWNLOAD_DEST_KEY),
      );
      set({
        ...Object.fromEntries(flagEntries),
        ...Object.fromEntries(valueEntries),
        autoDownloadDestination,
        hydrated: true,
      } as Partial<FeatureSettingsState>);
    } catch {
      // DB not open yet at launch — re-hydrated at home mount. Leave `hydrated` false.
    }
  },
  setFlag: async (flag, value) => {
    set({ [flag]: value } as Partial<FeatureSettingsState>); // optimistic
    try {
      await kvSet(getDatabase(), FLAGS[flag].key, value ? '1' : '0');
    } catch {
      // best-effort persist; the in-memory toggle still applies this session
    }
  },
  setMaxConcurrentDownloads: async (n) => {
    const setting = VALUE_SETTINGS.maxConcurrentDownloads;
    const val = setting.clamp(n);
    setting.apply(val); // apply immediately, before the persist
    set({ maxConcurrentDownloads: val }); // optimistic
    try {
      await kvSet(getDatabase(), setting.key, setting.serialize(val));
    } catch {
      // best-effort persist; the in-memory cap still applies this session
    }
  },
  setAutoDownloadDestination: async (dest) => {
    set({ autoDownloadDestination: dest }); // optimistic
    try {
      await kvSet(getDatabase(), AUTO_DOWNLOAD_DEST_KEY, dest);
    } catch {
      // best-effort persist; the in-memory choice still applies this session
    }
  },
}));
