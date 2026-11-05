import { useLocalSearchParams } from 'expo-router';
import {
  ChatAttachmentsScreen,
  parseChatAttachmentsTab,
} from '@ui/conversations/ChatAttachmentsScreen';

function parseChatGuid(value: string | string[] | undefined): string | null {
  const guid = Array.isArray(value) ? value[0] : value;
  return guid != null && guid.length > 0 && guid.length <= 4096 ? guid : null;
}

/** Thin route wrapper for the account-owned All Attachments page (`?tab=photos|videos|files|links`). */
export default function ChatAttachmentsRoute(): React.JSX.Element {
  const params = useLocalSearchParams<{ guid?: string | string[]; tab?: string | string[] }>();
  const chatGuid = parseChatGuid(params.guid);
  return (
    <ChatAttachmentsScreen
      key={chatGuid ?? 'invalid'}
      chatGuid={chatGuid}
      initialTab={parseChatAttachmentsTab(params.tab)}
    />
  );
}
