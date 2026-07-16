/**
 * ShareIntentHandler (src/ui/ShareIntentHandler.tsx): captures an Android share-sheet intent,
 * stages it in useShareIntentStore, and routes to the new-chat creator. Locked in:
 *   - shared files are normalized (bare paths get a file:// scheme, uri-form paths pass through,
 *     null sizes become 0) and staged alongside the text;
 *   - a shared web URL wins over plain text;
 *   - staging routes to /new-chat and ALWAYS resets the native intent (even when empty, so a
 *     consumed/blank intent doesn't re-fire);
 *   - no share intent → renders nothing, touches nothing.
 *
 * In-file mocks: `expo-share-intent` (a mutable useShareIntent return the test swaps per case —
 * the native module has no jest half) and `expo-router` (useRouter().push). The share-intent
 * store is the REAL zustand store, reset in beforeEach per AGENTS.md.
 */
import React from 'react';
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

jest.mock('expo-router', () => ({ useRouter: () => ({ push: mockPush }) }));
jest.mock('expo-share-intent', () => ({ useShareIntent: () => mockShare.current }));

// eslint-disable-next-line import/first
import { ShareIntentHandler } from '@ui/ShareIntentHandler';

function setIntent(over: Partial<MockShareState>): jest.Mock {
  const resetShareIntent = jest.fn();
  mockShare.current = { hasShareIntent: true, shareIntent: {}, resetShareIntent, ...over };
  return resetShareIntent;
}

describe('ShareIntentHandler', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockShare.current = { hasShareIntent: false, shareIntent: {}, resetShareIntent: jest.fn() };
    useShareIntentStore.setState({ text: null, files: [] });
  });

  it('does nothing when there is no share intent', async () => {
    const reset = mockShare.current.resetShareIntent;
    await renderWithTheme(<ShareIntentHandler />);
    expect(mockPush).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
    expect(useShareIntentStore.getState().files).toEqual([]);
  });

  it('stages shared files (normalizing bare paths and null sizes) and routes to new-chat', async () => {
    const reset = setIntent({
      shareIntent: {
        files: [
          {
            path: '/data/user/0/doc.pdf',
            fileName: 'doc.pdf',
            mimeType: 'application/pdf',
            size: 123,
          },
          {
            path: 'content://media/photo.jpg',
            fileName: 'photo.jpg',
            mimeType: 'image/jpeg',
            size: null,
          },
        ],
        text: null,
      },
    });
    await renderWithTheme(<ShareIntentHandler />);
    expect(useShareIntentStore.getState().files).toEqual([
      {
        uri: 'file:///data/user/0/doc.pdf',
        name: 'doc.pdf',
        mimeType: 'application/pdf',
        size: 123,
      },
      { uri: 'content://media/photo.jpg', name: 'photo.jpg', mimeType: 'image/jpeg', size: 0 },
    ]);
    expect(useShareIntentStore.getState().text).toBeNull();
    expect(mockPush).toHaveBeenCalledWith('/new-chat');
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('prefers the shared web URL over plain text', async () => {
    setIntent({ shareIntent: { webUrl: 'https://example.com', text: 'ignored' } });
    await renderWithTheme(<ShareIntentHandler />);
    expect(useShareIntentStore.getState().text).toBe('https://example.com');
    expect(mockPush).toHaveBeenCalledWith('/new-chat');
  });

  it('stages plain shared text when there is no web URL', async () => {
    setIntent({ shareIntent: { text: 'hello from another app' } });
    await renderWithTheme(<ShareIntentHandler />);
    expect(useShareIntentStore.getState().text).toBe('hello from another app');
    expect(useShareIntentStore.getState().files).toEqual([]);
    expect(mockPush).toHaveBeenCalledWith('/new-chat');
  });

  it('resets an empty intent without staging or routing', async () => {
    const reset = setIntent({ shareIntent: {} });
    await renderWithTheme(<ShareIntentHandler />);
    expect(mockPush).not.toHaveBeenCalled();
    expect(useShareIntentStore.getState().text).toBeNull();
    expect(reset).toHaveBeenCalledTimes(1);
  });
});
