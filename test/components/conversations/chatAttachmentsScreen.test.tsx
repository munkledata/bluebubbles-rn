import React from 'react';
import { act, fireEvent, renderWithTheme, screen, waitFor } from '../support/renderWithTheme';
import { useDialogStore } from '@ui/dialog/dialogStore';
import type { ChatDocumentRow, ChatLink } from '@db/repositories';

const mockBack = jest.fn();
const mockPush = jest.fn();
const mockOpenChat = jest.fn();
const mockSafeOpenUrl = jest.fn();
const mockShowToast = jest.fn();
const mockLoadMore = jest.fn();
const mockLease = {
  generation: 12,
  current: true,
  isCurrent(): boolean {
    return this.current;
  },
};
const mockInvalidationListeners = new Set<() => void>();

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function row(
  guid: string,
  mimeType: string,
  extra: Partial<ChatDocumentRow> = {},
): ChatDocumentRow {
  return {
    id: 1,
    guid,
    messageGuid: `message-of-${guid}`,
    messageId: 10,
    mimeType,
    transferName: `${guid}.bin`,
    totalBytes: 1024,
    height: null,
    width: null,
    blurhash: null,
    hasLivePhoto: 0,
    isSticker: 0,
    hideAttachment: 0,
    localPath: null,
    service: null,
    dateCreated: 1,
    ...extra,
  };
}

function state<T>(items: T[], hasMore = false) {
  return {
    data: { items, hasMore },
    isLoading: false,
    error: null,
    hasMore,
    loadingMore: false,
    loadMoreError: null,
    loadMore: mockLoadMore,
    retry: jest.fn(),
  };
}

let mockStates: Record<string, ReturnType<typeof state<unknown>>> = {};
const mockRequestedSources: string[] = [];

jest.mock('expo-router', () => ({
  useRouter: () => ({ back: mockBack, push: mockPush }),
}));

jest.mock('@ui/useChatNavigator', () => ({
  useChatNavigator: () => mockOpenChat,
}));

jest.mock('@features/conversations/useChatPagedRows', () => ({
  useChatPagedRows: (source: { id: string }) => {
    mockRequestedSources.push(source.id);
    return mockStates[source.id];
  },
}));

jest.mock('@utils', () => ({
  ...jest.requireActual('@utils'),
  safeOpenUrl: (url: string) => mockSafeOpenUrl(url),
}));

jest.mock('@/services/download', () => ({ download: jest.fn() }));

jest.mock('@/services/openFile', () => ({ openAttachmentFile: jest.fn() }));

jest.mock('@ui/toast/toastStore', () => ({
  showToast: (...args: unknown[]) => mockShowToast(...args),
}));

jest.mock('@/services/download/attachmentCacheCoordinator', () => ({
  attachmentCacheCoordinator: { protect: (path: string) => ({ path, release: jest.fn() }) },
}));

const mockLoadVideoPoster = jest.fn<Promise<string | null>, [string]>();
jest.mock('@/services/download/videoPosters', () => ({
  loadVideoPoster: (guid: string) => mockLoadVideoPoster(guid),
}));

jest.mock('@/services/realtime/deliveryCoordinator', () => ({
  captureRealtimeDeliveryLease: () => mockLease,
  subscribeRealtimeGenerationInvalidation: (_generation: number, listener: () => void) => {
    mockInvalidationListeners.add(listener);
    return () => mockInvalidationListeners.delete(listener);
  },
}));

// eslint-disable-next-line import/first
import {
  ChatAttachmentsScreen,
  parseChatAttachmentsTab,
} from '@ui/conversations/ChatAttachmentsScreen';
// eslint-disable-next-line import/first
import { useSessionStore } from '@state/sessionStore';

const CHAT = 'iMessage;-;+15551234567';
const links: ChatLink[] = [
  { url: 'https://example.com/private', messageGuid: 'link-message', dateCreated: 5 },
];

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadVideoPoster.mockReset().mockResolvedValue(null);
  useSessionStore.setState({ serverInfo: null });
  mockLease.current = true;
  mockInvalidationListeners.clear();
  mockRequestedSources.length = 0;
  useDialogStore.getState().reset();
  mockSafeOpenUrl.mockResolvedValue(true);
  mockStates = {
    photos: state([row('photo-1', 'image/jpeg'), row('photo-2', 'image/png')], true),
    videos: state([row('video-1', 'video/mp4')]),
    files: state([row('report', 'application/pdf')]),
    links: state(links),
  };
});

/** Press the dialog's "Show in Chat" button the way AppDialog would. */
async function chooseShowInChat(): Promise<void> {
  const dialog = useDialogStore.getState().current;
  expect(dialog?.buttons.map((b) => b.text)).toEqual(['Show in Chat', 'Cancel']);
  await act(async () => {
    useDialogStore.getState().dismiss();
    dialog?.buttons[0]?.onPress?.();
  });
}

