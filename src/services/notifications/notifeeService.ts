import {
  AlarmType,
  AndroidGroupAlertBehavior,
  AndroidImportance,
  AndroidStyle,
  AuthorizationStatus,
  TriggerType,
  nativeNotificationAdapter as notifee,
  type DisplayedNotification,
  type Notification,
  type TimestampTrigger,
  type TriggerNotification,
} from './nativeNotificationAdapter';
import type { EventDeliveryContext, NotificationIntent } from '@core/realtime';
import { isExactMessagePartTopology } from '@core/messages/retraction';
import { parseMessagePartTopology } from '@core/models';
import { logger } from '@core/secure';
import type { AppDatabase } from '@db/types';
import { useLockStore } from '@state/lockStore';
import { buildMessageSnippet, isRcsChatGuid } from '@utils';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
} from '../realtime/deliveryCoordinator';
import { isActiveChat } from './activeChat';
import {
  MESSAGE_HISTORY_IDS_KEY,
  decodeMessageHistoryIds,
  encodeMessageHistoryIds,
  mergeMessageNotificationHistory,
  normalizeMessageNotificationAvatarUri,
  normalizeMessageNotificationHistory,
  normalizeMessageNotificationHistoryEntry,
  normalizeMessageNotificationLabel,
  normalizeMessageNotificationText,
  normalizeMessageNotificationTitle,
  type MessageNotificationHistoryEntry,
} from './messageHistory';
import {
  NOTIFICATION_DATA_OWNER,
  NOTIFICATION_DATA_SCHEMA,
  chatChannelIdForLocalId,
  chatNotificationId,
  clearNotificationRoutes,
  deleteFaceTimeRoute,
  faceTimeNotificationId,
  findFaceTimeRoute,
  isSafeReminderNotificationId,
  listMessageNotificationTruth,
  listFutureReminderTriggerRoutes,
  localFailedMessageRoute,
  localRouteForGuids,
  localRouteForMessageGuid,
  migrateReminderNotificationId,
  nativeRouteData,
  nativeStatusData,
  replacementReminderNotificationId,
  resolveNotificationData,
  sendFailureNotificationId,
  MAX_MESSAGE_NOTIFICATION_TRUTH_IDS,
  type MessageNotificationTruth,
} from './notificationRouting';

export const CHANNEL_NEW_MESSAGE = 'com.bluegreengatorapps.messages.new_messages';
export const CHANNEL_REMINDERS = 'com.bluegreengatorapps.messages.reminders';
export const PRESS_OPEN = 'open-chat';
export const PRESS_INBOX = 'open-inbox';
export const PRESS_REMINDER = 'open-reminder';
export const ACTION_REPLY = 'reply';
export const ACTION_MARK_READ = 'mark-read';
export const ACTION_LOVE = 'love';
export const ACTION_ANSWER_FACETIME = 'answer-facetime';
export const ACTION_DECLINE_FACETIME = 'decline-facetime';

/**
 * Every native notification mutation runs through one queue. Legacy payload maintenance and
 * account teardown enumerate and replace OS state, so allowing a post/cancel to race either
 * read-modify-write sequence could leave old account data behind or resurrect a dismissed notice.
 *
 * Keep maintenance helpers below PRIVATE and call notify-kit directly from inside their queue
 * slot. Calling an exported queued helper there would wait on the slot it already owns.
 */
let notificationOperationTail: Promise<void> = Promise.resolve();
// Installed synchronously before enabling App Lock crosses any native/vault await. Keep the
// barrier after a failed transition; only a successful policy commit may release it.
let appLockPrivacyBarrier = false;
let notificationPrivacyEpoch = 0;

/** Call only after the lock store reflects a successfully committed/read vault policy. */
export function commitAppLockNotificationPrivacy(): void {
  notificationPrivacyEpoch += 1;
  appLockPrivacyBarrier = false;
}

function capturePresentationContext(context?: EventDeliveryContext): EventDeliveryContext {
  const account = context ?? captureRealtimeDeliveryLease();
  const epoch = notificationPrivacyEpoch;
  return { ...account, isCurrent: () => account.isCurrent() && epoch === notificationPrivacyEpoch };
}

function enqueueNotificationOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = notificationOperationTail.then(operation);
  // A failed native call is returned to its caller, but must not poison every later operation.
  notificationOperationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

const STATUS_LOCKED_ID = 'bb-locked-messages';
const STATUS_RCS_ID = 'bb-rcs-bridge-down';
const STATUS_TEST_ID = 'bb-test-notification';
const STATUS_ALIAS_ID = 'bb-aliases-removed';
// Android notification channels survive app updates. This id is cleanup-only and must never be
// exported or passed to createChannel again.
const LEGACY_FACETIME_CHANNEL_ID = 'com.bluegreengatorapps.messages.facetime';
const MESSAGE_GROUP_ID = 'gator-message-group';
const MESSAGE_GROUP_SUMMARY_ID = 'gator-message-summary';
const SEND_FAILURE_TITLE = 'Message status needs review';
const SEND_FAILURE_BODY = 'Open Gator to review.';

