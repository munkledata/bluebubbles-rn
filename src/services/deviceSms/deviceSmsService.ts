/**
 * Device-SMS service — the JS half of the "Phone SMS" feature.
 *
 * Sends/reads SMS directly from THIS Android phone's own SIM via the native
 * `device-sms` Expo module (Telephony provider + SmsManager). This is a
 * deliberately SEPARATE channel from the app's iMessage/SMS-relay chats (which
 * route through the paired Mac) — see modules/device-sms/index.ts.
 *
 * Dependency-deferred native pattern (mirrors src/native/deviceIntegrity.ts): the
 * native module only links after a clean rebuild, so every call degrades
 * gracefully (returns empty / throws a typed error) when it's absent, and NOTHING
 * here runs from a startup path — only the device-sms screens touch it, lazily.
 */
import { PermissionsAndroid, Platform, type Permission } from 'react-native';
import { logger } from '@core/secure';
import { getDatabase } from '@db/database';
import { findContactNameByAddress, getHandleName } from '@db/repositories';
import { useRedactedModeStore } from '@state/redactedModeStore';
import {
  getDeviceSmsModule,
  type DeviceSmsModule,
  type IncomingSmsEvent,
  type SmsAttachmentInfo,
  type SmsMessageInfo,
  type SmsMessageStatus,
  type SmsThreadInfo,
} from '../../../modules/device-sms';

export type { IncomingSmsEvent, SmsAttachmentInfo, SmsMessageInfo, SmsMessageStatus, SmsThreadInfo };

/** Thrown by the write wrappers when the native module isn't linked (pre-rebuild). */
export class DeviceSmsUnavailableError extends Error {
  constructor() {
    super('Phone SMS is unavailable — it requires a rebuild of the app.');
    this.name = 'DeviceSmsUnavailableError';
  }
}

const SMS_PERMISSIONS: Permission[] = [
  PermissionsAndroid.PERMISSIONS.READ_SMS,
  PermissionsAndroid.PERMISSIONS.SEND_SMS,
  PermissionsAndroid.PERMISSIONS.RECEIVE_SMS,
];

let moduleCache: DeviceSmsModule | null = null;
let availabilityCache: boolean | null = null;

/** Lazily resolve the native module, caching the (possibly null) result. */
function resolveModule(): DeviceSmsModule | null {
  if (moduleCache) return moduleCache;
  if (Platform.OS !== 'android') return null;
  try {
    moduleCache = getDeviceSmsModule();
    return moduleCache;
  } catch (e) {
    // Not linked yet (pre-rebuild) — degrade to "unavailable" rather than crash.
    logger.debug('[deviceSms] native module not linked (rebuild required)', e);
    return null;
  }
}

/** True only on Android with the native device-sms module linked. Cached. */
export function isDeviceSmsAvailable(): boolean {
  if (availabilityCache === null) {
    availabilityCache = Platform.OS === 'android' && resolveModule() !== null;
  }
  return availabilityCache;
}

// ---- Permissions -----------------------------------------------------------

/** Prompt for READ/SEND/RECEIVE_SMS. Resolves true only if ALL are granted. */
export async function requestSmsPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    const res = await PermissionsAndroid.requestMultiple(SMS_PERMISSIONS);
    return SMS_PERMISSIONS.every((p) => res[p] === PermissionsAndroid.RESULTS.GRANTED);
  } catch (e) {
    logger.warn('[deviceSms] requestSmsPermissions failed', e);
    return false;
  }
}

/** True only when ALL of READ/SEND/RECEIVE_SMS are currently held. */
export async function hasSmsPermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  try {
    for (const p of SMS_PERMISSIONS) {
      if (!(await PermissionsAndroid.check(p))) return false;
    }
    return true;
  } catch (e) {
    logger.warn('[deviceSms] hasSmsPermissions check failed', e);
    return false;
  }
}

// ---- Typed provider wrappers ----------------------------------------------

/** Conversation threads, newest-first. Returns [] when the module is unavailable. */
export async function listSmsThreads(limit = 100, offset = 0): Promise<SmsThreadInfo[]> {
  const mod = resolveModule();
  if (!mod) return [];
  try {
    return await mod.getThreads(limit, offset);
  } catch (e) {
    logger.warn('[deviceSms] listSmsThreads failed', e);
    return [];
  }
}

/**
 * Messages in a thread, OLDEST→NEWEST. `beforeDateMs` pages older history (0 =
 * most recent page). Returns [] when the module is unavailable.
 */
export async function listSmsMessages(
  threadId: number,
  limit = 100,
  beforeDateMs = 0,
): Promise<SmsMessageInfo[]> {
  const mod = resolveModule();
  if (!mod) return [];
  try {
    return await mod.getMessages(threadId, limit, beforeDateMs);
  } catch (e) {
    logger.warn('[deviceSms] listSmsMessages failed', e);
    return [];
  }
}

/**
 * Send an SMS via SmsManager. Throws {@link DeviceSmsUnavailableError} pre-rebuild
 * and rethrows the native failure otherwise, so the composer can mark the row failed.
 */
export async function sendDeviceSms(address: string, body: string): Promise<void> {
  const mod = resolveModule();
  if (!mod) throw new DeviceSmsUnavailableError();
  try {
    await mod.sendSms(address, body);
  } catch (e) {
    logger.warn('[deviceSms] sendDeviceSms failed', e);
    throw e;
  }
}

/** Resolve (creating if needed) the provider thread id for an address. */
export async function getOrCreateSmsThreadId(address: string): Promise<number> {
  const mod = resolveModule();
  if (!mod) throw new DeviceSmsUnavailableError();
  try {
    return await mod.getOrCreateThreadId(address);
  } catch (e) {
    logger.warn('[deviceSms] getOrCreateSmsThreadId failed', e);
    throw e;
  }
}

