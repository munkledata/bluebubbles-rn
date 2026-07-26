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

// One object across renders, matching expo-router: `useRouter()` returns the module-level `router`
// singleton, so its identity never changes. A fresh object per render would hide the fact that the
// hook's callback is stable.
const mockRouter = { push: mockPush, replace: mockReplace };

jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
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

  it('keeps ONE stable callback across navigations, and still sees the new path', async () => {
    // `usePathname()` is a useSyncExternalStore subscription, so putting it in the dependency list
    // changed this callback's identity on every route change — which re-ran callers' "once on
    // mount" effects. The worst of those is the connected layout's notification-tap drain: it
    // re-read getInitialNotification(), which on Android keeps echoing the launching intent, and
    // threw the user back into the chat they had just pressed Back out of. The path must still be
    // read at CALL time, or the fix would break the push/replace/none rules instead.
    mockPathname = '/home';
    const { result, rerender } = await renderHook(() => useChatNavigator());
    const first = result.current;

    mockPathname = '/chat/abc'; // navigated into a thread
    await rerender({}); // RNTL 14 / React 19: rerender is async
    expect(result.current).toBe(first);

    // Same function object, but it must now REPLACE (thread → thread), not push.
    result.current('/chat/def');
    expect(mockReplace).toHaveBeenCalledWith('/chat/def');
    expect(mockPush).not.toHaveBeenCalled();
  });
});
