/**
 * useMessages (src/features/conversations/useMessages.ts) — the live, newest-first chat feed with
 * attachments, reactions, and reply-quote previews attached. Locked-in contract:
 *   - it subscribes to the ['messages','handles','attachments'] tables and passes
 *     [chatGuid, limit, anchorGuid, anchorId, windowGeneration] as the reactive deps;
 *   - an unknown chat guid (getChatIdByGuid → null) yields [] and skips every downstream read;
 *   - enrichment wiring: each row gets its OWN attachments (by message id), reactions (by guid),
 *     and reply preview (by threadOriginatorGuid + exact part) — and only reply targets are fetched,
 *     deduped;
 *   - an exact anchor loads the centered window (listMessagesAround) instead of the recent window
 *     (listMessagesWithSenders), and the current-window proof distinguishes retained old rows.
 *
 * The reactive layer (@db/useReactiveQuery) is mocked with a tiny real hook that RUNS the passed
 * enrichment fn once (and re-runs on dep change) so the wiring is exercised; the repositories are
 * mocked in-file with controlled rows. `getDatabase` is the shared setup stub (its value is only
 * forwarded into the mocked repo fns).
 */
import { act, renderHook, waitFor } from '../support/renderWithTheme';
import { useMessages, type EnrichedMessage } from '@features/conversations/useMessages';
import {
  getChatIdByGuid,
  getMessagePreviewByGuid,
  listAttachmentsByMessageIds,
  listMessagesAround,
  listMessagesWithSenders,
  listReactionsByMessageGuids,
  listStickersForTargets,
  type AttachmentRow,
  type MessageWindowAnchor,
  type MessagePreview,
  type ReactionRow,
} from '@db/repositories';
import { mkMessage } from './_fixtures';

// Captured args from the (mocked) reactive layer — name is `mock*` so the factory may close over
// it. `run` is kept so identity tests can re-invoke the query fn (simulating a reactive flush).
const mockReactiveArgs: {
  tables: string[];
  deps: unknown[];
  run: (() => Promise<unknown>) | null;
} = { tables: [], deps: [], run: null };

