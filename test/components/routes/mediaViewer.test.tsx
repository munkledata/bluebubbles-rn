/**
 * MediaViewer route (app/(app)/media/[guid].tsx): the fullscreen photo viewer opened by tapping
 * a picture in a thread.
 *
 * THE BUG THIS LOCKS DOWN: both action pills used to `await` their helper and DISCARD the answer.
 * `saveAttachmentsToPhotos` returns a four-way result (saved | none | denied | error) and
 * `shareAttachment` reports whether the sheet opened at all — and every one of those outcomes,
 * INCLUDING complete success, rendered as absolutely nothing on screen. A save that worked was
 * pixel-identical to a dead button, which is exactly how it was reported.
 *
 * So these tests assert the OUTCOME REPORTING, not the native work: the media helpers are mocked
 * to return each status, and the assertions read the real toast/dialog stores (the same singletons
 * `AppToast`/`AppDialog` render from at the app root).
 *
 * Mock notes: the ZoomableImage subtree is swapped for a plain View (it pulls in expo-image), and
 * `expo-video` is stubbed because the module is imported at file scope even for a photo. The
 * jest.mock factories create their `jest.fn()`s inline — a factory must not dereference an outer
 * `const mock…`, which is still undefined at factory-eval time.
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { useDialogStore } from '@ui/dialog/dialogStore';
import { useToastStore } from '@ui/toast/toastStore';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ guid: 'att-1' }),
  useRouter: () => ({ back: jest.fn(), push: jest.fn(), replace: jest.fn() }),
  usePathname: () => '/media/att-1',
}));

jest.mock('expo-video', () => ({
  useVideoPlayer: () => ({ loop: false, play: jest.fn(), pause: jest.fn() }),
  VideoView: () => null,
}));

// expo-image lives under here; the viewer's behavior under test doesn't need a real image.
jest.mock('@ui/attachments/ZoomableImage', () => {
  const { View } = require('react-native');
  return { ZoomableImage: (p: { uri: string | null }) => <View testID={`img:${p.uri ?? 'none'}`} /> };
});

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 0, left: 0, right: 0 }),
}));

const ATT = {
  id: 1,
  guid: 'att-1',
  messageId: 1,
  mimeType: 'image/jpeg',
  transferName: 'a.jpg',
  totalBytes: 1000,
  height: 100,
  width: 100,
  blurhash: null,
  hasLivePhoto: 0,
  isSticker: 0,
  hideAttachment: 0,
  emojiImageContentIdentifier: null,
  emojiImageShortDescription: null,
  localPath: 'file:///docs/a.jpg',
  service: 'iMessage',
};

jest.mock('@db/repositories', () => ({
  getAttachmentByGuid: jest.fn(),
  listChatImageAttachmentsByAttachmentGuid: jest.fn(),
}));

jest.mock('@/services/media', () => ({
  shareAttachment: jest.fn(),
  saveAttachmentsToPhotos: jest.fn(),
}));

import { getAttachmentByGuid, listChatImageAttachmentsByAttachmentGuid } from '@db/repositories';
import { saveAttachmentsToPhotos, shareAttachment } from '@/services/media';
import MediaViewer from '../../../app/(app)/media/[guid]';

const getAtt = getAttachmentByGuid as jest.Mock;
const listGallery = listChatImageAttachmentsByAttachmentGuid as jest.Mock;
const share = shareAttachment as jest.Mock;
const save = saveAttachmentsToPhotos as jest.Mock;

/** Render the viewer and wait until the photo (hence the enabled pills) is on screen. */
async function renderViewer(): Promise<void> {
  await renderWithTheme(<MediaViewer />);
  await waitFor(() => expect(screen.getByTestId('img:file:///docs/a.jpg')).toBeTruthy());
}

/** The two action pills, in bar order: share (⤴) then save (⤓). */
function pills(): ReturnType<typeof screen.getByText>[] {
  return [screen.getByText('⤴'), screen.getByText('⤓')];
}

beforeEach(() => {
  useToastStore.setState({ current: null, queue: [] });
  useDialogStore.setState({ current: null, queue: [] });
  getAtt.mockResolvedValue(ATT);
  listGallery.mockResolvedValue({ items: [ATT], index: 0 });
});

describe('MediaViewer save button', () => {
  it('confirms a successful save with a toast — it used to show nothing at all', async () => {
    save.mockResolvedValue({ status: 'saved', saved: 1 });
    await renderViewer();

    fireEvent.press(pills()[1]!);

    await waitFor(() => expect(useToastStore.getState().current?.message).toBe('Saved to Photos'));
    expect(save).toHaveBeenCalledWith(['file:///docs/a.jpg']);
  });

  it('explains a refused Photos permission instead of failing silently', async () => {
    save.mockResolvedValue({ status: 'denied' });
    await renderViewer();

    fireEvent.press(pills()[1]!);

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Save'));
    expect(useDialogStore.getState().current?.message).toMatch(/permission/i);
    expect(useToastStore.getState().current).toBeNull();
  });

  it('reports a failed save', async () => {
    save.mockResolvedValue({ status: 'error' });
    await renderViewer();

    fireEvent.press(pills()[1]!);

    await waitFor(() =>
      expect(useToastStore.getState().current?.message).toMatch(/couldn’t save/i),
    );
  });
});

describe('MediaViewer share button', () => {
  it('says nothing when the share sheet opened — the sheet IS the feedback', async () => {
    share.mockResolvedValue({ ok: true });
    await renderViewer();

    fireEvent.press(pills()[0]!);

    await waitFor(() =>
      expect(share).toHaveBeenCalledWith('file:///docs/a.jpg', 'image/jpeg'),
    );
    expect(useDialogStore.getState().current).toBeNull();
    expect(useToastStore.getState().current).toBeNull();
  });

  // The reported symptom: tapping share appeared to do nothing at all. A share sheet that fails to
  // open is a hard failure and must say so — it can no longer masquerade as a successful share.
  it('surfaces a share that never opened, and points at the log', async () => {
    share.mockResolvedValue({ ok: false, reason: 'failed' });
    await renderViewer();

    fireEvent.press(pills()[0]!);

    await waitFor(() => expect(useDialogStore.getState().current?.title).toBe('Share'));
    expect(useDialogStore.getState().current?.message).toMatch(/App Logs/);
  });

  it('distinguishes "sharing unavailable on this device"', async () => {
    share.mockResolvedValue({ ok: false, reason: 'unavailable' });
    await renderViewer();

    fireEvent.press(pills()[0]!);

    await waitFor(() =>
      expect(useDialogStore.getState().current?.message).toMatch(/isn’t available/i),
    );
  });
});

describe('MediaViewer gating', () => {
  // The pills are disabled for an undownloaded photo, so no helper may be called at all. This is
  // the branch that must NOT start reporting outcomes — there is nothing to act on.
  it('does nothing when the photo has no local file', async () => {
    const remote = { ...ATT, localPath: null };
    getAtt.mockResolvedValue(remote);
    listGallery.mockResolvedValue({ items: [remote], index: 0 });
    await renderWithTheme(<MediaViewer />);
    await waitFor(() => expect(screen.getByTestId('img:none')).toBeTruthy());

    fireEvent.press(pills()[0]!);
    fireEvent.press(pills()[1]!);

    expect(share).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(useDialogStore.getState().current).toBeNull();
    expect(useToastStore.getState().current).toBeNull();
  });
});
