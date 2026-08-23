import { useSyncExternalStore } from 'react';
import { getForegroundBootSnapshot, subscribeForegroundBoot } from '@/services/boot/foregroundBoot';
import type { BootState } from '@/services/boot/bootStateMachine';

/** React projection of the coordinator itself—no second mutable boot store to drift or leak. */
export function useForegroundBootState(): BootState {
  return useSyncExternalStore(
    subscribeForegroundBoot,
    getForegroundBootSnapshot,
    getForegroundBootSnapshot,
  );
}
