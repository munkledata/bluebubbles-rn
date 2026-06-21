import { create } from 'zustand';

export type SyncStatus = 'idle' | 'syncing' | 'done' | 'error';

interface SyncState {
  status: SyncStatus;
  chats: number;
  messages: number;
  error: string | null;

  begin: () => void;
  progress: (p: { chats: number; messages: number }) => void;
  done: (p: { chats: number; messages: number }) => void;
  fail: (message: string) => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  status: 'idle',
  chats: 0,
  messages: 0,
  error: null,

  begin: () => set({ status: 'syncing', error: null }),
  progress: (p) => set({ chats: p.chats, messages: p.messages }),
  done: (p) => set({ status: 'done', chats: p.chats, messages: p.messages }),
  fail: (message) => set({ status: 'error', error: message }),
}));
