/**
 * Share-intent capture + navigation (src/ui/ShareIntentHandler.tsx). The handler is split so a
 * share is reliable even when the app was killed/locked at share time:
 *   - ShareIntentCapture (mounted at the ROOT, inside ShareIntentProvider) subscribes to the RAW
 *     `ExpoShareIntentModule` events and hands each payload to `captureShareIntent`, which copies
 *     the files somewhere readable and stages them. It does NOT navigate.
 *   - ShareIntentNavigator (mounted in the connected (app) layout) opens /new-chat exactly once
 *     while a share is pending in the store, and re-arms after the store is cleared.
 *
 * The capture reads the RAW native module rather than `useShareIntentContext()` because the
 * library's parser drops the `content://` uri (the only readable source for a document) and
 * swallows its own errors — a failed share used to produce no attachment AND no log line. The
 * payload/copy logic itself is covered by the node-project tests (shareIntentPayload,
 * materializeShare, captureShare); this file covers the WIRING.
 *
 * In-file mocks: `expo-share-intent`'s ShareIntentModule (no jest native half), `@/services/share`
 * (its index pulls expo-file-system), `expo-router`, and the shortcuts bridge. The store is the
 * REAL zustand store, reset in beforeEach per AGENTS.md.
 */
import React from 'react';
import { act } from '@testing-library/react-native';
import { renderWithTheme } from './support/renderWithTheme';
import { logger } from '@core/secure';
import { useShareIntentStore } from '@state/shareIntentStore';

type Listener = (event: unknown) => void;

const mockPush = jest.fn();
const mockReplace = jest.fn();
const mockCapture = jest.fn(async (_value: unknown) => {});
// The Direct Share target the user tapped (guid) or null for a plain share.
const mockShortcutId: { current: string | null } = { current: null };

/** A stand-in for the native module; `null` reproduces a pre-rebuild bundle. */
const nativeModule: {
  current: {
    addListener: jest.Mock;
    getShareIntent: jest.Mock;
    listeners: Map<string, Listener>;
    removed: string[];
  } | null;
} = { current: null };

function makeNativeModule() {
  const listeners = new Map<string, Listener>();
  const removed: string[] = [];
  const order: string[] = [];
  const mod = {
    listeners,
    removed,
    order,
    addListener: jest.fn((event: string, cb: Listener) => {
      order.push(`add:${event}`);
      listeners.set(event, cb);
      return {
        remove: () => {
          removed.push(event);
        },
      };
    }),
    getShareIntent: jest.fn(async () => {
      order.push('getShareIntent');
    }),
  };
  return mod;
}

jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  usePathname: () => '/home',
}));
jest.mock('expo-share-intent', () => ({
  get ShareIntentModule() {
    return nativeModule.current;
  },
}));
jest.mock('@/services/share', () => ({ captureShareIntent: (v: unknown) => mockCapture(v) }));
jest.mock('@/services/shortcuts/shareShortcuts', () => ({
  getLaunchShortcutId: () => mockShortcutId.current,
  // useChatNavigator feeds Android's People Service a usage signal on every chat open.
  reportChatOpened: jest.fn(),
}));

// eslint-disable-next-line import/first
import { ShareIntentCapture, ShareIntentNavigator } from '@ui/ShareIntentHandler';

describe('ShareIntentCapture (root capture)', () => {
  let mod: ReturnType<typeof makeNativeModule>;

  beforeEach(() => {
    mockPush.mockClear();
    mockCapture.mockClear();
    mod = makeNativeModule();
    nativeModule.current = mod;
    useShareIntentStore.setState({ text: null, files: [] });
  });

  it('subscribes to BOTH onChange and onError, then drains the cold-start intent', async () => {
    await renderWithTheme(<ShareIntentCapture />);
    expect(mod.addListener).toHaveBeenCalledTimes(2);
    expect([...mod.listeners.keys()].sort()).toEqual(['onChange', 'onError']);
    // The drain must come AFTER subscribing or the event it triggers is missed.
    expect(mod.order).toEqual(['add:onChange', 'add:onError', 'getShareIntent']);
  });

  it('forwards the raw payload value to the capture service', async () => {
    await renderWithTheme(<ShareIntentCapture />);
    const payload = {
      files: [{ contentUri: 'content://x/1', fileName: 'bill.pdf', mimeType: 'application/pdf' }],
    };
    await act(async () => {
      mod.listeners.get('onChange')?.({ value: payload });
    });
    expect(mockCapture).toHaveBeenCalledWith(payload);
  });

  it('does not navigate — capture only stages', async () => {
    await renderWithTheme(<ShareIntentCapture />);
    await act(async () => {
      mod.listeners.get('onChange')?.({ value: { text: 'hi' } });
    });
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('LOGS a native error instead of failing silently', async () => {
    const spy = jest.spyOn(logger, 'error').mockImplementation(() => {});
    await renderWithTheme(<ShareIntentCapture />);
    await act(async () => {
      mod.listeners.get('onError')?.({ value: 'empty uri for file sharing: android.intent.action.SEND' });
    });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('empty uri for file sharing'));
    spy.mockRestore();
  });

  it('removes both listeners on unmount', async () => {
    const view = await renderWithTheme(<ShareIntentCapture />);
    await act(async () => {
      view.unmount();
    });
    expect(mod.removed.sort()).toEqual(['onChange', 'onError']);
  });

  it('mounts cleanly when the native module is absent (pre-rebuild bundle)', async () => {
    nativeModule.current = null;
    await expect(renderWithTheme(<ShareIntentCapture />)).resolves.toBeDefined();
    expect(mockCapture).not.toHaveBeenCalled();
  });
});

describe('ShareIntentNavigator (in-app navigation)', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockShortcutId.current = null;
    useShareIntentStore.setState({ text: null, files: [] });
  });

  it('does not navigate when the store is empty', async () => {
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('opens /new-chat once for a pending shared file (no Direct Share target)', async () => {
    useShareIntentStore.setState({
      text: null,
      files: [{ uri: 'file:///x.jpg', name: 'x.jpg', mimeType: 'image/jpeg', size: 1 }],
    });
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith('/new-chat');
  });

  it('opens the tapped chat (with ?share=1) when the share came from a Direct Share target', async () => {
    mockShortcutId.current = 'iMessage;-;+15551234567';
    useShareIntentStore.setState({
      text: null,
      files: [{ uri: 'file:///x.jpg', name: 'x.jpg', mimeType: 'image/jpeg', size: 1 }],
    });
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    expect(mockPush).toHaveBeenCalledWith(
      `/chat/${encodeURIComponent('iMessage;-;+15551234567')}?share=1`,
    );
  });

  it('opens /new-chat for pending shared text', async () => {
    useShareIntentStore.setState({ text: 'hi', files: [] });
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).toHaveBeenCalledWith('/new-chat');
  });

  it('re-arms after the store is cleared (a second share navigates again)', async () => {
    useShareIntentStore.setState({ text: 'first', files: [] });
    await renderWithTheme(<ShareIntentNavigator />);
    expect(mockPush).toHaveBeenCalledTimes(1);
    // new-chat consumes + clears the store...
    await act(async () => {
      useShareIntentStore.setState({ text: null, files: [] });
    });
    // ...then a second share arrives and must navigate again.
    await act(async () => {
      useShareIntentStore.setState({ text: 'second', files: [] });
    });
    expect(mockPush).toHaveBeenCalledTimes(2);
  });
});
