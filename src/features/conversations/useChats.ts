import { getDatabase } from '@db/database';
import { listChatsForInbox, type InboxRow } from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';

// Any write to these tables affects an inbox row, so we watch all four:
// messages (preview/order/unread), chats (pin/mute/archive/rename/read marker),
// chat_handles + handles (participants/titles).
const TABLES = ['messages', 'chats', 'chat_handles', 'handles'];

/** Live inbox rows, re-queried automatically as sync/socket writes land. */
export function useChats(includeArchived = false): ReactiveState<InboxRow[]> {
  return useReactiveQuery<InboxRow[]>(
    () => listChatsForInbox(getDatabase(), { includeArchived }),
    TABLES,
    [includeArchived],
  );
}