function dataString(data: Notification['data'], key: string): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function notificationId(notification: Notification, displayedId?: string): string | undefined {
  const id = notification.id ?? displayedId;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function messageActions(
  includeLove: boolean,
  chatGuid?: string,
  messageGuid?: string,
): NonNullable<Notification['android']>['actions'] {
  const reactionAvailable =
    !!chatGuid && isRcsChatGuid(chatGuid) && !!messageGuid && messageGuid.startsWith('rcs-');
  return [
    {
      title: 'Reply',
      pressAction: { id: ACTION_REPLY },
      input: { allowFreeFormInput: true, placeholder: 'Message' },
    },
    { title: 'Mark as read', pressAction: { id: ACTION_MARK_READ } },
    ...(includeLove && reactionAvailable
      ? [{ title: '♥ Love', pressAction: { id: ACTION_LOVE } }]
      : []),
  ];
}

interface DisplayedMessageHistory {
  chatId: number;
  entries: MessageNotificationHistoryEntry[];
  title: string;
  channelId: string;
  isGroup: boolean;
}

type DisplayedNotificationSnapshot = Pick<DisplayedNotification, 'id' | 'notification'>;

function positiveLocalId(value: unknown): number | undefined {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return undefined;
  const parsed = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function messageHistoryData(entries: readonly MessageNotificationHistoryEntry[]): {
  [MESSAGE_HISTORY_IDS_KEY]: string;
} {
  return { [MESSAGE_HISTORY_IDS_KEY]: encodeMessageHistoryIds(entries) };
}

function messagingStyleLines(entries: readonly MessageNotificationHistoryEntry[]) {
  return entries.map((entry) => ({
    text: entry.text,
    timestamp: entry.timestamp,
    person: {
      name: entry.senderName,
      id: 'contact',
      ...(entry.avatarUri ? { icon: entry.avatarUri } : {}),
    },
  }));
}

function messageGroupingAndroid(): {
  groupId: string;
  groupAlertBehavior: AndroidGroupAlertBehavior;
} {
  return {
    groupId: MESSAGE_GROUP_ID,
    // The individual incoming message keeps its normal sound/vibration; the summary stays silent.
    groupAlertBehavior: AndroidGroupAlertBehavior.CHILDREN,
  };
}

/** Accept only this build's bounded schema-2 history; malformed/legacy state is never merged. */
function parseDisplayedMessageHistory(
  displayed: DisplayedNotificationSnapshot,
  chatId: number,
): DisplayedMessageHistory | null {
  const source = displayed.notification;
  if (notificationId(source, displayed.id) !== chatNotificationId(chatId)) return null;
  if (
    dataString(source.data, 'gatorOwner') !== NOTIFICATION_DATA_OWNER ||
    dataString(source.data, 'gatorSchema') !== NOTIFICATION_DATA_SCHEMA ||
    dataString(source.data, 'gatorKind') !== 'message' ||
    positiveLocalId(source.data?.chatId) !== chatId
  ) {
    return null;
  }
  const style = source.android?.style;
  if (
    style?.type !== AndroidStyle.MESSAGING ||
    !Array.isArray(style.messages) ||
    style.messages.length < 1
  ) {
    return null;
  }

  // Notifications written just before this upgrade contain one safe local messageId but no
  // parallel history list. Adopt that exact one-line shape; any multi-line unowned shape fails.
  const encodedIds = source.data?.[MESSAGE_HISTORY_IDS_KEY];
  const ids =
    encodedIds == null && style.messages.length === 1
      ? [positiveLocalId(source.data?.messageId)]
      : decodeMessageHistoryIds(encodedIds, style.messages.length);
  if (!ids || ids.some((id) => id == null)) return null;

  const entries: MessageNotificationHistoryEntry[] = [];
  for (let index = 0; index < style.messages.length; index += 1) {
    const line = style.messages[index];
    const messageId = ids[index];
    const icon = line?.person?.icon;
    if (
      messageId == null ||
      typeof line?.text !== 'string' ||
      line.text.length === 0 ||
      typeof line.timestamp !== 'number' ||
      !Number.isFinite(line.timestamp) ||
      typeof line.person?.name !== 'string' ||
      line.person.name.length === 0 ||
      line.person.id !== 'contact' ||
      (icon != null && (typeof icon !== 'string' || icon.length === 0))
    ) {
      return null;
    }
    const entry = normalizeMessageNotificationHistoryEntry({
      messageId,
      text: line.text,
      timestamp: line.timestamp,
      senderName: line.person.name,
      ...(typeof icon === 'string' ? { avatarUri: icon } : {}),
    });
    if (!entry) return null;
    entries.push(entry);
  }

  const title = normalizeMessageNotificationTitle(source.title) ?? null;
  const channelId = source.android?.channelId;
  if (
    !title ||
    (channelId !== CHANNEL_NEW_MESSAGE && channelId !== chatChannelIdForLocalId(chatId))
  ) {
    return null;
  }
  return { chatId, entries, title, channelId, isGroup: style.group === true };
}

function findDisplayedMessageHistory(
  displayed: readonly DisplayedNotificationSnapshot[],
  chatId: number,
): DisplayedMessageHistory | null {
  const id = chatNotificationId(chatId);
  const matches = displayed.filter((item) => notificationId(item.notification, item.id) === id);
  return matches.length === 1 ? parseDisplayedMessageHistory(matches[0]!, chatId) : null;
}

function messageNotificationFromHistory(
  history: DisplayedMessageHistory,
  options: { onlyAlertOnce?: boolean; chatGuid?: string; messageGuid?: string } = {},
): Notification {
  const entries = normalizeMessageNotificationHistory(history.entries);
  const latest = entries.at(-1);
  if (!latest) throw new Error('cannot build an empty message notification history');
  const title = normalizeMessageNotificationTitle(history.title) ?? 'Conversation';
  return {
    id: chatNotificationId(history.chatId),
    title,
    body: latest.text,
    data: {
      ...nativeRouteData(
        'message',
        { chatId: history.chatId, messageId: latest.messageId },
        latest.timestamp,
      ),
      ...messageHistoryData(entries),
    },
    android: {
      channelId: history.channelId,
      smallIcon: 'ic_stat_gator',
      ...(options.onlyAlertOnce ? { onlyAlertOnce: true } : {}),
      ...messageGroupingAndroid(),
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      style: {
        type: AndroidStyle.MESSAGING,
        person: { name: 'You', id: 'self' },
        group: history.isGroup,
        messages: messagingStyleLines(entries),
      },
      actions: messageActions(true, options.chatGuid, options.messageGuid),
    },
  };
}

function fixedMessageGroupSummary(): Notification {
  return {
    id: MESSAGE_GROUP_SUMMARY_ID,
    title: 'Gator',
    // Android removes every grouped child when its summary is cancelled. Once a 2+ chat group has
    // formed, the summary therefore remains as a silent scaffold until the final child is gone.
    // Keep the copy truthful during that temporary one-child tail as well as at 2+ children.
    body: 'New messages',
    // Android persists this outside SQLCipher. Keep it route-free and entirely app-authored.
    data: nativeStatusData('message-summary'),
    android: {
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_stat_gator',
      onlyAlertOnce: true,
      ...messageGroupingAndroid(),
      groupSummary: true,
      // Opening the inbox must not let Android clear unread children as a side-effect.
      autoCancel: false,
      pressAction: { id: PRESS_INBOX, launchActivity: 'default' },
    },
  };
}

function localChatIdFromMessageNotificationId(id: string | undefined): number | undefined {
  const match = /^gator-message-([1-9]\d*)$/.exec(id ?? '');
  const chatId = positiveLocalId(match?.[1]);
  return chatId != null && chatNotificationId(chatId) === id ? chatId : undefined;
}

/** Count only one exact, owned schema-2 child per opaque local chat id. */
function strictDisplayedMessageChildren(
  displayed: readonly DisplayedNotificationSnapshot[],
  excludedId?: string,
): DisplayedMessageHistory[] {
  const buckets = new Map<string, DisplayedNotificationSnapshot[]>();
  for (const item of displayed) {
    const id = notificationId(item.notification, item.id);
    if (!id || id === excludedId || localChatIdFromMessageNotificationId(id) == null) continue;
    const bucket = buckets.get(id) ?? [];
    bucket.push(item);
    buckets.set(id, bucket);
  }

  const children: DisplayedMessageHistory[] = [];
  for (const [id, items] of buckets) {
    if (items.length !== 1) continue;
    const chatId = localChatIdFromMessageNotificationId(id);
    if (chatId == null) continue;
    const parsed = parseDisplayedMessageHistory(items[0]!, chatId);
    if (parsed) children.push(parsed);
  }
  return children;
}

function hasCurrentMessageGrouping(notification: Notification): boolean {
  return (
    notification.android?.groupId === MESSAGE_GROUP_ID &&
    notification.android.groupAlertBehavior === AndroidGroupAlertBehavior.CHILDREN &&
    notification.android.groupSummary !== true
  );
}

function hasCurrentMessageGroupSummary(
  displayed: readonly DisplayedNotificationSnapshot[],
): boolean {
  const matches = displayed.filter(
    (item) => notificationId(item.notification, item.id) === MESSAGE_GROUP_SUMMARY_ID,
  );
  if (matches.length !== 1) return false;
  const summary = matches[0]!.notification;
  const dataKeys = Object.keys(summary.data ?? {}).sort();
  return (
    markerKind(summary) === 'message-summary' &&
    dataKeys.length === 3 &&
    dataKeys[0] === 'gatorKind' &&
    dataKeys[1] === 'gatorOwner' &&
    dataKeys[2] === 'gatorSchema' &&
    summary.title === 'Gator' &&
    summary.body === 'New messages' &&
    summary.subtitle == null &&
    summary.android?.channelId === CHANNEL_NEW_MESSAGE &&
    summary.android.groupId === MESSAGE_GROUP_ID &&
    summary.android.groupSummary === true &&
    summary.android.groupAlertBehavior === AndroidGroupAlertBehavior.CHILDREN &&
    summary.android.onlyAlertOnce === true &&
    summary.android.autoCancel === false &&
    summary.android.pressAction?.id === PRESS_INBOX &&
    summary.android.actions == null &&
    summary.android.style == null &&
    summary.android.largeIcon == null &&
    summary.android.ticker == null
  );
}

function hasDisplayedMessageGroupSummary(
  displayed: readonly DisplayedNotificationSnapshot[],
): boolean {
  return displayed.some(
    (item) => notificationId(item.notification, item.id) === MESSAGE_GROUP_SUMMARY_ID,
  );
}

/** Any raw child in our native group makes summary cancellation destructive, even if untrusted. */
function hasDisplayedMessageGroupMember(
  displayed: readonly DisplayedNotificationSnapshot[],
): boolean {
  return displayed.some(
    (item) =>
      item.notification.android?.groupId === MESSAGE_GROUP_ID &&
      item.notification.android.groupSummary !== true,
  );
}

function nativeFailureName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function hydratedMessageMutationAllowed(): boolean {
  const lock = useLockStore.getState();
  return lock.hydrated && !privateNotificationMustBeHidden();
}

const MESSAGE_GROUP_LOCK_READ_TIMEOUT_MS = 2_000;

/**
 * Resolve one mutation policy without hydrating or caching foreground App Lock state. A verified
 * headless OFF read can authorize a generic summary or replacement of DB-reconciled existing
 * history. Every guard requires the captured account to remain current; headless guards also
 * require the original lock snapshot, while hydrated guards recheck the live lock policy.
 */
async function resolveMessageNotificationMutationGuard(
  context?: EventDeliveryContext,
): Promise<() => boolean> {
  const lease = capturePresentationContext(context);
  const lockSnapshot = useLockStore.getState();
  if (!lease.isCurrent()) return () => false;
  if (lockSnapshot.hydrated) {
    return () => lease.isCurrent() && hydratedMessageMutationAllowed();
  }
  if (privateNotificationMustBeHidden()) return () => false;

  let readActive = true;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let abortRead: (() => void) | undefined;
  let persistedLockDisabled = false;
  const unavailable = new Promise<'true'>((resolve) => {
    // A stuck SecureStore read must not wedge the serialized native queue or account teardown.
    abortRead = () => resolve('true');
    timeoutHandle = setTimeout(abortRead, MESSAGE_GROUP_LOCK_READ_TIMEOUT_MS);
    lease.signal?.addEventListener('abort', abortRead, { once: true });
    if (lease.signal?.aborted) abortRead();
  });
  try {
    const value = await Promise.race([
      (async () => {
        const { vault } = await import('../clients');
        if (!readActive || !lease.isCurrent() || useLockStore.getState() !== lockSnapshot) {
          return 'true';
        }
        return vault.get('appLockEnabled');
      })(),
      unavailable,
    ]);
    // Match FCM's persisted policy: only a successful missing/default or explicit OFF is safe.
    persistedLockDisabled = value === null || value === 'false';
  } catch (error) {
    if (lease.isCurrent()) {
      logger.warn('[notif] message-group lock-state read failed', {
        errorName: nativeFailureName(error),
      });
    }
  } finally {
    readActive = false;
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (abortRead) lease.signal?.removeEventListener('abort', abortRead);
  }
  // Object identity also rejects OFF -> ON -> OFF and foreground hydration during native waits.
  return () =>
    persistedLockDisabled && lease.isCurrent() && useLockStore.getState() === lockSnapshot;
}

async function cancelMessageGroupSummaryBestEffort(
  canMutate: () => boolean,
  context?: EventDeliveryContext,
): Promise<void> {
  if (!canMutate()) return;
  try {
    await notifee.cancelNotification(MESSAGE_GROUP_SUMMARY_ID);
  } catch (error) {
    if (deliveryIsCurrent(context)) {
      logger.warn('[notif] message-group summary cancellation failed', {
        errorName: nativeFailureName(error),
      });
    }
  }
}

/**
 * Inspect current grouped children and repair their fixed summary. The caller already owns the
 * global notification queue slot. Never rewrite a child captured in a native snapshot: it may have
 * been swiped since enumeration, and startup maintenance must not rewrite valid detailed notices.
 * Pre-feature children adopt grouping naturally when a fresh message replaces their stable id.
 */
async function reconcileMessageGroupFromDisplayedNow(
  displayed: readonly DisplayedNotificationSnapshot[],
  context?: EventDeliveryContext,
  excludedId?: string,
  mutationGuard?: () => boolean,
): Promise<void> {
  context ??= captureRealtimeDeliveryLease();
  if (!deliveryIsCurrent(context)) return;
  // The App Lock transition owns its separate displayed-state sweep. Ordinary group repair must
  // never cancel just the summary while private children remain underneath it.
  const canMutate = mutationGuard ?? (await resolveMessageNotificationMutationGuard(context));
  if (!canMutate()) return;

  const children = strictDisplayedMessageChildren(displayed, excludedId).filter((child) => {
    const source = displayed.find(
      (item) => notificationId(item.notification, item.id) === chatNotificationId(child.chatId),
    )?.notification;
    return source != null && hasCurrentMessageGrouping(source);
  });

  if (!deliveryIsCurrent(context)) return;
  // Android's NotificationManager deliberately cancels all group children when their summary is
  // cancelled. Do that only after the group is empty. A summary first appears at two children, but
  // remains as a silent scaffold through a 2 -> 1 transition so the surviving child is not lost.
  // Rebuilding that survivor from this native snapshot would race a user swipe and could resurrect
  // a notification, so the episode-lifetime scaffold is the safe option at the JS bridge boundary.
  const hasSummary = hasDisplayedMessageGroupSummary(displayed);
  if (children.length === 0) {
    // Strict parsing can reject a malformed or duplicate child that Android still considers a
    // member of this group. Never let that turn into destructive cleanup of the rejected record;
    // if a summary already exists, fall through so private or stale fields are repaired in place.
    if (!hasDisplayedMessageGroupMember(displayed)) {
      await cancelMessageGroupSummaryBestEffort(canMutate, context);
      return;
    }
    if (!hasSummary) return;
  }
  // A first-ever single child does not need a summary. If this is the tail of an existing group,
  // however, repair the summary in place: cancelling it would delete the child, while retaining a
  // stale or malformed summary could persist private native fields indefinitely.
  if (children.length === 1 && !hasSummary) return;
  if (hasCurrentMessageGroupSummary(displayed)) return;

  try {
    await ensureChannel();
    if (!deliveryIsCurrent(context)) return;
    if (!canMutate()) return;
    await notifee.displayNotification(fixedMessageGroupSummary());
    if (!deliveryIsCurrent(context)) {
      // Disconnect also queues a store-wide sweep, but contain this just-created old-account
      // summary immediately while the current queue slot is still admitted.
      try {
        await notifee.cancelNotification(MESSAGE_GROUP_SUMMARY_ID);
      } catch {
        // The authoritative account-teardown sweep remains queued behind this operation.
      }
    }
  } catch (error) {
    if (deliveryIsCurrent(context)) {
      logger.warn('[notif] message-group summary repair failed', {
        errorName: nativeFailureName(error),
      });
    }
  }
}

async function reconcileMessageGroupNow(
  context?: EventDeliveryContext,
  excludedId?: string,
): Promise<void> {
  context ??= captureRealtimeDeliveryLease();
  if (!deliveryIsCurrent(context)) return;
  const canMutate = await resolveMessageNotificationMutationGuard(context);
  if (!canMutate()) return;
  let displayed: DisplayedNotification[];
  try {
    displayed = await notifee.getDisplayedNotifications();
  } catch (error) {
    if (deliveryIsCurrent(context)) {
      logger.warn('[notif] message-group enumeration failed', {
        errorName: nativeFailureName(error),
      });
    }
    // Unknown is not empty. Cancelling a group summary makes Android cancel every child in that
    // group, so an enumeration failure must preserve the entire native group for the next retry.
    return;
  }
  if (!canMutate()) return;
  await reconcileMessageGroupFromDisplayedNow(displayed, context, excludedId, canMutate);
}

interface OwnedDisplayedMessageHistory {
  id: string;
  history: DisplayedMessageHistory;
}

function isMessageChildIdLike(id: string | undefined): boolean {
  return id?.startsWith('gator-message-') === true && id !== MESSAGE_GROUP_SUMMARY_ID;
}

/**
 * Parse every app-owned message child as one exact current history. An owned-looking malformed,
 * mismatched, or duplicate record is uncertainty rather than evidence that it is safe to retain.
 */
function ownedDisplayedMessageHistories(
  displayed: readonly DisplayedNotificationSnapshot[],
): OwnedDisplayedMessageHistory[] {
  const buckets = new Map<string, DisplayedNotificationSnapshot[]>();
  for (const item of displayed) {
    const sourceId = notificationId(item.notification);
    const displayedId = typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined;
    if (!isMessageChildIdLike(sourceId) && !isMessageChildIdLike(displayedId)) continue;
    if (!sourceId || !displayedId || sourceId !== displayedId) {
      throw new Error('a displayed message child has mismatched native identifiers');
    }
    const bucket = buckets.get(sourceId) ?? [];
    bucket.push(item);
    buckets.set(sourceId, bucket);
  }

  const histories: OwnedDisplayedMessageHistory[] = [];
  for (const [id, items] of buckets) {
    const chatId = localChatIdFromMessageNotificationId(id);
    if (chatId == null || items.length !== 1) {
      throw new Error('a displayed message child is malformed or duplicated');
    }
    const history = parseDisplayedMessageHistory(items[0]!, chatId);
    if (!history) throw new Error('a displayed message child has malformed history');
    histories.push({ id, history });
  }
  return histories;
}

async function containUncertainDisplayedMessageState(
  message: string,
  failures: unknown[],
): Promise<never> {
  try {
    // A native tag is not exposed by notify-kit enumeration, so only the store-wide displayed
    // sweep proves containment for an owned-looking malformed record.
    await notifee.cancelDisplayedNotifications();
  } catch (error) {
    failures.push(error);
  }
  throw new DisplayedStateContainedError(message, failures);
}

class DisplayedStateContainedError extends Error {
  constructor(message: string, failures: unknown[]) {
    super(privacyError(message, failures).message);
    this.name = 'DisplayedStateContainedError';
  }
}

function reconciledMessageHistoryEntry(
  entry: MessageNotificationHistoryEntry,
  chatId: number,
  truth: MessageNotificationTruth | undefined,
): MessageNotificationHistoryEntry | null {
  if (!truth || truth.chatId !== chatId || truth.notificationEligible !== 1) return null;

  if (truth.retractionState === 'partial') {
    const topology = parseMessagePartTopology(truth.messagePartTopology);
    if (
      !topology ||
      !isExactMessagePartTopology(topology) ||
      topology.currentParts.length === 0 ||
      topology.currentParts.length >= topology.originalPartIndexes.length
    ) {
      return null;
    }
    const text =
      normalizeMessageNotificationText(
        buildMessageSnippet({
          text: truth.text,
          subject: truth.subject,
          hasAttachments: truth.hasAttachments,
          hasVisibleAttachments: truth.hasVisibleAttachments,
          attachmentDescription: truth.attachmentDescription,
          balloonBundleId: truth.balloonBundleId,
        }),
      ) ?? 'Message';
    return { ...entry, text };
  }

  // A migrated row with no classifier is intact only when the legacy date marker agrees. Treat
  // every unknown value or contradictory intact/date pair as hidden instead of guessing.
  if (
    (truth.retractionState === 'intact' || truth.retractionState == null) &&
    truth.dateRetracted == null
  ) {
    return entry;
  }
  return null;
}

function reconciledMessageHistory(
  history: DisplayedMessageHistory,
  truthByMessageId: ReadonlyMap<number, MessageNotificationTruth>,
): { entries: MessageNotificationHistoryEntry[]; changed: boolean } {
  const entries: MessageNotificationHistoryEntry[] = [];
  let changed = false;
  for (const entry of history.entries) {
    const next = reconciledMessageHistoryEntry(
      entry,
      history.chatId,
      truthByMessageId.get(entry.messageId),
    );
    if (!next) {
      changed = true;
      continue;
    }
    if (next.text !== entry.text) changed = true;
    entries.push(next);
  }
  return { entries, changed };
}

/**
 * Last-moment presence check for one planned mutation. A child swiped while an earlier sibling's
 * native replacement was awaiting must not be recreated from the batch snapshot.
 */
async function revalidateDisplayedMessageHistoryForMutation(
  id: string,
  chatId: number,
  requestedIds: ReadonlySet<number>,
): Promise<DisplayedMessageHistory | null> {
  let displayed: DisplayedNotification[];
  try {
    displayed = await notifee.getDisplayedNotifications();
  } catch (error) {
    return containUncertainDisplayedMessageState(
      'displayed message history was cancelled because mutation presence was uncertain',
      [error],
    );
  }
  const matches = displayed.filter((item) => notificationId(item.notification, item.id) === id);
  if (matches.length === 0) return null;
  const history = matches.length === 1 ? parseDisplayedMessageHistory(matches[0]!, chatId) : null;
  if (!history || history.entries.some((entry) => !requestedIds.has(entry.messageId))) {
    return containUncertainDisplayedMessageState(
      'displayed message history changed before mutation and was cancelled',
      [],
    );
  }
  return history;
}

/** Private DB-truth reconciliation. The caller already owns the global native mutation slot. */
async function reconcileDisplayedMessageHistoriesNow(
  db?: AppDatabase,
  context?: EventDeliveryContext,
): Promise<void> {
  context ??= captureRealtimeDeliveryLease();
  if (!deliveryIsCurrent(context)) return;
  const canReplaceHistory = await resolveMessageNotificationMutationGuard(context);
  if (!deliveryIsCurrent(context)) return;
  let firstDisplayed: DisplayedNotification[];
  try {
    firstDisplayed = await notifee.getDisplayedNotifications();
  } catch (error) {
    return containUncertainDisplayedMessageState(
      'displayed message history was cancelled because it could not be enumerated safely',
      [error],
    );
  }
  if (!deliveryIsCurrent(context)) return;

  let firstHistories: OwnedDisplayedMessageHistory[];
  try {
    firstHistories = ownedDisplayedMessageHistories(firstDisplayed);
  } catch (error) {
    return containUncertainDisplayedMessageState(
      'malformed displayed message history was cancelled',
      [error],
    );
  }
  const messageIds = firstHistories.flatMap(({ history }) =>
    history.entries.map((entry) => entry.messageId),
  );
  const uniqueMessageIds = [...new Set(messageIds)];
  if (uniqueMessageIds.length > MAX_MESSAGE_NOTIFICATION_TRUTH_IDS) {
    return containUncertainDisplayedMessageState(
      'displayed message history exceeded its reconciliation bound and was cancelled',
      [],
    );
  }

  let truthRows: MessageNotificationTruth[];
  try {
    truthRows = await listMessageNotificationTruth(uniqueMessageIds, db);
  } catch (error) {
    return containUncertainDisplayedMessageState(
      'displayed message history was cancelled because encrypted-DB truth was unavailable',
      [error],
    );
  }
  if (!deliveryIsCurrent(context)) return;

  const requestedIds = new Set(uniqueMessageIds);
  const truthByMessageId = new Map<number, MessageNotificationTruth>();
  for (const truth of truthRows) {
    if (
      !Number.isSafeInteger(truth.messageId) ||
      !requestedIds.has(truth.messageId) ||
      truthByMessageId.has(truth.messageId)
    ) {
      return containUncertainDisplayedMessageState(
        'displayed message history was cancelled because encrypted-DB truth was malformed',
        [],
      );
    }
    truthByMessageId.set(truth.messageId, truth);
  }

  // Re-enumerate after the DB read. A child swiped while that read was in flight is absent here and
  // is never rebuilt from the older snapshot. New/unrecognized history means our proof is stale.
  let liveDisplayed: DisplayedNotification[];
  try {
    liveDisplayed = await notifee.getDisplayedNotifications();
  } catch (error) {
    return containUncertainDisplayedMessageState(
      'displayed message history was cancelled because its final state was uncertain',
      [error],
    );
  }
  if (!deliveryIsCurrent(context)) return;

  let liveHistories: OwnedDisplayedMessageHistory[];
  try {
    liveHistories = ownedDisplayedMessageHistories(liveDisplayed);
  } catch (error) {
    return containUncertainDisplayedMessageState(
      'malformed displayed message history was cancelled',
      [error],
    );
  }
  for (const { history } of liveHistories) {
    if (history.entries.some((entry) => !requestedIds.has(entry.messageId))) {
      return containUncertainDisplayedMessageState(
        'displayed message history changed during reconciliation and was cancelled',
        [],
      );
    }
  }

  const failures: unknown[] = [];
  let mutated = false;
  for (const { id, history } of liveHistories) {
    if (!deliveryIsCurrent(context)) return;
    const planned = reconciledMessageHistory(history, truthByMessageId);
    if (!planned.changed) continue;
    try {
      // Channel setup can await. Finish it before the last-moment child enumeration so there is no
      // native wait between the proof of presence and the replacement itself.
      if (planned.entries.length > 0) await ensureChannel();
      if (!deliveryIsCurrent(context)) return;
      const current = await revalidateDisplayedMessageHistoryForMutation(
        id,
        history.chatId,
        requestedIds,
      );
      if (!deliveryIsCurrent(context)) return;
      if (!current) continue;
      const reconciled = reconciledMessageHistory(current, truthByMessageId);
      if (!reconciled.changed) continue;
      if (reconciled.entries.length === 0 || !canReplaceHistory()) {
        await notifee.cancelNotification(id);
        mutated = true;
        continue;
      }
      await notifee.displayNotification(
        messageNotificationFromHistory(
          { ...current, entries: reconciled.entries },
          {
            onlyAlertOnce: true,
            // Reconciliation intentionally has no current server message GUID. Omitting it keeps
            // a rebuilt/stale history's Love action hidden instead of guessing from its chat.
            chatGuid: reconciled.entries
              .map((entry) => truthByMessageId.get(entry.messageId)?.chatGuid)
              .find((guid): guid is string => typeof guid === 'string' && guid.length > 0),
          },
        ),
      );
      mutated = true;
      if (!deliveryIsCurrent(context) || !canReplaceHistory()) {
        // The bridge may have committed as the account or lock policy changed. Remove the exact
        // stable id now. Account teardown and App Lock admission also queue their own sweeps.
        try {
          await notifee.cancelNotification(id);
        } catch {
          // Best effort: native cancellation can fail even after a successful replacement.
        }
        return;
      }
    } catch (error) {
      if (error instanceof DisplayedStateContainedError) {
        failures.push(error);
        break;
      }
      // An uncertain replacement must not leave the old retracted text visible.
      try {
        await notifee.cancelNotification(id);
        mutated = true;
      } catch (cancelError) {
        failures.push(cancelError);
      }
      failures.push(error);
      break;
    }
  }
  if (failures.length > 0) {
    throw privacyError('one or more displayed message histories could not be reconciled', failures);
  }
  if (!deliveryIsCurrent(context) || !mutated) return;
  await reconcileMessageGroupNow(context);
}

function markerKind(source: Notification): string | undefined {
  return dataString(source.data, 'gatorOwner') === NOTIFICATION_DATA_OWNER &&
    dataString(source.data, 'gatorSchema') === NOTIFICATION_DATA_SCHEMA
    ? dataString(source.data, 'gatorKind')
    : undefined;
}

function isReminderPayload(source: Notification): boolean {
  return markerKind(source) === 'reminder' || dataString(source.data, 'reminder') === '1';
}

async function sanitizedMessageNotification(source: Notification): Promise<Notification | null> {
  const resolved = await resolveNotificationData(source.data);
  if (!resolved?.chatGuid || resolved.reminder === '1' || resolved.faceTimeUuid) return null;
  const route = await localRouteForGuids(resolved.chatGuid, resolved.messageGuid);
  if (!route) return null;
  const messageDate = resolved.messageDate;
  const parsedDate = messageDate == null ? Number.NaN : Number(messageDate);
  const style = source.android?.style;
  const isGroup = style?.type === AndroidStyle.MESSAGING && style.group === true;
  const existingTimestamp =
    style?.type === AndroidStyle.MESSAGING ? style.messages.at(0)?.timestamp : undefined;
  const timestamp = Number.isFinite(parsedDate)
    ? parsedDate
    : typeof existingTimestamp === 'number' && Number.isFinite(existingTimestamp)
      ? existingTimestamp
      : Date.now();
  if (route.messageId != null) {
    return messageNotificationFromHistory(
      {
        chatId: route.chatId,
        title: 'Contact',
        channelId: CHANNEL_NEW_MESSAGE,
        isGroup,
        entries: [
          {
            messageId: route.messageId,
            text: 'New message',
            timestamp,
            senderName: 'Contact',
          },
        ],
      },
      {
        onlyAlertOnce: true,
        chatGuid: resolved.chatGuid,
        messageGuid: resolved.messageGuid,
      },
    );
  }

  // A legacy chat-only payload has no opaque message key, so it cannot join strictly validated
  // history/grouping. Preserve its generic one-line compatibility notice without claiming it.
  return {
    id: chatNotificationId(route.chatId),
    title: 'Contact',
    body: 'New message',
    data: {
      ...nativeRouteData(
        'message',
        route,
        messageDate && Number.isFinite(parsedDate) ? messageDate : undefined,
      ),
    },
    android: {
      // Legacy cleanup cannot safely recover the conversation title, so use the shared generic
      // channel. Fresh ordinary notifications can still use an existing per-chat channel.
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_stat_gator',
      onlyAlertOnce: true,
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      style: {
        type: AndroidStyle.MESSAGING,
        person: { name: 'You', id: 'self' },
        group: isGroup,
        messages: [
          {
            text: 'New message',
            timestamp,
            person: { name: 'Contact', id: 'contact' },
          },
        ],
      },
      actions: messageActions(false, resolved.chatGuid),
    },
  };
}

function fixedSendFailureNotification(
  route: NonNullable<Awaited<ReturnType<typeof localFailedMessageRoute>>>['route'],
): Notification {
  return {
    id: sendFailureNotificationId(route.messageId),
    title: SEND_FAILURE_TITLE,
    body: SEND_FAILURE_BODY,
    data: nativeRouteData('send-failure', route),
    android: {
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_stat_gator',
      onlyAlertOnce: true,
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
    },
  };
}

async function sanitizedSendFailureNotification(
  source: Notification,
): Promise<Notification | null> {
  const resolved = await resolveNotificationData(source.data);
  if (!resolved?.chatGuid || !resolved.messageGuid) return null;
  const target = await localFailedMessageRoute(resolved.messageGuid);
  if (!target || target.chatGuid !== resolved.chatGuid) return null;
  return fixedSendFailureNotification(target.route);
}

interface ReminderReplacement {
  notification: Notification;
  oldId: string;
  newId: string;
}

interface ReminderTriggerPlan {
  reminder: ReminderReplacement;
  trigger: TimestampTrigger;
}

async function sanitizedReminderNotification(
  source: Notification,
  displayedId?: string,
  scheduledFor?: number,
): Promise<ReminderReplacement | null> {
  const oldId = notificationId(source, displayedId);
  if (!oldId) return null;
  const resolved = await resolveNotificationData(source.data);
  if (!resolved?.chatGuid || resolved.reminder !== '1') return null;
  const route = await localRouteForGuids(resolved.chatGuid, resolved.messageGuid);
  if (!route) return null;
  const safeId = isSafeReminderNotificationId(oldId)
    ? oldId
    : resolved.messageGuid
      ? await replacementReminderNotificationId(oldId, resolved.messageGuid, scheduledFor)
      : null;
  if (!safeId) return null;
  const messageDate = resolved.messageDate;
  return {
    oldId,
    newId: safeId,
    notification: {
      id: safeId,
      title: 'Reminder',
      body: 'Reminder',
      data: nativeRouteData(
        'reminder',
        route,
        messageDate && Number.isFinite(Number(messageDate)) ? messageDate : undefined,
      ),
      android: {
        channelId: CHANNEL_REMINDERS,
        smallIcon: 'ic_stat_gator',
        onlyAlertOnce: true,
        pressAction: { id: PRESS_REMINDER, launchActivity: 'default' },
      },
    },
  };
}

function sanitizedDurableReminderNotification(
  durable: Awaited<ReturnType<typeof listFutureReminderTriggerRoutes>>[number],
): ReminderTriggerPlan {
  return {
    reminder: {
      oldId: durable.oldId,
      newId: durable.newId,
      notification: {
        id: durable.newId,
        title: 'Reminder',
        body: 'Reminder',
        data: nativeRouteData('reminder', durable.route, durable.messageDate),
        android: {
          channelId: CHANNEL_REMINDERS,
          smallIcon: 'ic_stat_gator',
          onlyAlertOnce: true,
          pressAction: { id: PRESS_REMINDER, launchActivity: 'default' },
        },
      },
    },
    trigger: {
      type: TriggerType.TIMESTAMP,
      timestamp: durable.scheduledFor,
      alarmManager: { type: AlarmType.SET_AND_ALLOW_WHILE_IDLE },
    },
  };
}

/** Preserve designated non-private notices while stripping any unexpected extra presentation. */
function preservedStatusNotification(id: string): Notification | null {
  let title: string;
  let body: string;
  let kind: 'locked' | 'rcs' | 'test' | 'alias';
  switch (id) {
    case STATUS_LOCKED_ID:
      title = 'Gator';
      body = 'You have new messages';
      kind = 'locked';
      break;
    case STATUS_RCS_ID:
      title = 'Gator';
      body = 'RCS service needs attention.';
      kind = 'rcs';
      break;
    case STATUS_TEST_ID:
      title = 'Gator';
      body = 'Test notification received.';
      kind = 'test';
      break;
    case STATUS_ALIAS_ID:
      title = 'iMessage';
      body = 'An iMessage alias was deregistered.';
      kind = 'alias';
      break;
    default:
      return null;
  }
  return {
    id,
    title,
    body,
    data: nativeStatusData(kind),
    android: {
      channelId: CHANNEL_NEW_MESSAGE,
      smallIcon: 'ic_stat_gator',
      onlyAlertOnce: true,
      pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
    },
  };
}

async function sanitizedNotification(
  source: Notification,
  displayedId?: string,
): Promise<Notification | null> {
  const id = notificationId(source, displayedId);
  if (!id) return null;
  const status = preservedStatusNotification(id);
  if (status) return status;
  const kind = markerKind(source);
  const reminder = await sanitizedReminderNotification(source, displayedId);
  if (reminder) return reminder.notification;
  // A legacy/current FaceTime notice is cleanup-only during the whitelist rebuild. Returning null
  // ensures the store-wide containment sweep removes it and never reconstructs call presentation.
  if (kind === 'facetime' || dataString(source.data, 'faceTimeUuid')) return null;
  if (kind === 'send-failure') return sanitizedSendFailureNotification(source);
  return sanitizedMessageNotification(source);
}

function isTimestampTrigger(value: unknown): value is TimestampTrigger {
  if (typeof value !== 'object' || value == null) return false;
  const trigger = value as Partial<TimestampTrigger>;
  return trigger.type === TriggerType.TIMESTAMP && Number.isFinite(trigger.timestamp);
}

function privacyError(message: string, failures: unknown[]): Error {
  const details = failures.map((failure) => String(failure)).join('; ');
  return new Error(`${message}${details ? ` (${details})` : ''}`);
}

async function sanitizeDisplayedNotifications(context?: EventDeliveryContext): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  let displayed: DisplayedNotification[];
  try {
    displayed = await notifee.getDisplayedNotifications();
  } catch (enumerationError) {
    try {
      await notifee.cancelDisplayedNotifications();
    } catch (cancelError) {
      throw privacyError('could not enumerate or contain displayed notifications', [
        enumerationError,
        cancelError,
      ]);
    }
    throw privacyError(
      'displayed notifications were cancelled because they could not be enumerated safely',
      [enumerationError],
    );
  }

  const failures: unknown[] = [];
  const plans: Notification[] = [];
  for (const item of displayed) {
    if (!deliveryIsCurrent(context)) return;
    try {
      const reminder = await sanitizedReminderNotification(item.notification, item.id);
      if (!deliveryIsCurrent(context)) return;
      if (reminder) {
        if (
          !(await migrateReminderNotificationId(
            reminder.oldId,
            reminder.newId,
            context ? () => context.isCurrent() : undefined,
          ))
        ) {
          failures.push(new Error('a displayed reminder has no durable row'));
          continue;
        }
        plans.push(reminder.notification);
        continue;
      }
      if (isReminderPayload(item.notification)) {
        failures.push(new Error('a displayed reminder could not be reconciled to its durable row'));
        continue;
      }
      const replacement = await sanitizedNotification(item.notification, item.id);
      if (replacement) plans.push(replacement);
    } catch (error) {
      failures.push(error);
    }
  }

  // notify-kit's Android targeted cancel needs the original tag. Store-wide cancellation is the
  // only reliable containment for tagged entries, and it also catches an alarm that fired after
  // enumeration but before this final sweep.
  if (!deliveryIsCurrent(context)) return;
  try {
    await notifee.cancelDisplayedNotifications();
  } catch (error) {
    throw privacyError('could not contain displayed notifications before rebuilding', [error]);
  }
  const rebuilt: DisplayedNotificationSnapshot[] = [];
  for (const replacement of plans) {
    if (!deliveryIsCurrent(context)) return;
    try {
      await notifee.displayNotification(replacement);
      rebuilt.push({ id: replacement.id, notification: replacement });
    } catch (error) {
      failures.push(error);
    }
  }
  if (deliveryIsCurrent(context)) {
    await reconcileMessageGroupFromDisplayedNow(rebuilt, context);
  }

  if (failures.length > 0) {
    throw privacyError(
      'one or more displayed notifications could not be preserved safely',
      failures,
    );
  }
}

/**
 * Ordinary connected startup rewrites only displayed reminders. Message children are reconciled
 * separately from DB truth, so this pass never copies their Android-owned private presentation.
 */
async function sanitizeCurrentDisplayedReminders(context?: EventDeliveryContext): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  let displayed: DisplayedNotification[];
  try {
    displayed = await notifee.getDisplayedNotifications();
  } catch (enumerationError) {
    try {
      await notifee.cancelDisplayedNotifications();
    } catch (cancelError) {
      throw privacyError('could not enumerate or contain displayed reminders', [
        enumerationError,
        cancelError,
      ]);
    }
    throw privacyError('displayed notifications were cancelled after reminder inspection failed', [
      enumerationError,
    ]);
  }

  const failures: unknown[] = [];
  for (const item of displayed) {
    if (!deliveryIsCurrent(context)) return;
    if (!isReminderPayload(item.notification)) continue;
    const oldId = notificationId(item.notification, item.id);
    let newId: string | undefined;
    try {
      const reminder = await sanitizedReminderNotification(item.notification, item.id);
      if (!reminder) throw new Error('a displayed reminder has no safe durable route');
      newId = reminder.newId;
      if (
        !(await migrateReminderNotificationId(
          reminder.oldId,
          reminder.newId,
          context ? () => context.isCurrent() : undefined,
        ))
      ) {
        throw new Error('a displayed reminder has no durable row');
      }
      if (!deliveryIsCurrent(context)) return;
      // Retire a legacy/private id before posting its generic replacement. A failure may lose this
      // already-fired tray item, but the encrypted Reminders list remains authoritative and no
      // private native payload is allowed to win that trade-off.
      if (reminder.oldId !== reminder.newId) {
        await notifee.cancelNotification(reminder.oldId);
      }
      if (!deliveryIsCurrent(context)) return;
      await notifee.displayNotification(reminder.notification);
    } catch (error) {
      failures.push(error);
      const ids = [...new Set([oldId, newId].filter((id): id is string => id != null))];
      if (ids.length === 0) {
        return containUncertainDisplayedMessageState(
          'a displayed reminder without a cancellable id forced displayed-state containment',
          failures,
        );
      }
      for (const id of ids) {
        try {
          await notifee.cancelNotification(id);
        } catch (cancelError) {
          return containUncertainDisplayedMessageState(
            'a displayed reminder could not be contained by id',
            [...failures, cancelError],
          );
        }
      }
    }
  }
  if (failures.length > 0) {
    throw privacyError('one or more displayed reminders could not be preserved safely', failures);
  }
}

