import { Linking } from 'react-native';
import { faceTimeApi } from '@core/api';
import type { HttpClient } from '@core/api/http';
import { isFaceTimeLink } from '@core/facetime';
import { resolveExactMessageTargetPartIndex } from '@core/messages/partIndex';
import { parseMessagePartTopology } from '@core/models';
import { bodyTextFromRuns, parseAttributedRuns } from '@core/richtext';
import { logger, readAccountRevocationState } from '@core/secure';
import { deleteReminderByNotificationId, getMessageActionPartLayoutByGuid } from '@db/repositories';
import { withDbWriteLock } from '@db/transaction';
import { isDevServer } from '@utils/isDev';
import { isRcsChatGuid } from '@utils/chat';
import { accountRevocationMarker, fixedCredentialClient, http, vault } from '../clients';
import { inspectBackgroundSession } from '../background/backgroundSyncOrchestrator';
import { markRead, type ReadReceiptTransport } from '../chatActions';
import { ensureDatabase } from '../databaseControl';
import {
  captureRealtimeDeliveryLease,
  runTrackedRealtimeWork,
  type RealtimeDeliveryLease,
} from '../realtime/deliveryCoordinator';
import { sendTextMessage } from '@/services/send/sendService';
import {
  captureSessionRcsCapabilityLease,
  messageTargetServerAuthorization,
  resolveRcsAttemptOwnership,
  type RcsCapabilitySource,
} from '@/services/send/rcsAttemptCapability';
import { sendReactionMessage } from '@/services/send/sendReactionService';
import { logicalSendQueue } from '@/services/send/logicalSendQueue';
import {
  ACTION_ANSWER_FACETIME,
  ACTION_DECLINE_FACETIME,
  ACTION_LOVE,
  ACTION_MARK_READ,
  ACTION_REPLY,
  PRESS_REMINDER,
  cancelFaceTimeNotification,
  cancelNotificationById,
} from './notifeeService';
import type { EventDetail } from './nativeNotificationAdapter';
import {
  chatNotificationId,
  isSafeReminderNotificationId,
  NOTIFICATION_DATA_OWNER,
  NOTIFICATION_DATA_SCHEMA,
  resolveNotificationData,
  type NotificationRouteKind,
} from './notificationRouting';

/** Private control-flow signal: the callback belongs to an account that is being retired. */
const STALE_NOTIFICATION_ACTION = Symbol('stale-notification-action');

function assertCurrentAccount(lease: RealtimeDeliveryLease): void {
  if (!lease.isCurrent()) throw STALE_NOTIFICATION_ACTION;
}

interface NotificationActionTransport extends ReadReceiptTransport {
  /** DB settlement guard: account/revocation only, never transient transport currentness. */
  accountIsCurrent(): boolean;
  /** Present only for a foreground session whose cached capability has exact provenance. */
  readonly capabilitySource?: RcsCapabilitySource;
}

function assertCurrentTransport(transport: NotificationActionTransport): void {
  if (!transport.isCurrent()) throw STALE_NOTIFICATION_ACTION;
}

/**
 * Resolve one credential identity for a notification's complete network effect.
 *
 * A warm process pins the connected singleton and its monotonic transport revision. A cold
 * headless process instead re-authorizes an immutable vault tuple and never hydrates/publishes the
 * foreground store. The separate account guard deliberately survives only transport rotation so a
 * durable outgoing row can still settle to retryable/error instead of being stranded as sending.
 */
async function resolveNotificationActionTransport(
  accountLease: RealtimeDeliveryLease,
): Promise<NotificationActionTransport> {
  assertCurrentAccount(accountLease);
  const capabilitySource = captureSessionRcsCapabilityLease();
  if (capabilitySource) {
    const actionHttp = http.pinTransport();
    const snapshot = actionHttp.snapshotTransport();
    const accountIsCurrent = (): boolean => accountLease.isCurrent();
    const isCurrent = (): boolean =>
      accountIsCurrent() && capabilitySource.isCurrent() && actionHttp.isTransportCurrent();
    if (
      snapshot.origin !== capabilitySource.origin ||
      snapshot.transportRevision !== capabilitySource.revision ||
      !isCurrent()
    ) {
      throw STALE_NOTIFICATION_ACTION;
    }
    return Object.freeze({
      http: actionHttp,
      accountIsCurrent,
      isCurrent,
      capabilitySource,
    });
  }

  const inspection = await inspectBackgroundSession(vault, accountRevocationMarker);
  assertCurrentAccount(accountLease);
  if (inspection.kind !== 'ready') {
    throw new Error(`Headless notification transport is unavailable (${inspection.kind}).`);
  }
  const accountIsCurrent = (): boolean =>
    accountLease.isCurrent() && readAccountRevocationState(accountRevocationMarker) === 'clear';
  const actionHttp: HttpClient = fixedCredentialClient(
    inspection.session.origin,
    inspection.session.password,
    accountIsCurrent,
  );
  const isCurrent = (): boolean => accountIsCurrent() && actionHttp.isTransportCurrent();
  if (!isCurrent()) throw STALE_NOTIFICATION_ACTION;
  return Object.freeze({ http: actionHttp, accountIsCurrent, isCurrent });
}

