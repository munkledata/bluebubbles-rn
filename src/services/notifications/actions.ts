import notifee, { type EventDetail } from 'react-native-notify-kit';
import { Linking } from 'react-native';
import { faceTimeApi } from '@core/api';
import { isFaceTimeLink } from '@core/facetime';
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

  switch (detail.pressAction?.id) {
    case ACTION_REPLY: {
      const text = detail.input?.trim();
      if (text) await replyTo(chatGuid, text);
      await notifee.cancelNotification(chatGuid);
      break;
    }
    case ACTION_MARK_READ:
      await markRead(chatGuid);
      await notifee.cancelNotification(chatGuid);
      break;
    case ACTION_LOVE: {
      // "♥ Love" the message the notification is about. Needs the messageGuid the
      // intent carried; without it there's nothing to react to.
      const messageGuid = detail.notification?.data?.messageGuid as string | undefined;
      if (messageGuid) await loveMessage(chatGuid, messageGuid);
      await notifee.cancelNotification(chatGuid);
      break;
    }
    case PRESS_REMINDER: {
      // Reminder fired + tapped → it's done; remove the DB row. Deep-link to the
      // chat is handled by launchActivity.
      const notifId = detail.notification?.id;
      // ensureDatabase (not getDatabase) so this works in the headless killed-app wake,
      // where boot() never ran and the DB was never opened.
      if (notifId) await deleteReminderByNotificationId(await ensureDatabase(), notifId);
      break;
    }
    default:
      // open-chat / body press: deep-link handled by launchActivity; nothing here.
      break;
  }
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

async function replyTo(chatGuid: string, text: string): Promise<void> {
  // DEV: simulate the round-trip locally so the reply shows Delivered without a server.
  if (isDevServer()) {
    const { devSendFake } = await import('@features/conversations/devSeed');
    await devSendFake(chatGuid, text);
    return;
  }
  // ensureDatabase: a killed-app inline-reply runs headless with no prior DB open.
  await sendTextMessage(await ensureDatabase(), http, { chatGuid, text });
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
