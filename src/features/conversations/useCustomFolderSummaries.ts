import { useCallback, useState } from 'react';
import type { CustomFolderSummaryRow } from '@db/repositories';
import { useReactiveQuery, type ReactiveState } from '@db/useReactiveQuery';
import { loadCustomFolderSummaries } from '@/services/customFolderCommands';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';

const TABLES = ['custom_folders', 'custom_folder_members', 'messages', 'chats'];

interface CustomFolderSummariesEnvelope {
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
  const requestKey = `${accountLease.generation}|${retryNonce}`;
  const state = useReactiveQuery<CustomFolderSummariesEnvelope>(
    async () => {
      try {
        const result = await loadCustomFolderSummaries(accountLease);
        if (result.status === 'stale') {
          return { key: requestKey, rows: null, stale: true, error: null };
        }
        return { key: requestKey, rows: result.value, stale: false, error: null };
      } catch (cause) {
        return { key: requestKey, rows: null, stale: false, error: toError(cause) };
      }
    },
    TABLES,
    [requestKey],
    { enabled: queryEnabled },
  );

  const current = queryEnabled && state.data?.key === requestKey ? state.data : null;
  const retry = useCallback((): void => setRetryNonce((value) => value + 1), []);

  return {
    data: current?.rows ?? null,
    isLoading:
      queryEnabled && !current?.stale && (state.isLoading || (current == null && !state.error)),
    error: current?.error ?? null,
    retry,
  };
}
