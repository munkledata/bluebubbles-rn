/**
 * Group / chat-event system messages (ported from the Flutter `buildGroupEventText`).
 *
 * iMessage emits in-thread events — someone added/removed, the group renamed, the photo changed,
 * someone left, a location shared, an audio kept, a FaceTime started — as messages carrying an
 * `itemType` (+ `groupActionType`, `groupTitle`, and `otherHandle` → the affected participant).
 * These render as a centered event line rather than a bubble. Pure/structural so it stays in the
 * React-free utils layer and is unit-testable.
 */
export interface GroupEventFields {
  itemType?: number | null;
  groupActionType?: number | null;
  groupTitle?: string | null;
  /** Resolved display name of the affected participant (`other_handle` → a name), if known. */
  otherHandleName?: string | null;
  /** Sender's display name (the actor). Null for own messages → rendered as "You". */
  senderName?: string | null;
  /** 1 when the current user is the actor. */
  isFromMe?: number | boolean | null;
}

/** True when this message is a group/chat system event rather than standalone content. */
export function isGroupEvent(
  m: Pick<GroupEventFields, 'itemType' | 'groupActionType' | 'groupTitle'>,
): boolean {
  return (m.itemType ?? 0) > 0 || (m.groupActionType ?? 0) > 0 || m.groupTitle != null;
}

/**
 * Human-readable text for a group event, e.g. "Alice added Bob to the conversation." Mirrors the
 * old app's item_type/group_action_type mapping. The actor is "You" for own messages; an unknown
 * affected participant falls back to "someone".
 */
export function buildGroupEventText(m: GroupEventFields): string {
  const name = m.isFromMe ? 'You' : (m.senderName ?? 'Someone');
  const other = m.otherHandleName ?? 'someone';
  const itemType = m.itemType ?? 0;
  const groupActionType = m.groupActionType ?? 0;

  if (itemType === 1) {
    if (groupActionType === 0) return `${name} added ${other} to the conversation.`;
    if (groupActionType === 1) return `${name} removed ${other} from the conversation.`;
  } else if (itemType === 2) {
    return m.groupTitle != null
      ? `${name} named the conversation "${m.groupTitle}".`
      : `${name} removed the name from the conversation.`;
  } else if (itemType === 3) {
    if (groupActionType == null || groupActionType === 0) return `${name} left the conversation.`;
    if (groupActionType === 1) return `${name} changed the group photo.`;
    if (groupActionType === 2) return `${name} removed the group photo.`;
  } else if (itemType === 4 && groupActionType === 0) {
    return `${name} shared ${name === 'You' ? 'your' : 'their'} location.`;
  } else if (itemType === 5) {
    return `${name} kept an audio message.`;
  } else if (itemType === 6) {
    return `${name} started a FaceTime call.`;
  }

  return 'Unknown group event';
}
