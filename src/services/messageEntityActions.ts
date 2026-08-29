import {
  findMessageEntities,
  type MessageDateEntity,
  type MessageEntity,
  type MessagePhoneEntity,
  type MessageUrlEntity,
} from '@core/richtext';
import { safeOpenUrl } from '@utils';

const CALENDAR_INSERT_ACTION = 'android.intent.action.INSERT';
const CALENDAR_EVENTS_URI = 'content://com.android.calendar/events';
const CALENDAR_EVENT_MIME = 'vnd.android.cursor.dir/event';

export type MessageEntityActionRequest =
  | { action: 'open-url'; entity: MessageUrlEntity }
  | { action: 'dial-phone'; entity: MessagePhoneEntity }
  | { action: 'message-phone'; entity: MessagePhoneEntity }
  | { action: 'copy-phone'; entity: MessagePhoneEntity }
  | { action: 'open-calendar-draft'; entity: MessageDateEntity }
  | { action: 'copy-date'; entity: MessageDateEntity };

export interface MessageEntityActionDependencies {
  openUrl: (url: string) => Promise<boolean>;
  copyText: (text: string) => Promise<void>;
  openCalendarDraft: (date: MessageDateEntity) => Promise<void>;
}

const defaultDependencies: MessageEntityActionDependencies = {
  openUrl: safeOpenUrl,
  copyText: async (text) => {
    const Clipboard = await import('expo-clipboard');
    await Clipboard.setStringAsync(text);
  },
  openCalendarDraft: async (date) => {
    const IntentLauncher = await import('expo-intent-launcher');
    await IntentLauncher.startActivityAsync(CALENDAR_INSERT_ACTION, {
      data: CALENDAR_EVENTS_URI,
      type: CALENDAR_EVENT_MIME,
      // These are Android CalendarContract's fixed extra names. No action, URI, title, or other
      // private message text is accepted from the peer-controlled entity.
      extra: {
        beginTime: date.startUtcMs,
        endTime: date.endUtcMs,
        allDay: true,
      },
    });
  },
};

/**
 * Reparse the exact displayed span at the native boundary. TypeScript types are not a runtime
 * security boundary, so a forged object must not be able to smuggle a different target/action.
 */
function revalidateEntity(entity: MessageEntity): MessageEntity | null {
  const reparsed = findMessageEntities(entity.text);
  const exact = reparsed.find(
    (candidate) =>
      candidate.kind === entity.kind &&
      candidate.start === 0 &&
      candidate.end === entity.text.length,
  );
  if (!exact) return null;
  if (entity.kind === 'url' && exact.kind === 'url') return exact.url === entity.url ? exact : null;
  if (entity.kind === 'phone' && exact.kind === 'phone') {
    return exact.number === entity.number ? exact : null;
  }
  if (entity.kind === 'date' && exact.kind === 'date') {
    return exact.startUtcMs === entity.startUtcMs && exact.endUtcMs === entity.endUtcMs
      ? exact
      : null;
  }
  return null;
}

/**
 * Execute one closed, user-confirmed message-entity action. Returns false for a forged/mismatched
 * request or unavailable native handler and never logs the peer-controlled value.
 */
export async function performMessageEntityAction(
  request: MessageEntityActionRequest,
  dependencies: MessageEntityActionDependencies = defaultDependencies,
): Promise<boolean> {
  const entity = revalidateEntity(request.entity);
  if (!entity) return false;

  try {
    switch (request.action) {
      case 'open-url':
        return entity.kind === 'url' && dependencies.openUrl(entity.url);
      case 'dial-phone':
        return entity.kind === 'phone' && dependencies.openUrl(`tel:${entity.number}`);
      case 'message-phone':
        return entity.kind === 'phone' && dependencies.openUrl(`sms:${entity.number}`);
      case 'copy-phone':
        if (entity.kind !== 'phone') return false;
        await dependencies.copyText(entity.text);
        return true;
      case 'open-calendar-draft':
        if (entity.kind !== 'date') return false;
        await dependencies.openCalendarDraft(entity);
        return true;
      case 'copy-date':
        if (entity.kind !== 'date') return false;
        await dependencies.copyText(entity.text);
        return true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}
