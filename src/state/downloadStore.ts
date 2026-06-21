import { create } from 'zustand';

export type DownloadStatus = 'idle' | 'downloading' | 'error';

/**
 * Pure: bytes → ratio in [0,1]. Returns null (indeterminate) when the total is
 * unknown — expo-file-system reports totalBytes === -1 when the server omits
 * Content-Length, so the ring falls back to a spinner.
 */
export function progressRatio(loaded: number, total: number): number | null {
  if (!Number.isFinite(total) || total <= 0) return null;
  const r = loaded / total;
  if (!Number.isFinite(r)) return null;
  return Math.min(1, Math.max(0, r));
}

interface DownloadState {
  /** null = indeterminate (spinner); 0..1 = determinate ring. */
  progress: Record<string, number | null>;
  status: Record<string, DownloadStatus>;
  start: (guid: string) => void;
  setProgress: (guid: string, loaded: number, total: number) => void;
  finish: (guid: string) => void;
  fail: (guid: string) => void;
}

/**
 * Presentation-only download state keyed by attachment guid. The actual image/
 * video swap stays driven by the reactive `localPath` DB write — this store only
 * powers the progress ring / spinner / retry affordance.
 */
export const useDownloadStore = create<DownloadState>((set) => ({
  progress: {},
  status: {},
  start: (g) =>
    set((s) => ({
      status: { ...s.status, [g]: 'downloading' },
      progress: { ...s.progress, [g]: 0 },
    })),
  setProgress: (g, loaded, total) =>
    set((s) => ({ progress: { ...s.progress, [g]: progressRatio(loaded, total) } })),
  finish: (g) =>
    set((s) => ({ status: { ...s.status, [g]: 'idle' }, progress: { ...s.progress, [g]: 1 } })),
  fail: (g) => set((s) => ({ status: { ...s.status, [g]: 'error' } })),
}));
