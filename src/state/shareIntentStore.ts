import { create } from 'zustand';

/** A file shared INTO the app via the Android share sheet, normalized for the composer. */
export interface SharedAttachment {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
}

interface ShareIntentState {
  /** Shared text or URL, if any. */
  text: string | null;
  /** Shared files (images/videos/documents). */
  files: SharedAttachment[];
  set: (payload: { text: string | null; files: SharedAttachment[] }) => void;
  clear: () => void;
}

/**
 * Dormant handoff store retained for a future owned, bounded inbound-share implementation. IPC-01
 * currently mounts no producer or navigator, and the release manifest accepts no Android share
 * intents. Files cannot ride expo-router URL params, so a safe future intake can stage an atomic,
 * fully materialized batch here before its connected-layout consumer navigates.
 */
export const useShareIntentStore = create<ShareIntentState>((set) => ({
  text: null,
  files: [],
  set: ({ text, files }) => set({ text, files }),
  clear: () => set({ text: null, files: [] }),
}));