describe('ChatAttachmentsScreen', () => {
  it('opens a photo in the viewer, pages on scroll, and long-press shows it in the chat', async () => {
    await renderWithTheme(<ChatAttachmentsScreen chatGuid={CHAT} />);

    expect(screen.getByRole('tab', { name: 'Photos' })).toBeSelected();
    await fireEvent.press(screen.getByRole('imagebutton', { name: 'Shared photo 1 of 2' }));
    expect(mockPush).toHaveBeenCalledWith('/media/photo-1');

    await fireEvent(screen.getByTestId('chat-attachments-photos'), 'endReached', {
      distanceFromEnd: 0,
    });
    expect(mockLoadMore).toHaveBeenCalledTimes(1);

    await fireEvent(screen.getByRole('imagebutton', { name: 'Shared photo 2 of 2' }), 'longPress');
    await chooseShowInChat();
    expect(mockOpenChat).toHaveBeenCalledWith(
      `/chat/${encodeURIComponent(CHAT)}?focus=message-of-photo-2`,
    );
  });

  it('asks for video posters in the Videos grid when the server makes them', async () => {
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_video_poster: true } as never,
    });
    await renderWithTheme(<ChatAttachmentsScreen chatGuid={CHAT} initialTab="videos" />);

    await waitFor(() => expect(mockLoadVideoPoster).toHaveBeenCalledWith('video-1'));
    expect(mockLoadVideoPoster).toHaveBeenCalledTimes(1);
  });

  it('never asks for posters in an RCS chat, on Photos, or without server support', async () => {
    useSessionStore.setState({
      serverInfo: { version: 'test', supports_video_poster: true } as never,
    });
    const rcs = await renderWithTheme(
      <ChatAttachmentsScreen chatGuid="RCS;-;chat-attachments-rcs" initialTab="videos" />,
    );
    expect(screen.getByRole('imagebutton', { name: 'Shared video 1 of 1' })).toBeTruthy();
    await rcs.unmount();

    const photos = await renderWithTheme(<ChatAttachmentsScreen chatGuid={CHAT} />);
    expect(screen.getByRole('imagebutton', { name: 'Shared photo 1 of 2' })).toBeTruthy();
    await photos.unmount();

    useSessionStore.setState({ serverInfo: { version: 'test' } as never });
    await renderWithTheme(<ChatAttachmentsScreen chatGuid={CHAT} initialTab="videos" />);
    expect(screen.getByRole('imagebutton', { name: 'Shared video 1 of 1' })).toBeTruthy();

    expect(mockLoadVideoPoster).not.toHaveBeenCalled();
  });

  it('switches tabs, each with its own read', async () => {
    await renderWithTheme(<ChatAttachmentsScreen chatGuid={CHAT} />);

    await fireEvent.press(screen.getByRole('tab', { name: 'Videos' }));
    expect(screen.getByRole('tab', { name: 'Videos' })).toBeSelected();
    expect(screen.getByRole('imagebutton', { name: 'Shared video 1 of 1' })).toBeTruthy();
    expect(screen.queryByRole('imagebutton', { name: /Shared photo/ })).toBeNull();

    await fireEvent.press(screen.getByRole('tab', { name: 'Files' }));
    expect(screen.getByText('report.bin')).toBeTruthy();
    expect(mockRequestedSources).toEqual(expect.arrayContaining(['photos', 'videos', 'files']));
    expect(mockRequestedSources).not.toContain('links');
  });

  it('opens a link through the safe opener and offers Show in Chat on a file', async () => {
    mockSafeOpenUrl.mockResolvedValueOnce(false);
    await renderWithTheme(<ChatAttachmentsScreen chatGuid={CHAT} initialTab="links" />);

    await fireEvent.press(
      screen.getByRole('link', { name: 'Shared link: https://example.com/private' }),
    );
    expect(mockSafeOpenUrl).toHaveBeenCalledWith('https://example.com/private');
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledTimes(1));

    await fireEvent(
      screen.getByRole('link', { name: 'Shared link: https://example.com/private' }),
      'longPress',
    );
    await chooseShowInChat();
    expect(mockOpenChat).toHaveBeenCalledWith(
      `/chat/${encodeURIComponent(CHAT)}?focus=link-message`,
    );

    await fireEvent.press(screen.getByRole('tab', { name: 'Files' }));
    await fireEvent(screen.getByRole('button', { name: 'Download report.bin' }), 'longPress');
    await chooseShowInChat();
    expect(mockOpenChat).toHaveBeenLastCalledWith(
      `/chat/${encodeURIComponent(CHAT)}?focus=message-of-report`,
    );
  });

  it('removes private rows and any open menu when the account retires', async () => {
    const view = await renderWithTheme(
      <ChatAttachmentsScreen chatGuid={CHAT} initialTab="links" />,
    );
    await fireEvent(
      screen.getByRole('link', { name: 'Shared link: https://example.com/private' }),
      'longPress',
    );
    const menu = useDialogStore.getState().current;
    expect(menu).not.toBeNull();

    mockLease.current = false;
    await act(async () => {
      for (const listener of mockInvalidationListeners) listener();
    });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Conversation account changed. Go back and reopen All Attachments.',
    );
    expect(JSON.stringify(view.toJSON())).not.toContain('example.com/private');
    expect(useDialogStore.getState().current).toBeNull();

    // A late press on the stale menu must not navigate.
    await act(async () => menu?.buttons[0]?.onPress?.());
    expect(mockOpenChat).not.toHaveBeenCalled();
  });

  it('parses only known tabs', () => {
    expect(parseChatAttachmentsTab('links')).toBe('links');
    expect(parseChatAttachmentsTab(['files'])).toBe('files');
    expect(parseChatAttachmentsTab('secret')).toBe('photos');
    expect(parseChatAttachmentsTab(undefined)).toBe('photos');
  });
});
