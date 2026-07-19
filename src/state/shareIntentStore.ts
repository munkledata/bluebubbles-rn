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
 * Holds content shared INTO Gator from another app (via `expo-share-intent`) between the capture
 * point (`ShareIntentCapture`, mounted at the root above the lock/auth gate) and its consumer (the
 * new-chat creator, which stages it and clears the store). `ShareIntentNavigator` (in the connected
 * (app) layout) opens new-chat once a share is pending here. Files can't ride expo-router URL
 * params, so they pass through this store instead. See `src/ui/ShareIntentHandler.tsx`.
 */
export const useShareIntentStore = create<ShareIntentState>((set) => ({
  text: null,
  files: [],
  set: ({ text, files }) => set({ text, files }),
  clear: () => set({ text: null, files: [] }),
}));
