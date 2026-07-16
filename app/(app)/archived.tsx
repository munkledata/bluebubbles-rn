import type { InboxRow } from '@db/repositories';
import { FilteredChatListScreen } from '@ui/conversations/FilteredChatListScreen';

const isArchived = (r: InboxRow): boolean => !!r.isArchived;

/** Archived conversations: a flat list; long-press → unarchive / pin / delete. */
export default function ArchivedScreen(): React.JSX.Element {
  return (
    <FilteredChatListScreen
      title="Archived"
      emptyText="No archived conversations"
      filter={isArchived}
      includeArchived
    />
  );
}
