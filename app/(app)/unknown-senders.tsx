import type { InboxRow } from '@db/repositories';
import { FilteredChatListScreen } from '@ui/conversations/FilteredChatListScreen';

const isUnknownSender = (r: InboxRow): boolean => r.hasKnownSender !== 1 && !r.isArchived;

/**
 * Unknown Senders: chats where no participant matched a device contact, routed out of the main
 * inbox when the "Filter Unknown Senders" setting is on (their notifications are silenced too).
 */
export default function UnknownSendersScreen(): React.JSX.Element {
  return (
    <FilteredChatListScreen
      title="Unknown Senders"
      emptyText="No conversations from unknown senders"
      filter={isUnknownSender}
    />
  );
}
