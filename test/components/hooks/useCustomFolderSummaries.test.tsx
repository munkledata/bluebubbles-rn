import { act, renderHook, waitFor } from '../support/renderWithTheme';
import type { CustomFolderSummaryRow } from '@db/repositories';
import { useCustomFolderSummaries } from '@features/conversations/useCustomFolderSummaries';
import type { RealtimeDeliveryLease } from '@/services/realtime/deliveryCoordinator';
import { loadCustomFolderSummaries } from '@/services/customFolderCommands';

jest.mock('@/services/customFolderCommands', () => ({
  loadCustomFolderSummaries: jest.fn(),
}));

const mockLoadCustomFolderSummaries = jest.mocked(loadCustomFolderSummaries);

const INITIAL_ROWS: CustomFolderSummaryRow[] = [
  {
    id: 1,
    name: 'Family',
    sortOrder: 0,
    chatCount: 2,
    showUnreadBadge: 1,
    unreadChatCount: 1,
  },
];
const REPLACEMENT_ROWS: CustomFolderSummaryRow[] = [
  {
    id: 2,
    name: 'Work',
    sortOrder: 0,
    chatCount: 4,
    showUnreadBadge: 0,
    unreadChatCount: 0,
  },
];

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function lease(generation: number): RealtimeDeliveryLease {
  return { generation, isCurrent: () => true };
}

describe('useCustomFolderSummaries retained state', () => {
  beforeEach(() => {
    mockLoadCustomFolderSummaries.mockReset();
  });

  it('keeps the same-account rows and error until a retry replaces them atomically', async () => {
    const accountLease = lease(7);
    const loadError = new Error('folder refresh failed');
    mockLoadCustomFolderSummaries.mockResolvedValueOnce({
      status: 'committed',
      value: INITIAL_ROWS,
    });

    const { result } = await renderHook(() => useCustomFolderSummaries(accountLease));
    await waitFor(() => expect(result.current.data).toBe(INITIAL_ROWS));

    mockLoadCustomFolderSummaries.mockRejectedValueOnce(loadError);
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(result.current.error).toBe(loadError));
    expect(result.current.data).toBe(INITIAL_ROWS);

    const replacement = deferred<Awaited<ReturnType<typeof loadCustomFolderSummaries>>>();
    mockLoadCustomFolderSummaries.mockReturnValueOnce(replacement.promise);
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(mockLoadCustomFolderSummaries).toHaveBeenCalledTimes(3));

    expect(result.current.data).toBe(INITIAL_ROWS);
    expect(result.current.error).toBe(loadError);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      replacement.resolve({ status: 'committed', value: REPLACEMENT_ROWS });
      await replacement.promise;
    });
    await waitFor(() => expect(result.current.data).toBe(REPLACEMENT_ROWS));
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('does not expose retained rows to a new account generation', async () => {
    const firstLease = lease(10);
    const secondLease = lease(11);
    const secondLoad = deferred<Awaited<ReturnType<typeof loadCustomFolderSummaries>>>();
    mockLoadCustomFolderSummaries
      .mockResolvedValueOnce({ status: 'committed', value: INITIAL_ROWS })
      .mockReturnValueOnce(secondLoad.promise);

    const { result, rerender } = await renderHook(
      ({ accountLease }: { accountLease: RealtimeDeliveryLease }) =>
        useCustomFolderSummaries(accountLease),
      { initialProps: { accountLease: firstLease } },
    );
    await waitFor(() => expect(result.current.data).toBe(INITIAL_ROWS));

    await rerender({ accountLease: secondLease });
    await waitFor(() => expect(mockLoadCustomFolderSummaries).toHaveBeenCalledTimes(2));

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      secondLoad.resolve({ status: 'committed', value: REPLACEMENT_ROWS });
      await secondLoad.promise;
    });
    await waitFor(() => expect(result.current.data).toBe(REPLACEMENT_ROWS));
  });
});