/**
 * Positively identify the privacy-safe local-route format written by this build.
 *
 * Schema 2 intentionally stores no account fingerprint in Android state. It becomes account-bound
 * only when its non-reused local integer key (or random call token) resolves in the CURRENT
 * encrypted database. Legacy payloads contain raw server GUIDs and have no such private lookup.
 * They stay readable in `notificationOpen.ts` so an upgrade can still navigate a body tap, but
 * they must not perform actions: an old-account raw guid can be byte-identical on the next server.
 */
function hasPrivateRouteSchema(
  data: Record<string, unknown> | undefined,
  kinds: readonly NotificationRouteKind[],
): boolean {
  return (
    data?.gatorOwner === NOTIFICATION_DATA_OWNER &&
    data.gatorSchema === NOTIFICATION_DATA_SCHEMA &&
    typeof data.gatorKind === 'string' &&
    kinds.includes(data.gatorKind as NotificationRouteKind)
  );
}

type CurrentChatPress = (data: Record<string, unknown>) => void;

/**
 * Handle a notification action press (foreground or headless background).
 * Reply → outgoing-queue send; Mark-as-read → advance the read marker; both
 * clear the chat's notification. Reads the inline reply text from `detail.input`.
 */
export async function handleNotificationAction(detail: EventDetail): Promise<void> {
  // Capture before the first await, then publish the drain slot before route resolution begins.
  // Disconnect synchronously invalidates this lease and waits for the whole admitted callback, so
  // no reply/read/reaction/call action can wake up later and operate through the next account.
  const accountLease = captureRealtimeDeliveryLease();
  try {
    await runTrackedRealtimeWork(accountLease, () =>
      handleNotificationActionForAccount(detail, accountLease),
    );
  } catch (error) {
    if (error !== STALE_NOTIFICATION_ACTION) throw error;
  }
}

