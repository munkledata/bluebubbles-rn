/**
 * Decision matrix for opening a chat deep-link relative to the current route
 * (`src/utils/chatNavigation.ts`, driven by `useChatNavigator`).
 *
 * Two behaviours are locked here:
 *  - never STACK a thread on a thread (replace when already in a chat, push otherwise); and
 *  - never RELOAD the thread already on screen (a plain tap into the open thread is a no-op) —
 *    the reported "clicking a notification reloads the chat I'm already in" bug.
 */
import { resolveChatNavigation } from '@utils';

describe('resolveChatNavigation', () => {
  it('PUSHES from a non-chat screen (inbox / archived / search → thread)', () => {
    expect(resolveChatNavigation('/home', '/chat/abc')).toBe('push');
    expect(resolveChatNavigation('/archived', '/chat/abc')).toBe('push');
    expect(resolveChatNavigation('/', '/chat/abc?focus=m&focusDate=1')).toBe('push');
  });

  it('does NOTHING when the target is the plain thread already open (the reload fix)', () => {
    expect(resolveChatNavigation('/chat/abc', '/chat/abc')).toBe('none');
  });

  it('does nothing even when encoding differs between the current path and the target', () => {
    // usePathname() reports the guid DECODED; chatDeepLink ENCODES it — both must normalize equal.
    expect(resolveChatNavigation('/chat/iMessage;-;+1555', '/chat/iMessage%3B-%3B%2B1555')).toBe(
      'none',
    );
  });

  it('REPLACES when switching to a different thread (so Back still → Messages)', () => {
    expect(resolveChatNavigation('/chat/abc', '/chat/def')).toBe('replace');
  });

  it('REPLACES for a reminder anchor even into the SAME chat (must jump to the old message)', () => {
    expect(resolveChatNavigation('/chat/c1', '/chat/c1?focus=m1&focusDate=5')).toBe('replace');
  });

  it('REPLACES for a Direct Share even into the SAME chat (must re-stage the shared files)', () => {
    expect(resolveChatNavigation('/chat/c1', '/chat/c1?share=1')).toBe('replace');
  });

  it('a plain message tap into the SAME chat is a no-op regardless of focus in the target being absent', () => {
    // A message notification builds a PLAIN /chat/<guid> (no ?focus) — this is the common tap.
    expect(resolveChatNavigation('/chat/iMessage;-;+1', '/chat/iMessage%3B-%3B%2B1')).toBe('none');
  });
});
