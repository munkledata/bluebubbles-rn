import { create } from 'zustand';
import { getDatabase } from '@db/database';
import { kvGet, kvSet } from '@db/repositories';

/**
 * User-configurable behavior toggles that gate features which were previously hardcoded:
 * Private API client behaviors (typing indicators, read receipts) and attachment auto-download.
 * Persisted in `kv`; each defaults to the app's prior always-on behavior, so an un-hydrated read
 * (before launch hydration) behaves exactly as before. Hydrate at app launch + home mount like the
 * other kv stores (see [[redactedModeStore]] / smartReplyStore).
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
  | 'messageNotifications';

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
};

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
  hydrated: boolean;
  hydrate: () => Promise<void>;
  setFlag: (flag: FeatureFlag, value: boolean) => Promise<void>;
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
  hydrated: false,
  hydrate: async () => {
    try {
      const db = getDatabase();
      const entries = await Promise.all(
        (Object.keys(FLAGS) as FeatureFlag[]).map(async (f) => {
          const v = await kvGet(db, FLAGS[f].key);
          return [f, v == null ? FLAGS[f].def : v === '1'] as const;
        }),
      );
      set({ ...Object.fromEntries(entries), hydrated: true });
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
}));
