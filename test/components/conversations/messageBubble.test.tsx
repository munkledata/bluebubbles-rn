/**
 * MessageBubble (src/ui/conversations/MessageBubble.tsx) — rendered DIRECTLY with props
 * (never through MessageList, per the batch instructions). Behaviors locked in:
 *   - plain text + @mention runs (mentions get the accent color + semibold, from parseAttributedRuns)
 *   - the "Edited" label (and deferEdited suppressing it)
 *   - the unsent-message tombstone
 *   - the from-me send-error state (badge + title + retry callback)
 *   - reply-quote passthrough when a threaded reply preview is present
 *   - bubble send-effect animation is CLEANED UP on unmount (recycling FlashList): under fake
 *     timers, unmount mid-animation and assert no unmounted-update/act warnings + timers drain.
 *
 * Expected values are derived from the source: DEFAULT_PRESET ('oled-dark') → darkTheme tokens,
 * the mention/attachment attribute keys in @core/richtext/parser, errorTitleForCode in
 * @utils/messageStatus, and the effect id map in @core/effects/effectsMapper.
 */
import React from 'react';
import { StyleSheet, View } from 'react-native';
import type { TestInstance } from 'test-renderer';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';
import type {
  AttachmentRow,
  MessageRow,
  MessagePreview,
  ReactionRow,
  StickerRow,
} from '@db/repositories';
import { reactionMeta } from '@core/reactions/reactionType';

// AttachmentView pulls in the download/API services (and transitively `ky`, an ESM module the
// component-project transform doesn't process). Observable probe stubs keep that native graph out
// while positively proving the exact attachment/sticker rows reach their mounted children.
jest.mock('@ui/attachments', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    // Distinguishable markers so the stack-vs-gallery routing is assertable.
    AttachmentView: jest.fn(({ att }: { att: Record<string, unknown> }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, null, 'ATT'),
        React.createElement(
          Text,
          { accessibilityLabel: 'Attachment probe ' + attachmentCanary(att) },
          'ATT-PROBE:' + attachmentCanary(att),
        ),
      ),
    ),
    AttachmentGalleryGrid: jest.fn(({ atts }: { atts: Record<string, unknown>[] }) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, null, 'GRID'),
        React.createElement(
          Text,
          { accessibilityLabel: 'Gallery probe ' + atts.map(attachmentCanary).join('|') },
          'GRID-PROBE:' + atts.map(attachmentCanary).join('|'),
        ),
      ),
    ),
    // A marker carrying the COUNT so wiring is assertable without rendering the real overlay
    // (which pulls @/services/download -> ky, ESM and untransformed in this project).
    StickerOverlay: jest.fn(({ stickers }: { stickers: Array<Record<string, unknown>> }) => {
      const canary = stickers
        .map((sticker) => {
          const attachment = (sticker.attachment ?? {}) as Record<string, unknown>;
          return `${String(sticker.stickerMessageGuid ?? '')}|${attachmentCanary(attachment)}`;
        })
        .join('|');
      return React.createElement(
        React.Fragment,
        null,
        React.createElement(Text, null, 'STICKER:' + stickers.length),
        React.createElement(
          Text,
          { accessibilityLabel: 'Sticker probe ' + canary },
          'STICKER-PROBE:' + canary,
        ),
      );
    }),
  };

  function attachmentCanary(att: Record<string, unknown>): string {
    return [att.guid, att.transferName, att.localPath, att.blurhash]
      .filter((value) => value != null)
      .map(String)
      .join('|');
  }
});

// Keep the URL-preview hook observable without opening the native DB from this rendered component
// suite.
jest.mock('@features/conversations/useUrlPreview', () => ({
  useUrlPreview: jest.fn(() => null),
}));

// eslint-disable-next-line import/first
import { MessageBubble } from '@ui/conversations/MessageBubble';
// eslint-disable-next-line import/first
import { darkTheme, gatorTheme } from '@ui/theme/tokens';
// eslint-disable-next-line import/first
import { contrastRatio, readableTextOn } from '@ui/theme/adaptiveFromImage';
// eslint-disable-next-line import/first
import { useUrlPreview } from '@features/conversations/useUrlPreview';

const attachmentModuleMocks = jest.requireMock('@ui/attachments') as {
  AttachmentView: jest.Mock;
  AttachmentGalleryGrid: jest.Mock;
  StickerOverlay: jest.Mock;
};
const mockUseUrlPreview = useUrlPreview as jest.MockedFunction<typeof useUrlPreview>;