/**
 * notify-kit refuses a trigger time that is not in the future, yet a reminder being re-armed can
 * already be due: Android delivers these inexact alarms minutes late, and one can come due while a
 * rebuild runs. Fire such a reminder shortly instead of losing it.
 */
const REARM_DUE_REMINDER_DELAY_MS = 5_000;

async function armSanitizedReminder(
  { reminder, trigger }: ReminderTriggerPlan,
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  try {
    await notifee.createTriggerNotification(reminder.notification, {
      ...trigger,
      timestamp: Math.max(trigger.timestamp, Date.now() + REARM_DUE_REMINDER_DELAY_MS),
    });
  } catch (createError) {
    // A rejected bridge call is not proof that Android made no change. The id and payload are safe,
    // but cancel the uncertain result before retrying so we never leave an untracked native alarm.
    try {
      await notifee.cancelTriggerNotification(reminder.newId);
    } catch (cancelError) {
      throw privacyError('could not clean up an uncertain reminder re-arm', [
        createError,
        cancelError,
      ]);
    }
    throw createError;
  }

  if (!deliveryIsCurrent(context)) {
    // Disconnect will also queue a store-wide cancel, but retire this just-created alarm while the
    // maintenance slot is still admitted so it cannot survive if account cleanup later degrades.
    try {
      await notifee.cancelTriggerNotification(reminder.newId);
    } catch {
      // The account owner is already gone; its queued teardown remains the authoritative sweep.
    }
    return;
  }

  try {
    if (
      !(await migrateReminderNotificationId(
        reminder.oldId,
        reminder.newId,
        context ? () => context.isCurrent() : undefined,
      ))
    ) {
      throw new Error('a scheduled reminder has no durable row');
    }
  } catch (migrationError) {
    // The native half must not outlive a failed durable hand-off. This is a direct native call:
    // the enclosing maintenance pass already owns the notification queue slot.
    try {
      await notifee.cancelTriggerNotification(reminder.newId);
    } catch (cancelError) {
      throw privacyError('could not retire a reminder after its durable hand-off failed', [
        migrationError,
        cancelError,
      ]);
    }
    throw migrationError;
  }
}

