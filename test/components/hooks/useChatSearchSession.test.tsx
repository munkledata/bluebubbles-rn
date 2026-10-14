/* eslint-disable import/first -- Jest mocks must be registered before importing their consumers. */
const mockUseChatSearch = jest.fn();

jest.mock('@features/conversations/useChatSearch', () => ({
  useChatSearch: (...args: unknown[]) => mockUseChatSearch(...args),
}));

import {
  useChatSearchSession,
  type ChatSearchSessionOptions,
} from '@features/conversations/useChatSearchSession';
import {
  captureRealtimeDeliveryLease,
  resumeRealtimeDeliveries,
} from '@/services/realtime/deliveryCoordinator';
import { act, renderHook } from '../support/renderWithTheme';

beforeEach(() => {
  mockUseChatSearch.mockReturnValue({
    fetchNextPage: jest.fn(),
    hasNextPage: false,
    isPending: false,
    results: [],
    totalCount: 0,
  });
});

afterEach(() => {
  resumeRealtimeDeliveries();
  mockUseChatSearch.mockReset();
});

function options(overrides: Partial<ChatSearchSessionOptions> = {}): ChatSearchSessionOptions {
  return {
    guid: 'iMessage;-;+15550001111',
    accountLease: captureRealtimeDeliveryLease(),
    setJump: jest.fn(),
    exitAnchor: jest.fn(),
    hasMessageAnchor: false,
    isCurrentWindow: true,
    onOpen: jest.fn(),
    ...overrides,
  };
}

async function renderSession(initial: ChatSearchSessionOptions) {
  return renderHook((props: ChatSearchSessionOptions) => useChatSearchSession(props), {
    initialProps: initial,
  });
}

describe('useChatSearchSession', () => {
  it('dismisses other modes when opening, and closing leaves the anchored window', async () => {
    const opts = options();
    const { result } = await renderSession(opts);

    await act(async () => {
      result.current.toggleSearch();
    });
    expect(opts.onOpen).toHaveBeenCalledTimes(1);
    expect(result.current.searchOpen).toBe(true);
    expect(opts.exitAnchor).not.toHaveBeenCalled();

    await act(async () => {
      result.current.toggleSearch();
    });
    expect(result.current.searchOpen).toBe(false);
    expect(opts.exitAnchor).toHaveBeenCalledTimes(1);
    expect(opts.onOpen).toHaveBeenCalledTimes(1);
  });

  it('keeps returningToNewest until the newest window has loaded after closing', async () => {
    const opts = options({ hasMessageAnchor: true, isCurrentWindow: false });
    const { result, rerender } = await renderSession(opts);
    await act(async () => {
      result.current.toggleSearch();
    });

    await act(async () => {
      result.current.closeSearch();
    });
    expect(result.current.returningToNewest).toBe(true);

    // The anchor is gone but the newest window is still loading.
    await act(async () => {
      rerender({ ...opts, hasMessageAnchor: false, isCurrentWindow: false });
    });
    expect(result.current.returningToNewest).toBe(true);

    await act(async () => {
      rerender({ ...opts, hasMessageAnchor: false, isCurrentWindow: true });
    });
    expect(result.current.returningToNewest).toBe(false);
  });
});
