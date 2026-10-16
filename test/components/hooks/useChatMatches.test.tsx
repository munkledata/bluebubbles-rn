/**
 * useChatMatches (src/features/search/useChatMatches.ts) — runs bounded, reactive conversation
 * search after a 200 ms settled-input delay. Locked-in contract:
 *   - empty/short queries are idle and return no rows;
 *   - a chat matches when the term is in its resolved TITLE (via resolveTitle) or participant names;
 *   - with `contentMatches` (default true) it ALSO matches chats whose guid comes back from the
 *     debounced FTS body search (`searchChatGuidsByMessage`, 200ms);
 *   - `contentMatches: false` (the search page's Chats section) NEVER runs the body search, so a
 *     chat appears only on a name/people hit;
 *   - old term/account results are hidden while the current bounded query settles.
 *
 * Repository matching is mocked here; the exact paging/title/order behavior is covered by the DB
 * repository suite.
 */
import { renderHook, act } from '../support/renderWithTheme';
import { useChatMatches } from '@features/search/useChatMatches';
import {
  InboxSearchCancelledError,
  searchChatGuidsByMessage,
  searchChatsForInboxPage,
} from '@db/repositories';
import { runInboxSearchIndexRebuildOnce } from '@/services/search/inboxSearchIndexRebuild';
import {
  captureRealtimeDeliveryLease,
  pauseRealtimeDeliveries,
  resumeRealtimeDeliveries,
  type RealtimeDeliveryLease,
} from '@/services/realtime/deliveryCoordinator';
import { mkInboxRow } from './_fixtures';

jest.mock('@db/repositories', () => ({
  InboxSearchCancelledError: class InboxSearchCancelledError extends Error {},
  searchChatGuidsByMessage: jest.fn(),
  searchChatsForInboxPage: jest.fn(),
}));
jest.mock('@/services/search/inboxSearchIndexRebuild', () => ({
  runInboxSearchIndexRebuildOnce: jest.fn(async () => undefined),
}));

const mockGuidSearch = searchChatGuidsByMessage as jest.MockedFunction<
  typeof searchChatGuidsByMessage
>;
const mockChatSearch = searchChatsForInboxPage as jest.MockedFunction<
  typeof searchChatsForInboxPage
>;
const mockIndexRebuild = runInboxSearchIndexRebuildOnce as jest.MockedFunction<
  typeof runInboxSearchIndexRebuildOnce
>;

const ROWS = [
  mkInboxRow({ id: 1, guid: 'c-1', displayName: 'Weekend Trip', participantNames: 'Bob, Carol' }),
  mkInboxRow({ id: 2, guid: 'c-2', displayName: 'Work', participantNames: 'Dave' }),
  mkInboxRow({ id: 3, guid: 'c-3', displayName: null, participantNames: 'Zelda Fitzgerald' }),
];

async function advance(ms: number): Promise<void> {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  resumeRealtimeDeliveries();
  jest.useFakeTimers();
  mockGuidSearch.mockResolvedValue([]);
  mockIndexRebuild.mockClear();
  mockChatSearch.mockImplementation(async (_db, opts) => {
    const folded = opts.query.normalize('NFC').toLowerCase();
    const messageGuids = new Set(opts.messageMatchGuids ?? []);
    const rows = ROWS.filter(
      (row) =>
        `${row.customName ?? row.displayName ?? ''} ${row.participantNames ?? ''}`
          .normalize('NFC')
          .toLowerCase()
          .includes(folded) || messageGuids.has(row.guid),
    );
    return { rows, hasMore: false };
  });
});

afterEach(() => {
  resumeRealtimeDeliveries();
  jest.useRealTimers();
});

