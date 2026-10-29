/**
 * Owner decision: Apple's screening flags join the known/unknown split only while "Filter Unknown
 * Senders" is on. The hook reads that setting and hands it to the inbox SQL; this locks the wiring
 * (the SQL itself is covered by test/db/appleScreening.test.ts).
 */
import { act, renderHook, waitFor } from '../support/renderWithTheme';
import { countChatsForInbox, listChatsForInboxPage } from '@db/repositories';
import { useChats } from '@features/conversations/useChats';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';

jest.mock('@db/database', () => ({ getDatabase: () => ({}) }));
jest.mock('@db/repositories', () => ({
  countChatsForInbox: jest.fn(async () => 0),
  listChatsForInbox: jest.fn(async () => []),
  listChatsForInboxPage: jest.fn(async () => ({ rows: [], hasMore: false })),
}));
jest.mock('@db/useReactiveQuery', () => ({
  // Run the query once per dependency change; the real hook's native subscription is irrelevant.
  useReactiveQuery: (query: () => Promise<unknown>, _tables: unknown, deps: unknown[]) => {
    const { useEffect, useState } = jest.requireActual<typeof import('react')>('react');
    const [data, setData] = useState<unknown>(null);
    useEffect(() => {
      void query().then(setData);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return { data, isLoading: data == null, error: null };
  },
}));

const mockPage = jest.mocked(listChatsForInboxPage);
const mockCount = jest.mocked(countChatsForInbox);

function lastScreening(mock: jest.Mock | typeof mockPage | typeof mockCount): unknown {
  const call = (mock as jest.Mock).mock.calls.at(-1) as [unknown, { appleScreening?: boolean }];
  return call[1].appleScreening;
}

beforeEach(() => {
  mockPage.mockClear();
  mockCount.mockClear();
});

afterAll(() => {
  useFeatureSettingsStore.setState({ filterUnknownSenders: false });
});

const options = {
  pageSize: 50,
  filters: { read: 'any', sender: 'known', kind: 'any', mute: 'any', service: 'any' } as const,
  countUnknown: true,
};

it('leaves Apple screening off while Filter Unknown Senders is off', async () => {
  useFeatureSettingsStore.setState({ filterUnknownSenders: false });
  await renderHook(() => useChats(false, options));
  await waitFor(() => expect(mockPage).toHaveBeenCalled());
  expect(lastScreening(mockPage)).toBe(false);
  expect(lastScreening(mockCount)).toBe(false);
});

it('turns Apple screening on with the setting and re-queries when it flips', async () => {
  useFeatureSettingsStore.setState({ filterUnknownSenders: true });
  await renderHook(() => useChats(false, options));
  await waitFor(() => expect(mockPage).toHaveBeenCalled());
  expect(lastScreening(mockPage)).toBe(true);
  expect(lastScreening(mockCount)).toBe(true);

  mockPage.mockClear();
  await act(async () => {
    useFeatureSettingsStore.setState({ filterUnknownSenders: false });
  });
  await waitFor(() => expect(mockPage).toHaveBeenCalled());
  expect(lastScreening(mockPage)).toBe(false);
});