/**
 * Native trigger replacement is not transactional. Retry only the failed safe plans once: this
 * repairs the ordinary transient/partial failure without replaying successful alarms, while a
 * persistent failure still rejects promptly instead of wedging the global notification queue.
 */
async function armSanitizedReminders(
  plans: ReminderTriggerPlan[],
  context?: EventDeliveryContext,
): Promise<unknown[]> {
  let remaining = plans;
  let lastFailures: unknown[] = [];
  for (let attempt = 0; attempt < 2 && remaining.length > 0; attempt += 1) {
    const failedPlans: ReminderTriggerPlan[] = [];
    lastFailures = [];
    for (const plan of remaining) {
      if (!deliveryIsCurrent(context)) return [];
      try {
        await armSanitizedReminder(plan, context);
      } catch (error) {
        failedPlans.push(plan);
        lastFailures.push(error);
      }
    }
    remaining = failedPlans;
  }
  return lastFailures;
}

async function sanitizeTriggerNotifications(context?: EventDeliveryContext): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  let pending: TriggerNotification[];
  try {
    pending = await notifee.getTriggerNotifications();
  } catch (enumerationError) {
    try {
      await notifee.cancelTriggerNotifications();
    } catch (cancelError) {
      throw privacyError('could not enumerate or contain scheduled notifications', [
        enumerationError,
        cancelError,
      ]);
    }
    throw privacyError(
      'scheduled notifications were cancelled because they could not be enumerated safely',
      [enumerationError],
    );
  }

  const failures: unknown[] = [];
  const plans = new Map<string, ReminderTriggerPlan>();
  for (const item of pending) {
    if (!deliveryIsCurrent(context)) return;
    const trigger = isTimestampTrigger(item.trigger) ? item.trigger : null;
    if (!trigger) continue;
    try {
      const reminder = await sanitizedReminderNotification(
        item.notification,
        undefined,
        trigger.timestamp,
      );
      if (!deliveryIsCurrent(context)) return;
      if (reminder) plans.set(reminder.newId, { reminder, trigger });
      else if (isReminderPayload(item.notification)) {
        failures.push(new Error('a scheduled reminder could not be reconciled to its durable row'));
      }
    } catch (error) {
      failures.push(error);
    }
  }

  if (!deliveryIsCurrent(context)) return;
  try {
    // Android's trigger list cannot reveal an alarm lost by an earlier failed rebuild. Merge in
    // every future encrypted-DB reminder so this maintenance pass repairs that missing native half.
    for (const durable of await listFutureReminderTriggerRoutes()) {
      const plan = sanitizedDurableReminderNotification(durable);
      plans.set(plan.reminder.newId, plan);
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    await notifee.cancelTriggerNotifications();
  } catch (error) {
    throw privacyError('could not contain scheduled notifications before rebuilding', [error]);
  }
  failures.push(...(await armSanitizedReminders([...plans.values()], context)));

  if (failures.length > 0) {
    throw privacyError(
      'one or more scheduled notifications could not be preserved safely',
      failures,
    );
  }
}

