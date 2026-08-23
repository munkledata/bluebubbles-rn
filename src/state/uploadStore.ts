import { create } from 'zustand';
import type { UploadProgressSink, UploadStartInfo } from '@/services/send/trackedUpload';

/**
 * Presentation-only upload state, keyed by ATTACHMENT guid (the same key the attachment
 * components already render under, so a bubble can look itself up with `att.guid`).
 *
 * Same rule as `downloadStore`: this store never drives what is actually true about a message.
 * `send_state` in the DB owns "sending / sent / error" and the reactive query owns the bubble —
 * this only powers the ring, the byte readout and the composer's upload bar.
 *
 * ONE deliberate difference from `downloadStore`: settling REMOVES the entry rather than parking
 * it at `status: 'idle'`. The set of entries IS the answer to "is anything uploading right now",
 * which the composer bar reads directly, and a retained entry would also leave a stale 100% ring
 * on a recycled FlashList row. A failure needs no entry either — the message row's own
 * `send_state = 'error'` already draws the red badge and the retry affordance.
 */

export interface UploadEntry {
  /** Which chat the file is going to — the composer status bar is per-chat. */
  chatGuid: string;
  /** File name, for the status bar's single-file readout. */
  name: string;
  sent: number;
  /** 0 until the native uploader reports the content length on its first progress event. */
  total: number;
  /** Wall clock of the last progress event; stall detection derives from it. */
  updatedAt: number;
}

interface UploadState {
  byGuid: Record<string, UploadEntry>;
  start: (key: string, info: UploadStartInfo) => void;
  progress: (key: string, sent: number, total: number) => void;
  settle: (key: string) => void;
  /** Account teardown: remove every presentation-only entry synchronously. */
  reset: () => void;
}

export const useUploadStore = create<UploadState>((set) => ({
  byGuid: {},

  start: (key, info) =>
    set((s) => ({
      byGuid: {
        ...s.byGuid,
        [key]: {
          chatGuid: info.chatGuid,
          name: info.name,
          sent: 0,
          total: Number.isFinite(info.total) && info.total > 0 ? info.total : 0,
          updatedAt: Date.now(),
        },
      },
    })),

  progress: (key, sent, total) =>
    set((s) => {
      const prev = s.byGuid[key];
      // No entry means this upload already settled. A late native event must NOT resurrect it —
      // events are emitted from the native side and can land after the promise resolves, and a
      // resurrected entry has nothing left to settle it, so the phantom spinner would be forever.
      if (!prev) return s;
      return {
        byGuid: {
          ...s.byGuid,
          [key]: {
            ...prev,
            sent: Number.isFinite(sent) && sent > 0 ? sent : prev.sent,
            // Keep the last known total: the native layer reports -1 for an unknown length, and
            // overwriting a real total with that would knock a determinate bar back to a spinner.
            total: Number.isFinite(total) && total > 0 ? total : prev.total,
            updatedAt: Date.now(),
          },
        },
      };
    }),

  settle: (key) =>
    set((s) => {
      if (!(key in s.byGuid)) return s;
      const next = { ...s.byGuid };
      delete next[key];
      return { byGuid: next };
    }),

  reset: () => set({ byGuid: {} }),
}));

/**
 * The store as an {@link UploadProgressSink} — the production wiring handed to `runTrackedUpload`.
 * Reads `getState()` per call so it is safe to hold as a module constant.
 */
export const uploadStoreSink: UploadProgressSink = {
  start: (key, info) => useUploadStore.getState().start(key, info),
  progress: (key, sent, total) => useUploadStore.getState().progress(key, sent, total),
  settle: (key) => useUploadStore.getState().settle(key),
};