describe('useChatMatches', () => {
  it('keeps an empty query idle without starting either repository search', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), {
      initialProps: { q: '' },
    });

    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(mockGuidSearch).not.toHaveBeenCalled();
    expect(mockChatSearch).not.toHaveBeenCalled();
    expect(mockIndexRebuild).not.toHaveBeenCalled();
  });

  it('matches by resolved title', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), {
      initialProps: { q: 'trip' },
    });
    await advance(200);
    expect(result.current.data?.map((r) => r.id)).toEqual([1]);
    expect(mockIndexRebuild).toHaveBeenCalledTimes(1);
  });

  it('matches by participant name (chat with no display name)', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), {
      initialProps: { q: 'zelda' },
    });
    await advance(200);
    expect(result.current.data?.map((r) => r.id)).toEqual([3]);
  });

  it('also includes a chat whose guid comes back from the debounced content search', async () => {
    // "Work"/"Dave"/"Zelda" contain no "lunch" in title/people, but row 2's body matched in FTS.
    mockGuidSearch.mockResolvedValue(['c-2']);
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), {
      initialProps: { q: 'lunch' },
    });
    // Before the debounce fires there is no content hit yet.
    expect(result.current.data).toEqual([]);
    await advance(200);
    expect(mockGuidSearch).toHaveBeenCalledWith(undefined, 'lunch');
    expect(mockChatSearch).toHaveBeenCalledWith(undefined, {
      query: 'lunch',
      messageMatchGuids: ['c-2'],
      limit: 50,
      archive: 'active',
      shouldContinue: expect.any(Function),
    });
    expect(result.current.data?.map((r) => r.id)).toEqual([2]);
  });

  it('never runs the content search when contentMatches is false', async () => {
    const { result } = await renderHook(
      ({ q }: { q: string }) => useChatMatches(q, { contentMatches: false }),
      {
        initialProps: { q: 'work' },
      },
    );
    await advance(200);
    expect(mockGuidSearch).not.toHaveBeenCalled();
    expect(mockChatSearch).toHaveBeenCalledWith(undefined, {
      query: 'work',
      messageMatchGuids: [],
      limit: 50,
      archive: 'active',
      shouldContinue: expect.any(Function),
    });
    // Still name-matches row 2 ("Work").
    expect(result.current.data?.map((r) => r.id)).toEqual([2]);
  });

  it('searches archived chats too when asked (review M248)', async () => {
    await renderHook(
      ({ q }: { q: string }) => useChatMatches(q, { contentMatches: false, archive: 'all' }),
      { initialProps: { q: 'work' } },
    );
    await advance(200);
    expect(mockChatSearch).toHaveBeenCalledWith(undefined, {
      query: 'work',
      messageMatchGuids: [],
      limit: 50,
      archive: 'all',
      shouldContinue: expect.any(Function),
    });
  });

  it('is case-insensitive on the name filter', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), {
      initialProps: { q: 'WORK' },
    });
    await advance(200);
    expect(result.current.data?.map((r) => r.id)).toEqual([2]);
  });

  it('debounces again when a settled query is cleared and then repeated', async () => {
    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useChatMatches(q, { contentMatches: false }),
      { initialProps: { q: 'work' } },
    );
    await advance(200);
    expect(result.current.data?.map((row) => row.guid)).toEqual(['c-2']);
    expect(mockChatSearch).toHaveBeenCalledTimes(1);

    await act(async () => rerender({ q: '' }));
    await act(async () => rerender({ q: 'work' }));
    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(true);
    expect(mockChatSearch).toHaveBeenCalledTimes(1);

    await advance(100);
    await act(async () => rerender({ q: 'work' }));
    expect(mockChatSearch).toHaveBeenCalledTimes(1);
    await advance(99);
    expect(mockChatSearch).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockChatSearch).toHaveBeenCalledTimes(2);
    expect(result.current.data?.map((row) => row.guid)).toEqual(['c-2']);
  });

  it('cancels an obsolete term scan before publishing the new term', async () => {
    let oldShouldContinue: (() => boolean) | undefined;
    let rejectOld: ((error: Error) => void) | undefined;
    mockChatSearch.mockImplementationOnce(
      (_db, options) =>
        new Promise((_, reject) => {
          oldShouldContinue = options.shouldContinue;
          rejectOld = reject;
        }),
    );
    const { result, rerender } = await renderHook(
      ({ q }: { q: string }) => useChatMatches(q, { contentMatches: false }),
      { initialProps: { q: 'work' } },
    );
    await advance(200);
    expect(oldShouldContinue?.()).toBe(true);

    await act(async () => rerender({ q: 'trip' }));
    expect(oldShouldContinue?.()).toBe(false);
    await act(async () => rejectOld?.(new InboxSearchCancelledError()));
    await advance(200);
    expect(result.current.data?.map((row) => row.guid)).toEqual(['c-1']);
    expect(result.current.error).toBeNull();
  });

  it('swallows a rejected content search and still returns name matches', async () => {
    mockGuidSearch.mockRejectedValue(new Error('fts blew up'));
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), {
      initialProps: { q: 'work' },
    });
    await advance(200);
    // The rejection is swallowed (empty guid set) — the name filter alone still finds row 2.
    expect(result.current.data?.map((r) => r.id)).toEqual([2]);
  });

  it('returns an empty list for a term that matches no name and no body', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), {
      initialProps: { q: 'nonexistent' },
    });
    await advance(200);
    expect(result.current.data).toEqual([]);
  });

  it('treats one astral Unicode character as one code point and does not start body search', async () => {
    const { result } = await renderHook(() => useChatMatches('😀'));

    await advance(500);

    expect(mockGuidSearch).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
  });

  it('hides account A chat matches immediately when its generation retires', async () => {
    const accountLease = captureRealtimeDeliveryLease();
    const { result } = await renderHook(() =>
      useChatMatches('work', { contentMatches: false, accountLease }),
    );
    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(true);
    await advance(200);
    expect(result.current.data?.map((row) => row.guid)).toEqual(['c-2']);

    await act(async () => {
      await pauseRealtimeDeliveries();
    });

    expect(result.current.data).toEqual([]);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not reuse account A body matches when account B repeats the same query in-place', async () => {
    const accountA = captureRealtimeDeliveryLease();
    mockGuidSearch.mockResolvedValueOnce(['c-2']).mockResolvedValueOnce(['c-3']);
    const { result, rerender } = await renderHook(
      ({ lease }: { lease: RealtimeDeliveryLease }) =>
        useChatMatches('lunch', { accountLease: lease }),
      { initialProps: { lease: accountA } },
    );
    await advance(200);
    expect(result.current.data?.map((row) => row.guid)).toEqual(['c-2']);

    await act(async () => {
      await pauseRealtimeDeliveries();
      resumeRealtimeDeliveries();
    });
    const accountB = captureRealtimeDeliveryLease();
    await act(async () => {
      rerender({ lease: accountB });
    });

    expect(result.current.data).toEqual([]);
    await advance(200);
    expect(result.current.data?.map((row) => row.guid)).toEqual(['c-3']);
  });
});
