/**
 * Process-local authority for the one chat the user can currently see.
 *
 * Native/headless notification delivery can import this plain module without a React tree. Its
 * default is deliberately "not visible" so a background or killed-process wake never suppresses an
 * alert merely because a chat happened to be open before the process died.
 */
export interface ActiveChatClaim {
  /** Publish whether this focused route is genuinely visible (foreground and not App-Locked). */
  setVisible(visible: boolean): void;
  /** Release only this exact route claim; a stale blur must not clear a newer focused chat. */
  release(): void;
}

interface ActiveChatState {
  readonly owner: symbol;
  readonly chatGuid: string;
  visible: boolean;
}

let activeChat: ActiveChatState | null = null;

/** Claim navigation focus for one chat. A later claim supersedes this one synchronously. */
export function claimActiveChat(chatGuid: string): ActiveChatClaim {
  const owner = Symbol('active-chat');
  const state: ActiveChatState = { owner, chatGuid, visible: false };
  activeChat = state;

  return {
    setVisible: (visible) => {
      if (activeChat?.owner === owner) activeChat.visible = visible;
    },
    release: () => {
      if (activeChat?.owner === owner) activeChat = null;
    },
  };
}

/** True only for the exact focused, foreground, unlocked conversation. */
export function isActiveChat(chatGuid: string): boolean {
  return activeChat?.visible === true && activeChat.chatGuid === chatGuid;
}

/** Disconnect/account replacement synchronously invalidates every retained route claim. */
export function resetActiveChat(): void {
  activeChat = null;
}
