import type { NewChatService } from '@/services/chatActions';

/** What "Message <name>" on a group message does. */
export type DirectMessagePlan =
  /** Open the sender's existing one-to-one chat. */
  | { kind: 'open'; path: string }
  /** Open the new-message screen with the sender filled in; nothing is sent until Start. */
  | { kind: 'compose'; params: { to: string; service?: NewChatService } }
  /** Neither is possible on this server. */
  | { kind: 'notice'; message: string };

export const DIRECT_MESSAGE_UNAVAILABLE =
  'There is no conversation with this person yet, and this server can’t start a new one.';

/**
 * The group's service, when Gator can start a new chat on it. An SMS group (relayed by the Mac)
 * has none, so the new-message screen keeps its usual choice.
 */
export function directMessageServiceFor(
  chatService: 'iMessage' | 'SMS' | 'RCS' | null,
): NewChatService | null {
  return chatService === 'iMessage' || chatService === 'RCS' ? chatService : null;
}

export function planDirectMessage({
  address,
  service,
  existingChatGuid,
  newChatAvailable,
}: {
  address: string;
  service: NewChatService | null;
  existingChatGuid: string | null;
  newChatAvailable: boolean;
}): DirectMessagePlan {
  if (existingChatGuid) {
    return { kind: 'open', path: `/chat/${encodeURIComponent(existingChatGuid)}` };
  }
  if (!newChatAvailable) return { kind: 'notice', message: DIRECT_MESSAGE_UNAVAILABLE };
  return { kind: 'compose', params: service ? { to: address, service } : { to: address } };
}
