import { create } from 'zustand';

/** A file shared INTO the app via the Android share sheet, normalized for the composer. */
export interface SharedAttachment {
  uri: string;
  name: string;
  mimeType: string;
  size: number;
  /** Native-owned transient file that must be adopted before durable outgoing commit. */
  origin?: 'paste' | 'share';
  /** Stable order in the native manifest; never derive replay ownership from a path or name. */
  shareItemIndex?: number;
}

interface ShareIntentState {
  /** Exact native batch currently owned by one composer handoff. */
  batchId: string | null;
  /** Native capture time, part of the immutable replay-receipt identity. */
  createdAtMs: number | null;
  /** Shared text or URL, if any. */
  text: string | null;
  /** Shared files (images/videos/documents). */
  files: SharedAttachment[];
  /** Opaque Direct Share token paired inside the same native manifest. */
  targetToken: string | null;
  /** Content-free native rejection reason, shown only after the protected tree is visible. */
  failureReason: string | null;
  stageIfEmpty: (payload: {
    batchId: string;
    createdAtMs: number;
    text: string | null;
    files: SharedAttachment[];
    targetToken: string | null;
  }) => boolean;
  clearIf: (batchId: string) => boolean;
  setFailureReason: (reason: string) => void;
  clearFailureReason: () => void;
  /** Test/admin reset only; production consumers use clearIf with their captured token. */
  clear: () => void;
}

/**
 * Process-local presentation of one native-owned, complete share claim. The route carries the
 * exact batch id and production consumers acknowledge only that id after durable send ownership.
 * Native storage remains authoritative across process death; this store never owns provider URIs.
 */
export const useShareIntentStore = create<ShareIntentState>((set) => ({
  batchId: null,
  createdAtMs: null,
  text: null,
  files: [],
  targetToken: null,
  failureReason: null,
  stageIfEmpty: (payload) => {
    let staged = false;
    set((state) => {
      if (state.batchId !== null) return state;
      staged = true;
      return {
        batchId: payload.batchId,
        createdAtMs: payload.createdAtMs,
        text: payload.text,
        files: payload.files,
        targetToken: payload.targetToken,
      };
    });
    return staged;
  },
  clearIf: (batchId) => {
    let cleared = false;
    set((state) => {
      if (state.batchId !== batchId) return state;
      cleared = true;
      return { batchId: null, createdAtMs: null, text: null, files: [], targetToken: null };
    });
    return cleared;
  },
  setFailureReason: (failureReason) => set({ failureReason }),
  clearFailureReason: () => set({ failureReason: null }),
  clear: () => set({ batchId: null, createdAtMs: null, text: null, files: [], targetToken: null }),
}));
