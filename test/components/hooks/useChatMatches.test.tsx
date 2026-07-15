/**
 * useChatMatches (src/features/search/useChatMatches.ts) — filters the loaded inbox rows to those
 * matching a query. Locked-in contract:
 *   - empty query returns ALL rows unchanged (the inbox default);
 *   - a chat matches when the term is in its resolved TITLE (via resolveTitle) or participant names;
 *   - with `contentMatches` (default true) it ALSO matches chats whose guid comes back from the
 *     debounced FTS body search (`searchChatGuidsByMessage`, 200ms);
 *   - `contentMatches: false` (the search page's Chats section) NEVER runs the body search, so a
 *     chat appears only on a name/people hit;
 *   - it passes through `useChats`'s reactive state (isLoading/error) with only `data` replaced.
 *
 * `useChats` and `searchChatGuidsByMessage` are mocked in-file with controlled data; `resolveTitle`
 * (from @utils) runs for real so title-matching semantics are exercised end-to-end.
 */
import { renderHook, act } from '../support/renderWithTheme';
import { useChatMatches } from '@features/search/useChatMatches';
import { useChats } from '@features/conversations/useChats';
import { searchChatGuidsByMessage } from '@db/repositories';
import { mkInboxRow } from './_fixtures';

jest.mock('@features/conversations/useChats', () => ({ useChats: jest.fn() }));
jest.mock('@db/repositories', () => ({ searchChatGuidsByMessage: jest.fn() }));

const mockUseChats = useChats as jest.MockedFunction<typeof useChats>;
const mockGuidSearch = searchChatGuidsByMessage as jest.MockedFunction<
  typeof searchChatGuidsByMessage
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
  jest.useFakeTimers();
  mockUseChats.mockReturnValue({ data: ROWS, isLoading: false, error: null });
  mockGuidSearch.mockResolvedValue([]);
});

afterEach(() => {
  jest.useRealTimers();
});

describe('useChatMatches', () => {
  it('returns all rows for an empty query and passes reactive state through', async () => {
    mockUseChats.mockReturnValue({ data: ROWS, isLoading: true, error: null });
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), { initialProps: { q: '' } });

    expect(result.current.data).toBe(ROWS);
    expect(result.current.isLoading).toBe(true); // passed through untouched
    expect(mockGuidSearch).not.toHaveBeenCalled();
  });

  it('matches by resolved title', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), {
      initialProps: { q: 'trip' },
    });
    await advance(200);
    expect(result.current.data?.map((r) => r.id)).toEqual([1]);
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
    expect(result.current.data?.map((r) => r.id)).toEqual([2]);
  });

  it('never runs the content search when contentMatches is false', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q, { contentMatches: false }), {
      initialProps: { q: 'work' },
    });
    await advance(200);
    expect(mockGuidSearch).not.toHaveBeenCalled();
    // Still name-matches row 2 ("Work").
    expect(result.current.data?.map((r) => r.id)).toEqual([2]);
  });

  it('is case-insensitive on the name filter', async () => {
    const { result } = await renderHook(({ q }: { q: string }) => useChatMatches(q), {
      initialProps: { q: 'WORK' },
    });
    await advance(200);
    expect(result.current.data?.map((r) => r.id)).toEqual([2]);
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
});
