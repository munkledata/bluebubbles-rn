import notifee, { type EventDetail } from 'react-native-notify-kit';
import { Linking } from 'react-native';
import { faceTimeApi } from '@core/api';
import { isFaceTimeLink } from '@core/facetime';
import { logger } from '@core/secure';
import { deleteReminderByNotificationId } from '@db/repositories';
import { isDevServer } from '@utils/isDev';
import { http } from '../clients';
import { markRead } from '../chatActions';
import { ensureDatabase } from '../databaseControl';
import { sendTextMessage } from '@/services/send/sendService';
import { sendReactionMessage } from '@/services/send/sendReactionService';
import {
  ACTION_ANSWER_FACETIME,
  ACTION_DECLINE_FACETIME,
  ACTION_LOVE,
  ACTION_MARK_READ,
  ACTION_REPLY,
  PRESS_REMINDER,
} from './notifeeService';

/**
 * Handle a notification action press (foreground or headless background).
 * Reply → outgoing-queue send; Mark-as-read → advance the read marker; both
 * clear the chat's notification. Reads the inline reply text from `detail.input`.
 */
export async function handleNotificationAction(detail: EventDetail): Promise<void> {
  // FaceTime call actions carry a faceTimeUuid (no chatGuid) — handle first.
  const faceTimeUuid = detail.notification?.data?.faceTimeUuid as string | undefined;
  if (faceTimeUuid) {
    await handleFaceTimeAction(detail.pressAction?.id, faceTimeUuid);
    return;
  }

  const chatGuid = detail.notification?.data?.chatGuid as string | undefined;
  if (!chatGuid) return;

  const actionId = detail.pressAction?.id;
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
        await replyTo(chatGuid, text, () => {
          clearTray = true;
        });
        break;
      }
      case ACTION_MARK_READ:
        await markRead(chatGuid);
        break;
      case ACTION_LOVE: {
        // "♥ Love" the message the notification is about. Needs the messageGuid the
        // intent carried; without it there's nothing to react to.
        const messageGuid = detail.notification?.data?.messageGuid as string | undefined;
        if (messageGuid) await loveMessage(chatGuid, messageGuid);
        break;
      }
    }
  } catch (e) {
    logger.warn('[notif] action failed', { action: actionId, error: String(e) });
  } finally {
    // Note the flag is set from INSIDE the send (the queue handover), not after it returns: a
    // throw AFTER the enqueue still clears, because the reply is already on its way and leaving
    // the notification up would invite the user to send it twice.
    if (clearTray) await notifee.cancelNotification(chatGuid);
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
export async function handleNotificationPress(detail: EventDetail): Promise<void> {
  if (detail.pressAction?.id !== PRESS_REMINDER) return;
  const notifId = detail.notification?.id;
  // ensureDatabase (not getDatabase) so this works in the headless killed-app wake, where
  // boot() never ran and the DB was never opened.
  if (notifId) await deleteReminderByNotificationId(await ensureDatabase(), notifId);
}

/**
 * Answer → ask the server to answer the call, then open the returned FaceTime
 * link; Decline → just clear the notification. Both clear the ringing
 * notification (id = ft-<uuid>). In dev, skip the server call and open a stub.
 */
async function handleFaceTimeAction(actionId: string | undefined, uuid: string): Promise<void> {
  const dismiss = (): Promise<void> => notifee.cancelNotification(`ft-${uuid}`);
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
        await faceTimeApi.answerFaceTime(http, uuid);
        link = await faceTimeApi.createFaceTimeLink(http);
      }
      // The link comes from the server — only open a real FaceTime link, never an
      // arbitrary scheme/Intent (a compromised server could otherwise deep-link).
      if (!isFaceTimeLink(link)) throw new Error('rejected non-FaceTime link');
      await Linking.openURL(link);
    } catch {
      // best-effort; the call may already have ended / the link was rejected
    } finally {
      await dismiss();
    }
  }
}

/**
 * Send an inline notification reply. `onQueued` fires the instant the send is durable — the
 * optimistic row + outgoing-queue row are committed, so the queue owns delivery and a POST failure
 * is retried rather than lost. The caller uses it to decide whether the notification (the only copy
 * of the typed text) may be cleared.
 */
async function replyTo(chatGuid: string, text: string, onQueued: () => void): Promise<void> {
  // DEV: simulate the round-trip locally so the reply shows Delivered without a server.
  if (isDevServer()) {
    const { devSendFake } = await import('@features/conversations/devSeed');
    await devSendFake(chatGuid, text);
    onQueued(); // the fake write IS the durable point in dev
    return;
  }
  // ensureDatabase: a killed-app inline-reply runs headless with no prior DB open.
  await sendTextMessage(await ensureDatabase(), http, { chatGuid, text }, Date.now(), onQueued);
}

/** Send a 'love' tapback for the notification's message (mirrors the in-app react path). */
async function loveMessage(chatGuid: string, messageGuid: string): Promise<void> {
  // DEV: simulate the reaction round-trip locally without a server.
  if (isDevServer()) {
    const { devSendFakeReaction } = await import('@features/conversations/devSeed');
    await devSendFakeReaction(chatGuid, messageGuid, 'love');
    return;
  }
  // ensureDatabase: a killed-app action runs headless with no prior DB open.
  await sendReactionMessage(await ensureDatabase(), http, {
    chatGuid,
    targetGuid: messageGuid,
    reaction: 'love',
  });
}