jest.mock('@db/useReactiveQuery', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  return {
    __esModule: true,
    useReactiveQuery: (run: () => Promise<unknown>, tables: string[], deps: unknown[]) => {
      mockReactiveArgs.tables = tables;
      mockReactiveArgs.deps = deps;
      mockReactiveArgs.run = run;
      const [state, setState] = React.useState({ data: null, isLoading: true, error: null });
      React.useEffect(() => {
        let cancelled = false;
        run()
          .then((data) => {
            if (!cancelled) setState({ data, isLoading: false, error: null });
          })
          .catch((error: Error) => {
            if (!cancelled) setState({ data: null, isLoading: false, error });
          });
        return () => {
          cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps);
      return state;
    },
  };
});

jest.mock('@db/repositories', () => ({
  getChatIdByGuid: jest.fn(),
  getMessagePreviewByGuid: jest.fn(),
  listAttachmentsByMessageIds: jest.fn(),
  listMessagesAround: jest.fn(),
  listMessagesWithSenders: jest.fn(),
  listReactionsByMessageGuids: jest.fn(),
  listStickersForTargets: jest.fn(),
}));

const mChatId = getChatIdByGuid as jest.MockedFunction<typeof getChatIdByGuid>;
const mPreview = getMessagePreviewByGuid as jest.MockedFunction<typeof getMessagePreviewByGuid>;
const mAtt = listAttachmentsByMessageIds as jest.MockedFunction<typeof listAttachmentsByMessageIds>;
const mAround = listMessagesAround as jest.MockedFunction<typeof listMessagesAround>;
const mRecent = listMessagesWithSenders as jest.MockedFunction<typeof listMessagesWithSenders>;
const mReactions = listReactionsByMessageGuids as jest.MockedFunction<
  typeof listReactionsByMessageGuids
>;
const mStickers = listStickersForTargets as jest.MockedFunction<typeof listStickersForTargets>;

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

function mkAttachment(over: Partial<AttachmentRow> = {}): AttachmentRow {
  return {
    id: 100,
    guid: 'att-100',
    messageId: 1,
    mimeType: 'image/jpeg',
    transferName: 'pic.jpg',
    totalBytes: 1234,
    height: 100,
    width: 100,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
    ...over,
  };
}

function mkReaction(over: Partial<ReactionRow> = {}): ReactionRow {
  return {
    targetGuid: 'msg-2',
    baseType: 'love',
    emoji: null,
    isFromMe: 0,
    senderName: 'Alice',
    dateCreated: 500,
    ...over,
  };
}

function mkPreview(over: Partial<MessagePreview> = {}): MessagePreview {
  return {
    guid: 'orig-1',
    text: 'original',
    senderName: 'Alice',
    isFromMe: 0,
    hasAttachments: 0,
    ...over,
  };
}

beforeEach(() => {
  mChatId.mockResolvedValue(10);
  mRecent.mockResolvedValue([]);
  mAround.mockResolvedValue([]);
  mAtt.mockResolvedValue(new Map());
  mReactions.mockResolvedValue(new Map());
  mStickers.mockResolvedValue(new Map());
  mPreview.mockResolvedValue(null);
});

describe('useMessages', () => {
  it('subscribes to the right tables and passes exact anchor primitives as deps', async () => {
    await renderHook(() => useMessages('iMessage;-;c1', 100, { guid: 'anchor-guid', id: 12345 }));
    expect(mockReactiveArgs.tables).toEqual(['messages', 'handles', 'attachments']);
    expect(mockReactiveArgs.deps).toEqual(['iMessage;-;c1', 100, 'anchor-guid', 12345, 0]);
  });

  it('returns [] and skips downstream reads for an unknown chat guid', async () => {
    mChatId.mockResolvedValue(null);
    const { result } = await renderHook(() => useMessages('nope'));
    await waitFor(() => expect(result.current.data).toEqual([]));
    expect(mRecent).not.toHaveBeenCalled();
    expect(mAtt).not.toHaveBeenCalled();
    expect(mReactions).not.toHaveBeenCalled();
  });

  it('attaches attachments/reactions/reply preview to the correct rows', async () => {
    const m1 = mkMessage({ id: 1, guid: 'msg-1', threadOriginatorGuid: null });
    const m2 = mkMessage({ id: 2, guid: 'msg-2', threadOriginatorGuid: 'orig-1' });
    mRecent.mockResolvedValue([m1, m2]);
    mAtt.mockResolvedValue(new Map([[1, [mkAttachment({ messageId: 1 })]]]));
    mReactions.mockResolvedValue(new Map([['msg-2', [mkReaction({ targetGuid: 'msg-2' })]]]));
    mPreview.mockResolvedValue(mkPreview({ guid: 'orig-1' }));

    const { result } = await renderHook(() => useMessages('iMessage;-;c1'));
    await waitFor(() => expect(result.current.data).toHaveLength(2));

    const [r1, r2] = result.current.data!;
    // Attachments key by message id.
    expect(r1!.attachments.map((a) => a.id)).toEqual([100]);
    expect(r2!.attachments).toEqual([]);
    // Reactions key by message guid.
    expect(r1!.reactions).toEqual([]);
    expect(r2!.reactions).toHaveLength(1);
    // Reply preview only on the row that has a threadOriginatorGuid.
    expect(r1!.replyPreview).toBeNull();
    expect(r2!.replyPreview?.guid).toBe('orig-1');

    // Attachment/reaction reads receive ALL ids/guids (filtering is done in SQL, not here).
    expect(mAtt).toHaveBeenCalledWith(undefined, [1, 2], undefined, {
      excludeRetractedAttachments: true,
    });
    expect(mReactions).toHaveBeenCalledWith(undefined, ['msg-1', 'msg-2']);
    // Only the reply target is fetched.
    expect(mPreview).toHaveBeenCalledTimes(1);
    expect(mPreview).toHaveBeenCalledWith(undefined, 'orig-1', null);
  });

  it('dedupes repeated reply targets into a single preview fetch', async () => {
    const a = mkMessage({ id: 1, guid: 'msg-1', threadOriginatorGuid: 'orig-x' });
    const b = mkMessage({ id: 2, guid: 'msg-2', threadOriginatorGuid: 'orig-x' });
    mRecent.mockResolvedValue([a, b]);
    mPreview.mockResolvedValue(mkPreview({ guid: 'orig-x' }));

    const { result } = await renderHook(() => useMessages('iMessage;-;c1'));
    await waitFor(() => expect(result.current.data).toHaveLength(2));

    expect(mPreview).toHaveBeenCalledTimes(1);
    expect(mPreview).toHaveBeenCalledWith(undefined, 'orig-x', null);
    // Both rows resolve the same preview.
    expect(result.current.data![0]!.replyPreview?.guid).toBe('orig-x');
    expect(result.current.data![1]!.replyPreview?.guid).toBe('orig-x');
  });

  it('loads the centered window (listMessagesAround) when an exact anchor is set', async () => {
    mAround.mockResolvedValue([mkMessage({ id: 9, guid: 'msg-9' })]);
    const anchor = { guid: 'msg-9', id: 9 };
    const { result } = await renderHook(() => useMessages('iMessage;-;c1', 100, anchor));
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(mAround).toHaveBeenCalledWith(undefined, 10, anchor);
    expect(mRecent).not.toHaveBeenCalled();
  });

  it('marks retained anchored rows stale until the newest window actually resolves', async () => {
    const anchored = mkMessage({ id: 9, guid: 'anchored-msg' });
    const newest = mkMessage({ id: 10, guid: 'newest-msg' });
    const newestWindow = deferred<Awaited<ReturnType<typeof listMessagesWithSenders>>>();
    const paginationWindow = deferred<Awaited<ReturnType<typeof listMessagesWithSenders>>>();
    mAround.mockResolvedValue([anchored]);
    mRecent.mockReturnValue(newestWindow.promise);
    const initialAnchor: MessageWindowAnchor = { guid: anchored.guid, id: anchored.id };
    const { result, rerender } = await renderHook(
      ({ anchor, limit }: { anchor?: MessageWindowAnchor; limit: number }) =>
        useMessages('iMessage;-;c1', limit, anchor),
      { initialProps: { anchor: initialAnchor, limit: 100 } },
    );
    await waitFor(() => expect(result.current.data?.[0]?.guid).toBe(anchored.guid));
    expect(result.current.isCurrentWindow).toBe(true);

    await rerender({ anchor: undefined, limit: 100 });

    expect(mRecent).toHaveBeenLastCalledWith(undefined, 10, 100);
    expect(result.current.data?.[0]?.guid).toBe(anchored.guid);
    expect(result.current.isCurrentWindow).toBe(false);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeNull();

    newestWindow.resolve([newest]);
    await waitFor(() => expect(result.current.data?.[0]?.guid).toBe(newest.guid));
    expect(result.current.isCurrentWindow).toBe(true);
    expect(result.current.isLoading).toBe(false);

    // Growing the same newest window is pagination, not a mode change. Retained newest rows remain
    // current and the Composer must not be disabled merely because an older page is being fetched.
    mRecent.mockReturnValue(paginationWindow.promise);
    await rerender({ anchor: undefined, limit: 300 });
    expect(mRecent).toHaveBeenLastCalledWith(undefined, 10, 300);
    expect(result.current.data?.[0]?.guid).toBe(newest.guid);
    expect(result.current.isCurrentWindow).toBe(true);
    expect(result.current.isLoading).toBe(false);
    await act(async () => {
      paginationWindow.resolve([newest]);
      await paginationWindow.promise;
    });
  });

  it('does not reuse an older newest proof after bouncing through a pending anchor', async () => {
    const retainedNewest = mkMessage({ id: 10, guid: 'retained-newest' });
    const refreshedNewest = mkMessage({ id: 11, guid: 'refreshed-newest' });
    const pendingAnchor = mkMessage({ id: 9, guid: 'pending-anchor' });
    const anchorWindow = deferred<Awaited<ReturnType<typeof listMessagesAround>>>();
    const newestWindow = deferred<Awaited<ReturnType<typeof listMessagesWithSenders>>>();
    mRecent.mockResolvedValueOnce([retainedNewest]).mockReturnValue(newestWindow.promise);
    mAround.mockReturnValue(anchorWindow.promise);
    const { result, rerender } = await renderHook(
      ({ anchor }: { anchor?: MessageWindowAnchor }) => useMessages('iMessage;-;c1', 100, anchor),
      { initialProps: { anchor: undefined } },
    );
    await waitFor(() => expect(result.current.data?.[0]?.guid).toBe(retainedNewest.guid));
    expect(result.current.isCurrentWindow).toBe(true);
    const refreshWindow = result.current.refreshWindow;

    await rerender({ anchor: { guid: pendingAnchor.guid, id: pendingAnchor.id } });
    expect(result.current.data?.[0]?.guid).toBe(retainedNewest.guid);
    expect(result.current.isCurrentWindow).toBe(false);

    await act(async () => refreshWindow());
    await rerender({ anchor: undefined });

    expect(result.current.refreshWindow).toBe(refreshWindow);
    expect(result.current.data?.[0]?.guid).toBe(retainedNewest.guid);
    expect(result.current.isCurrentWindow).toBe(false);
    expect(result.current.isLoading).toBe(true);

    await act(async () => {
      anchorWindow.resolve([pendingAnchor]);
      newestWindow.resolve([refreshedNewest]);
      await Promise.all([anchorWindow.promise, newestWindow.promise]);
    });
    await waitFor(() => expect(result.current.data?.[0]?.guid).toBe(refreshedNewest.guid));
    expect(result.current.isCurrentWindow).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('reports a failed requested window without treating it as current', async () => {
    const failure = new Error('message window failed');
    mRecent.mockRejectedValue(failure);

    const { result } = await renderHook(() => useMessages('iMessage;-;c1'));

    await waitFor(() => expect(result.current.error).toBe(failure));
    expect(result.current.data).toBeNull();
    expect(result.current.isCurrentWindow).toBe(false);
    expect(result.current.isLoading).toBe(false);
  });

  it('preserves row identity across re-queries when nothing changed', async () => {
    mRecent.mockResolvedValue([mkMessage({ id: 1, guid: 'msg-1', sendState: 'sending' })]);
    const { result } = await renderHook(() => useMessages('iMessage;-;c1'));
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    const first = result.current.data![0]!;

    // Simulate a reactive flush: re-run the captured query fn. The enrichment map builds a FRESH
    // object per pass; the identity cache must hand back the previous one when nothing changed,
    // or every flush defeats the memoized MessageRow/MessageBubble.
    const second = (await mockReactiveArgs.run!()) as { messages: EnrichedMessage[] };
    expect(second.messages[0]).toBe(first);

    // A mutable column changed (sendState) → a NEW object.
    mRecent.mockResolvedValue([mkMessage({ id: 1, guid: 'msg-1', sendState: 'sent' })]);
    const third = (await mockReactiveArgs.run!()) as { messages: EnrichedMessage[] };
    expect(third.messages[0]).not.toBe(first);
    expect(third.messages[0]!.sendState).toBe('sent');
  });

  it('a reactions change produces a new row object (nested content is fingerprinted)', async () => {
    mRecent.mockResolvedValue([mkMessage({ id: 1, guid: 'msg-1' })]);
    const { result } = await renderHook(() => useMessages('iMessage;-;c1'));
    await waitFor(() => expect(result.current.data).toHaveLength(1));
    const first = result.current.data![0]!;
    expect(first.reactions).toEqual([]);

    mReactions.mockResolvedValue(new Map([['msg-1', [mkReaction({ targetGuid: 'msg-1' })]]]));
    const second = (await mockReactiveArgs.run!()) as { messages: EnrichedMessage[] };
    expect(second.messages[0]).not.toBe(first);
    expect(second.messages[0]!.reactions).toHaveLength(1);
  });

  it('uses the recent window (listMessagesWithSenders) with no anchor', async () => {
    mRecent.mockResolvedValue([mkMessage({ id: 5, guid: 'msg-5' })]);
    const { result } = await renderHook(() => useMessages('iMessage;-;c1', 30));
    await waitFor(() => expect(result.current.data).toHaveLength(1));

    expect(mRecent).toHaveBeenCalledWith(undefined, 10, 30);
    expect(mAround).not.toHaveBeenCalled();
  });
});
