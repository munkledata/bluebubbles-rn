import { useLocalSearchParams } from 'expo-router';
import { SharedDocumentsScreen } from '@ui/conversations/SharedDocumentsScreen';

function parseChatGuid(value: string | string[] | undefined): string | null {
  const guid = Array.isArray(value) ? value[0] : value;
  return guid != null && guid.length > 0 && guid.length <= 4096 ? guid : null;
}

/** Thin route wrapper for the account-owned Shared Documents explorer. */
export default function SharedDocumentsRoute(): React.JSX.Element {
  const params = useLocalSearchParams<{ guid?: string | string[] }>();
  const chatGuid = parseChatGuid(params.guid);
  return <SharedDocumentsScreen key={chatGuid ?? 'invalid'} chatGuid={chatGuid} />;
}
