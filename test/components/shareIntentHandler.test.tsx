/**
 * Share-intent capture + navigation (src/ui/ShareIntentHandler.tsx). The handler is split so a
 * share is reliable even when the app was killed/locked at share time:
 *   - ShareIntentCapture (mounted at the ROOT, inside ShareIntentProvider) reads the intent from
 *     context and stashes it into useShareIntentStore — normalizing files (bare paths get a file://
 *     scheme, uri-form paths pass through, null sizes become 0), preferring a shared web URL over
 *     plain text, and ALWAYS resetting the native intent. It does NOT navigate.
 *   - ShareIntentNavigator (mounted in the connected (app) layout) opens /new-chat exactly once
 *     while a share is pending in the store, and re-arms after the store is cleared.
 *
 * In-file mocks: `expo-share-intent`'s `useShareIntentContext` (a mutable return the test swaps per
 * case — the native module has no jest half) and `expo-router` (useRouter().push). The store is the
 * REAL zustand store, reset in beforeEach per AGENTS.md.
 */
import React from 'react';
import { act } from '@testing-library/react-native';
import { renderWithTheme } from './support/renderWithTheme';
import { useShareIntentStore } from '@state/shareIntentStore';

interface MockShareFile {
  path: string;
  fileName: string;
  mimeType: string;
  size: number | null;
}
interface MockShareState {
  hasShareIntent: boolean;
  shareIntent: { files?: MockShareFile[]; text?: string | null; webUrl?: string | null };
  resetShareIntent: jest.Mock;
}

const mockPush = jest.fn();
const mockShare: { current: MockShareState } = {
  current: { hasShareIntent: false, shareIntent: {}, resetShareIntent: jest.fn() },
};
// The Direct Share target the user tapped (guid) or null for a plain share.
const mockShortcutId: { current: string | null } = { current: null };

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-share-intent', () => ({ useShareIntentContext: () => mockShare.current }));
jest.mock('@/services/shortcuts/shareShortcuts', () => ({
  getLaunchShortcutId: () => mockShortcutId.current,
}));

// eslint-disable-next-line import/first
import { ShareIntentCapture, ShareIntentNavigator } from '@ui/ShareIntentHandler';

function setIntent(over: Partial<MockShareState>): jest.Mock {
  const resetShareIntent = jest.fn();
  mockShare.current = { hasShareIntent: true, shareIntent: {}, resetShareIntent, ...over };
  return resetShareIntent;
}

describe('ShareIntentCapture (root capture)', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockShare.current = { hasShareIntent: false, shareIntent: {}, resetShareIntent: jest.fn() };
    useShareIntentStore.setState({ text: null, files: [] });
  });

  it('does nothing when there is no share intent', async () => {
    const reset = mockShare.current.resetShareIntent;
    await renderWithTheme(<ShareIntentCapture />);
    expect(reset).not.toHaveBeenCalled();
    expect(mockPush).not.toHaveBeenCalled();
    expect(useShareIntentStore.getState().files).toEqual([]);
  });

  it('stages shared files (normalizing bare paths and null sizes) WITHOUT navigating', async () => {
    const reset = setIntent({
      shareIntent: {
        files: [
          { path: '/data/user/0/doc.pdf', fileName: 'doc.pdf', mimeType: 'application/pdf', size: 123 },
          { path: 'content://media/photo.jpg', fileName: 'photo.jpg', mimeType: 'image/jpeg', size: null },
        ],
        text: null,
      },
    });
    await renderWithTheme(<ShareIntentCapture />);
    expect(useShareIntentStore.getState().files).toEqual([
      { uri: 'file:///data/user/0/doc.pdf', name: 'doc.pdf', mimeType: 'application/pdf', size: 123 },
      { uri: 'content://media/photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg', size: 0 },
    ]);
    expect(useShareIntentStore.getState().text).toBeNull();
    // Capture stashes only — navigation is the navigator's job.
    expect(mockPush).not.toHaveBeenCalled();
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('prefers the shared web URL over plain text', async () => {
    setIntent({ shareIntent: { webUrl: 'https://example.com', text: 'ignored' } });
    await renderWithTheme(<ShareIntentCapture />);
    expect(useShareIntentStore.getState().text).toBe('https://example.com');
  });

  it('stages plain shared text when there is no web URL', async () => {
    setIntent({ shareIntent: { text: 'hello from another app' } });
    await renderWithTheme(<ShareIntentCapture />);
    expect(useShareIntentStore.getState().text).toBe('hello from another app');
    expect(useShareIntentStore.getState().files).toEqual([]);
  });

  it('resets an empty intent without staging', async () => {
    const reset = setIntent({ shareIntent: {} });
    await renderWithTheme(<ShareIntentCapture />);
    expect(useShareIntentStore.getState().text).toBeNull();
    expect(useShareIntentStore.getState().files).toEqual([]);
    expect(reset).toHaveBeenCalledTimes(1);
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
