import { useCallback, useEffect, useRef, useState } from 'react';
import type { CustomFolderSummaryRow } from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';
import { loadCustomFolderSummaries } from '@/services/customFolderCommands';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';

const TABLES = ['custom_folders', 'custom_folder_members', 'messages', 'chats'];

interface CustomFolderSummariesEnvelope {
  generation: number;
  key: string;
  rows: CustomFolderSummaryRow[] | null;
  stale: boolean;
  error: Error | null;
}

export interface CustomFolderSummariesState extends ReactiveState<CustomFolderSummaryRow[]> {
  retry: () => void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Live ordered folder summaries, including exact folder-wide unread-conversation counts. */
export function useCustomFolderSummaries(
  accountLease: RealtimeDeliveryLease,
  enabled = true,
): CustomFolderSummariesState {
  const queryEnabled = enabled && accountLease.isCurrent();
  const [retryNonce, setRetryNonce] = useState(0);
  const lastSuccessfulRowsRef = useRef<{
    generation: number;
    rows: CustomFolderSummaryRow[];
  } | null>(null);
  const lastDisplayedRef = useRef<{
    generation: number;
    value: CustomFolderSummariesEnvelope;
  } | null>(null);
  const requestKey = `${accountLease.generation}|${retryNonce}`;
  const activeRequestKeyRef = useRef<string | null>(queryEnabled ? requestKey : null);
  const requestSequenceRef = useRef(0);
  activeRequestKeyRef.current = queryEnabled ? requestKey : null;
  const state = useReactiveQuery<CustomFolderSummariesEnvelope>(
    async () => {
      const requestSequence = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestSequence;
      try {
        const result = await loadCustomFolderSummaries(accountLease);
        if (result.status === 'stale') {
          return {
            generation: accountLease.generation,
            key: requestKey,
            rows: null,
            stale: true,
            error: null,
          };
        }
        if (
          activeRequestKeyRef.current === requestKey &&
          requestSequenceRef.current === requestSequence
        ) {
          lastSuccessfulRowsRef.current = {
            generation: accountLease.generation,
            rows: result.value,
          };
        }
        return {
          generation: accountLease.generation,
          key: requestKey,
          rows: result.value,
          stale: false,
          error: null,
        };
      } catch (cause) {
        const lastSuccessful = lastSuccessfulRowsRef.current;
        return {
          generation: accountLease.generation,
          key: requestKey,
          rows: lastSuccessful?.generation === accountLease.generation ? lastSuccessful.rows : null,
          stale: false,
          error: toError(cause),
        };
      }
    },
    TABLES,
    [requestKey],
    { enabled: queryEnabled },
  );

  const latest =
    queryEnabled && state.data?.generation === accountLease.generation ? state.data : null;
  const current = latest?.key === requestKey ? latest : null;
  useEffect(() => {
    if (state.data?.generation === accountLease.generation) {
      lastDisplayedRef.current = { generation: accountLease.generation, value: state.data };
    }
  }, [accountLease.generation, state.data]);
  const retained =
    queryEnabled && lastDisplayedRef.current?.generation === accountLease.generation
      ? lastDisplayedRef.current.value
      : null;
  // A retry/refocus must not flash away the last good rows (or temporarily clear an error gate)
  // while the replacement request is still in flight. The keyed result takes over atomically.
  const displayed = current ?? latest ?? retained;
  const retry = useCallback((): void => setRetryNonce((value) => value + 1), []);

  return {
    data: displayed?.rows ?? null,
    isLoading:
      queryEnabled && !current?.stale && (state.isLoading || (current == null && !state.error)),
    error: displayed?.error ?? null,
    retry,
  };
}
