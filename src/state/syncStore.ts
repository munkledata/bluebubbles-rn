import { create } from 'zustand';

export type SyncStatus = 'idle' | 'syncing' | 'done' | 'error';
export type SyncRepairStatus =
  'idle' | 'queued' | 'running' | 'cancelling' | 'cancelled' | 'done' | 'error';

const MAX_REPAIR_LOG_LINES = 12;

function appendRepairLog(lines: readonly string[], message: string): string[] {
  return [...lines, message].slice(-MAX_REPAIR_LOG_LINES);
}

interface SyncState {
  status: SyncStatus;
  chats: number;
  messages: number;
  error: string | null;
  /** User-invoked full cache repair. Routine sync state remains in `status` above. */
  repairStatus: SyncRepairStatus;
  repairPhase: string | null;
  /** Fixed, privacy-safe operational messages only; never server payload or message content. */
  repairLog: readonly string[];

  begin: () => void;
  progress: (p: { chats: number; messages: number }) => void;
  done: (p: { chats: number; messages: number }) => void;
  fail: (message: string) => void;
  queueRepair: () => void;
  beginRepair: () => void;
  noteRepair: (phase: string, message: string) => void;
  requestRepairCancel: () => void;
  finishRepair: () => void;
  cancelRepair: (message?: string) => void;
  failRepair: (message: string) => void;
  /** Account teardown: clear status, counts, and any previous-server error copy. */
  reset: () => void;
}

export const useSyncStore = create<SyncState>((set) => ({
  status: 'idle',
  chats: 0,
  messages: 0,
  error: null,
  repairStatus: 'idle',
  repairPhase: null,
  repairLog: [],

  begin: () => set({ status: 'syncing', error: null }),
  progress: (p) => set({ chats: p.chats, messages: p.messages }),
  done: (p) => set({ status: 'done', chats: p.chats, messages: p.messages }),
  fail: (message) => set({ status: 'error', error: message }),
  queueRepair: () =>
    set({
      status: 'syncing',
      chats: 0,
      messages: 0,
      error: null,
      repairStatus: 'queued',
      repairPhase: 'Waiting for active sync',
      repairLog: ['Repair queued behind any active sync.'],
    }),
  beginRepair: () =>
    set((state) => ({
      status: 'syncing',
      chats: 0,
      messages: 0,
      error: null,
      repairStatus: 'running',
      repairPhase: 'Preparing local cache',
      repairLog: appendRepairLog(state.repairLog, 'Started full local-cache repair.'),
    })),
  noteRepair: (phase, message) =>
    set((state) => ({
      repairPhase: phase,
      repairLog: appendRepairLog(state.repairLog, message),
    })),
  requestRepairCancel: () =>
    set((state) => ({
      repairStatus:
        state.repairStatus === 'queued' || state.repairStatus === 'running'
          ? 'cancelling'
          : state.repairStatus,
      repairPhase:
        state.repairStatus === 'queued' || state.repairStatus === 'running'
          ? 'Stopping after current request'
          : state.repairPhase,
      repairLog:
        state.repairStatus === 'queued' || state.repairStatus === 'running'
          ? appendRepairLog(state.repairLog, 'Cancellation requested.')
          : state.repairLog,
    })),
  finishRepair: () =>
    set((state) => ({
      status: 'done',
      error: null,
      repairStatus: 'done',
      repairPhase: 'Repair complete',
      repairLog: appendRepairLog(state.repairLog, 'Repair completed successfully.'),
    })),
  cancelRepair: (message = 'Repair stopped. Run it again to restart the full download.') =>
    set((state) => ({
      status: 'idle',
      error: null,
      repairStatus: 'cancelled',
      repairPhase: 'Repair stopped',
      repairLog: appendRepairLog(state.repairLog, message),
    })),
  failRepair: (message) =>
    set((state) => ({
      status: 'error',
      error: message,
      repairStatus: 'error',
      repairPhase: 'Repair failed',
      repairLog: appendRepairLog(
        state.repairLog,
        'Repair failed. Check the connection, then restart it.',
      ),
    })),
  reset: () =>
    set({
      status: 'idle',
      chats: 0,
      messages: 0,
      error: null,
      repairStatus: 'idle',
      repairPhase: null,
      repairLog: [],
    }),
}));