async function handleNotificationActionForAccount(
  detail: EventDetail,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  const actionId = detail.pressAction?.id;
  const expectedKind: NotificationRouteKind | null =
    actionId === ACTION_ANSWER_FACETIME || actionId === ACTION_DECLINE_FACETIME
      ? 'facetime'
      : actionId === ACTION_REPLY || actionId === ACTION_MARK_READ || actionId === ACTION_LOVE
        ? 'message'
        : null;
  if (!expectedKind || !hasPrivateRouteSchema(detail.notification?.data, [expectedKind])) return;

  let route: Awaited<ReturnType<typeof resolveNotificationData>>;
  try {
    route = await resolveNotificationData(detail.notification?.data);
  } catch (e) {
    // A safe payload needs the encrypted DB to turn local keys back into server GUIDs. If that DB
    // cannot open, leave the notification in place (especially an authored inline reply) and let
    // the user retry after the app is healthy; never leak an unhandled foreground rejection.
    if (accountLease.isCurrent()) logger.warn('[notif] action route could not be resolved', e);
    return;
  }
  if (!accountLease.isCurrent()) return;

  // FaceTime call actions carry a faceTimeUuid (no chatGuid) — handle first.
  const faceTimeUuid = route?.faceTimeUuid;
  if (faceTimeUuid) {
    await handleFaceTimeAction(actionId, faceTimeUuid, accountLease);
    return;
  }

  const chatGuid = route?.chatGuid;
  if (!chatGuid) return;

  // Only inline action buttons act. A body/main press (open-chat, reminder) is EventType.PRESS,
  // not ACTION_PRESS — handled by handleNotificationPress (side-effects) + openFromNotification
  // (deep-link + scroll-to-message) — and an unknown id must leave the tray untouched.
  const handled =
    actionId === ACTION_REPLY || actionId === ACTION_MARK_READ || actionId === ACTION_LOVE;
  if (!handled) return;

  // The work is wrapped so the tray is cleared even when it throws. Tapping a button and having the
  // notification just sit there is the user-visible symptom of any failure in here (they tap it
  // again, and again), and headlessly there is no other feedback at all — notifee's background
  // handler has no error path, so an escaping rejection is swallowed by the native bridge with
  // nothing logged.
  //
  // REPLY IS THE ONE EXCEPTION, and it is not symmetric with the others: Mark-as-read and Love are
  // idempotent and re-derivable, while a reply carries text the user AUTHORED that exists nowhere
  // else — Android's RemoteInput does not re-populate the field, so once the notification is gone
  // the words are gone. Clearing it only makes sense once delivery is durably owned by the outgoing
  // queue; before that (a failed first DB open on a headless wake, an unknown chat guid) nothing
  // was enqueued and NOTHING will retry, so the notification has to stay as the retype affordance.
  let clearTray = true;
  try {
    switch (actionId) {
      case ACTION_REPLY: {
        const text = detail.input?.trim();
        if (!text) break; // nothing typed → nothing to lose, clear as usual
        clearTray = false; // …until the send is committed to the queue
        await replyTo(
          chatGuid,
          text,
          () => {
            if (accountLease.isCurrent()) clearTray = true;
          },
          accountLease,
        );
        break;
      }
      case ACTION_MARK_READ:
        assertCurrentAccount(accountLease);
        await markRead(chatGuid, accountLease, {
          resolveReceiptTransport: () => resolveNotificationActionTransport(accountLease),
        });
        assertCurrentAccount(accountLease);
        break;
      case ACTION_LOVE: {
        // "♥ Love" the message the notification is about. Needs the messageGuid the
        // intent carried; without it there's nothing to react to.
        const messageGuid = route?.messageGuid;
        if (messageGuid) await loveMessage(chatGuid, messageGuid, accountLease);
        break;
      }
    }
  } catch (e) {
    if (e !== STALE_NOTIFICATION_ACTION && accountLease.isCurrent()) {
      logger.warn('[notif] action failed', { action: actionId, error: String(e) });
    }
  } finally {
    // Note the flag is set from INSIDE the send (the queue handover), not after it returns: a
    // throw AFTER the enqueue still clears, because the reply is already on its way and leaving
    // the notification up would invite the user to send it twice.
    const notificationId = detail.notification?.id;
    const localChatId = Number(detail.notification?.data?.chatId);
    const expectedNotificationId =
      Number.isSafeInteger(localChatId) && localChatId > 0 ? chatNotificationId(localChatId) : null;
    if (clearTray && notificationId === expectedNotificationId && accountLease.isCurrent()) {
      // Cancel the exact schema-2 id that fired. Never fall back to a raw chat guid: legacy data
      // cannot be bound to the active account and is deliberately action-inert above.
      await cancelNotificationById(notificationId, accountLease);
    }
  }
}

/**
 * Handle a MAIN notification press — the body tap, not an action button (EventType.PRESS).
 * Runs only the DB side-effects that must happen whether the app is foreground or headless.
 * Today that's: a fired reminder that's been tapped is done, so drop its DB row.
 *
 * NAVIGATION to the chat is done separately (openFromNotification) because it needs a React
 * tree — a killed-app tap navigates on next mount via `getInitialNotification()`. This is
 * idempotent (getInitialNotification and onBackgroundEvent can BOTH deliver the same launching
 * press, and deleteReminderByNotificationId is a no-op on an already-removed row).
 */
export async function handleNotificationPress(
  detail: EventDetail,
  onCurrentChatPress?: CurrentChatPress,
): Promise<void> {
  const accountLease = captureRealtimeDeliveryLease();
  try {
    await runTrackedRealtimeWork(accountLease, () =>
      handleNotificationPressForAccount(detail, accountLease, onCurrentChatPress),
    );
  } catch (error) {
    if (error !== STALE_NOTIFICATION_ACTION && accountLease.isCurrent()) throw error;
  }
}