beforeEach(() => {
  attachmentModuleMocks.AttachmentView.mockClear();
  attachmentModuleMocks.AttachmentGalleryGrid.mockClear();
  attachmentModuleMocks.StickerOverlay.mockClear();
  mockUseUrlPreview.mockClear();
});

type BubbleMsg = MessageRow & {
  attachments?: AttachmentRow[];
  reactions?: ReactionRow[];
  stickers?: StickerRow[];
  replyPreview?: MessagePreview | null;
};

function makeMsg(over: Partial<BubbleMsg> = {}): BubbleMsg {
  return {
    id: 1,
    guid: 'msg-1',
    chatId: 1,
    handleId: null,
    text: 'Hello there',
    attributedBody: null,
    subject: null,
    isFromMe: 0,
    dateCreated: 1_000,
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

/** An attributedBody with one confirmed-mention run inside a longer string (leaves gaps the
 *  parser must fill), matching the __kIMMentionConfirmedMention key the parser looks for. */
function mentionBody(full: string, start: number, length: number): string {
  return JSON.stringify([
    {
      string: full,
      runs: [{ range: [start, length], attributes: { __kIMMentionConfirmedMention: 'h-guid' } }],
    },
  ]);
}

const PRIVATE_PLAIN = 'private-plain-body-a19f';
const PRIVATE_ATTRIBUTED_TEXT = 'private-attributed-body-b27e';
const PRIVATE_ATTRIBUTED_LINK = 'https://private-link-b27e.example.com/story';
const PRIVATE_ATTRIBUTED = `${PRIVATE_ATTRIBUTED_TEXT} ${PRIVATE_ATTRIBUTED_LINK}`;
const PRIVATE_SUBJECT = 'private-subject-c35a';
const PRIVATE_TOMBSTONE_SENDER = 'private-tombstone-sender-d48c';
const PRIVATE_REPLY_SENDER = 'private-reply-sender-e51b';
const PRIVATE_REPLY_TEXT = 'private-reply-text-f63d';
const PRIVATE_REPLY_ATTACHMENT = 'private-reply-attachment-g74e';
const PRIVATE_PAYLOAD_TITLE = 'private-payload-title-h86f';
const PRIVATE_PAYLOAD_SUMMARY = 'private-payload-summary-j97a';
const PRIVATE_PAYLOAD_SITE = 'private-payload-site-k08b.example.com';
const PRIVATE_ATTACHMENT_GUID = 'private-attachment-guid-m29d';
const PRIVATE_ATTACHMENT_NAME = 'private-attachment-name-n31e.pdf';
const PRIVATE_ATTACHMENT_URI = 'file:///private-attachment-path-p42f.pdf';
const PRIVATE_ATTACHMENT_BLURHASH = 'private-attachment-blurhash-q53a';
const PRIVATE_GALLERY_GUID_ONE = 'private-gallery-guid-one-r54b';
const PRIVATE_GALLERY_URI_ONE = 'file:///private-gallery-path-one-s65c.jpg';
const PRIVATE_GALLERY_BLURHASH_ONE = 'private-gallery-blurhash-one-t76d';
const PRIVATE_GALLERY_GUID_TWO = 'private-gallery-guid-two-u87e';
const PRIVATE_GALLERY_URI_TWO = 'file:///private-gallery-path-two-v98f.jpg';
const PRIVATE_GALLERY_BLURHASH_TWO = 'private-gallery-blurhash-two-w09a';
const PRIVATE_STICKER_GUID = 'private-sticker-guid-r64b';
const PRIVATE_STICKER_ATTACHMENT_GUID = 'private-sticker-attachment-guid-s75c';
const PRIVATE_STICKER_URI = 'file:///private-sticker-path-t86d.png';
const PRIVATE_STICKER_BLURHASH = 'private-sticker-blurhash-u97e';
const PRIVATE_REACTION_EMOJI = '🧬🦄';
const PRIVATE_BIG_EMOJI = '🫥🩼';

const PRIVATE_PAYLOAD = JSON.stringify({
  urlData: [
    {
      url: 'https://private-payload-v08f.example.com/story',
      originalUrl: 'https://private-payload-v08f.example.com/story',
      title: PRIVATE_PAYLOAD_TITLE,
      summary: PRIVATE_PAYLOAD_SUMMARY,
      siteName: PRIVATE_PAYLOAD_SITE,
    },
  ],
});

const PRIVATE_ATTACHMENT = {
  guid: PRIVATE_ATTACHMENT_GUID,
  mimeType: 'application/pdf',
  transferName: PRIVATE_ATTACHMENT_NAME,
  localPath: PRIVATE_ATTACHMENT_URI,
  blurhash: PRIVATE_ATTACHMENT_BLURHASH,
} as AttachmentRow;

const PRIVATE_GALLERY_ATTACHMENTS = [
  {
    guid: PRIVATE_GALLERY_GUID_ONE,
    mimeType: 'image/jpeg',
    localPath: PRIVATE_GALLERY_URI_ONE,
    blurhash: PRIVATE_GALLERY_BLURHASH_ONE,
  } as AttachmentRow,
  {
    guid: PRIVATE_GALLERY_GUID_TWO,
    mimeType: 'image/png',
    localPath: PRIVATE_GALLERY_URI_TWO,
    blurhash: PRIVATE_GALLERY_BLURHASH_TWO,
  } as AttachmentRow,
];

const PRIVATE_STICKER = {
  stickerMessageGuid: PRIVATE_STICKER_GUID,
  stickerMessageId: 901,
  targetGuid: 'privacy-sticker-target',
  isFromMe: 0,
  dateCreated: 1_000,
  attachment: {
    guid: PRIVATE_STICKER_ATTACHMENT_GUID,
    mimeType: 'image/png',
    localPath: PRIVATE_STICKER_URI,
    blurhash: PRIVATE_STICKER_BLURHASH,
  } as AttachmentRow,
} satisfies StickerRow;

const PRIVATE_REACTION = {
  targetGuid: 'privacy-plain',
  baseType: 'emoji',
  emoji: PRIVATE_REACTION_EMOJI,
  isFromMe: 0,
  senderName: 'private-reaction-sender',
  dateCreated: 1_000,
} satisfies ReactionRow;

const PRIVATE_CANARIES = [
  PRIVATE_PLAIN,
  PRIVATE_ATTRIBUTED_TEXT,
  PRIVATE_ATTRIBUTED_LINK,
  PRIVATE_SUBJECT,
  PRIVATE_TOMBSTONE_SENDER,
  PRIVATE_REPLY_SENDER,
  PRIVATE_REPLY_TEXT,
  PRIVATE_REPLY_ATTACHMENT,
  PRIVATE_PAYLOAD_TITLE,
  PRIVATE_PAYLOAD_SUMMARY,
  PRIVATE_PAYLOAD_SITE,
  PRIVATE_ATTACHMENT_GUID,
  PRIVATE_ATTACHMENT_NAME,
  PRIVATE_ATTACHMENT_URI,
  PRIVATE_ATTACHMENT_BLURHASH,
  PRIVATE_GALLERY_GUID_ONE,
  PRIVATE_GALLERY_URI_ONE,
  PRIVATE_GALLERY_BLURHASH_ONE,
  PRIVATE_GALLERY_GUID_TWO,
  PRIVATE_GALLERY_URI_TWO,
  PRIVATE_GALLERY_BLURHASH_TWO,
  PRIVATE_STICKER_GUID,
  PRIVATE_STICKER_ATTACHMENT_GUID,
  PRIVATE_STICKER_URI,
  PRIVATE_STICKER_BLURHASH,
  PRIVATE_REACTION_EMOJI,
  PRIVATE_BIG_EMOJI,
] as const;

interface PressabilityConfig {
  onLongPress?: (event: object) => void;
}

const mockMeasureInWindow = (View as unknown as { prototype: { measureInWindow: jest.Mock } })
  .prototype.measureInWindow;

function pressableHost(node: TestInstance): TestInstance {
  let current: TestInstance | null = node;
  while (current) {
    const responder = current.props.onStartShouldSetResponder;
    if (typeof responder === 'function') {
      const readConfig = (
        responder as typeof responder & {
          testOnly_pressabilityConfig?: () => PressabilityConfig;
        }
      ).testOnly_pressabilityConfig;
      if (typeof readConfig === 'function') return current;
    }
    current = current.parent;
  }
  throw new Error('Expected a React Native Pressability configuration');
}

function configuredLongPress(node: TestInstance): PressabilityConfig['onLongPress'] {
  const responder = pressableHost(node).props.onStartShouldSetResponder as () => unknown;
  const readConfig = (
    responder as typeof responder & {
      testOnly_pressabilityConfig: () => PressabilityConfig;
    }
  ).testOnly_pressabilityConfig;
  return readConfig().onLongPress;
}

function expectContentCanariesPresent(tree: unknown): void {
  const json = JSON.stringify(tree);
  for (const canary of PRIVATE_CANARIES) expect(json).toContain(canary);
}

function ContentCanaryBubbles({
  onJumpToReply,
  onLongPress,
  onShowReactions,
}: {
  onJumpToReply: jest.Mock;
  onLongPress: jest.Mock;
  onShowReactions: jest.Mock;
}): React.JSX.Element {
  return (
    <>
      <MessageBubble
        msg={makeMsg({
          id: 101,
          guid: 'privacy-plain',
          text: PRIVATE_PLAIN,
          reactions: [PRIVATE_REACTION],
        })}
        showTail
        onLongPress={onLongPress}
        onShowReactions={onShowReactions}
      />
      <MessageBubble
        msg={makeMsg({
          id: 110,
          guid: 'privacy-gallery',
          text: '',
          hasAttachments: 1,
          attachments: PRIVATE_GALLERY_ATTACHMENTS,
        })}
        showTail
      />
      <MessageBubble
        msg={makeMsg({ id: 111, guid: 'privacy-big-emoji', text: PRIVATE_BIG_EMOJI })}
        showTail
      />
      <MessageBubble
        msg={makeMsg({
          id: 102,
          guid: 'privacy-attributed',
          text: '',
          attributedBody: JSON.stringify([{ string: PRIVATE_ATTRIBUTED, runs: [] }]),
        })}
        showTail
      />
      <MessageBubble
        msg={makeMsg({
          id: 103,
          guid: 'privacy-subject',
          text: '',
          subject: PRIVATE_SUBJECT,
        })}
        showTail
      />
      <MessageBubble
        msg={makeMsg({
          id: 104,
          guid: 'privacy-tombstone',
          senderName: PRIVATE_TOMBSTONE_SENDER,
          dateRetracted: 2_000,
        })}
        showTail
      />
      <MessageBubble
        msg={makeMsg({
          id: 105,
          guid: 'privacy-reply-text',
          text: '',
          threadOriginatorGuid: 'privacy-reply-origin-text',
          replyPreview: {
            guid: 'privacy-reply-origin-text',
            text: PRIVATE_REPLY_TEXT,
            senderName: PRIVATE_REPLY_SENDER,
            isFromMe: 0,
            hasAttachments: 0,
          },
        })}
        showTail
        onJumpToReply={onJumpToReply}
      />
      <MessageBubble
        msg={makeMsg({
          id: 106,
          guid: 'privacy-reply-attachment',
          text: '',
          threadOriginatorGuid: 'privacy-reply-origin-attachment',
          replyPreview: {
            guid: 'privacy-reply-origin-attachment',
            text: null,
            senderName: 'private-reply-attachment-sender',
            isFromMe: 0,
            hasAttachments: 1,
            attachmentDescription: PRIVATE_REPLY_ATTACHMENT,
          },
        })}
        showTail
        onJumpToReply={onJumpToReply}
      />
      <MessageBubble
        msg={makeMsg({
          id: 107,
          guid: 'privacy-payload',
          text: '',
          payloadData: PRIVATE_PAYLOAD,
        })}
        showTail
      />
      <MessageBubble
        msg={makeMsg({
          id: 108,
          guid: 'privacy-attachment',
          text: '',
          hasAttachments: 1,
          attachments: [PRIVATE_ATTACHMENT],
        })}
        showTail
      />
      <MessageBubble
        msg={makeMsg({
          id: 109,
          guid: 'privacy-sticker',
          text: '',
          stickers: [PRIVATE_STICKER],
        })}
        showTail
      />
    </>
  );
}

describe('MessageBubble content paths', () => {
  it('renders every content path and forwards its nested actions', async () => {
    const onJumpToReply = jest.fn();
    const onLongPress = jest.fn();
    const onShowReactions = jest.fn();
    const view = await renderWithTheme(
      <ContentCanaryBubbles
        onJumpToReply={onJumpToReply}
        onLongPress={onLongPress}
        onShowReactions={onShowReactions}
      />,
    );

    expectContentCanariesPresent(view.toJSON());
    expect(screen.getByText(`${PRIVATE_TOMBSTONE_SENDER} unsent a message`)).toBeTruthy();
    expect(
      screen.getByLabelText(`Reply to ${PRIVATE_REPLY_SENDER}. Tap to jump to the original.`),
    ).toBeTruthy();
    expect(screen.getByText('ATT')).toBeTruthy();
    expect(screen.getByText('GRID')).toBeTruthy();
    expect(screen.getByText('STICKER:1')).toBeTruthy();
    expect(screen.getByText(PRIVATE_REACTION_EMOJI)).toBeTruthy();
    expect(attachmentModuleMocks.AttachmentView).toHaveBeenCalledTimes(1);
    expect(attachmentModuleMocks.AttachmentGalleryGrid).toHaveBeenCalledTimes(1);
    expect(attachmentModuleMocks.StickerOverlay).toHaveBeenCalledTimes(1);
    expect(mockUseUrlPreview).toHaveBeenCalledWith(PRIVATE_ATTRIBUTED_LINK);
    expect(configuredLongPress(screen.getByText(PRIVATE_PLAIN))).toEqual(expect.any(Function));
    expect(onLongPress).not.toHaveBeenCalled();

    await fireEvent.press(
      screen.getByLabelText(`Reply to ${PRIVATE_REPLY_SENDER}. Tap to jump to the original.`),
    );
    await fireEvent.press(screen.getByLabelText('View who reacted'));
    expect(onJumpToReply).toHaveBeenCalledTimes(1);
    expect(onShowReactions).toHaveBeenCalledTimes(1);
  });
});

describe('MessageBubble accessibility actions', () => {
  beforeEach(() => mockMeasureInWindow.mockReset());

  it('opens the measured message menu for the standard longpress action only', async () => {
    const onLongPress = jest.fn();
    const rect = { x: 11, y: 22, width: 33, height: 44 };
    mockMeasureInWindow.mockImplementationOnce(
      (callback: (x: number, y: number, width: number, height: number) => void) =>
        callback(rect.x, rect.y, rect.width, rect.height),
    );
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ text: 'Hello there' })} showTail onLongPress={onLongPress} />,
    );

    const host = pressableHost(screen.getByText('Hello there'));
    expect(host).toHaveAccessibleName('Hello there');
    expect(host.props.accessibilityActions).toEqual([
      { name: 'longpress', label: 'Show message actions' },
    ]);
    expect(host.props.accessibilityHint).toBe('Double tap and hold for message actions');
    expect(host.props.onAccessibilityAction).toEqual(expect.any(Function));

    await act(async () => {
      fireEvent(host, 'accessibilityAction', { nativeEvent: { actionName: 'activate' } });
    });
    expect(mockMeasureInWindow).not.toHaveBeenCalled();
    expect(onLongPress).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent(host, 'accessibilityAction', { nativeEvent: { actionName: 'longpress' } });
    });
    expect(mockMeasureInWindow).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(onLongPress).toHaveBeenCalledWith(rect);
  });

  it('does not advertise a message action or hint when long-press is unavailable', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ text: 'Hello there' })} showTail />);

    const host = pressableHost(screen.getByText('Hello there'));
    expect(host).toHaveAccessibleName('Hello there');
    expect(host.props.accessibilityActions).toBeUndefined();
    expect(host.props.accessibilityHint).toBeUndefined();
    expect(host.props.onAccessibilityAction).toBeUndefined();
  });
});