/**
 * Other-party address for a thread id (or "" when unknown/unavailable). Used by the
 * thread screen when it's opened directly from a killed-app notification deep link —
 * there only the thread id is in the route params, so the address must be derived.
 */
export async function getSmsThreadAddress(threadId: number): Promise<string> {
  const mod = resolveModule();
  if (!mod) return '';
  try {
    return await mod.getThreadAddress(threadId);
  } catch (e) {
    logger.warn('[deviceSms] getSmsThreadAddress failed', e);
    return '';
  }
}

// ---- Killed-app notification prefs ----------------------------------------

/**
 * Pushes the killed-app notification prefs into the native SharedPreferences the manifest
 * receiver reads: whether SMS permissions are currently granted (the master enable) and the
 * app-wide Redacted Mode flag (hide-preview). Reuses the SAME source of truth as the Notifee
 * path (`useRedactedModeStore`, kv `privacy.redactedMode`). No-op (guarded) when the native
 * module isn't linked. NEVER call from a startup path — only after a permission grant / a
 * Redacted-Mode toggle / when a granted inbox mounts.
 */
export async function syncSmsNotificationPrefs(): Promise<void> {
  const mod = resolveModule();
  if (!mod) return;
  try {
    const granted = await hasSmsPermissions();
    const hidePreview = useRedactedModeStore.getState().enabled;
    await mod.setNotificationPrefs(granted, hidePreview);
  } catch (e) {
    logger.debug('[deviceSms] syncSmsNotificationPrefs failed', e);
  }
}

/**
 * Subscribe to incoming SMS broadcasts. Returns an unsubscribe function; a no-op
 * remover when the module is unavailable, so callers can wire it unconditionally.
 */
export function subscribeIncomingSms(cb: (event: IncomingSmsEvent) => void): () => void {
  const mod = resolveModule();
  if (!mod) return () => {};
  try {
    const sub = mod.addListener('onSmsReceived', cb);
    return () => {
      try {
        sub.remove();
      } catch (e) {
        logger.debug('[deviceSms] incoming-SMS unsubscribe failed', e);
      }
    };
  } catch (e) {
    logger.warn('[deviceSms] subscribeIncomingSms failed', e);
    return () => {};
  }
}

/**
 * Subscribe to Telephony provider changes (`content://mms-sms/`) — fires
 * (debounced ~400ms native-side) whenever an SMS/MMS row is added or updated,
 * including when the default SMS app finishes downloading an incoming MMS. This
 * is how incoming MMS (and other out-of-band provider mutations) surface live
 * without polling. Returns an unsubscribe function; a no-op when unavailable.
 */
export function subscribeProviderChanged(cb: () => void): () => void {
  const mod = resolveModule();
  if (!mod) return () => {};
  try {
    const sub = mod.addListener('onProviderChanged', cb);
    return () => {
      try {
        sub.remove();
      } catch (e) {
        logger.debug('[deviceSms] provider-changed unsubscribe failed', e);
      }
    };
  } catch (e) {
    logger.warn('[deviceSms] subscribeProviderChanged failed', e);
    return () => {};
  }
}

// ---- Name resolution -------------------------------------------------------

/** address → resolved display name (or the raw address). Bounded lifetime = process. */
const nameCache = new Map<string, string>();

/**
 * Best-effort display name for a raw SMS address: an exact handle match first (so
 * it agrees with the iMessage side when the number is also a known handle), then a
 * normalized-phone/email scan of synced device contacts, else the (pretty) raw
 * address. All DB access is guarded — the DB may not be open — and results are
 * memoized per address for the session.
 */
export async function resolveSmsSenderName(address: string): Promise<string> {
  const raw = (address ?? '').trim();
  if (!raw) return address ?? '';
  const cached = nameCache.get(raw);
  if (cached !== undefined) return cached;

  let resolved = raw;
  try {
    const db = getDatabase();
    // getHandleName returns COALESCE(display_name, address): equal to `raw` means it
    // fell through to the address (no contact-linked name), so keep scanning.
    const handleName = await getHandleName(db, raw);
    if (handleName && handleName !== raw) {
      resolved = handleName;
    } else {
      const contactName = await findContactNameByAddress(db, raw);
      if (contactName) resolved = contactName;
    }
  } catch (e) {
    logger.debug('[deviceSms] resolveSmsSenderName lookup failed', e);
  }

  nameCache.set(raw, resolved);
  return resolved;
}

/** recipients-key → resolved group title. Session-lived, keyed by the member set. */
const groupTitleCache = new Map<string, string>();

/**
 * Best-effort display title for a GROUP MMS thread: resolves each recipient to a
 * name (via {@link resolveSmsSenderName}) and joins them with ", ". Memoized on
 * the (order-independent) recipient set so the inbox/thread header doesn't
 * re-resolve on every render. Falls back to the pretty-printed addresses.
 */
export async function resolveSmsGroupTitle(recipients: string[]): Promise<string> {
  const list = (recipients ?? []).map((r) => (r ?? '').trim()).filter((r) => r.length > 0);
  if (list.length === 0) return '';
  // Order-independent cache key so [a,b] and [b,a] share one entry.
  const key = [...list].sort().join('|');
  const cached = groupTitleCache.get(key);
  if (cached !== undefined) return cached;

  const names = await Promise.all(list.map((r) => resolveSmsSenderName(r)));
  const title = names.filter((n) => n.trim().length > 0).join(', ');
  groupTitleCache.set(key, title);
  return title;
}
