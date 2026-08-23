import { create } from 'zustand';

export interface ActiveFaceTimeCall {
  /** Validated FaceTime join link (`facetime:` or `https://facetime.apple.com/…`). */
  link: string;
  /** Chat the call was started from (the link is also sent here so others can join). */
  chatGuid: string;
  /** Video requested (vs audio-only). Presentation hint only — the web client picks the mode. */
  video: boolean;
}

/** An incoming FaceTime call awaiting Answer/Decline (Phase 4) — distinct from the active call. */
export interface IncomingFaceTimeCall {
  /** Call identity from the server event — keys the ring + the answer op. */
  uuid: string;
  /** Display name (number/email/contact) used by the incoming-call overlay. */
  callerName: string;
  /** Audio-only call (presentation hint for the overlay copy). */
  isAudio: boolean;
  /** Optional caller avatar (data/URI) if the chat could be resolved. */
  avatarUri?: string;
}

interface FaceTimeState {
  /** Monotonic account boundary used to disown call work already in flight at teardown. */
  generation: number;
  call: ActiveFaceTimeCall | null;
  incoming: IncomingFaceTimeCall | null;
  open: (call: ActiveFaceTimeCall) => void;
  /** Open only if the async caller still belongs to the captured account generation. */
  openIfCurrent: (call: ActiveFaceTimeCall, generation: number) => boolean;
  close: () => void;
  /** Ring an incoming call (replaces any prior — one call at a time). */
  ring: (incoming: IncomingFaceTimeCall) => void;
  /** Stop ringing for `uuid`; no-op if a different (or no) call is ringing. */
  dismissIncoming: (uuid: string) => void;
  /** Account teardown: discard every caller/call identity from the previous server. */
  reset: () => void;
}

/**
 * FaceTime overlay state. `call` drives the safe external-browser handoff (`FaceTimeCallOverlay`);
 * `incoming` drives the ring overlay (`IncomingFaceTimeOverlay`). The outgoing start
 * orchestration lives in `useFaceTime`, the incoming answer/decline in `useIncomingFaceTime`
 * — this store is just the UI state. One call at a time.
 */
export const useFaceTimeStore = create<FaceTimeState>((set) => ({
  generation: 0,
  call: null,
  incoming: null,
  open: (call) => set({ call }),
  openIfCurrent: (call, generation) => {
    if (useFaceTimeStore.getState().generation !== generation) return false;
    set({ call });
    return true;
  },
  close: () => set({ call: null }),
  ring: (incoming) => set({ incoming }),
  // uuid-guarded so a late `ended` for an OLD call can't clear a newer ring.
  dismissIncoming: (uuid) => set((s) => (s.incoming?.uuid === uuid ? { incoming: null } : s)),
  reset: () => set((s) => ({ generation: s.generation + 1, call: null, incoming: null })),
}));