describe('MessageBubble text rendering', () => {
  it('renders a plain received text message', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ text: 'Hello there' })} showTail />);
    expect(screen.getByText('Hello there')).toBeTruthy();
  });

  it('uses a readable foreground on the received sender handle color', async () => {
    const background = '#FFFF00';
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ text: 'Colored sender', senderColor: background })} showTail />,
    );

    const text = screen.getByText('Colored sender');
    expect(StyleSheet.flatten(text.parent!.props.style).backgroundColor).toBe(background);
    expect(StyleSheet.flatten(text.props.style).color).toBe(readableTextOn(background));
    expect(
      contrastRatio(StyleSheet.flatten(text.props.style).color, background),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('renders a received @mention in a readable accent color and semibold', async () => {
    // "Hi @Alice!" → runs: "Hi " (gap), "@Alice" (mention), "!" (trailing)
    const body = mentionBody('Hi @Alice!', 3, 6);
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ text: '', attributedBody: body })} showTail />,
    );

    const mention = screen.getByText('@Alice');
    const style = StyleSheet.flatten(mention.props.style);
    expect(style.color).toBe(darkTheme.color.tint);
    expect(
      contrastRatio(style.color, darkTheme.color.bubble.receivedBackgroundBottom),
    ).toBeGreaterThanOrEqual(4.5);
    expect(style.fontWeight).toBe('600');
    // The surrounding plain runs are still present (no text dropped by the gap-filling parser).
    expect(screen.getByText('Hi ', { exact: false })).toBeTruthy();
  });

  it('uses the readable sent-bubble foreground for a sent @mention, not the theme tint', async () => {
    const body = mentionBody('Hi @Alice!', 3, 6);
    await renderWithTheme(
      <MessageBubble
        msg={makeMsg({ text: '', attributedBody: body, isFromMe: 1 })}
        showTail
        chatService="iMessage"
      />,
      { preset: 'gator' },
    );

    const mention = screen.getByText('@Alice');
    const style = StyleSheet.flatten(mention.props.style);
    const background = gatorTheme.color.bubble.senderBackground;
    expect(style.color).toBe(readableTextOn(background));
    expect(style.color).not.toBe(gatorTheme.color.tint);
    expect(contrastRatio(style.color, background)).toBeGreaterThanOrEqual(4.5);
    expect(style.fontWeight).toBe('600');
  });

  it('uses readable text on the actual outgoing SMS background', async () => {
    await renderWithTheme(
      <MessageBubble
        msg={makeMsg({ text: 'Carrier text', isFromMe: 1 })}
        showTail
        chatService="SMS"
      />,
    );

    const text = screen.getByText('Carrier text');
    const style = StyleSheet.flatten(text.props.style);
    const background = darkTheme.color.bubble.smsBackground;
    expect(style.color).toBe(readableTextOn(background));
    expect(contrastRatio(style.color, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('renders EDITED text sourced from attributedBody when the text column is empty', async () => {
    // Edited messages keep their body only in attributedBody; the bubble must still show it.
    const body = JSON.stringify([{ string: 'the edited body', runs: [] }]);
    await renderWithTheme(
      <MessageBubble
        msg={makeMsg({ text: '', attributedBody: body, dateEdited: 5_000 })}
        showTail
      />,
    );
    expect(screen.getByText('the edited body')).toBeTruthy();
  });

  it('renders the Private-API subject line above the body', async () => {
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ subject: 'Important', text: 'read this' })} showTail />,
    );
    expect(screen.getByText('Important')).toBeTruthy();
    expect(screen.getByText('read this')).toBeTruthy();
  });

  it('renders an emoji-only message enlarged (big emoji, no bubble)', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ text: '😀😍' })} showTail />);
    const node = screen.getByText('😀😍');
    const style = StyleSheet.flatten(node.props.style);
    expect(style.fontSize).toBeGreaterThan(darkTheme.font.size.body); // ~3× the body size
  });

  it('collapses an image-only multi-attachment message into the gallery grid', async () => {
    const msg = {
      ...makeMsg({ text: '' }),
      attachments: [
        { guid: 'g1', mimeType: 'image/jpeg' } as AttachmentRow,
        { guid: 'g2', mimeType: 'image/png' } as AttachmentRow,
        { guid: 'g3', mimeType: 'image/heic' } as AttachmentRow,
      ],
    };
    await renderWithTheme(<MessageBubble msg={msg} showTail />);
    expect(screen.getByText('GRID')).toBeTruthy();
    expect(screen.queryByText('ATT')).toBeNull(); // grid replaces the stack
  });

  it('keeps the vertical stack for a mixed image+file message', async () => {
    const msg = {
      ...makeMsg({ text: '' }),
      attachments: [
        { guid: 'g1', mimeType: 'image/jpeg' } as AttachmentRow,
        { guid: 'g2', mimeType: 'application/pdf' } as AttachmentRow,
      ],
    };
    await renderWithTheme(<MessageBubble msg={msg} showTail />);
    expect(screen.queryByText('GRID')).toBeNull();
    expect(screen.getAllByText('ATT')).toHaveLength(2);
  });

  it('renders a tapback on an attachment-only message (anchored to the attachment)', async () => {
    // Regression for "react to a photo shows no badge": the ReactionCluster used to live only in
    // the text-bubble branch. AttachmentView is mocked to null here, but the cluster sibling must
    // still render for a reacted, text-less message that has an attachment.
    const reaction: ReactionRow = {
      targetGuid: 'msg-1',
      baseType: 'love',
      emoji: null,
      isFromMe: 0,
      senderName: 'Bob',
      dateCreated: 1000,
    };
    const msg = {
      ...makeMsg({ text: '', reactions: [reaction] }),
      attachments: [{ guid: 'a1', mimeType: 'image/jpeg', localPath: '/x.jpg' } as AttachmentRow],
    };
    await renderWithTheme(<MessageBubble msg={msg} showTail />);
    expect(screen.getByText(reactionMeta('love').emoji)).toBeTruthy();
  });

  it('renders a tapback on an image-only GALLERY message (anchored to the grid)', async () => {
    // Same regression as above but through the multi-image gallery path — the cluster must
    // anchor to the gallery grid container, not just the single-attachment stack.
    const reaction: ReactionRow = {
      targetGuid: 'msg-1',
      baseType: 'like',
      emoji: null,
      isFromMe: 1,
      senderName: null,
      dateCreated: 1000,
    };
    const msg = {
      ...makeMsg({ text: '', reactions: [reaction] }),
      attachments: [
        { guid: 'g1', mimeType: 'image/jpeg' } as AttachmentRow,
        { guid: 'g2', mimeType: 'image/png' } as AttachmentRow,
      ],
    };
    await renderWithTheme(<MessageBubble msg={msg} showTail />);
    expect(screen.getByText('GRID')).toBeTruthy(); // gallery path taken
    expect(screen.getByText(reactionMeta('like').emoji)).toBeTruthy(); // cluster still renders
  });
});

