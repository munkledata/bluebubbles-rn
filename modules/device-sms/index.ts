/**
 * device-sms — local Expo module (Android-only).
 *
 * Reads/sends SMS directly on the device via the Telephony provider +
 * SmsManager. This is INDEPENDENT of the BlueBubbles server's SMS
 * forwarding (which relays through the Mac's paired iPhone number); this
 * module uses the Android phone's own SIM/number.
 *
 * The native side is only linked after a clean native rebuild
 * (`rm -rf android && expo run:android`). Never call getDeviceSmsModule()
 * from a startup path — access it lazily inside try/catch (see
 * src/services/deviceSms/). Requires runtime permissions READ_SMS /
 * SEND_SMS / RECEIVE_SMS (requested JS-side via PermissionsAndroid).
 */
import { requireNativeModule, type NativeModule } from 'expo-modules-core';

/** One row per conversation thread, newest-first. */
export interface SmsThreadInfo {
  threadId: number;
  /**
   * PRIMARY other-party address (raw, as stored by the provider) — the FIRST
   * recipient of the thread. Kept for back-compat / avatar seeding / 1:1 reply
   * target; use {@link recipients} for the full group membership.
   */
  address: string;
  /**
   * ALL resolved recipient addresses of the thread (length 1 for a 1:1 SMS/MMS,
   * >1 for a group). Derived from the conversation's space-separated
   * `recipient_ids` via the canonical-addresses map.
   */
  recipients: string[];
  /** True when the thread has more than one recipient (an MMS group thread). */
  isGroup: boolean;
  /** Body of the most recent message (may be empty for an attachment-only MMS). */
  snippet: string;
  /** Epoch ms of the most recent message. */
  date: number;
  messageCount: number;
  unreadCount: number;
}

export type SmsMessageStatus = 'received' | 'sent' | 'sending' | 'failed';

/**
 * One MMS part rendered as an attachment. `uri` is a `content://mms/part/<id>`
 * URI that loads in-app (the app holds READ_SMS). Text/SMIL parts are folded
 * into the message body natively and never appear here.
 */
export interface SmsAttachmentInfo {
  partId: number;
  /** MIME type, e.g. `image/jpeg`, `video/mp4` (lower-cased). */
  contentType: string;
  uri: string;
  /** Provider file name (`name`/`cl`), or "" when the provider gave none. */
  fileName: string;
}

export interface SmsMessageInfo {
  id: number;
  threadId: number;
  address: string;
  body: string;
  /** Epoch ms. */
  date: number;
  isFromMe: boolean;
  status: SmsMessageStatus;
  read: boolean;
  /** True for an MMS row (group and/or picture message), false for a plain SMS. */
  isMms: boolean;
  /** Attachment parts (ALWAYS present — empty array for SMS / text-only MMS). */
  attachments: SmsAttachmentInfo[];
}

export interface IncomingSmsEvent {
  address: string;
  body: string;
  /** Epoch ms. */
  date: number;
  threadId: number;
}

export type DeviceSmsModuleEvents = {
  onSmsReceived: (event: IncomingSmsEvent) => void;
  /**
   * The Telephony provider (`content://mms-sms/`) changed — a new/updated
   * SMS/MMS row, e.g. after the default SMS app finishes downloading an incoming
   * MMS. Debounced (~400ms) native-side; carries no payload — refetch the
   * current view.
   */
  onProviderChanged: () => void;
};

export declare class DeviceSmsModule extends NativeModule<DeviceSmsModuleEvents> {
  /** Threads newest-first. */
  getThreads(limit: number, offset: number): Promise<SmsThreadInfo[]>;
  /**
   * Messages in a thread, returned OLDEST→NEWEST (chronological, ready for
   * a bottom-anchored list). `beforeDateMs` pages older history; pass 0 for
   * the most recent page.
   */
  getMessages(threadId: number, limit: number, beforeDateMs: number): Promise<SmsMessageInfo[]>;
  /**
   * Sends via SmsManager (multipart-aware). Resolves when the SENT
   * PendingIntent reports success for all parts; rejects with the failure
   * code otherwise.
   */
  sendSms(address: string, body: string): Promise<void>;
  /** Resolves the provider thread id for an address (creating one if needed). */
  getOrCreateThreadId(address: string): Promise<number>;
  /**
   * The other-party address for a thread id (from its most recent message row), or ""
   * if the thread has no rows. Used when the thread screen is opened directly by a
   * killed-app notification deep link, where only the thread id is known.
   */
  getThreadAddress(threadId: number): Promise<string>;
  /**
   * Persists the killed-app notification prefs read by the manifest receiver
   * (`DeviceSmsReceiver`, which fires with no JS tree). `enabled` gates the whole
   * native-notification path (default off until the user grants SMS access);
   * `hidePreview` mirrors the app-wide Redacted Mode. Call after a permission grant and
   * whenever Redacted Mode changes — never from a startup path.
   */
  setNotificationPrefs(enabled: boolean, hidePreview: boolean): Promise<void>;
}

let cached: DeviceSmsModule | null = null;

/**
 * Lazily resolves the native module. THROWS if the native side isn't linked
 * yet (pre-rebuild) — callers must catch and degrade to "unavailable".
 */
export function getDeviceSmsModule(): DeviceSmsModule {
  cached ??= requireNativeModule<DeviceSmsModule>('DeviceSms');
  return cached;
}