function requiresNotificationStateRebuild(source: Notification): boolean {
  // FaceTime was retired after schema 2 shipped, so both its opaque schema-2 notices and older raw
  // UUID payloads must force the one-time whitelist rebuild. Other schema-2 notifications contain
  // only local keys/tokens and must not be rebuilt merely because startup maintenance runs.
  const kind = markerKind(source);
  if (kind === 'facetime') return true;
  if (kind != null) return false;
  return ['chatGuid', 'messageGuid', 'faceTimeUuid'].some(
    (key) => dataString(source.data, key) != null,
  );
}

/** One-time upgrade containment for native payloads written before opaque schema-2 routes. */
async function sanitizeLegacyNotificationPayloadsIfPresent(
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  const [displayedResult, triggersResult] = await Promise.allSettled([
    notifee.getDisplayedNotifications(),
    notifee.getTriggerNotifications(),
  ]);
  if (!deliveryIsCurrent(context)) return;
  if (displayedResult.status === 'rejected' || triggersResult.status === 'rejected') {
    const inspectionFailures = [displayedResult, triggersResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    const containmentFailures: unknown[] = [];
    // Stop pending alarms first, then sweep the tray last so an alarm that fires during
    // containment cannot leave a legacy payload displayed.
    try {
      await notifee.cancelTriggerNotifications();
    } catch (error) {
      containmentFailures.push(error);
    }
    try {
      await notifee.cancelDisplayedNotifications();
    } catch (error) {
      containmentFailures.push(error);
    }
    if (containmentFailures.length > 0) {
      throw privacyError('could not inspect or fully contain legacy notification state', [
        ...inspectionFailures,
        ...containmentFailures,
      ]);
    }
    throw privacyError(
      'notification state was cancelled because legacy payloads could not be inspected safely',
      inspectionFailures,
    );
  }
  const displayed = displayedResult.value;
  const triggers = triggersResult.value;

  const hasLegacy =
    displayed.some((item) => requiresNotificationStateRebuild(item.notification)) ||
    triggers.some((item) => requiresNotificationStateRebuild(item.notification));
  if (!hasLegacy) {
    // Current schema-2 alarms can still have been created by an older build with private title/body.
    // Rebuild every future alarm from encrypted durable rows on every connected startup.
    await sanitizeTriggerNotifications(context);
    if (deliveryIsCurrent(context)) {
      // Summary-only reconciliation never rewrites a captured child, so it cannot resurrect a
      // message the user swiped while reminder maintenance crossed the native bridge.
      await reconcileMessageGroupFromDisplayedNow(displayed, context);
    }
    return;
  }

  // Reuse the sanitized whitelist rebuild. This may make notifications already in the tray generic
  // for this one upgrade pass; future posts use fresh full content. Eliminating raw account
  // identifiers from OS state is the safer migration trade-off.
  const failures: unknown[] = [];
  try {
    await sanitizeTriggerNotifications(context);
  } catch (error) {
    failures.push(error);
  }
  if (!deliveryIsCurrent(context)) return;
  try {
    await sanitizeDisplayedNotifications(context);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw privacyError(
      'legacy notification migration completed with containment failures',
      failures,
    );
  }
}

async function sanitizePerChatChannels(
  genericizeSafeChannelNames: boolean,
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  const failures: unknown[] = [];
  const prefix = `${CHANNEL_NEW_MESSAGE}.chat.`;
  const safePrefix = `${prefix}route_`;
  let channels: Awaited<ReturnType<typeof notifee.getChannels>>;
  try {
    channels = await notifee.getChannels();
  } catch (error) {
    throw privacyError('could not enumerate conversation channels', [error]);
  }
  if (!deliveryIsCurrent(context)) return;
  for (const channel of channels) {
    if (!deliveryIsCurrent(context)) return;
    if (!channel.id.startsWith(prefix)) continue;
    const localRouteSuffix = channel.id.startsWith(safePrefix)
      ? channel.id.slice(safePrefix.length)
      : '';
    const isSafeLocalRoute = /^[1-9]\d*$/.test(localRouteSuffix);
    try {
      if (isSafeLocalRoute) {
        if (!genericizeSafeChannelNames) continue;
        await notifee.createChannel({
          id: channel.id,
          name: 'Conversation',
          importance: channel.importance,
        });
      } else {
        // Legacy ids were derived from a raw chat GUID and cannot be made private in place.
        await notifee.deleteChannel(channel.id);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw privacyError('could not sanitize conversation channels', failures);
}

/** Native-only check: cold App Lock must not open SQLCipher to inspect a pending alarm. */
function isGenericReminderAlarm(source: Notification): boolean {
  const data = source.data;
  const android = source.android;
  return (
    isSafeReminderNotificationId(source.id) &&
    source.title === 'Reminder' &&
    source.body === 'Reminder' &&
    source.subtitle == null &&
    markerKind(source) === 'reminder' &&
    data != null &&
    Object.keys(data).every((key) =>
      ['gatorOwner', 'gatorSchema', 'gatorKind', 'chatId', 'messageId', 'messageDate'].includes(
        key,
      ),
    ) &&
    positiveLocalId(data.chatId) != null &&
    (data.messageId == null || positiveLocalId(data.messageId) != null) &&
    (data.messageDate == null || /^\d{1,16}$/.test(String(data.messageDate))) &&
    android?.channelId === CHANNEL_REMINDERS &&
    android.smallIcon === 'ic_stat_gator' &&
    android.style == null &&
    android.largeIcon == null &&
    android.ticker == null &&
    android.inputHistory == null &&
    (android.actions == null || android.actions.length === 0) &&
    android.fullScreenAction == null &&
    android.groupId == null &&
    android.sortKey == null &&
    android.tag == null &&
    (android.sound == null || android.sound === 'default') &&
    android.pressAction?.id === PRESS_REMINDER &&
    android.pressAction.launchActivity === 'default' &&
    Object.keys(android.pressAction).every((key) => key === 'id' || key === 'launchActivity')
  );
}

async function scrubAppLockNotificationStateNow(): Promise<void> {
  const failures: unknown[] = [];
  try {
    const triggers = await notifee.getTriggerNotifications();
    for (const { notification } of triggers) {
      if (isGenericReminderAlarm(notification)) continue;
      if (!notification.id) throw new Error('a scheduled notification has no cancellable id');
      await notifee.cancelTriggerNotification(notification.id);
    }
  } catch {
    // Unknown/partially cancelled alarms may still fire private text. Contain them even though
    // this can lose native alarms; encrypted reminders remain available after unlock.
    try {
      await notifee.cancelTriggerNotifications();
    } catch {
      failures.push(new Error('scheduled notification privacy cleanup failed'));
    }
    failures.push(new Error('scheduled notification privacy could not be verified'));
  }
  try {
    await sanitizePerChatChannels(true);
  } catch {
    failures.push(new Error('conversation channel privacy cleanup failed'));
  }
  // Always sweep displayed state LAST: an old alarm could have fired while triggers were inspected.
  // Displayed-only cancellation deliberately preserves verified generic future alarms.
  try {
    await notifee.cancelDisplayedNotifications();
  } catch {
    failures.push(new Error('displayed notification privacy cleanup failed'));
  }
  if (failures.length > 0) throw privacyError('App Lock notification cleanup failed', failures);
}

/** Install the synchronous barrier, then wait for all older queued native writes and their sweep. */
export function beginAppLockNotificationPrivacy(): Promise<void> {
  appLockPrivacyBarrier = true;
  notificationPrivacyEpoch += 1;
  return enqueueNotificationOperation(scrubAppLockNotificationStateNow);
}

/**
 * Keep native privacy maintenance in one FIFO slot. Future reminder triggers are sanitized first;
 * displayed reminders are deliberately last so an alarm that fires during the pass is still swept.
 */
async function prepareNotificationPresentationStateNow(
  context?: EventDeliveryContext,
): Promise<void> {
  if (privateNotificationMustBeHidden()) {
    if (deliveryIsCurrent(context)) await scrubAppLockNotificationStateNow();
    // This connected-startup entry already has DB admission after authentication. Continue its
    // generic reminder recovery; cold hydration calls the native-only sweep directly instead.
  }
  const failures: unknown[] = [];
  let nativeStateSanitized = false;
  try {
    await sanitizeLegacyNotificationPayloadsIfPresent(context);
    nativeStateSanitized = true;
  } catch (error) {
    failures.push(error);
  }
  if (!deliveryIsCurrent(context)) return;
  if (nativeStateSanitized) {
    try {
      // Positive route creation is gone. Purge every encrypted route left by an older install only
      // after Android state is clean; a failed native sweep retains routes so stale actions can
      // still resolve their notification id for a later dismissal/retry.
      await clearNotificationRoutes(context ? () => context.isCurrent() : undefined);
    } catch (error) {
      failures.push(error);
    }
  }
  if (!deliveryIsCurrent(context)) return;
  try {
    // Deleting a missing channel is an Android no-op. Running this on every admitted startup also
    // repairs an earlier partial upgrade without ever recreating the retired channel.
    await notifee.deleteChannel(LEGACY_FACETIME_CHANNEL_ID);
  } catch (error) {
    failures.push(error);
  }
  if (!deliveryIsCurrent(context)) return;
  try {
    // This local DB pass does not depend on a successful network sync. It removes stale plaintext
    // after an offline launch and runs directly in the startup operation's existing FIFO slot.
    await reconcileDisplayedMessageHistoriesNow(undefined, context);
  } catch (error) {
    failures.push(error);
  }
  if (!deliveryIsCurrent(context)) return;
  try {
    await sanitizePerChatChannels(false, context);
  } catch (error) {
    failures.push(error);
  }
  if (!deliveryIsCurrent(context)) return;
  try {
    await sanitizeCurrentDisplayedReminders(context);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) {
    throw privacyError('notification presentation maintenance completed with failures', failures);
  }
}

/**
 * Run one ordinary connected-account startup maintenance pass after foreground boot has admitted
 * its encrypted DB. Capture ownership before joining the native queue: a pass that waits behind
 * Disconnect is dropped, while an admitted pass is visible to Disconnect's drain and cannot commit
 * a reminder-id handoff after its original account is revoked.
 */
export function prepareNotificationPresentationState(): Promise<void> {
  const accountLease = captureRealtimeDeliveryLease();
  return enqueueNotificationOperation(async () => {
    try {
      await runTrackedRealtimeWork(accountLease, (activeLease) =>
        prepareNotificationPresentationStateNow(activeLease),
      );
    } catch (error) {
      if (!accountLease.isCurrent()) return;
      throw error;
    }
  });
}

// Fallback avatar for a sender with no contact photo: the Gator mark, so the notification shows
// our icon instead of Android's generic gray silhouette. Resolve it only when the first message
// notification needs it; importing notification operations must not touch React Native's asset
// registry. Guarded because resolveAssetSource can return undefined and notify-kit throws on
// `icon: undefined`.
let gatorAvatarResolved = false;
let gatorAvatarUri: string | undefined;

function getGatorAvatarUri(): string | undefined {
  if (gatorAvatarResolved) return gatorAvatarUri;
  gatorAvatarResolved = true;
  try {
    // Literal requires keep both dependencies in Metro while avoiding a static React Native import
    // in React-free Node graphs. Any failure simply omits the optional fallback avatar.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- static RN import breaks the React-free node/headless import path
    const { Image } = require('react-native') as typeof import('react-native');
    gatorAvatarUri = Image.resolveAssetSource(
      require('../../../assets/notification-avatar.png') as number,
    )?.uri;
  } catch {
    gatorAvatarUri = undefined;
  }
  return gatorAvatarUri;
}

let channelReady: Promise<string> | null = null;
function ensureChannel(): Promise<string> {
  // Don't memoize a REJECTED promise — clear the cache on failure so a later call retries.
  // Without this reset, one transient createChannel failure poisoned the cache for the whole JS
  // context: every subsequent postNotification awaited the same rejected promise and threw, so
  // message notifications stopped permanently until the app was restarted. (The FaceTime and
  // Reminder channels below always had this guard; the main one silently did not.)
  channelReady ??= notifee
    .createChannel({
      id: CHANNEL_NEW_MESSAGE,
      name: 'New Messages',
      importance: AndroidImportance.HIGH,
    })
    .catch((e) => {
      channelReady = null;
      throw e;
    });
  return channelReady;
}

function deliveryIsCurrent(context?: EventDeliveryContext): boolean {
  return context?.isCurrent() ?? true;
}

function privateNotificationMustBeHidden(): boolean {
  const lock = useLockStore.getState();
  // Authentication/grace permits private in-app UI, never private OS notification presentation.
  return appLockPrivacyBarrier || lock.enabled || lock.locked;
}

/** A rejected bridge call may still have committed. Contain retired results on both exit paths. */
async function displayWithPresentationGuard(
  notification: Notification & { id: string },
  context: EventDeliveryContext | undefined,
  containsPrivateContent: boolean,
): Promise<boolean> {
  const canPresent = (): boolean =>
    deliveryIsCurrent(context) && (!containsPrivateContent || !privateNotificationMustBeHidden());
  if (!canPresent()) return false;
  try {
    await notifee.displayNotification(notification);
  } finally {
    if (!canPresent()) await notifee.cancelNotification(notification.id);
  }
  return canPresent();
}

async function containPrivateNotificationIfLocked(
  context?: EventDeliveryContext,
  quietUpdate = false,
): Promise<boolean> {
  if (!privateNotificationMustBeHidden()) return false;
  await postStatusNotification(
    STATUS_LOCKED_ID,
    'locked',
    'Gator',
    'You have new messages',
    context,
    false,
    quietUpdate,
  );
  return true;
}

/**
 * Post a fixed-id, content-less STATUS notification (server notices + the app-locked placeholder).
 * A stable id means repeated posts update in place instead of stacking. These carry no private
 * message routing data. RCS/self-test text is app-authored rather than trusted from the server;
 * alias text is user-visible content supplied by its ordinary detailed caller.
 *
 * The locked notice alerts on every post that stands for a genuinely new message, like an ordinary
 * message notification, even while an earlier one is still in the tray; `quietUpdate` keeps a
 * send failure or a hidden status from re-alerting.
 */
async function postStatusNotification(
  id: string,
  kind: 'locked' | 'rcs' | 'test' | 'alias',
  title: string,
  body: string,
  context?: EventDeliveryContext,
  hidePrivateWhenLocked = false,
  quietUpdate = false,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  await ensureChannel();
  if (!deliveryIsCurrent(context)) return;
  const hidePrivate = hidePrivateWhenLocked && privateNotificationMustBeHidden();
  const postedId = hidePrivate ? STATUS_LOCKED_ID : id;
  await displayWithPresentationGuard(
    {
      id: postedId,
      title: hidePrivate ? 'Gator' : title,
      body: hidePrivate ? 'You have new messages' : body,
      data: nativeStatusData(hidePrivate ? 'locked' : kind),
      android: {
        channelId: CHANNEL_NEW_MESSAGE,
        smallIcon: 'ic_stat_gator',
        ...(hidePrivate || (kind === 'locked' && quietUpdate) ? { onlyAlertOnce: true } : {}),
        pressAction: { id: PRESS_OPEN, launchActivity: 'default' },
      },
    },
    context,
    hidePrivateWhenLocked && !hidePrivate,
  );
}

/** Stable channel id derived only from a local integer key (never a phone/email-bearing GUID). */
export function chatChannelId(chatId: number): string {
  return chatChannelIdForLocalId(chatId);
}

/**
 * Create a per-conversation notification channel (if absent) and open its Android system settings,
 * so the user can set a custom sound / importance / vibration for THIS chat. Once created, that
 * chat's message notifications route to it (see `postNotification`). Parity with the old app's
 * per-chat "Notification Settings" tile. Android-only; a no-op elsewhere.
 */
export function openChatNotificationSettings(
  chatGuid: string,
  title: string,
  context?: EventDeliveryContext,
): Promise<void> {
  context = capturePresentationContext(context);
  return enqueueNotificationOperation(async () => {
    if (!deliveryIsCurrent(context)) return;
    const route = await localRouteForGuids(chatGuid);
    if (!deliveryIsCurrent(context)) return;
    if (!route) throw new Error('cannot open notification settings for an unknown conversation');
    const id = chatChannelId(route.chatId);
    const channelName = privateNotificationMustBeHidden()
      ? 'Conversation'
      : (normalizeMessageNotificationTitle(title) ?? 'Conversation');
    await notifee.createChannel({
      id,
      name: channelName,
      importance: AndroidImportance.HIGH,
    });
    if (!deliveryIsCurrent(context)) return;
    await notifee.openNotificationSettings(id);
  });
}

export type NotificationPermissionState = 'not-determined' | 'denied' | 'granted';

const NOTIFICATION_PERMISSION_READ_TIMEOUT_MS = 2_000;

class NotificationPermissionReadTimeoutError extends Error {
  override readonly name = 'NotificationPermissionReadTimeoutError';

  constructor() {
    super('notification permission read timed out');
  }
}

function notificationPermissionState(status: AuthorizationStatus): NotificationPermissionState {
  if (status >= AuthorizationStatus.AUTHORIZED) return 'granted';
  return status === AuthorizationStatus.NOT_DETERMINED ? 'not-determined' : 'denied';
}

/** Read notification access without showing Android's permission prompt. */
export async function getNotificationPermissionState(): Promise<NotificationPermissionState> {
  const settings = await notifee.getNotificationSettings();
  return notificationPermissionState(settings.authorizationStatus);
}

async function readNotificationPermissionWithinTimeout(): Promise<NotificationPermissionState> {
  const nativeRead = getNotificationPermissionState();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new NotificationPermissionReadTimeoutError()),
      NOTIFICATION_PERMISSION_READ_TIMEOUT_MS,
    );
  });
  try {
    return await Promise.race([nativeRead, timeout]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/** Request POST_NOTIFICATIONS (Android 13+) after the app has explained why. */
export async function requestNotificationPermission(): Promise<boolean> {
  const settings = await notifee.requestPermission();
  return notificationPermissionState(settings.authorizationStatus) === 'granted';
}

/** Open this app's Android notification controls for denied/permanently denied recovery. */
export function openNotificationPermissionSettings(): Promise<void> {
  return notifee.openNotificationSettings();
}

function isPresentationIntent(intent: NotificationIntent): boolean {
  return (
    intent.kind === 'message' ||
    intent.kind === 'send-failure' ||
    intent.kind === 'alias-removed' ||
    intent.kind === 'rcs-bridge-down' ||
    intent.kind === 'test-notification'
  );
}

function isPostNotificationsPermissionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const nativeError = error as { code?: unknown; message?: unknown; name?: unknown };
  return (
    nativeError.message ===
      'java.lang.SecurityException: POST_NOTIFICATIONS permission is not granted. Notification was not displayed.' &&
    (nativeError.code === 'EUNSPECIFIED' || nativeError.name === 'java.lang.Exception')
  );
}

/**
 * Show (or, for a cancel intent, clear) a chat notification. One notification
 * per chat (id = a local chat key) so a newer message updates it in place. Uses the
 * Android MESSAGING style so it threads with sender + avatar; carries inline
 * Reply + Mark-as-read actions handled by `handleNotificationAction`.
 */
export function postNotification(
  intent: NotificationIntent,
  context?: EventDeliveryContext,
): Promise<void> {
  if (isPresentationIntent(intent)) context = capturePresentationContext(context);
  return enqueueNotificationOperation(async () => {
    // A realtime event can sit behind account cleanup in this queue. Check its account lease at
    // the actual native-mutation boundary, not only before it joined the queue, so Disconnect
    // cannot let an old account post after queued teardown.
    if (context && !context.isCurrent()) return;
    // Explicit OS denial is a presentation opt-out, not a failed durable message delivery. Keep
    // cancellation/withdrawal intents ungated: those are privacy cleanup and must still run.
    if (isPresentationIntent(intent)) {
      const permission = await readNotificationPermissionWithinTimeout();
      if (context && !context.isCurrent()) return;
      if (permission !== 'granted') return;
    }
    try {
      await postNotificationNow(intent, context);
    } catch (error) {
      // Permission can be revoked after the preflight read. Contain only notify-kit's exact
      // POST_NOTIFICATIONS rejection. That native error is emitted only after the permission check
      // fails at the actual display boundary, so it is authoritative even if access changes again.
      if (!isPresentationIntent(intent) || !isPostNotificationsPermissionError(error)) throw error;
    }
  });
}

/** Private, already-running-in-the-queue adapter. Do not call exported queued helpers from here. */
async function postNotificationNow(
  intent: NotificationIntent,
  context?: EventDeliveryContext,
  routeDb?: AppDatabase,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  // Defense in depth for the common socket/FCM pipeline. The AppState coordinator normally keeps
  // the socket disconnected while locked, but an event already queued at the boundary must still
  // never render sender/title/body over the lock screen. The timestamp check closes the tiny window
  // before the UI listener has flipped `locked` on a warm resume.
  if (
    (intent.kind === 'message' ||
      intent.kind === 'send-failure' ||
      intent.kind === 'alias-removed') &&
    privateNotificationMustBeHidden()
  ) {
    await postStatusNotification(
      STATUS_LOCKED_ID,
      'locked',
      'Gator',
      'You have new messages',
      context,
      false,
      intent.kind !== 'message',
    );
    return;
  }
  if (intent.kind === 'cancel') {
    await cancelForChatNow(intent.chatGuid, context);
    return;
  }
  if (intent.kind === 'message-withdraw') {
    await withdrawMessageNotificationNow(intent.chatGuid, intent.messageGuid, context, routeDb);
    return;
  }
  if (intent.kind === 'facetime-cancel') {
    await cancelFaceTimeNotificationNow(intent.uuid, context);
    return;
  }
  if (intent.kind === 'send-failure-cancel') {
    await cancelSendFailureNotificationNow(intent.messageGuid, context, routeDb);
    return;
  }
  if (intent.kind === 'send-failure') {
    await postSendFailureNotificationNow(intent, context, routeDb);
    return;
  }
  if (intent.kind === 'rcs-bridge-down') {
    // The server is not a trusted presentation source. Keep diagnostics generic in OS state.
    await postStatusNotification(
      STATUS_RCS_ID,
      'rcs',
      'Gator',
      'RCS service needs attention.',
      context,
    );
    return;
  }
  if (intent.kind === 'test-notification') {
    // The server's push self-test. Seeing this IS the passing result; suppressing it would make a
    // healthy pipeline look broken, which is the exact failure this probe exists to rule out.
    await postStatusNotification(
      STATUS_TEST_ID,
      'test',
      'Gator',
      'Test notification received.',
      context,
    );
    return;
  }
  if (intent.kind === 'alias-removed') {
    const body =
      intent.aliases.length === 1
        ? `${intent.aliases[0]} has been deregistered.`
        : `Aliases deregistered: ${intent.aliases.join(', ')}`;
    await postStatusNotification(STATUS_ALIAS_ID, 'alias', 'iMessage', body, context, true);
    return;
  }
  // Suppress at the native boundary, not while deriving the intent: another-chat/background and
  // headless delivery still post, while a route that became visible during queued DB work stays
  // quiet. Re-check after every native/DB await below because focus can change between them.
  if (isActiveChat(intent.chatGuid)) return;
  if (!deliveryIsCurrent(context)) return;
  await ensureChannel();
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  const route = await localRouteForGuids(intent.chatGuid, intent.messageGuid);
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  if (!route) throw new Error('cannot post a notification for an unknown conversation');
  if (route.messageId == null) {
    throw new Error('cannot post a message notification without an opaque local message id');
  }
  let displayed: DisplayedNotification[];
  try {
    displayed = await notifee.getDisplayedNotifications();
  } catch (error) {
    // Preserve NOTIF-03's existing multi-line child rather than overwriting unknown history with one
    // line. The summary must remain too: Android cascades summary cancellation to every child, and
    // enumeration failure gives us no proof that the group is empty. Let the durable owner retry.
    throw error;
  }
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  const existingHistory = findDisplayedMessageHistory(displayed, route.chatId)?.entries ?? [];
  const replacesExistingLine = existingHistory.some((entry) => entry.messageId === route.messageId);
  const body = normalizeMessageNotificationText(intent.body) ?? 'Message';
  const normalizedSenderName = normalizeMessageNotificationLabel(intent.senderName);
  const senderName = normalizedSenderName ?? 'Contact';
  const title =
    normalizeMessageNotificationTitle(intent.chatTitle) ?? normalizedSenderName ?? 'Conversation';
  const avatarUri = normalizeMessageNotificationAvatarUri(intent.avatarUri ?? getGatorAvatarUri());
  const history = mergeMessageNotificationHistory(existingHistory, {
    messageId: route.messageId,
    text: body,
    timestamp: intent.timestamp,
    senderName,
    ...(avatarUri ? { avatarUri } : {}),
  });
  // A delayed duplicate may already have fallen outside the six-line window. In that case the
  // merge is a no-op, so do not repost unchanged history or alert the user again.
  if (!history.some((entry) => entry.messageId === route.messageId)) {
    await reconcileMessageGroupNow(context);
    return;
  }
  const latest = history.at(-1);
  if (!latest) throw new Error('cannot post an empty message notification history');
  // Route to this chat's OWN channel if the user has customized it (created via
  // openChatNotificationSettings); else the shared "New Messages" channel. getChannel returns null
  // for an uncreated channel, so this is a cheap per-post check with no persisted bookkeeping.
  const perChatId = chatChannelId(route.chatId);
  const customChannel = await notifee.getChannel(perChatId).catch(() => null);
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  if (customChannel) {
    // Updating a channel's name preserves the user's sound/importance settings while keeping the
    // current conversation title accurate.
    await notifee.createChannel({
      id: perChatId,
      name: title,
      importance: customChannel.importance,
    });
    if (!deliveryIsCurrent(context)) return;
    if (await containPrivateNotificationIfLocked(context)) return;
    if (isActiveChat(intent.chatGuid)) return;
  }
  const channelId = customChannel ? perChatId : CHANNEL_NEW_MESSAGE;
  if (!deliveryIsCurrent(context)) return;
  if (isActiveChat(intent.chatGuid)) return;
  const notification = messageNotificationFromHistory(
    {
      chatId: route.chatId,
      title,
      channelId,
      isGroup: intent.isGroup,
      entries: history,
    },
    {
      onlyAlertOnce: replacesExistingLine,
      chatGuid: intent.chatGuid,
      // A delayed event can merge behind a newer line. Only expose a reaction action when the
      // route we just resolved is still the notification's latest visible message.
      messageGuid: latest.messageId === route.messageId ? intent.messageGuid : undefined,
    },
  );
  if (
    !(await displayWithPresentationGuard(
      { ...notification, id: chatNotificationId(route.chatId) },
      context,
      true,
    ))
  )
    return;
  // Read the tray again after the post instead of trusting the earlier history snapshot. Another
  // child may have been swiped during this operation; a cached snapshot must not create a stale
  // summary (and, critically, is never used to repost that child).
  await reconcileMessageGroupNow(context);
}

/** Reconcile every bounded history line from DB truth; never replay the update envelope itself. */
async function withdrawMessageNotificationNow(
  chatGuid: string,
  _messageGuid: string,
  context?: EventDeliveryContext,
  db?: AppDatabase,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  const failures: unknown[] = [];
  try {
    await reconcileDisplayedMessageHistoriesNow(db, context);
  } catch (error) {
    failures.push(error);
  }
  // Compatibility cleanup only: old builds used the raw chat GUID as the native id. Do this even
  // when DB/native history reconciliation failed so a private legacy notice is not stranded.
  try {
    await notifee.cancelNotification(chatGuid);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0)
    throw privacyError('message notification reconciliation failed', failures);
}

async function postSendFailureNotificationNow(
  intent: Extract<NotificationIntent, { kind: 'send-failure' }>,
  context?: EventDeliveryContext,
  db?: AppDatabase,
): Promise<void> {
  if (!deliveryIsCurrent(context) || isActiveChat(intent.chatGuid)) return;
  await ensureChannel();
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context, true)) return;
  if (isActiveChat(intent.chatGuid)) return;
  const target = await localFailedMessageRoute(intent.messageGuid, db);
  if (!deliveryIsCurrent(context)) return;
  if (await containPrivateNotificationIfLocked(context, true)) return;
  if (!target || target.chatGuid !== intent.chatGuid || isActiveChat(intent.chatGuid)) return;
  await displayWithPresentationGuard(
    {
      ...fixedSendFailureNotification(target.route),
      id: sendFailureNotificationId(target.route.messageId),
    },
    context,
    true,
  );
}