describe('MessageBubble Genmoji attachment', () => {
  const genmojiMsg = () => ({
    ...makeMsg({ text: '' }),
    attachments: [
      {
        guid: 'gm-1',
        mimeType: 'image/png',
        localPath: '/data/gm.png',
        emojiImageContentIdentifier: 'gm-xyz',
        emojiImageShortDescription: 'a smiling cat wearing a top hat',
      } as AttachmentRow,
    ],
  });

  it('renders a single Genmoji via the attachment view (not the gallery grid), never as bubble text', async () => {
    await renderWithTheme(<MessageBubble msg={genmojiMsg()} showTail />);
    // Delegates to AttachmentView (→ ImageAttachment, which sizes it inline emoji-sized). The
    // description is alt text INSIDE that view — never a bubble Text node here.
    expect(screen.getByText('ATT')).toBeTruthy();
    expect(screen.queryByText('GRID')).toBeNull();
    expect(screen.queryByText('a smiling cat wearing a top hat')).toBeNull();
  });
});

describe('MessageBubble Edited label', () => {
  it('shows "Edited" for an edited (non-retracted) message', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ dateEdited: 5_000 })} showTail />);
    expect(screen.getByText('Edited')).toBeTruthy();
  });

  it('suppresses the inline "Edited" label when deferEdited is set', async () => {
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ dateEdited: 5_000 })} showTail deferEdited />,
    );
    expect(screen.queryByText('Edited')).toBeNull();
  });

  it('does not show "Edited" when the message was also retracted', async () => {
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ dateEdited: 5_000, dateRetracted: 6_000 })} showTail />,
    );
    expect(screen.queryByText('Edited')).toBeNull();
  });
});

