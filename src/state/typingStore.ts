import { create } from 'zustand';

interface TypingState {
  /** chatGuid → the other party is currently typing. */
  typing: Record<string, boolean>;
  /** Apply a typing-indicator event. `display=false` clears immediately. */
  setTyping: (chatGuid: string, display: boolean) => void;
}

// Typing indicators are best-effort: the server sends `display:true` while typing and
// (usually) `display:false` on stop, but a stop can be lost — so auto-clear after a TTL.
const TYPING_TTL_MS = 12_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();

export const useTypingStore = create<TypingState>((set) => ({
  typing: {},
  setTyping: (chatGuid, display) => {
    const existing = timers.get(chatGuid);
    if (existing) clearTimeout(existing);
    timers.delete(chatGuid);
    if (display) {
      timers.set(
        chatGuid,
        setTimeout(() => {
          timers.delete(chatGuid);
          set((s) => ({ typing: { ...s.typing, [chatGuid]: false } }));
        }, TYPING_TTL_MS),
      );
    }
    set((s) => ({ typing: { ...s.typing, [chatGuid]: display } }));
  },
}));
