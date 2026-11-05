import React from 'react';
import { act, fireEvent, renderWithTheme, screen } from '../support/renderWithTheme';

const mockPush = jest.fn();
const mockLease = {
  generation: 3,
  current: true,
  isCurrent(): boolean {
    return this.current;
  },
};
let mockRetire: (() => void) | null = null;
let mockSummaries: { data: unknown; error: Error | null; isLoading: boolean } = {
  data: null,
  error: null,
  isLoading: true,
};
const mockEnabled: boolean[] = [];

jest.mock('expo-router', () => {
  const ReactLib = jest.requireActual('react') as typeof import('react');
  return {
    useRouter: () => ({ push: mockPush }),
    // Focused for the life of the component, like a mounted inbox.
    useFocusEffect: (effect: () => void | (() => void)) => ReactLib.useEffect(effect, [effect]),
  };
});
jest.mock('@ui/hooks/useScreenAccountLease', () => ({ useScreenAccountLease: () => mockLease }));
jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  subscribeRealtimeGenerationInvalidation: (_generation: number, listener: () => void) => {
    mockRetire = listener;
    return () => undefined;
  },
}));
jest.mock('@features/conversations/useCustomFolderSummaries', () => ({
  useCustomFolderSummaries: (_lease: unknown, enabled: boolean) => {
    mockEnabled.push(enabled);
    return { ...mockSummaries, retry: jest.fn() };
  },
}));

// eslint-disable-next-line import/first
import { InboxFolderChips } from '@ui/conversations/InboxFolderChips';

const folder = (id: number, name: string, unreadChatCount = 0, showUnreadBadge: 0 | 1 = 1) => ({
  id,
  name,
  sortOrder: id,
  chatCount: 3,
  showUnreadBadge,
  unreadChatCount,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockLease.current = true;
  mockRetire = null;
  mockEnabled.length = 0;
  mockSummaries = {
    data: [folder(1, 'Family', 2), folder(2, 'Work', 5, 0)],
    error: null,
    isLoading: false,
  };
});

describe('InboxFolderChips', () => {
  it('shows a chip per folder, with an unread badge only where the folder wants one', async () => {
    await renderWithTheme(<InboxFolderChips />);
    expect(screen.getByRole('button', { name: 'Family folder, 2 unread' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Work folder' })).toBeTruthy();
    expect(screen.queryByText('5')).toBeNull();
    expect(mockEnabled.at(-1)).toBe(true);

    await fireEvent.press(screen.getByRole('button', { name: 'Work folder' }));
    expect(mockPush).toHaveBeenCalledWith('/folders/2/browse');
  });

  it('shows nothing with no folders, while loading, or on error', async () => {
    mockSummaries = { data: [], error: null, isLoading: false };
    const view = await renderWithTheme(<InboxFolderChips />);
    expect(view.toJSON()).toBeNull();
    mockSummaries = { data: null, error: null, isLoading: true };
    await view.rerender(<InboxFolderChips />);
    expect(view.toJSON()).toBeNull();
    mockSummaries = { data: [folder(1, 'Family')], error: new Error('x'), isLoading: false };
    await view.rerender(<InboxFolderChips />);
    expect(view.toJSON()).toBeNull();
  });

  it('disappears and stops reading once the account is retired', async () => {
    const view = await renderWithTheme(<InboxFolderChips />);
    expect(screen.getByText('Family')).toBeTruthy();
    mockLease.current = false;
    await act(async () => {
      mockRetire?.();
    });
    expect(view.toJSON()).toBeNull();
    expect(mockEnabled.at(-1)).toBe(false);
  });
});