describe('MessageBubble tombstone (unsent)', () => {
  it('renders "You unsent a message" for an own retracted message', async () => {
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ isFromMe: 1, dateRetracted: 6_000 })} showTail />,
    );
    expect(screen.getByText('You unsent a message')).toBeTruthy();
    // The tombstone replaces the whole bubble — the original text is gone.
    expect(screen.queryByText('Hello there')).toBeNull();
  });

  it("renders the sender's name in a received retracted tombstone", async () => {
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ senderName: 'Bob', dateRetracted: 6_000 })} showTail />,
    );
    expect(screen.getByText('Bob unsent a message')).toBeTruthy();
  });
});

describe('MessageBubble Scheduled badge (Apple Send Later)', () => {
  it('shows "Scheduled" for a pending scheduled (from-me, not-yet-sent) message', async () => {
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ isFromMe: 1, isScheduled: 1, isSent: 0 })} showTail />,
    );
    expect(screen.getByText('Scheduled')).toBeTruthy();
    // The bubble text still renders alongside the badge (a pending row keeps its typed body).
    expect(screen.getByText('Hello there')).toBeTruthy();
  });

  it('does NOT show "Scheduled" once a scheduled message has SENT (isSent=1)', async () => {
    // The bug fix: the server keeps emitting isScheduled:true after a Send-Later message sends, so
    // the badge MUST gate on isSent — a delivered scheduled message shows no "Scheduled" caption.
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ isFromMe: 1, isScheduled: 1, isSent: 1 })} showTail />,
    );
    expect(screen.queryByText('Scheduled')).toBeNull();
  });

  it('treats a null/undefined isSent (pre-migration row) as not-yet-sent → still badges', async () => {
    // Old rows synced before the is_sent column carry NULL; they must still badge a pending
    // scheduled row (the value self-heals to the real is_sent on the next upsert).
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ isFromMe: 1, isScheduled: 1, isSent: null })} showTail />,
    );
    expect(screen.getByText('Scheduled')).toBeTruthy();
  });

  it('does not show "Scheduled" for an ordinary message', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ isScheduled: 0 })} showTail />);
    expect(screen.queryByText('Scheduled')).toBeNull();
  });

  it('shows the tombstone, not "Scheduled", once a scheduled message is unsent', async () => {
    // The retracted tombstone replaces the whole bubble (the badge lives inside it), so even if the
    // flag lingered a retracted row shows no badge.
    await renderWithTheme(
      <MessageBubble
        msg={makeMsg({ isFromMe: 1, isScheduled: 1, dateRetracted: 6_000 })}
        showTail
      />,
    );
    expect(screen.queryByText('Scheduled')).toBeNull();
    expect(screen.getByText('You unsent a message')).toBeTruthy();
  });
});

