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
import { StyleSheet } from 'react-native';
import { renderWithTheme, screen, fireEvent, act } from '../support/renderWithTheme';
import type { AttachmentRow, MessageRow, MessagePreview, ReactionRow } from '@db/repositories';
import { reactionMeta } from '@core/reactions/reactionType';

// AttachmentView pulls in the download/API services (and transitively `ky`, an ESM module the
// component-project transform doesn't process). These tests render text bubbles only — no
// attachments — so stub it to a no-op to keep the module graph off the native/ESM services.
jest.mock('@ui/attachments', () => {
  const React = require('react');
  const { Text } = require('react-native');
  return {
    // Distinguishable markers so the stack-vs-gallery routing is assertable.
    AttachmentView: () => React.createElement(Text, null, 'ATT'),
    AttachmentGalleryGrid: () => React.createElement(Text, null, 'GRID'),
  };
});

// eslint-disable-next-line import/first
import { MessageBubble } from '@ui/conversations/MessageBubble';
// eslint-disable-next-line import/first
import { darkTheme } from '@ui/theme/tokens';

type BubbleMsg = MessageRow & {
  attachments?: never[];
  reactions?: ReactionRow[];
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

describe('MessageBubble text rendering', () => {
  it('renders a plain received text message', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ text: 'Hello there' })} showTail />);
    expect(screen.getByText('Hello there')).toBeTruthy();
  });

  it('renders a confirmed @mention in the accent color and semibold', async () => {
    // "Hi @Alice!" → runs: "Hi " (gap), "@Alice" (mention), "!" (trailing)
    const body = mentionBody('Hi @Alice!', 3, 6);
    await renderWithTheme(
      <MessageBubble msg={makeMsg({ text: '', attributedBody: body })} showTail />,
    );

    const mention = screen.getByText('@Alice');
    const style = StyleSheet.flatten(mention.props.style);
    expect(style.color).toBe(darkTheme.color.tint);
    expect(style.fontWeight).toBe('600');
    // The surrounding plain runs are still present (no text dropped by the gap-filling parser).
    expect(screen.getByText('Hi ', { exact: false })).toBeTruthy();
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
  it('shows "Scheduled" for a pending scheduled (from-me) message', async () => {
    await renderWithTheme(<MessageBubble msg={makeMsg({ isFromMe: 1, isScheduled: 1 })} showTail />);
    expect(screen.getByText('Scheduled')).toBeTruthy();
    // The bubble text still renders alongside the badge (a pending row keeps its typed body).
    expect(screen.getByText('Hello there')).toBeTruthy();
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
      plain.unmount();
      act(() => {
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
      unmount();

      // Advance well past the animation duration; nothing should re-schedule work.
      act(() => {
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
