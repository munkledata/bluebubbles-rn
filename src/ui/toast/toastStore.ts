import { create } from 'zustand';

export interface ToastRequest {
  id: number;
  message: string;
  durationMs: number;
}

interface ToastState {
  /** The toast currently on screen (null = none). */
  current: ToastRequest | null;
  /** Toasts waiting behind the current one, shown one at a time. */
  queue: ToastRequest[];
  enqueue: (req: Omit<ToastRequest, 'id'>) => void;
  /** Dismiss the current toast and promote the next queued one (if any). */
  dismiss: () => void;
}

let nextId = 1;

/**
 * App-wide ephemeral toast queue — a brief, NON-blocking status pill (e.g. "Downloaded 3 images to
 * Gator album"), rendered by {@link AppToast}. A tiny FIFO queue plays a burst of toasts back in
 * order instead of clobbering each other. Mirrors the dialog store's shape.
 */
export const useToastStore = create<ToastState>((set, get) => ({
  current: null,
  queue: [],
  enqueue: (req) => {
    const full: ToastRequest = { ...req, id: nextId++ };
    if (get().current == null) set({ current: full });
    else set((s) => ({ queue: [...s.queue, full] }));
  },
  dismiss: () =>
    set((s) => {
      const [next, ...rest] = s.queue;
      return { current: next ?? null, queue: rest };
    }),
}));

const DEFAULT_DURATION_MS = 2500;

/**
 * Show a brief toast. Zero-React and callable from services/hooks (like {@link showDialog}). In a
 * headless FCM context there is no React host, so this just enqueues into the store and nothing
 * renders — harmless.
 */
export function showToast(message: string, opts?: { durationMs?: number }): void {
  useToastStore
    .getState()
    .enqueue({ message, durationMs: opts?.durationMs ?? DEFAULT_DURATION_MS });
}