describe('MessageBubble send-error state', () => {
  it('renders the error badge + title and fires onRetry when the badge is pressed', async () => {
    const onRetry = jest.fn();
    await renderWithTheme(
      <MessageBubble
        msg={makeMsg({ isFromMe: 1, error: 22, sendState: 'error' })}
        showTail
        onRetry={onRetry}
      />,
    );
    // errorTitleForCode(22) → generic label (22 has no specific client title, and is > 0 so it
    // would be "iMessage Error (Code 22)").
    expect(screen.getByText('iMessage Error (Code 22)')).toBeTruthy();

    const badge = screen.getByText('!');
    fireEvent.press(badge); // press bubbles up to the badge Pressable's onPress
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not show the error UI for a received message even if error != 0', async () => {
    // The error affordance is from-me only (isFromMe && isError).
    await renderWithTheme(<MessageBubble msg={makeMsg({ isFromMe: 0, error: 22 })} showTail />);
    expect(screen.queryByText('!')).toBeNull();
    expect(screen.queryByText('iMessage Error (Code 22)')).toBeNull();
  });
});

describe('MessageBubble reply quote passthrough', () => {
  it('renders the reply quote when a threaded reply preview is present', async () => {
    const replyPreview: MessagePreview = {
      guid: 'orig',
      text: 'the original message',
      senderName: 'Carol',
      isFromMe: 0,
      hasAttachments: 0,
    };
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ threadOriginatorGuid: 'orig', replyPreview })} showTail />,
    );
    expect(screen.getByText('Carol')).toBeTruthy();
    expect(screen.getByText('the original message')).toBeTruthy();
  });
});

