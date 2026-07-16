import { useState } from 'react';
import { getDatabase } from '@db/database';
import { listChatsForInbox, type InboxRow } from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';
import { createRowIdentityCache } from './rowIdentity';

// Any write to these tables affects an inbox row, so we watch all four:
// messages (preview/order/unread), chats (pin/mute/archive/rename/read marker),
// chat_handles + handles (participants/titles).
const TABLES = ['messages', 'chats', 'chat_handles', 'handles'];

/** Live inbox rows, re-queried automatically as sync/socket writes land. */
export function useChats(includeArchived = false): ReactiveState<InboxRow[]> {
  // Unchanged inbox rows keep their identity across reactive flushes, so the memoized
  // ConversationTile only re-renders for a real row change (see rowIdentity.ts).
  // Lazy initializer — useRef(create()) would re-invoke the factory every render.
  const [reconcile] = useState(() => createRowIdentityCache<InboxRow>((c) => c.guid));
  return useReactiveQuery<InboxRow[]>(
    async () => reconcile(await listChatsForInbox(getDatabase(), { includeArchived })),
    TABLES,
    [includeArchived],
  );
}
