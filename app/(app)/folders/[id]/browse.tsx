import { useLocalSearchParams } from 'expo-router';
import { FolderConversationListScreen } from '@ui/conversations/FolderConversationListScreen';

function parseFolderId(value: string | string[] | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  const id = Number(raw);
  return raw != null && Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** Browse the currently available conversations in one stable device-local folder membership. */
export default function ConversationFolderBrowseRoute(): React.JSX.Element {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  return <FolderConversationListScreen folderId={parseFolderId(params.id)} />;
}