async function cancelSendFailureNotificationNow(
  messageGuid: string,
  context?: EventDeliveryContext,
  db?: AppDatabase,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  // An RCS bridge can acknowledge with the temp guid just after a server error. The repository
  // deliberately keeps that error sticky, so the acknowledgement is not sufficient evidence to
  // withdraw the notice: current encrypted-DB truth must no longer be failed.
  if (await localFailedMessageRoute(messageGuid, db)) return;
  if (!deliveryIsCurrent(context)) return;
  const route = await localRouteForMessageGuid(messageGuid, db);
  if (!deliveryIsCurrent(context) || !route) return;
  await notifee.cancelNotification(sendFailureNotificationId(route.messageId));
}

/** Post fixed app-authored failure copy only after the supplied DB contains a current error row. */
export function postSendFailureNotification(
  db: AppDatabase,
  chatGuid: string,
  messageGuid: string,
  context?: EventDeliveryContext,
): Promise<void> {
  context = capturePresentationContext(context);
  return enqueueNotificationOperation(() =>
    postNotificationNow({ kind: 'send-failure', chatGuid, messageGuid }, context, db),
  );
}

/** Best-effort exact withdrawal after a retry/ack settles the same local message row. */
export function cancelSendFailureNotification(
  db: AppDatabase,
  messageGuid: string,
  context?: EventDeliveryContext,
): Promise<void> {
  return enqueueNotificationOperation(() =>
    cancelSendFailureNotificationNow(messageGuid, context, db),
  );
}

