/**
 * Arbitrary-emoji tapbacks (iOS 18 / macOS 15) in the UI:
 *   - ReactionCluster renders the actual glyph for baseType 'emoji' rows, one badge per
 *     DISTINCT glyph (own glyph badges tinted), coexisting with classic-type badges;
 *   - MessageActionsOverlay grows a "+" affordance that reveals an emoji input; submitting
 *     a glyph fires onReact('emoji', glyph) + onClose; letters/digits are rejected (no call);
 *   - an already-applied own glyph renders as a selected chip whose tap fires the removal
 *     onReact('-emoji', glyph).
 *
 * Same in-file safe-area mock as messageActionsOverlay.test.tsx; every state-mutating
 * fireEvent is flushed with await waitFor (RNTL 14 / React 19).
 */
import React from 'react';
import { renderWithTheme, screen, fireEvent, waitFor } from '../support/renderWithTheme';
import { ReactionCluster } from '@ui/conversations/ReactionCluster';
import {
  MessageActionsOverlay,
  type SelectedMessage,
} from '@ui/conversations/MessageActionsOverlay';
import type { ReactionRow } from '@db/repositories';

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

function emojiRow(glyph: string, over: Partial<ReactionRow> = {}): ReactionRow {
  return {
    targetGuid: 'msg-1',
    baseType: 'emoji',
    emoji: glyph,
    isFromMe: 0,
    senderName: 'Alice',
    dateCreated: 1_000,
    ...over,
  };
}

describe('ReactionCluster — emoji glyph badges', () => {
  it('renders the actual glyph for an emoji tapback', async () => {
    await renderWithTheme(<ReactionCluster reactions={[emojiRow('🔥')]} isFromMe={false} />);
    expect(screen.getByText('🔥')).toBeTruthy();
  });

  it('one badge per DISTINCT glyph — same glyph from two senders collapses, different glyphs do not', async () => {
    await renderWithTheme(
      <ReactionCluster
        reactions={[
          emojiRow('🔥', { senderName: 'A' }),
          emojiRow('🔥', { senderName: 'B' }),
          emojiRow('🫡', { senderName: 'A' }),
        ]}
        isFromMe={false}
      />,
    );
    expect(screen.getAllByText('🔥')).toHaveLength(1);
    expect(screen.getAllByText('🫡')).toHaveLength(1);
  });

  it('emoji and classic badges coexist on one bubble', async () => {
    await renderWithTheme(
      <ReactionCluster
        reactions={[
          emojiRow('🔥'),
          {
            targetGuid: 'msg-1',
            baseType: 'love',
            emoji: null,
            isFromMe: 1,
            senderName: null,
            dateCreated: 1,
          },
        ]}
        isFromMe={false}
      />,
    );
    expect(screen.getByText('🔥')).toBeTruthy();
    expect(screen.getByText('❤️')).toBeTruthy(); // reactionMeta('love').emoji
  });
});

function handlers() {
  return {
    onClose: jest.fn(),
    onReact: jest.fn(),
    onReply: jest.fn(),
    onRemindLater: jest.fn(),
    onEdit: jest.fn(),
    onUnsend: jest.fn(),
    onCancelSend: jest.fn(),
    onCopy: jest.fn(),
    onForward: jest.fn(),
    onSave: jest.fn(),
    onShare: jest.fn(),
    onDelete: jest.fn(),
  };
}

function makeSelected(overrides: Partial<SelectedMessage> = {}): SelectedMessage {
  return {
    guid: 'm1',
    text: 'hey there',
    isFromMe: false,
    senderName: 'Alice',
    mine: [],
    myEmojis: [],
    dateCreated: Date.now(),
    isRetracted: false,
    isTemp: false,
    sendState: 'sent',
    attachments: [],
    ...overrides,
  };
}

describe('MessageActionsOverlay — emoji tapback input', () => {
  it('"+" reveals the emoji input; submitting a glyph fires onReact("emoji", glyph) + onClose', async () => {
    const h = handlers();
    await renderWithTheme(<MessageActionsOverlay selected={makeSelected()} {...h} />);

    fireEvent.press(screen.getByLabelText('React with any emoji'));
    const input = await screen.findByLabelText('Emoji reaction input');
    fireEvent.changeText(input, '🔥');
    await waitFor(() =>
      expect(screen.getByLabelText('Emoji reaction input').props.value).toBe('🔥'),
    );
    fireEvent(input, 'submitEditing');
    await waitFor(() => expect(h.onReact).toHaveBeenCalledWith('emoji', '🔥'));
    expect(h.onClose).toHaveBeenCalled();
  });

  it('rejects letters/digits — no send, the input stays open', async () => {
    const h = handlers();
    await renderWithTheme(<MessageActionsOverlay selected={makeSelected()} {...h} />);

    fireEvent.press(screen.getByLabelText('React with any emoji'));
    const input = await screen.findByLabelText('Emoji reaction input');
    fireEvent.changeText(input, 'lol');
    await waitFor(() =>
      expect(screen.getByLabelText('Emoji reaction input').props.value).toBe('lol'),
    );
    fireEvent(input, 'submitEditing');
    await waitFor(() => expect(screen.getByLabelText('Emoji reaction input')).toBeTruthy());
    expect(h.onReact).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it('an already-applied own glyph renders as a selected chip whose tap fires the removal', async () => {
    const h = handlers();
    await renderWithTheme(
      <MessageActionsOverlay selected={makeSelected({ myEmojis: ['🔥'] })} {...h} />,
    );

    const chip = screen.getByLabelText('Remove 🔥 reaction');
    expect(chip.props.accessibilityState).toMatchObject({ selected: true });
    fireEvent.press(chip);
    await waitFor(() => expect(h.onReact).toHaveBeenCalledWith('-emoji', '🔥'));
    expect(h.onClose).toHaveBeenCalled();
  });

  it('classic tapback taps still fire the single-arg contract (no glyph)', async () => {
    const h = handlers();
    await renderWithTheme(<MessageActionsOverlay selected={makeSelected()} {...h} />);
    fireEvent.press(screen.getByLabelText('Heart'));
    await waitFor(() => expect(h.onReact).toHaveBeenCalledWith('love'));
  });
});
