import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { bubbleEffectOf } from '@core/effects';
import { parseAttributedRuns, type TextRun } from '@core/richtext';
import type { AttachmentRow, MessagePreview, MessageRow, ReactionRow } from '@db/repositories';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { useUrlPreview } from '@features/conversations/useUrlPreview';
import { errorTitleForCode, firstUrl, resolveBubbleColor, safeOpenUrl } from '@utils';
import { useTheme } from '../theme';
import { AttachmentView } from '../attachments';
import { BubbleEffectView } from './effects';
import { ReactionCluster } from './ReactionCluster';
import { overlayPillStyle, overlayTextStyle } from './overlayText';
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
  /**
   * The chat's own outgoing service ('iMessage' | 'SMS' | 'RCS'), derived from the chat guid by
   * the chat screen. From-me rows have no joined handle → `senderService` is null, so this is how
   * an outgoing SMS/RCS bubble picks its green/teal colour. Received rows use their own
   * `senderService` and ignore this. A stable primitive, so it's memo-safe.
   */
  chatService?: 'iMessage' | 'SMS' | 'RCS' | null;
  onRetry?: () => void;
  onLongPress?: () => void;
  /** Tap the reply quote → jump to the original message. */
  onJumpToReply?: () => void;
  /**
   * Don't render the "Edited" label here — the caller will, below the bubble. The group-avatar row
   * aligns the sender avatar to the bubble's bottom, so an inline "Edited" would drag the avatar
   * down to the label's level; MessageRow renders it under the row instead.
   */
  deferEdited?: boolean;
  /** A chat wallpaper is set → the bubble's unbacked texts (inline "Edited", the unsent-message
   *  tombstone) get the frosted-pill treatment so they stay legible over the image. */
  hasBackground?: boolean;
}

const URL_RE = /(https?:\/\/[^\s]+)/g;

/** iOS message bubble: reply quote + attachments + text, with reactions + long-press.
 * Memoized (it does heavy work: attachments, reactions, URL preview, run rendering). */
