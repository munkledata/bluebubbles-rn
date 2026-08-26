import { create } from 'zustand';
import { getDatabase } from '@db/database';
import {
  clearErrorReportsWithinTransaction,
  kvGet,
  kvSetWithinTransaction,
} from '@db/repositories';
import { withDbTransaction } from '@db/transaction';
import type { AppDatabase } from '@db/types';
import {
  DEFAULT_MAX_CONCURRENT_DOWNLOADS,
  MAX_CONCURRENT_DOWNLOADS_LIMIT,
  setMaxConcurrentDownloads as applyMaxConcurrentDownloads,
} from '@/services/download/downloadService';
import { canCommitHydration, reportHydrationError, type HydrationOptions } from '@state/hydration';

/**
 * User-configurable behavior toggles that gate features which were previously hardcoded:
 * Private API client behaviors (typing indicators, read receipts) and attachment auto-download.
 * Persisted in `kv`; ordinary feature flags default to the app's prior behavior. Error reporting
 * is the deliberate exception: it is a versioned, explicit consent choice and fails closed until
 * hydration proves the user opted in. Hydrate at app launch + home mount alongside
 * `syncSettingsStore` through the shared hydration registry.
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
  | 'filterUnknownSenders';

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
};

/** Versioned, device-local record of informed error-reporting consent. */
export const ERROR_REPORTING_CONSENT_KEY = 'diagnostics.errorReportingConsent.v1';
/** Pre-consent toggle key. A persisted 0/1 is an existing explicit choice and is migrated once. */
export const LEGACY_ERROR_REPORTING_KEY = 'diagnostics.errorReporting';
type ErrorReportingConsentValue = 'granted' | 'denied';

export interface ErrorReportingConsentWriteContext extends HydrationOptions {
  /** Exact account database captured before this choice joins the serialized tail. */
  readonly db: AppDatabase;
  /** Required account/run authority; checked before admission, BEGIN, and COMMIT. */
  readonly shouldCommit: () => boolean;
}

// Consent writes are serialized so a rapid Allow -> Off cannot finish out of order. Enabling is
// persist-first (nothing can be captured or sent before durable consent exists); disabling updates
// memory immediately so the reporting service can abort an in-flight request, then rolls back only
// if the durable write fails and no newer choice superseded it.
let errorReportingPersistenceTail: Promise<void> = Promise.resolve();
let errorReportingChoiceGeneration = 0;

function canCommitErrorReportingConsentWrite(
  generation: number,
  context: ErrorReportingConsentWriteContext,
): boolean {
  return generation === errorReportingChoiceGeneration && canCommitHydration(context);
}

function enqueueErrorReportingConsentWrite(
  value: ErrorReportingConsentValue,
  generation: number,
  context: ErrorReportingConsentWriteContext,
): Promise<boolean> {
  const persist = errorReportingPersistenceTail.then(async () => {
    if (!canCommitErrorReportingConsentWrite(generation, context)) return false;
    try {
      await withDbTransaction(
        context.db,
        async (transactionContext) => {
          await kvSetWithinTransaction(transactionContext, ERROR_REPORTING_CONSENT_KEY, value);
          // Every explicit choice starts from an empty diagnostic queue. This makes both directions
          // safe when a newer choice supersedes an older queued one: Allow can never authorize rows
          // whose preceding Off was skipped or failed, while Off cannot commit without its purge.
          await clearErrorReportsWithinTransaction(transactionContext);
        },
        () => canCommitErrorReportingConsentWrite(generation, context),
      );
      return true;
    } catch (error) {
      // A revoked account/run or superseding choice owns neither an error nor a rollback into the
      // new state. A DB failure that still belongs to the current choice must keep rejecting.
      if (!canCommitErrorReportingConsentWrite(generation, context)) return false;
      throw error;
    }
  });
  errorReportingPersistenceTail = persist.then(
    () => undefined,
    () => undefined,
  );
  return persist;
}

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
  hydrate: (options?: HydrationOptions) => Promise<void>;
  setFlag: (flag: FeatureFlag, value: boolean) => Promise<void>;
  setErrorReportingConsent: (
    value: boolean,
    context: ErrorReportingConsentWriteContext,
  ) => Promise<void>;
  setMaxConcurrentDownloads: (n: number) => Promise<void>;
  setAutoDownloadDestination: (dest: AutoDownloadDestination) => Promise<void>;
}

