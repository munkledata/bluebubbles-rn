/**
 * Regression guard for the "threads stacking" + "reloads the open thread" fixes
 * (src/ui/useChatNavigator.ts; decision logic in src/utils/chatNavigation.ts).
 *
 * The app keeps ONE navigation stack with the Messages list at its base. Opening a thread while
 * already reading one used to PUSH a second thread on top, so Back returned to the PREVIOUS thread
 * instead of the inbox. `useChatNavigator` fixes that: REPLACE when the current route is already a
 * `/chat/…`, PUSH otherwise — so the stack stays [Messages, thread] and Back lands on Messages.
 * A SECOND fix rides along: tapping a notification for the thread ALREADY on screen must do
 * NOTHING (a `replace` to the same route remounts the screen — the visible reload). This asserts
 * all three outcomes at the hook boundary (the pure matrix is covered in test/utils).
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

  it('does NOTHING when the target is the thread already on screen (no reload)', async () => {
    // A message notification tapped while already viewing that chat used to `replace` the route,
    // which remounts the screen — spinner, re-scroll, lost draft. Now it's a no-op.
    mockPathname = '/chat/abc';
    const { result } = await renderHook(() => useChatNavigator());
    result.current('/chat/abc');
    expect(mockPush).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });
});