async function handleNotificationPressForAccount(
  detail: EventDetail,
  accountLease: RealtimeDeliveryLease,
  onCurrentChatPress?: CurrentChatPress,
): Promise<void> {
  const data = detail.notification?.data;
  const isReminderPress = detail.pressAction?.id === PRESS_REMINDER;

  // A foreground non-reminder caller has no DB side-effect to run. The background callback passes
  // `onCurrentChatPress`, so it still resolves the safe local route before stashing navigation.
  if (!isReminderPress && !onCurrentChatPress) return;
  // A summary route contains no local chat key and needs no DB lookup. A background/headless press
  // still has to reach the pending-navigation slot so the active app can explicitly open its inbox.
  if (hasPrivateRouteSchema(data, ['message-summary'])) {
    if (onCurrentChatPress && data && accountLease.isCurrent()) onCurrentChatPress(data);
    return;
  }
  if (!hasPrivateRouteSchema(data, ['message', 'send-failure', 'reminder'])) return;

  let route: Awaited<ReturnType<typeof resolveNotificationData>>;
  try {
    route = await resolveNotificationData(data);
  } catch (error) {
    if (accountLease.isCurrent()) {
      logger.warn('[notif] press route could not be resolved', error);
    }
    return;
  }
  if (!accountLease.isCurrent() || !route?.chatGuid) return;

  // The pending slot is session-scoped and reset synchronously by Disconnect. Resolve first so an
  // old schema-2 local id that no longer exists cannot navigate into the next account.
  if (onCurrentChatPress && data) onCurrentChatPress(data);

  if (!isReminderPress || route.reminder !== '1') return;
  const notificationId = detail.notification?.id;
  if (notificationId == null || !isSafeReminderNotificationId(notificationId)) return;

  // ensureDatabase (not getDatabase) so this works in the headless killed-app wake, where boot()
  // never ran and the DB was never opened. Re-check after the native/Keystore-backed open before
  // mutating the account database.
  assertCurrentAccount(accountLease);
  const db = await ensureDatabase();
  assertCurrentAccount(accountLease);
  await deleteReminderByNotificationId(db, notificationId, () => accountLease.isCurrent());
}

/**
 * Answer → ask the server to answer the call, then open the returned FaceTime
 * link; Decline → just clear the notification. Both clear the ringing
 * notification (id = ft-<uuid>). In dev, skip the server call and open a stub.
 */
async function handleFaceTimeAction(
  actionId: string | undefined,
  uuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  const dismiss = async (): Promise<void> => {
    assertCurrentAccount(accountLease);
    await cancelFaceTimeNotification(uuid, accountLease);
  };
  if (actionId === ACTION_DECLINE_FACETIME) {
    await dismiss();
    return;
  }
  if (actionId === ACTION_ANSWER_FACETIME) {
    try {
      let link: string | null;
      if (isDevServer()) {
        link = `https://facetime.apple.com/join#v=1&p=dev&k=${uuid}`;
      } else {
        // Gator's answer op only acks the answer ({ answered: true }); the openable join
        // link is minted by a SEPARATE op. Answer the call, then request a link to open.
        const transport = await resolveNotificationActionTransport(accountLease);
        assertCurrentTransport(transport);
        await faceTimeApi.answerFaceTime(transport.http, uuid);
        assertCurrentTransport(transport);
        link = await faceTimeApi.createFaceTimeLink(transport.http);
      }
      assertCurrentAccount(accountLease);
      // The link comes from the server — only open a real FaceTime link, never an
      // arbitrary scheme/Intent (a compromised server could otherwise deep-link).
      if (!isFaceTimeLink(link)) throw new Error('rejected non-FaceTime link');
      await Linking.openURL(link);
      assertCurrentAccount(accountLease);
    } catch {
      // best-effort; the call may already have ended / the link was rejected
    } finally {
      if (accountLease.isCurrent()) await dismiss();
    }
  }
}

/**
 * Send an inline notification reply. `onQueued` fires the instant the send is durable — the
 * optimistic row + outgoing-queue row are committed, so the queue owns delivery and a POST failure
 * is retried rather than lost. The caller uses it to decide whether the notification (the only copy
 * of the typed text) may be cleared.
 */
