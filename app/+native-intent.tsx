import { newChatPathForIMessageLink } from '@utils/imessageLink';

/**
 * Expo Router's hook for links that open the app. Only `imessage:` links are rewritten (to New
 * Message with the recipient filled in); every other link, including `gator://` and the dev client,
 * passes through unchanged. Returning null would drop a link, so a failure here keeps the original.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    return newChatPathForIMessageLink(path) ?? path;
  } catch {
    return path;
  }
}
