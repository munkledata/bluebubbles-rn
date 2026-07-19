/**
 * Regression guard for the "threads stacking" fix (src/ui/useChatNavigator.ts).
 *
 * The app keeps ONE navigation stack with the Messages list at its base. Opening a thread while
 * already reading one used to PUSH a second thread on top, so Back returned to the PREVIOUS thread
 * instead of the inbox. `useChatNavigator` fixes that with one rule: REPLACE when the current route
 * is already a `/chat/…`, PUSH otherwise — so the stack stays [Messages, thread] and Back from any
 * thread lands on Messages. This asserts that decision directly (the two prior test files only ever
 * exercised the push path, since their screens are never on a chat).
 */
// `mock`-prefixed so jest's hoisted factory may reference them (temporal-dead-zone rule).
const mockPush = jest.fn();
const mockReplace = jest.fn();
let mockPathname = '/home';

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => mockPathname,
}));

// eslint-disable-next-line import/first
import { renderHook } from './support/renderWithTheme';
// eslint-disable-next-line import/first
import { useChatNavigator } from '@ui/useChatNavigator';

describe('useChatNavigator — never stacks a thread on a thread', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockReplace.mockClear();
    mockPathname = '/home';
  });

  it('PUSHES when the current screen is NOT a chat (inbox → thread)', async () => {
    mockPathname = '/home';
    const { result } = await renderHook(() => useChatNavigator());
    result.current('/chat/abc');
    expect(mockPush).toHaveBeenCalledWith('/chat/abc');
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('REPLACES when a thread is already open (thread → thread), so Back → Messages', async () => {
    mockPathname = '/chat/abc';
    const { result } = await renderHook(() => useChatNavigator());
    result.current('/chat/def');
    expect(mockReplace).toHaveBeenCalledWith('/chat/def');
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('preserves the full path (focus/share query) on both branches', async () => {
    mockPathname = '/home';
    const fromHome = await renderHook(() => useChatNavigator());
    fromHome.result.current('/chat/g?focus=m&focusDate=123');
    expect(mockPush).toHaveBeenCalledWith('/chat/g?focus=m&focusDate=123');

    mockPathname = '/chat/g';
    const fromChat = await renderHook(() => useChatNavigator());
    fromChat.result.current('/chat/h?share=1');
    expect(mockReplace).toHaveBeenCalledWith('/chat/h?share=1');
  });

  it('treats a non-chat route (Archived) as PUSH, not replace', async () => {
    mockPathname = '/archived';
    const { result } = await renderHook(() => useChatNavigator());
    result.current('/chat/abc');
    expect(mockPush).toHaveBeenCalledWith('/chat/abc');
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