describe('MessageBubble bubble-effect cleanup on unmount (FlashList recycling)', () => {
  it('stops the send-effect animation on unmount, draining its timers with no unmounted-update warnings', async () => {
    jest.useFakeTimers();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Baseline: a bubble with NO send-effect. After unmount + drain, the environment leaves a
      // small, stable residual timer count (a RN/jest-expo singleton, NOT a per-render leak — it
      // is identical across renders). The effect case must drain back to exactly this.
      const plain = await renderWithTheme(<MessageBubble msg={makeMsg()} showTail />);
      await plain.unmount();
      await act(() => {
        jest.advanceTimersByTime(5_000);
      });
      const baseline = jest.getTimerCount();

      // 'gentle' = a long (1000–1200ms) timing animation → guaranteed mid-flight at unmount.
      const { unmount } = await renderWithTheme(
        <MessageBubble
          msg={makeMsg({ expressiveSendStyleId: 'com.apple.MobileSMS.expressivesend.gentle' })}
          showTail
        />,
      );
      expect(screen.getByText('Hello there')).toBeTruthy();
      // The effect scheduled animation frames → strictly more pending timers than the baseline.
      const activeCount = jest.getTimerCount();
      expect(activeCount).toBeGreaterThan(baseline);

      // Unmount mid-animation — the BubbleEffectView effect-cleanup must call anim.stop().
      await unmount();

      // Advance well past the animation duration; nothing should re-schedule work.
      await act(() => {
        jest.advanceTimersByTime(5_000);
      });

      // The effect's timers drained: back to the environment baseline, no leftover animation frames.
      expect(jest.getTimerCount()).toBe(baseline);

      // No "state update on an unmounted component" / not-wrapped-in-act warnings from a leaked callback.
      const messages = [...errSpy.mock.calls, ...warnSpy.mock.calls].map((c) => String(c[0] ?? ''));
      expect(messages.some((m) => /unmounted|not wrapped in act/i.test(m))).toBe(false);
    } finally {
      errSpy.mockRestore();
      warnSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
