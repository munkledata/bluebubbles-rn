/**
 * useScheduledMessageCount: binds a conversation-scoped pending count to the
 * scheduled_messages reactive table and never exposes loading/error/stale-chat data.
 */
import { act, renderHook } from '../support/renderWithTheme';
import { getDatabase } from '@db/database';
import { listScheduledByChat, type ScheduledRow } from '@db/repositories';
import { useReactiveQuery } from '@db/useReactiveQuery';
import { useScheduledMessageCount } from '@features/conversations/useScheduledMessageCount';

jest.mock('@db/repositories', () => ({ listScheduledByChat: jest.fn() }));
jest.mock('@db/useReactiveQuery', () => ({ useReactiveQuery: jest.fn() }));

const CHAT_GUID = 'iMessage;-;+15551230000';
const TEST_DATABASE = { testDb: true } as never;
const mockGetDatabase = getDatabase as jest.MockedFunction<typeof getDatabase>;
const mockListScheduledByChat = listScheduledByChat as jest.MockedFunction<
  typeof listScheduledByChat
>;
const mockUseReactiveQuery = useReactiveQuery as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockGetDatabase.mockReturnValue(TEST_DATABASE);
  mockListScheduledByChat.mockResolvedValue([]);
  mockUseReactiveQuery.mockReturnValue({ data: null, isLoading: true, error: null });
});

describe('useScheduledMessageCount', () => {
  it('subscribes to scheduled_messages and counts the pending rows for this chat', async () => {
    const rows = [{ id: 1 }, { id: 2 }] as ScheduledRow[];
    mockListScheduledByChat.mockResolvedValue(rows);

    await renderHook(() => useScheduledMessageCount(CHAT_GUID));

    expect(mockUseReactiveQuery).toHaveBeenCalledTimes(1);
    const [run, tables, deps] = mockUseReactiveQuery.mock.calls[0]!;
    expect(tables).toEqual(['scheduled_messages']);
    expect(deps).toEqual([CHAT_GUID]);
    await expect(run()).resolves.toEqual({ chatGuid: CHAT_GUID, count: 2 });
    expect(mockGetDatabase).toHaveBeenCalledTimes(1);
    expect(mockListScheduledByChat).toHaveBeenCalledWith(TEST_DATABASE, CHAT_GUID);
  });

  it('returns the loaded count owned by the current chat', async () => {
    mockUseReactiveQuery.mockReturnValue({
      data: { chatGuid: CHAT_GUID, count: 4 },
      isLoading: false,
      error: null,
    });

    const { result } = await renderHook(() => useScheduledMessageCount(CHAT_GUID));

    expect(result.current).toBe(4);
  });

  it('uses zero while loading, after an error, or while the retained result belongs to another chat', async () => {
    const { result, rerender } = await renderHook(
      ({ chatGuid }: { chatGuid: string }) => useScheduledMessageCount(chatGuid),
      { initialProps: { chatGuid: CHAT_GUID } },
    );
    expect(result.current).toBe(0);

    mockUseReactiveQuery.mockReturnValue({
      data: null,
      isLoading: false,
      error: new Error('database unavailable'),
    });
    await act(async () => rerender({ chatGuid: CHAT_GUID }));
    expect(result.current).toBe(0);

    mockUseReactiveQuery.mockReturnValue({
      data: { chatGuid: 'iMessage;-;another-chat', count: 7 },
      isLoading: true,
      error: null,
    });
    await act(async () => rerender({ chatGuid: CHAT_GUID }));
    expect(result.current).toBe(0);
  });
});
