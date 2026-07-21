import React, { useMemo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { bubbleEffectOf } from '@core/effects';
import { parsePayloadData } from '@core/models';
import { parseAttributedRuns, type TextRun } from '@core/richtext';
import type {
  AttachmentRow,
  MessagePreview,
  MessageRow,
  ReactionRow,
  UrlPreviewRow,
} from '@db/repositories';
import { isSafePreviewUrl } from '@/services/urlPreview';
import { useRedactedModeStore } from '@state/redactedModeStore';
import { useUrlPreview } from '@features/conversations/useUrlPreview';
import { errorTitleForCode, firstUrl, isBigEmoji, resolveBubbleColor, safeOpenUrl } from '@utils';
import { useTheme } from '../theme';
import { AttachmentGalleryGrid, AttachmentView } from '../attachments';
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
  /** Tap the reaction badges → open the "who reacted" detail. Omit → badges stay inert. */
  onShowReactions?: () => void;
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
  onShowReactions,
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
  // From-me bubbles colour from the CHAT's service only — never the joined-handle `senderService`.
  // On a 1:1 chat an outgoing row DOES carry the recipient's handle (the "no handle for from-me"
  // assumption is false there), and that handle's service loads/updates asynchronously from the
  // reactive query, so letting it win the `??` paints a transient green then flips to blue once the
  // re-sync settles. `chatService` is the stable, authoritative source for own bubbles. Received
  // bubbles are gray regardless of service, so their `senderService` never affects colour.
  const effectiveService = isFromMe
    ? (chatService ?? null)
    : (msg.senderService ?? chatService ?? null);
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
  // Memoized on the source PRIMITIVES (not the row's identity) — parsing runs a JSON.parse, so
  // it must not re-run on every render of a recycling list row.
  const { runs, bodyText } = useMemo(() => {
    const parsed = parseAttributedRuns(msg.attributedBody, msg.text);
    return { runs: parsed, bodyText: bodyTextOf(parsed) };
  }, [msg.attributedBody, msg.text]);
  const hasText = bodyText.trim().length > 0;
  const isRetracted = !!msg.dateRetracted;
  const isEdited = !isRetracted && !!msg.dateEdited;
  // Apple "Send Later": a small "Scheduled" badge under the bubble ONLY while the row is pending
  // (not yet sent). The server keeps emitting isScheduled:true even AFTER the message sends (it's
  // gated on schedule_type, not is_sent), so isScheduled alone would badge a delivered Send-Later
  // message forever — gate on isSent to drop it once sent. A null/undefined isSent (a row synced
  // before the is_sent column existed) counts as not-sent and re-syncs its value on the next upsert.
  // The retracted tombstone returns early below, so a retracted row never reaches the badge;
  // scheduled rows are always from-me, so no defer/avatar interaction.
  const isScheduled = !!msg.isScheduled && msg.isSent !== 1;
  // Redacted mode also suppresses the link preview (it would leak the URL/title).
  const previewUrl = useMemo(
    () => (!redacted && hasText && !isRetracted ? firstUrl(bodyText) : null),
    [redacted, hasText, isRetracted, bodyText],
  );
  // Apple's rich-link metadata (server-decoded payload_data): the title/summary/image the
  // SENDER's device already fetched. When it carries something renderable, synthesize the card
  // row directly — no network fetch, no url_previews cache — which is what makes bot-hostile
  // sites (X, Instagram, …) preview reliably. Image/icon URLs pass the same SSRF guard as the
  // fetch path (they come from the wire, so treat them like any server-supplied URL).
  const payloadPreview = useMemo<UrlPreviewRow | null>(() => {
    if (redacted || isRetracted || !msg.payloadData) return null;
    const item = parsePayloadData(msg.payloadData)?.urlData?.[0];
    if (!item) return null;
    const img =
      item.imageUrl && isSafePreviewUrl(item.imageUrl)
        ? item.imageUrl
        : item.iconUrl && isSafePreviewUrl(item.iconUrl)
          ? item.iconUrl
          : null;
    if (!item.title && !img) return null; // nothing the card could render — fall back to fetch
    return {
      url: item.url ?? item.originalUrl ?? '',
      title: item.title ?? null,
      description: item.summary ?? null,
      imageUrl: img,
      siteName: item.siteName ?? null,
      fetchedAt: null,
      error: 0,
    };
  }, [redacted, isRetracted, msg.payloadData]);
  // Own the preview lookup here (not inside the card) so we can also decide whether to draw the
  // raw link text. When the WHOLE message is just a URL and its card loaded, hide the text so we
  // don't show a blue link AND a card (matching iMessage). If the preview failed, keep the link
  // so it's still tappable. Hook is called unconditionally (null url → null) to keep hook order —
  // and a payload-backed message passes null so it NEVER fetches or touches the cache table.
  const fetched = useUrlPreview(payloadPreview ? null : previewUrl);
  const preview = payloadPreview ?? fetched;
  // The card's tap target/domain line. Prefer the text URL; a URL balloon whose text somehow
  // lacks a regex-matchable URL (bare-domain text) still gets its card via the payload URL.
  const cardUrl = previewUrl ?? (payloadPreview?.url ? payloadPreview.url : null);
  const previewLoaded = !!preview && preview.error !== 1 && (!!preview.title || !!preview.imageUrl);
  const urlOnly = useMemo(
    () =>
      previewUrl != null &&
      bodyText
        .replace(previewUrl, '')
        .trim()
        .replace(/^[).,!?;:'"]+$/, '') === '',
    [previewUrl, bodyText],
  );
  // Keep the text bubble if it carries a reaction — the reaction cluster anchors to it.
  const showText = hasText && !(urlOnly && previewLoaded && (msg.reactions?.length ?? 0) === 0);
  // Subject line (Private API): a bold line above the body. Hidden under redacted mode.
  const subjectText = msg.subject?.trim() ?? '';
  const hasSubject = !redacted && subjectText.length > 0;
  // Emoji-only message (no attachments, no subject) → enlarged, bubble-less (matches iMessage).
  const emojiOnly = useMemo(() => isBigEmoji(bodyText), [bodyText]);
  const bigEmoji = !redacted && !hasSubject && atts.length === 0 && emojiOnly;
  // Reactions anchor to the text/subject/emoji bubble when there is one; for an attachment-ONLY
  // message they must anchor to the attachment instead, or a tapback on a photo shows nothing.
  const attsReactionAnchor =
    reactions.length > 0 && atts.length > 0 && !showText && !hasSubject && !bigEmoji;
  // A message that is ONLY images (≥2) collapses into a single two-column gallery grid bubble
  // (iMessage-style) instead of a tall vertical stack. Mixed image+file messages keep the stack.
  const imageOnlyGallery =
    atts.length >= 2 && atts.every((a) => (a.mimeType ?? '').startsWith('image/'));
  const attachmentsNode = imageOnlyGallery ? (
    <AttachmentGalleryGrid atts={atts} isFromMe={isFromMe} />
  ) : (
    atts.map((att, i) => (
      <AttachmentView
        key={att.guid}
        att={att}
        isFromMe={isFromMe}
        showTail={showTail && !hasText && i === atts.length - 1}
      />
    ))
  );

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
      ) : attsReactionAnchor ? (
        // Attachment-only message with a tapback: wrap in a relative anchor so the (absolutely
        // positioned) reaction cluster pins to the attachment's top corner.
        <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
          {attachmentsNode}
          <ReactionCluster reactions={reactions} isFromMe={isFromMe} onPress={onShowReactions} />
        </View>
      ) : (
        attachmentsNode
      )}
      {bigEmoji && showText ? (
        // Emoji-only: enlarged, no bubble background.
        <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
          <Text
            style={[
              styles.bigEmoji,
              {
                color: textColor,
                fontSize: theme.font.size.body * 3,
                lineHeight: theme.font.size.body * 3.4,
              },
            ]}
          >
            {bodyText}
          </Text>
          {reactions.length > 0 ? (
            <ReactionCluster reactions={reactions} isFromMe={isFromMe} onPress={onShowReactions} />
          ) : null}
        </View>
      ) : showText || hasSubject ? (
        <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
          <View
            style={[
              styles.bubble,
              { backgroundColor, borderRadius: theme.radius.bubble, ...corners },
            ]}
          >
            {hasSubject ? (
              <Text style={[styles.subject, { color: textColor, fontSize: theme.font.size.body }]}>
                {subjectText}
              </Text>
            ) : null}
            {showText ? (
              <Text style={[styles.text, { color: textColor, fontSize: theme.font.size.body }]}>
                {redacted ? 'Message' : renderRuns(runs, textColor, theme.color.tint)}
              </Text>
            ) : null}
          </View>
          {reactions.length > 0 ? (
            <ReactionCluster reactions={reactions} isFromMe={isFromMe} onPress={onShowReactions} />
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
      {isScheduled ? (
        // Same frosted-pill overlay treatment as "Edited" so it stays legible over a wallpaper.
        <Text
          style={[
            styles.scheduled,
            overlay,
            { alignSelf: isFromMe ? 'flex-end' : 'flex-start' },
            pill,
          ]}
        >
          Scheduled
        </Text>
      ) : null}
      {cardUrl ? <UrlPreviewCard url={cardUrl} preview={preview} isFromMe={isFromMe} /> : null}
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
  // Bold subject line above the body inside a bubble.
  subject: { fontWeight: '700', marginBottom: 2 },
  // Emoji-only message: enlarged, no bubble; sits where the bubble would.
  bigEmoji: { marginHorizontal: 6, marginVertical: 2 },
  tombstone: { fontStyle: 'italic', fontSize: 13, marginHorizontal: 14, marginVertical: 4 },
  edited: { fontSize: 11, marginTop: 2, marginHorizontal: 14 },
  // Same footprint as the "Edited" label — a small caption under the bubble.
  scheduled: { fontSize: 11, marginTop: 2, marginHorizontal: 14 },
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
