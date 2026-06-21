import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { bubbleEffectOf } from '@core/effects';
import { hasMention, parseAttributedRuns, type TextRun } from '@core/richtext';
import type { AttachmentRow, MessagePreview, MessageRow, ReactionRow } from '@db/repositories';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { firstUrl, resolveBubbleColor, safeOpenUrl } from '@utils';
import { useTheme } from '../theme';
import { AttachmentView } from '../attachments';
import { BubbleEffectView } from './effects';
import { ReactionCluster } from './ReactionCluster';
import { ReplyQuote } from './ReplyQuote';
import { UrlPreviewCard } from './UrlPreviewCard';

interface MessageBubbleProps {
  msg: MessageRow & {
    attachments?: AttachmentRow[];
    reactions?: ReactionRow[];
    replyPreview?: MessagePreview | null;
  };
  showTail: boolean;
  /** Per-chat custom accent color for own bubbles (overrides the theme default). */
  accentColor?: string | null;
  onRetry?: () => void;
  onLongPress?: () => void;
  /** Tap the reply quote → jump to the original message. */
  onJumpToReply?: () => void;
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

/** iOS message bubble: reply quote + attachments + text, with reactions + long-press.
 * Memoized (it does heavy work: attachments, reactions, URL preview, run rendering). */
export const MessageBubble = React.memo(function MessageBubble({
  msg,
  showTail,
  accentColor,
  onRetry,
  onLongPress,
  onJumpToReply,
}: MessageBubbleProps): React.JSX.Element {
  const theme = useTheme();
  const redacted = useRedactedModeStore((s) => s.enabled);
  const b = theme.color.bubble;
  const isFromMe = msg.isFromMe === 1;
  const isSms = msg.senderService === 'SMS';
  const isError = msg.sendState === 'error' || msg.error !== 0;
  const isSending = msg.sendState === 'sending';
  const atts = msg.attachments ?? [];
  const reactions = msg.reactions ?? [];
  const hasText = !!msg.text;
  const isRetracted = !!msg.dateRetracted;
  const isEdited = !isRetracted && !!msg.dateEdited;
  // Redacted mode also suppresses the link preview (it would leak the URL/title).
  const previewUrl = !redacted && hasText && !isRetracted ? firstUrl(msg.text) : null;

  // Unsent: replace the whole bubble (incl. reactions/quote/attachments) with a tombstone.
  if (isRetracted) {
    return (
      <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
        <Text style={[styles.tombstone, { color: theme.color.tertiaryLabel }]}>
          {isFromMe ? 'You unsent a message' : `${msg.senderName ?? 'They'} unsent a message`}
        </Text>
      </View>
    );
  }

  const backgroundColor = isFromMe
    ? isSms
      ? b.smsBackground
      : resolveBubbleColor(accentColor, b.senderBackground)
    : b.receivedBackgroundBottom;
  const textColor = isFromMe ? b.senderText : b.receivedText;

  // Tail corner is the bottom corner toward the screen edge, only on last-in-group.
  // The text bubble tails only when there are no attachments below it.
  const textTail = showTail && atts.length === 0 ? theme.radius.tail : theme.radius.bubble;
  const corners = isFromMe
    ? { borderBottomRightRadius: textTail }
    : { borderBottomLeftRadius: textTail };

  const bubble = (
    <Pressable
      onLongPress={onLongPress}
      delayLongPress={350}
      style={{ opacity: isSending ? 0.6 : 1 }}
    >
      {msg.replyPreview && msg.threadOriginatorGuid ? (
        <ReplyQuote preview={msg.replyPreview} isFromMe={isFromMe} onPress={onJumpToReply} />
      ) : null}
      {atts.map((att, i) => (
        <AttachmentView
          key={att.guid}
          att={att}
          isFromMe={isFromMe}
          showTail={showTail && !hasText && i === atts.length - 1}
        />
      ))}
      {hasText ? (
        <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
          <View
            style={[
              styles.bubble,
              { backgroundColor, borderRadius: theme.radius.bubble, ...corners },
            ]}
          >
            <Text style={[styles.text, { color: textColor, fontSize: theme.font.size.body }]}>
              {redacted
                ? 'Message'
                : renderBody(msg.attributedBody, msg.text!, textColor, theme.color.tint)}
            </Text>
          </View>
          {reactions.length > 0 ? (
            <ReactionCluster reactions={reactions} isFromMe={isFromMe} />
          ) : null}
        </View>
      ) : null}
      {isEdited ? (
        <Text
          style={[
            styles.edited,
            { color: theme.color.tertiaryLabel, alignSelf: isFromMe ? 'flex-end' : 'flex-start' },
          ]}
        >
          Edited
        </Text>
      ) : null}
      {previewUrl ? <UrlPreviewCard url={previewUrl} isFromMe={isFromMe} /> : null}
    </Pressable>
  );

  if (isFromMe && isError) {
    return (
      <View style={styles.errorRow}>
        <Pressable
          onPress={onRetry}
          hitSlop={8}
          style={[styles.errorBadge, { borderColor: theme.color.destructive }]}
        >
          <Text style={[styles.errorMark, { color: theme.color.destructive }]}>!</Text>
        </Pressable>
        {bubble}
      </View>
    );
  }

  // iMessage bubble send-effect (slam/loud/gentle/invisible-ink) plays once.
  const bubbleEffect = bubbleEffectOf(msg.expressiveSendStyleId);
  if (bubbleEffect) return <BubbleEffectView effect={bubbleEffect}>{bubble}</BubbleEffectView>;
  return bubble;
});

/**
 * Render the bubble text. When the message carries a confirmed @mention in its
 * attributedBody, render styled runs (mentions in the accent color, links still
 * tappable); otherwise fall back to plain linkify of the text.
 */
function renderBody(
  attributedBody: string | null,
  text: string,
  color: string,
  mentionColor: string,
): React.ReactNode {
  const runs = parseAttributedRuns(attributedBody, text);
  if (!hasMention(runs)) return linkify(text, color);
  return runs.map((run: TextRun, i) => {
    if (run.attachment) return null; // rendered separately as an attachment
    if (run.mention)
      return (
        <Text key={i} style={{ color: mentionColor, fontWeight: '600' }}>
          {run.text}
        </Text>
      );
    return <React.Fragment key={i}>{linkify(run.text, color)}</React.Fragment>;
  });
}

function linkify(text: string, color: string): React.ReactNode {
  const parts = text.split(URL_RE);
  return parts.map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <Text
        key={i}
        style={{ color, textDecorationLine: 'underline' }}
        onPress={() => void safeOpenUrl(part)}
      >
        {part}
      </Text>
    ) : (
      part
    ),
  );
}

const styles = StyleSheet.create({
  anchor: { position: 'relative', marginHorizontal: 10, maxWidth: '78%' },
  bubble: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginVertical: 1,
  },
  text: { lineHeight: 22 },
  tombstone: { fontStyle: 'italic', fontSize: 13, marginHorizontal: 14, marginVertical: 4 },
  edited: { fontSize: 11, marginTop: 2, marginHorizontal: 14 },
  errorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  errorBadge: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorMark: { fontWeight: '800', fontSize: 13 },
});
