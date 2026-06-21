/** A message in the conversation history fed to a smart-reply provider. */
export interface SmartReplyMessage {
  text: string;
  isFromMe: boolean;
}

/**
 * Generates up to 3 suggested replies from recent history. Async so a future
 * on-device ML Kit provider (a native call) can drop in behind this interface
 * without changing any UI. Returns [] when it has no suggestion.
 */
export interface SmartReplyProvider {
  suggest(history: SmartReplyMessage[]): Promise<string[]>;
}