export function cancelForChat(chatGuid: string, context?: EventDeliveryContext): Promise<void> {
  return enqueueNotificationOperation(() => cancelForChatNow(chatGuid, context));
}

export function cancelFaceTimeNotification(
  uuid: string,
  context?: EventDeliveryContext,
): Promise<void> {
  return enqueueNotificationOperation(() => cancelFaceTimeNotificationNow(uuid, context));
}

/** Cancel the exact native id delivered with an action/press, without another DB route lookup. */
export function cancelNotificationById(id: string, context?: EventDeliveryContext): Promise<void> {
  return enqueueNotificationOperation(async () => {
    if (!deliveryIsCurrent(context)) return;
    await notifee.cancelNotification(id);
    if (localChatIdFromMessageNotificationId(id) != null) {
      await reconcileMessageGroupNow(context, id);
    }
  });
}

async function cancelForChatNow(chatGuid: string, context?: EventDeliveryContext): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  let removedId: string | undefined;
  try {
    const route = await localRouteForGuids(chatGuid);
    if (!deliveryIsCurrent(context)) return;
    if (route) {
      removedId = chatNotificationId(route.chatId);
      await notifee.cancelNotification(removedId);
      if (!deliveryIsCurrent(context)) return;
    }
  } catch (error) {
    if (!deliveryIsCurrent(context)) return;
    // A legacy payload still has a directly cancellable raw id. A failed DB open must not stop us
    // reaching that compatibility cleanup (especially in a failing headless action's finally).
    logger.warn('[notif] could not resolve the private chat notification id', error);
  }
  // Backward-compatible cleanup for notifications posted by an older build. New writes never use
  // this raw id; startup legacy maintenance handles persisted tagged entries reliably.
  if (!deliveryIsCurrent(context)) return;
  await notifee.cancelNotification(chatGuid);
  await reconcileMessageGroupNow(context, removedId);
}