export const MessageBubble = React.memo(function MessageBubble({
  msg,
  showTail,
  accentColor,
  chatService,
  onRetry,
  onLongPress,
  onJumpToReply,
  deferEdited,
  hasBackground,
}: MessageBubbleProps): React.JSX.Element {
  const theme = useTheme();
  // Frosted-pill treatment for the bubble's unbacked texts over a wallpaper (see MessageRow).
  const overlay = overlayTextStyle(hasBackground, theme.color.tertiaryLabel, theme.color.label);
  const pill = overlayPillStyle(hasBackground, theme.color.background);
  const redacted = useRedactedModeStore((s) => s.enabled);
  const b = theme.color.bubble;
  const isFromMe = msg.isFromMe === 1;
  // Received rows carry the sender's service via the joined handle; from-me rows have no handle,
  // so fall back to the chat's own service (from the guid) — that's what colours an outgoing
  // SMS/RCS bubble correctly instead of the iMessage-blue accent.
  const effectiveService = msg.senderService ?? chatService ?? null;
  const isSms = effectiveService === 'SMS';
  const isRcs = effectiveService === 'RCS';
  const isError = msg.sendState === 'error' || msg.error !== 0;
  const isSending = msg.sendState === 'sending';
  // Skip iMessage's hidden rich-link / plugin-payload attachments (URL previews, App Store,
  // Apple Music, …) — they back a rich card (rendered from the message text below), not a file,
  // so rendering them would show empty "file box" chips.
  const atts = (msg.attachments ?? []).filter((a) => !a.hideAttachment);
  const reactions = msg.reactions ?? [];
  // EDITED messages keep their text in attributedBody (the `text` column goes empty), so derive the
  // body from the parsed runs rather than `msg.text` alone — otherwise an edit renders as a blank
  // bubble. `bodyTextOf` strips the U+FFFC attachment placeholder so an attachment-only message
  // isn't a stray-glyph bubble.
  const runs = parseAttributedRuns(msg.attributedBody, msg.text);
  const bodyText = bodyTextOf(runs);
  const hasText = bodyText.trim().length > 0;
  const isRetracted = !!msg.dateRetracted;
  const isEdited = !isRetracted && !!msg.dateEdited;
  // Redacted mode also suppresses the link preview (it would leak the URL/title).
  const previewUrl = !redacted && hasText && !isRetracted ? firstUrl(bodyText) : null;
  // Own the preview lookup here (not inside the card) so we can also decide whether to draw the
  // raw link text. When the WHOLE message is just a URL and its card loaded, hide the text so we
  // don't show a blue link AND a card (matching iMessage). If the preview failed, keep the link
  // so it's still tappable. Hook is called unconditionally (null url → null) to keep hook order.
  const preview = useUrlPreview(previewUrl);
  const previewLoaded =
    !!preview && preview.error !== 1 && (!!preview.title || !!preview.imageUrl);
  const urlOnly =
    previewUrl != null &&
    bodyText.replace(previewUrl, '').trim().replace(/^[).,!?;:'"]+$/, '') === '';
  // Keep the text bubble if it carries a reaction — the reaction cluster anchors to it.
  const showText = hasText && !(urlOnly && previewLoaded && (msg.reactions?.length ?? 0) === 0);

  // Unsent: replace the whole bubble (incl. reactions/quote/attachments) with a tombstone.
  if (isRetracted) {
    return (
      <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
        <Text style={[styles.tombstone, overlay, pill]}>
          {isFromMe
            ? 'You unsent a message'
            : `${(redacted ? null : msg.senderName) ?? 'They'} unsent a message`}
        </Text>
      </View>
    );
  }

  // RCS gets its own teal (mirrors the SMS-green branch); `?? b.smsBackground` guards a custom
  // theme persisted before the rcsBackground token existed. Both directions now colour: the
  // received side reads the joined handle's service, the sent side reads the chat's service
  // (threaded via `chatService`), so from-me SMS/RCS bubbles are green/teal, not iMessage blue.
  const nonImessageBg = isRcs ? (b.rcsBackground ?? b.smsBackground) : b.smsBackground;
  const backgroundColor = isFromMe
    ? isSms || isRcs
      ? nonImessageBg
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
      {redacted && atts.length > 0 ? (
        // Redacted mode hides attachment content (photos/videos/files) behind a placeholder,
        // matching the inbox/media-gallery masking — else the thread leaks images on screen-share.
        <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
          <View style={[styles.redactedAtt, { backgroundColor: theme.color.secondaryBackground }]}>
            <Text style={{ color: theme.color.tertiaryLabel, fontSize: 13 }}>
              {atts.length > 1 ? `${atts.length} attachments` : 'Attachment'}
            </Text>
          </View>
        </View>
      ) : (
        atts.map((att, i) => (
          <AttachmentView
            key={att.guid}
            att={att}
            isFromMe={isFromMe}
            showTail={showTail && !hasText && i === atts.length - 1}
          />
        ))
      )}
      {showText ? (
        <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
          <View
            style={[
              styles.bubble,
              { backgroundColor, borderRadius: theme.radius.bubble, ...corners },
            ]}
          >
            <Text style={[styles.text, { color: textColor, fontSize: theme.font.size.body }]}>
              {redacted ? 'Message' : renderRuns(runs, textColor, theme.color.tint)}
            </Text>
          </View>
          {reactions.length > 0 ? (
            <ReactionCluster reactions={reactions} isFromMe={isFromMe} />
          ) : null}
        </View>
      ) : null}
      {isEdited && !deferEdited ? (
        <Text
          style={[
            styles.edited,
            overlay,
            { alignSelf: isFromMe ? 'flex-end' : 'flex-start' },
            pill,
          ]}
        >
          Edited
        </Text>
      ) : null}
      {previewUrl ? (
        <UrlPreviewCard url={previewUrl} preview={preview} isFromMe={isFromMe} />
      ) : null}
    </Pressable>
  );

  if (isFromMe && isError) {
    return (
      <View>
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
        <Text style={[styles.errorTitle, { color: theme.color.destructive }]}>
          {errorTitleForCode(msg.error)}
        </Text>
      </View>
    );
  }

  // iMessage bubble send-effect (slam/loud/gentle/invisible-ink) plays once.
  const bubbleEffect = bubbleEffectOf(msg.expressiveSendStyleId);
  if (bubbleEffect) return <BubbleEffectView effect={bubbleEffect}>{bubble}</BubbleEffectView>;
  return bubble;
});

const OBJECT_REPLACEMENT = /￼/g;

/** Plain body text from the parsed runs (attachments excluded, U+FFFC placeholder stripped). */
function bodyTextOf(runs: TextRun[]): string {
  return runs
    .filter((r) => !r.attachment)
    .map((r) => r.text.replace(OBJECT_REPLACEMENT, ''))
    .join('');
}

/**
 * Render the bubble text from the parsed attributedBody runs: mentions in the accent color,
 * links tappable, everything else plain. Rendering from the runs (not `msg.text`) is what makes
 * EDITED messages show — their edited text lives in attributedBody while the `text` column is empty.
 */
function renderRuns(runs: TextRun[], color: string, mentionColor: string): React.ReactNode {
  return runs.map((run: TextRun, i) => {
    if (run.attachment) return null; // rendered separately as an attachment
    const text = run.text.replace(OBJECT_REPLACEMENT, '');
    if (!text) return null;
    if (run.mention)
      return (
        <Text key={i} style={{ color: mentionColor, fontWeight: '600' }}>
          {text}
        </Text>
      );
    return <React.Fragment key={i}>{linkify(text, color)}</React.Fragment>;
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
  redactedAtt: {
    width: 160,
    height: 120,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: 1,
  },
  bubble: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginVertical: 1,
  },
  text: { lineHeight: 22 },
  tombstone: { fontStyle: 'italic', fontSize: 13, marginHorizontal: 14, marginVertical: 4 },
  edited: { fontSize: 11, marginTop: 2, marginHorizontal: 14 },
  errorRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end' },
  errorTitle: { fontSize: 11, textAlign: 'right', marginRight: 14, marginTop: 2 },
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