async function replyTo(
  chatGuid: string,
  text: string,
  onQueued: () => void,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  const turn = await logicalSendQueue.acquire(accountLease);
  try {
    // DEV: simulate the round-trip locally so the reply shows Delivered without a server.
    if (isDevServer()) {
      const { devSendFake } = await import('@features/conversations/devSeed');
      assertCurrentAccount(accountLease);
      await devSendFake(chatGuid, text, undefined, accountLease, onQueued);
      assertCurrentAccount(accountLease);
      return;
    }
    // ensureDatabase: a killed-app inline-reply runs headless with no prior DB open.
    assertCurrentAccount(accountLease);
    const db = await ensureDatabase();
    assertCurrentAccount(accountLease);
    const transport = await resolveNotificationActionTransport(accountLease);
    await sendTextMessage(
      db,
      transport.http,
      { chatGuid, text },
      Date.now(),
      onQueued,
      undefined,
      transport.accountIsCurrent,
      transport.capabilitySource,
    );
    assertCurrentAccount(accountLease);
  } finally {
    turn.release();
  }
}

/** Send a 'love' tapback for the notification's message (mirrors the in-app react path). */
async function loveMessage(
  chatGuid: string,
  messageGuid: string,
  accountLease: RealtimeDeliveryLease,
): Promise<void> {
  const turn = await logicalSendQueue.acquire(accountLease);
  try {
    // A notification carries aggregate identity only. Resolve the same conservative text/caption
    // target as the mounted bubble from the current encrypted row before either dev or real send.
    assertCurrentAccount(accountLease);
    const db = await ensureDatabase();
    assertCurrentAccount(accountLease);
    // One shared SQLite connection means even a read can otherwise see a neighbouring owner's
    // uncommitted rows. Take the global coordinator slot, but do not open a transaction: this is
    // one bounded DB-only snapshot and all parsing/network work stays after the slot is released.
    const layout = await withDbWriteLock(async () => {
      assertCurrentAccount(accountLease);
      return getMessageActionPartLayoutByGuid(db, messageGuid);
    });
    assertCurrentAccount(accountLease);
    // Missing/deleted/full/unknown targets are not a legacy part-zero message. The DB query returns
    // null for all of them, so abort instead of reacting to an unrelated part or stale notification.
    if (!layout) return;
    const bodyText = bodyTextFromRuns(parseAttributedRuns(layout.attributedBody, layout.text));

    // DEV: simulate the reaction round-trip locally without a server.
    if (isDevServer()) {
      const partIndex = resolveExactMessageTargetPartIndex({
        attachmentCount: layout.visibleAttachmentCount,
        hasText: bodyText.trim().length > 0,
        partCount: layout.partCount,
        topology: parseMessagePartTopology(layout.messagePartTopology),
        topologySupported: false,
        visibleAttachmentGuids: layout.visibleAttachmentGuids,
      });
      if (partIndex == null) return;
      const { devSendFakeReaction } = await import('@features/conversations/devSeed');
      assertCurrentAccount(accountLease);
      await devSendFakeReaction(chatGuid, messageGuid, 'love', undefined, partIndex, accountLease);
      assertCurrentAccount(accountLease);
      return;
    }
    const transport = await resolveNotificationActionTransport(accountLease);
    assertCurrentTransport(transport);
    const capability = await resolveRcsAttemptOwnership(
      transport.http,
      chatGuid,
      transport.accountIsCurrent,
      transport.capabilitySource,
      { requireServerInfo: true },
    );
    assertCurrentTransport(transport);
    const partIndex =
      isRcsChatGuid(chatGuid) && messageGuid.startsWith('rcs-')
        ? 0
        : resolveExactMessageTargetPartIndex({
            attachmentCount: layout.visibleAttachmentCount,
            hasText: bodyText.trim().length > 0,
            partCount: layout.partCount,
            topology: parseMessagePartTopology(layout.messagePartTopology),
            topologySupported: capability.serverInfo?.supports_message_part_topology === true,
            visibleAttachmentGuids: layout.visibleAttachmentGuids,
          });
    if (partIndex == null) return;
    await sendReactionMessage(
      db,
      transport.http,
      {
        chatGuid,
        targetGuid: messageGuid,
        reaction: 'love',
        partIndex,
      },
      Date.now(),
      transport.accountIsCurrent,
      messageTargetServerAuthorization(capability.serverInfo, transport.isCurrent),
    );
    assertCurrentAccount(accountLease);
  } finally {
    turn.release();
  }
}