export const useFeatureSettingsStore = create<FeatureSettingsState>((set, get) => ({
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
  errorReportingEnabled: false,
  maxConcurrentDownloads: VALUE_SETTINGS.maxConcurrentDownloads.def,
  autoDownloadDestination: AUTO_DOWNLOAD_DEST_DEFAULT,
  hydrated: false,
  hydrate: async (options) => {
    const consentGenerationAtStart = errorReportingChoiceGeneration;
    try {
      const db = getDatabase();
      const [flagEntries, valueEntries, autoDownloadRaw, consentRaw, legacyConsentRaw] =
        await Promise.all([
          Promise.all(
            (Object.keys(FLAGS) as FeatureFlag[]).map(async (f) => {
              const v = await kvGet(db, FLAGS[f].key);
              return [f, v == null ? FLAGS[f].def : v === '1'] as const;
            }),
          ),
          Promise.all(
            (Object.keys(VALUE_SETTINGS) as ValueSettingKey[]).map(async (k) => {
              const setting = VALUE_SETTINGS[k];
              const value = setting.parse(await kvGet(db, setting.key));
              return [k, value] as const;
            }),
          ),
          kvGet(db, AUTO_DOWNLOAD_DEST_KEY),
          kvGet(db, ERROR_REPORTING_CONSENT_KEY),
          kvGet(db, LEGACY_ERROR_REPORTING_KEY),
        ]);
      if (!canCommitHydration(options)) return;

      // A versioned value is authoritative. Missing/corrupt consent fails closed; the only legacy
      // value preserved as ON is an explicit persisted `1` from the old toggle.
      const errorReportingEnabled =
        consentRaw === 'granted' || (consentRaw == null && legacyConsentRaw === '1');

      // Seal the migration (including the missing-key -> denied case) without making hydration
      // depend on this best-effort write. The generation + shared tail prevent it from overwriting
      // an explicit choice made while the reads were in flight.
      if (consentRaw == null && consentGenerationAtStart === errorReportingChoiceGeneration) {
        await enqueueErrorReportingConsentWrite(
          errorReportingEnabled ? 'granted' : 'denied',
          consentGenerationAtStart,
          { db, shouldCommit: () => canCommitHydration(options) },
        ).catch(() => undefined);
      }
      if (!canCommitHydration(options)) return;

      const hydratedState: Partial<FeatureSettingsState> = {
        ...Object.fromEntries(flagEntries),
        ...Object.fromEntries(valueEntries),
        autoDownloadDestination: parseAutoDownloadDestination(autoDownloadRaw),
        hydrated: true,
      };
      // A newer explicit user choice wins over this older hydration snapshot.
      if (consentGenerationAtStart === errorReportingChoiceGeneration) {
        hydratedState.errorReportingEnabled = errorReportingEnabled;
      }

      // Reads and migration are complete. Apply runtime values and publish Zustand state in one
      // synchronous ownership window so a retired run cannot change the download gate or settings.
      if (!canCommitHydration(options)) return;
      for (const [key, value] of valueEntries) VALUE_SETTINGS[key].apply(value);
      set(hydratedState);
    } catch (error) {
      reportHydrationError(options, error);
      // DB not open yet at launch — re-hydrated at home mount. Leave `hydrated` false.
    }
  },
  setFlag: async (flag, value) => {
    set({ [flag]: value } as Partial<FeatureSettingsState>); // optimistic
    try {
      await withDbTransaction(getDatabase(), (context) =>
        kvSetWithinTransaction(context, FLAGS[flag].key, value ? '1' : '0'),
      );
    } catch {
      // best-effort persist; the in-memory toggle still applies this session
    }
  },
  setErrorReportingConsent: async (value, context) => {
    if (!canCommitHydration(context)) return;
    const generation = ++errorReportingChoiceGeneration;
    const previous = {
      errorReportingEnabled: get().errorReportingEnabled,
      hydrated: get().hydrated,
    };
    // Revocation is immediate so subscribers can abort transport before storage finishes.
    if (!value) set({ errorReportingEnabled: false, hydrated: true });
    try {
      const committed = await enqueueErrorReportingConsentWrite(
        value ? 'granted' : 'denied',
        generation,
        context,
      );
      if (committed && canCommitErrorReportingConsentWrite(generation, context)) {
        set({ errorReportingEnabled: value, hydrated: true });
      }
    } catch (error) {
      if (!canCommitErrorReportingConsentWrite(generation, context)) return;
      set(previous);
      throw error;
    }
  },
  setMaxConcurrentDownloads: async (n) => {
    const setting = VALUE_SETTINGS.maxConcurrentDownloads;
    const val = setting.clamp(n);
    setting.apply(val); // apply immediately, before the persist
    set({ maxConcurrentDownloads: val }); // optimistic
    try {
      await withDbTransaction(getDatabase(), (context) =>
        kvSetWithinTransaction(context, setting.key, setting.serialize(val)),
      );
    } catch {
      // best-effort persist; the in-memory cap still applies this session
    }
  },
  setAutoDownloadDestination: async (dest) => {
    set({ autoDownloadDestination: dest }); // optimistic
    try {
      await withDbTransaction(getDatabase(), (context) =>
        kvSetWithinTransaction(context, AUTO_DOWNLOAD_DEST_KEY, dest),
      );
    } catch {
      // best-effort persist; the in-memory choice still applies this session
    }
  },
}));

/** Runtime gate used by every capture/upload boundary. Unhydrated always means no consent. */
export function hasErrorReportingConsent(): boolean {
  const { errorReportingEnabled, hydrated } = useFeatureSettingsStore.getState();
  return hydrated && errorReportingEnabled;
}
