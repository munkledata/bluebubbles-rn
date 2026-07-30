/**
 * MessageBubble ↔ StickerOverlay WIRING (src/ui/conversations/MessageBubble.tsx).
 *
 * A sticker is an image someone slapped onto one of your messages. It used to render nowhere at
 * all: every chat-thread query filtered `associated_message_type IS NULL`, which correctly hid
 * reactions and silently swallowed stickers — so the sender saw a sticker on your photo and you saw
 * nothing. This suite pins the bubble half of the fix: that the overlay is reached from EVERY kind
 * of target bubble, and that redacted mode suppresses it.
 *
 * Deliberately a SEPARATE file from messageBubble.test.tsx. That suite has pre-existing act
 * pollution (its later tests render empty), and appending here would have made these tests fail for
 * a reason that has nothing to do with them — the exact misleading failure mode AGENTS.md warns
 * about. Real overlay BEHAVIOUR (download, fade, dismiss, a11y) lives in
 * test/components/attachments/stickerOverlay.test.tsx; this file only proves the wiring.
 */
import React from 'react';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { useRedactedModeStore } from '@state/redactedModeStore';
import type { AttachmentRow, MessageRow, StickerRow } from '@db/repositories';

// The real overlay pulls @/services/download -> ky (ESM, untransformed in this project). The marker
// carries the COUNT so the wiring is assertable.
jest.mock('@ui/attachments', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return {
    AttachmentView: () => R.createElement(Text, null, 'ATT'),
    AttachmentGalleryGrid: () => R.createElement(Text, null, 'GRID'),
    StickerOverlay: ({ stickers }: { stickers: unknown[] }) =>
      R.createElement(Text, null, 'STICKER:' + stickers.length),
  };
});

// eslint-disable-next-line import/first
import { MessageBubble } from '@ui/conversations/MessageBubble';

type BubbleMsg = MessageRow & {
  attachments?: AttachmentRow[];
  stickers?: StickerRow[];
};

function makeMsg(over: Partial<BubbleMsg> = {}): BubbleMsg {
  return {
    id: 1,
    guid: 'msg-1',
    chatId: 1,
    handleId: null,
    text: 'hello',
    attributedBody: null,
    subject: null,
    isFromMe: 0,
    dateCreated: 1000,
    dateRead: null,
    dateDelivered: null,
    dateEdited: null,
    dateRetracted: null,
    hasAttachments: 0,
    error: 0,
    sendState: 'sent',
    wasDeliveredQuietly: 0,
    didNotifyRecipient: 0,
    associatedMessageGuid: null,
    associatedMessageType: null,
    associatedMessageEmoji: null,
    threadOriginatorGuid: null,
    expressiveSendStyleId: null,
    senderAddress: null,
    senderName: null,
    senderAvatar: null,
    senderService: null,
    ...over,
  };
}

function mkSticker(over: Partial<StickerRow> = {}): StickerRow {
  return {
    stickerMessageGuid: 'st-1',
    stickerMessageId: 2,
    targetGuid: 'msg-1',
    isFromMe: 0,
    dateCreated: 1000,
    attachment: null,
    ...over,
  };
}

const img = (guid: string): AttachmentRow =>
  ({ guid, mimeType: 'image/jpeg', localPath: `/${guid}.jpg` }) as AttachmentRow;

beforeEach(() => {
  useRedactedModeStore.setState({ enabled: false, hydrated: true });
});

describe('MessageBubble — sticker overlay wiring', () => {
  it('renders the overlay on an ordinary text bubble', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ stickers: [mkSticker()] })} showTail />);
    expect(screen.getByText('STICKER:1')).toBeTruthy();
  });

  it('passes every sticker through', async () => {
    const two = [mkSticker(), mkSticker({ stickerMessageGuid: 'st-2' })];
    await renderWithTheme(<MessageBubble msg={makeMsg({ stickers: two })} showTail />);
    expect(screen.getByText('STICKER:2')).toBeTruthy();
  });

  it('renders no overlay when there are no stickers', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg()} showTail />);
    expect(screen.queryByText(/^STICKER:/)).toBeNull();
  });

  // An attachment-ONLY message must still anchor the overlay, or a sticker placed on a photo shows
  // nothing — the same class of bug as a tapback on an image needing its own anchor.
  it('anchors the overlay on a single-attachment, text-less message', async () => {
    const msg = makeMsg({ text: '', stickers: [mkSticker()], attachments: [img('a1')] });
    await renderWithTheme(<MessageBubble msg={msg} showTail />);
    expect(screen.getByText('STICKER:1')).toBeTruthy();
    expect(screen.getByText('ATT')).toBeTruthy();
  });

  it('anchors the overlay on a multi-image GALLERY message', async () => {
    const msg = makeMsg({
      text: '',
      stickers: [mkSticker()],
      attachments: [img('g1'), img('g2')],
    });
    await renderWithTheme(<MessageBubble msg={msg} showTail />);
    expect(screen.getByText('STICKER:1')).toBeTruthy();
    expect(screen.getByText('GRID')).toBeTruthy();
  });

  // The fallback anchor: nothing else to render, so without it the overlay has no positioned
  // parent and vanishes.
  it('anchors the overlay when the target has no other content at all', async () => {
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ text: '', stickers: [mkSticker()] })} showTail />,
    );
    expect(screen.getByText('STICKER:1')).toBeTruthy();
  });

  it('renders the overlay on a subject-only bubble', async () => {
    const msg = makeMsg({ text: '', subject: 'Subject line', stickers: [mkSticker()] });
    await renderWithTheme(<MessageBubble msg={msg} showTail />);
    expect(screen.getByText('STICKER:1')).toBeTruthy();
  });
});

describe('MessageBubble — stickers under redacted mode', () => {
  // Redacted mode exists so a screenshot is safe; a sticker is arbitrary sender-supplied imagery,
  // so it is suppressed exactly like the attachment placeholder.
  it('renders NO sticker imagery when redacted', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    await renderWithTheme(<MessageBubble msg={makeMsg({ stickers: [mkSticker()] })} showTail />);
    expect(screen.queryByText(/^STICKER:/)).toBeNull();
  });

  it('suppresses the overlay on an attachment message too', async () => {
    useRedactedModeStore.setState({ enabled: true, hydrated: true });
    const msg = makeMsg({ text: '', stickers: [mkSticker()], attachments: [img('a1')] });
    await renderWithTheme(<MessageBubble msg={msg} showTail />);
    expect(screen.queryByText(/^STICKER:/)).toBeNull();
  });
});