function runTrackedMessageGroupReconciliation(): Promise<void> {
  const accountLease = captureRealtimeDeliveryLease();
  return (async () => {
    try {
      // Registration happens synchronously before the queue wait, so Disconnect sees and drains it.
      await runTrackedRealtimeWork(accountLease, () =>
        enqueueNotificationOperation(() => reconcileMessageGroupNow(accountLease)),
      );
    } catch (error) {
      if (accountLease.isCurrent()) throw error;
    }
  })();
}

/**
 * Repair the current message group after a privacy gate opens. While App Lock is effective, native
 * removal events deliberately leave the tray untouched; successful warm unlock calls this narrow
 * pass so a summary cannot remain stale until another message or restart.
 */
export function reconcileMessageNotificationGroup(): Promise<void> {
  return runTrackedMessageGroupReconciliation();
}

/**
 * Reconcile Android message history against the supplied account database after a sync/repair.
 * Registration precedes the FIFO wait so Disconnect drains an admitted reconciliation.
 */
export function reconcileMessageNotificationsWithDatabase(
  db: AppDatabase,
  context?: EventDeliveryContext,
): Promise<void> {
  const accountLease = context ?? captureRealtimeDeliveryLease();
  return (async () => {
    try {
      await runTrackedRealtimeWork(accountLease, () =>
        enqueueNotificationOperation(() => reconcileDisplayedMessageHistoriesNow(db, accountLease)),
      );
    } catch (error) {
      if (accountLease.isCurrent()) throw error;
    }
  })();
}

/**
 * Repair the summary after Android itself removes a child through a body tap, swipe, or Clear All.
 * Re-enumerate instead of blindly excluding the stable id from the event: a delayed callback may
 * describe an older notice after a newer message already reused that chat id. A summary dismissal is
 * intentionally ignored so we do not fight the user.
 */
export function reconcileMessageNotificationGroupAfterRemoval(
  source: Notification | undefined,
): Promise<void> {
  const id = notificationId(source ?? {});
  const chatId = localChatIdFromMessageNotificationId(id);
  if (
    !source ||
    chatId == null ||
    markerKind(source) !== 'message' ||
    positiveLocalId(source.data?.chatId) !== chatId
  ) {
    return Promise.resolve();
  }

  return runTrackedMessageGroupReconciliation();
}

async function cancelFaceTimeNotificationNow(
  uuid: string,
  context?: EventDeliveryContext,
): Promise<void> {
  if (!deliveryIsCurrent(context)) return;
  try {
    const token = await findFaceTimeRoute(uuid);
    if (!deliveryIsCurrent(context)) return;
    if (token) {
      await notifee.cancelNotification(faceTimeNotificationId(token));
      if (!deliveryIsCurrent(context)) return;
      await deleteFaceTimeRoute(token, context ? () => context.isCurrent() : undefined);
    }
  } catch (error) {
    if (!deliveryIsCurrent(context)) return;
    logger.warn('[notif] could not resolve the private FaceTime notification id', error);
  }
  if (deliveryIsCurrent(context)) await notifee.cancelNotification(`ft-${uuid}`);
}

/** Used by account teardown so it cannot race queued native work and restore stale notices. */
export function cancelAllNotifications(): Promise<void> {
  return enqueueNotificationOperation(async () => {
    const failures: unknown[] = [];
    try {
      await notifee.cancelAllNotifications();
    } catch (error) {
      failures.push(error);
    }
    try {
      // Per-chat channel names are persistent Android state. This runs after every earlier queued
      // post/channel creation, so even one that crossed the account-revocation boundary cannot
      // leave the old conversation title behind. The sanitizer preserves shared channels and the
      // user's settings on safe local-id channels; only legacy raw-identifier channels are removed.
      await sanitizePerChatChannels(true);
    } catch (error) {
      failures.push(error);
    }
    try {
      await clearNotificationRoutes();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0)
      throw privacyError('could not fully clear notification state', failures);
  });
}

/**
 * A single content-less "you have messages" notification used while the app is locked. This
 * presenter never reads message content. The V3 caller authenticates and durably admits its
 * encrypted-at-rest envelope before invoking it; the temporary pre-cutoff V2 caller also
 * authenticates its frame first but never opens the database. A fixed id keeps one notice in the
 * tray; each post alerts, because callers post only for a genuinely new message or a self-test.
 */
export function postLockedNotification(context?: EventDeliveryContext): Promise<void> {
  context ??= captureRealtimeDeliveryLease();
  return enqueueNotificationOperation(() =>
    postStatusNotification(STATUS_LOCKED_ID, 'locked', 'Gator', 'You have new messages', context),
  );
}

/** Withdraw the generic locked notice once the user has unlocked and can see what arrived. */
export function clearLockedNotification(): Promise<void> {
  return enqueueNotificationOperation(() => notifee.cancelNotification(STATUS_LOCKED_ID));
}

let reminderChannelReady: Promise<string> | null = null;
function ensureReminderChannel(): Promise<string> {
  // Don't memoize a rejected promise — clear the cache on failure so a later
  // call can retry instead of being permanently broken.
  reminderChannelReady ??= notifee
    .createChannel({ id: CHANNEL_REMINDERS, name: 'Reminders', importance: AndroidImportance.HIGH })
    .catch((e) => {
      reminderChannelReady = null;
      throw e;
    });
  return reminderChannelReady;
}

/**
 * Schedule a one-shot reminder notification. Uses the inexact SET_AND_ALLOW_WHILE_IDLE alarm type,
 * so it needs no SCHEDULE_EXACT_ALARM permission; best-effort timing is fine for reminders.
 */
interface ReminderNotificationArgs {
  notificationId: string;
  chatGuid: string;
  messageGuid: string;
  scheduledFor: number;
  /** The reminded message's timestamp (ms) — carried so a tap deep-links with ?focusDate and
   *  scrolls to the message. Omitted when the message's date is unknown. */
  messageDate?: number;
}

export function scheduleReminderNotification(args: ReminderNotificationArgs): Promise<void> {
  return enqueueNotificationOperation(() => scheduleReminderNotificationNow(args));
}

/** Private, already-running-in-the-queue adapter. */
async function scheduleReminderNotificationNow(args: ReminderNotificationArgs): Promise<void> {
  if (!isSafeReminderNotificationId(args.notificationId)) {
    throw new Error('refusing to persist a reminder notification with a legacy identifier');
  }
  await ensureReminderChannel();
  const route = await localRouteForGuids(args.chatGuid, args.messageGuid);
  if (!route) throw new Error('cannot schedule a reminder for an unknown conversation');
  // SET_AND_ALLOW_WHILE_IDLE = inexact alarm that still fires in Doze — needs NO
  // SCHEDULE_EXACT_ALARM permission (exact alarms throw a SecurityException on
  // Android 12+ without it). Best-effort timing is fine for reminders.
  const trigger: TimestampTrigger = {
    type: TriggerType.TIMESTAMP,
    timestamp: args.scheduledFor,
    alarmManager: { type: AlarmType.SET_AND_ALLOW_WHILE_IDLE },
  };
  try {
    await notifee.createTriggerNotification(
      {
        id: args.notificationId,
        // Android persists trigger presentation outside SQLCipher. Keep it generic; the tap route
        // resolves the private chat/message only after the app has opened its encrypted database.
        title: 'Reminder',
        body: 'Reminder',
        data: nativeRouteData('reminder', route, args.messageDate),
        android: {
          channelId: CHANNEL_REMINDERS,
          smallIcon: 'ic_stat_gator',
          onlyAlertOnce: true,
          pressAction: { id: PRESS_REMINDER, launchActivity: 'default' },
        },
      },
      trigger,
    );
  } catch (e) {
    logger.warn('[reminder] createTriggerNotification failed', e);
    throw e;
  }
}

export function cancelReminderNotification(notificationId: string): Promise<void> {
  // `cancelNotification` removes either native form that can own this id: a future trigger or a
  // notification that has already fired. Trigger-only cancellation leaves a fired reminder in the
  // tray after the user deletes it from Gator.
  return enqueueNotificationOperation(() => notifee.cancelNotification(notificationId));
}

/** Fire-and-forget cancel — call when a chat is opened/read in the UI. */
export function clearChatNotification(chatGuid: string, context?: EventDeliveryContext): void {
  void cancelForChat(chatGuid, context).catch((error) => {
    if (context && !context.isCurrent()) return;
    logger.warn('[notif] clear chat notification failed', error);
  });
}
