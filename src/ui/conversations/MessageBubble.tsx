import React, { useCallback, useMemo, useRef } from 'react';
import { Pressable, StyleSheet, Text, View, type AccessibilityActionEvent } from 'react-native';
import { bubbleEffectOf } from '@core/effects';
import { parsePayloadData } from '@core/models';
import {
  parseAttributedRuns,
  splitMessageEntitySpans,
  type MessageEntity,
  type TextRun,
} from '@core/richtext';
import type {
  AttachmentRow,
  MessagePreview,
  MessageRow,
  ReactionRow,
  StickerRow,
  UrlPreviewRow,
} from '@db/repositories';
import { isSafePreviewUrl } from '@/services/urlPreview';
import {
  performMessageEntityAction,
  type MessageEntityActionRequest,
} from '@/services/messageEntityActions';
import { useUrlPreview } from '@features/conversations/useUrlPreview';
import { showDialog } from '@ui/dialog/dialogStore';
import { showToast } from '@ui/toast/toastStore';
import {
  errorTitleForCode,
  firstUrl,
  isBigEmoji,
  isHexColor,
  resolveBubbleColor,
  type BubbleRect,
} from '@utils';
import { contrastRatio, readableTextOn, useTheme } from '../theme';
import { AttachmentGalleryGrid, AttachmentView, StickerOverlay } from '../attachments';
import { BubbleEffectView } from './effects';
import { ReactionCluster } from './ReactionCluster';
import { overlayPillStyle, overlayTextStyle } from './overlayText';
import { ReplyQuote } from './ReplyQuote';
import { UrlPreviewCard } from './UrlPreviewCard';

interface MessageBubbleProps {
  msg: MessageRow & {
    attachments?: AttachmentRow[];
    reactions?: ReactionRow[];
    /** Stickers placed ON this message, drawn as an overlay (see StickerOverlay). */
    stickers?: StickerRow[];
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
  /** Long-press the bubble → open the reaction/action menu, anchored to this bubble's
   *  on-screen rectangle (measured here so the floating menu can pin above/below it). */
  onLongPress?: (rect: BubbleRect) => void;
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

const MESSAGE_ACTIONS = [{ name: 'longpress', label: 'Show message actions' }] as const;

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
  // Measure the bubble on long-press so the reaction/action menu can float around its actual
  // on-screen position (iMessage-style), rather than sit in a bottom sheet. measureInWindow is
  // async (one frame) — fine for a long-press.
  const bubbleRef = useRef<View>(null);
  const handleLongPress = useCallback(() => {
    if (!onLongPress) return;
    const node = bubbleRef.current;
    if (!node) return;
    node.measureInWindow((x, y, width, height) => onLongPress({ x, y, width, height }));
  }, [onLongPress]);
  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent): void => {
      if (event.nativeEvent.actionName === 'longpress') handleLongPress();
    },
    [handleLongPress],
  );
  const b = theme.color.bubble;
  const isFromMe = msg.isFromMe === 1;
  // From-me bubbles colour from the CHAT's service only — never the joined-handle `senderService`.
  // On a 1:1 chat an outgoing row DOES carry the recipient's handle (the "no handle for from-me"
  // assumption is false there), and that handle's service loads/updates asynchronously from the
  // reactive query, so letting it win the `??` paints a transient green then flips to blue once the
  // re-sync settles. `chatService` is the stable, authoritative source for own bubbles. Received
  // bubbles use their validated per-handle color when one exists, so `senderService` does not
  // choose their background.
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
  const showReactionCluster = reactions.length > 0;
  const stickers = msg.stickers ?? [];
  // Remount the overlay when the sticker SET changes so per-sticker fade/dismiss state can't ride
  // onto a different sticker in a recycled FlashList row.
  const stickerKey = stickers.map((s) => s.stickerMessageGuid).join('|');
  // EDITED messages keep their text in attributedBody (the `text` column goes empty), so derive the
  // body from the parsed runs rather than `msg.text` alone — otherwise an edit renders as a blank
  // bubble. `bodyTextOf` strips the U+FFFC attachment placeholder so an attachment-only message
  // isn't a stray-glyph bubble.
  // Memoized on the source PRIMITIVES (not the row's identity) — parsing runs a JSON.parse, so
  // it must not re-run on every render of a recycling list row.
  const { runs, bodyText } = useMemo(() => {
    const parsed = mergeAdjacentPlainRuns(parseAttributedRuns(msg.attributedBody, msg.text));
    return { runs: parsed, bodyText: bodyTextOf(parsed) };
  }, [msg.attributedBody, msg.text]);
  const hasText = bodyText.trim().length > 0;
  const hasActionableEntities = useMemo(
    () =>
      runs.some(
        (run) =>
          !run.mention &&
          !run.attachment &&
          splitMessageEntitySpans(run.text).some((span) => span.kind === 'entity'),
      ),
    [runs],
  );
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
  const previewUrl = useMemo(
    () => (hasText && !isRetracted ? firstUrl(bodyText) : null),
    [hasText, isRetracted, bodyText],
  );
  // Apple's rich-link metadata (server-decoded payload_data): the title/summary/image the
  // SENDER's device already fetched. When it carries something renderable, synthesize the card
  // row directly — no network fetch, no url_previews cache — which is what makes bot-hostile
  // sites (X, Instagram, …) preview reliably. Image/icon URLs remain validated for a future
  // bounded pipeline, but NET-00's card deliberately never mounts remote preview artwork.
  const payloadPreview = useMemo<UrlPreviewRow | null>(() => {
    if (isRetracted || !msg.payloadData) return null;
    const item = parsePayloadData(msg.payloadData)?.urlData?.[0];
    if (!item) return null;
    const img =
      item.imageUrl && isSafePreviewUrl(item.imageUrl)
        ? item.imageUrl
        : item.iconUrl && isSafePreviewUrl(item.iconUrl)
          ? item.iconUrl
          : null;
    if (!item.title && !img) return null; // fall back to the local cache lookup / raw link
    return {
      url: item.url ?? item.originalUrl ?? '',
      title: item.title ?? null,
      description: item.summary ?? null,
      imageUrl: img,
      siteName: item.siteName ?? null,
      fetchedAt: null,
      error: 0,
    };
  }, [isRetracted, msg.payloadData]);
  // Own the preview lookup here (not inside the card) so we can also decide whether to draw the
  // raw link text. When the WHOLE message is just a URL and its card loaded, hide the text so we
  // don't show a blue link AND a card (matching iMessage). If the preview failed, keep the link
  // so it's still tappable. Hook is called unconditionally (null url → null) to keep hook order —
  // and a renderable payload-backed message passes null so it never touches the cache table. On
  // other messages the hook is cache-read-only: a miss cannot start HTML or image traffic.
  const fetched = useUrlPreview(payloadPreview ? null : previewUrl);
  // useReactiveQuery deliberately keeps the previous dependency's data until the next read
  // resolves. A recycled FlashList row may therefore briefly carry URL A's cached preview while
  // rendering URL B. Adopt cache data only when its exact key matches the current message URL.
  const fetchedForCurrentUrl = fetched?.url === previewUrl ? fetched : null;
  const preview = payloadPreview ?? fetchedForCurrentUrl;
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
  // Subject line (Private API): a bold line above the body.
  const subjectText = msg.subject?.trim() ?? '';
  const hasSubject = subjectText.length > 0;
  // Emoji-only message (no attachments, no subject) → enlarged, bubble-less (matches iMessage).
  const emojiOnly = useMemo(() => isBigEmoji(bodyText), [bodyText]);
  const bigEmoji = !hasSubject && atts.length === 0 && emojiOnly;
  // Reactions anchor to the text/subject/emoji bubble when there is one; for an attachment-ONLY
  // message they must anchor to the attachment instead, or a tapback on a photo shows nothing.
  // Reactions AND stickers anchor to the text/subject/emoji bubble when there is one; for an
  // attachment-ONLY message they must anchor to the attachment instead, or an overlay on a photo
  // shows nothing.
  const attsOverlayAnchor =
    (showReactionCluster || stickers.length > 0) &&
    atts.length > 0 &&
    !showText &&
    !hasSubject &&
    !bigEmoji;
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
          {isFromMe ? 'You unsent a message' : `${msg.senderName ?? 'They'} unsent a message`}
        </Text>
      </View>
    );
  }

  // RCS gets its own teal (mirrors the SMS-green branch); `?? b.smsBackground` guards a custom
  // theme persisted before the rcsBackground token existed. Received rows use their last-known
  // valid handle color, independent of service; from-me SMS/RCS rows use the chat service.
  const nonImessageBg = isRcs ? (b.rcsBackground ?? b.smsBackground) : b.smsBackground;
  const receivedHandleColor = !isFromMe && isHexColor(msg.senderColor) ? msg.senderColor : null;
  const backgroundColor = isFromMe
    ? isSms || isRcs
      ? nonImessageBg
      : resolveBubbleColor(accentColor, b.senderBackground)
    : (receivedHandleColor ?? b.receivedBackgroundBottom);
  // Own bubbles can use the theme sender colour, a per-chat accent, SMS green, or RCS teal.
  // Choose text from the background we actually rendered instead of reusing senderText, which
  // only describes the normal iMessage bubble and becomes unreadable on the brighter variants.
  const textColor =
    isFromMe || receivedHandleColor ? readableTextOn(backgroundColor) : b.receivedText;
  // A sent mention must use the same readable foreground as the rest of the sent text. Received
  // mentions keep the accent when it clears AA, otherwise they fall back to readable body text.
  const mentionColor = isFromMe
    ? textColor
    : contrastRatio(theme.color.tint, backgroundColor) >= 4.5
      ? theme.color.tint
      : textColor;

  // Tail corner is the bottom corner toward the screen edge, only on last-in-group.
  // The text bubble tails only when there are no attachments below it.
  const textTail = showTail && atts.length === 0 ? theme.radius.tail : theme.radius.bubble;
  const corners = isFromMe
    ? { borderBottomRightRadius: textTail }
    : { borderBottomLeftRadius: textTail };
  const messageActionLabel = bodyText.replace(/\s+/g, ' ').trim().slice(0, 120);

  const bubble = (
    <Pressable
      ref={bubbleRef}
      onLongPress={onLongPress ? handleLongPress : undefined}
      delayLongPress={onLongPress ? 350 : undefined}
      // An accessible Pressable groups all descendants on Android. Keep the existing grouping for
      // ordinary bubbles, but let TalkBack focus actionable inline entities independently.
      accessible={hasActionableEntities ? false : undefined}
      accessibilityActions={onLongPress && !hasActionableEntities ? MESSAGE_ACTIONS : undefined}
      accessibilityHint={
        onLongPress && !hasActionableEntities
          ? 'Double tap and hold for message actions'
          : undefined
      }
      onAccessibilityAction={
        onLongPress && !hasActionableEntities ? handleAccessibilityAction : undefined
      }
      style={{ opacity: isSending ? 0.6 : 1 }}
    >
      {onLongPress && hasActionableEntities ? (
        <View
          pointerEvents="none"
          collapsable={false}
          accessible
          importantForAccessibility="yes"
          accessibilityRole="button"
          accessibilityLabel={
            messageActionLabel ? `Message actions for ${messageActionLabel}` : 'Message actions'
          }
          accessibilityHint="Double tap and hold for message actions"
          accessibilityActions={MESSAGE_ACTIONS}
          onAccessibilityAction={handleAccessibilityAction}
          style={styles.messageActionAccessibilityTarget}
        />
      ) : null}
      {msg.replyPreview && msg.threadOriginatorGuid ? (
        <ReplyQuote
          preview={msg.replyPreview}
          isFromMe={isFromMe}
          hasBackground={hasBackground}
          onPress={onJumpToReply}
        />
      ) : null}
      {attsOverlayAnchor ? (
        // Attachment-only message with a tapback: wrap in a relative anchor so the (absolutely
        // positioned) reaction cluster pins to the attachment's top corner.
        <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
          {attachmentsNode}
          {showReactionCluster ? (
            <ReactionCluster reactions={reactions} isFromMe={isFromMe} onPress={onShowReactions} />
          ) : null}
          {stickers.length ? (
            <StickerOverlay key={stickerKey} stickers={stickers} isFromMe={isFromMe} />
          ) : null}
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
                // Emoji-only messages have no bubble, so their fallback glyph colour belongs to
                // the screen surface rather than the sent-bubble foreground chosen above.
                color: theme.color.label,
                fontSize: theme.font.size.body * 3,
                lineHeight: theme.font.size.body * 3.4,
              },
            ]}
          >
            {bodyText}
          </Text>
          {showReactionCluster ? (
            <ReactionCluster reactions={reactions} isFromMe={isFromMe} onPress={onShowReactions} />
          ) : null}
          {stickers.length ? (
            <StickerOverlay key={stickerKey} stickers={stickers} isFromMe={isFromMe} />
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
                {renderRuns(runs, textColor, mentionColor)}
              </Text>
            ) : null}
          </View>
          {showReactionCluster ? (
            <ReactionCluster reactions={reactions} isFromMe={isFromMe} onPress={onShowReactions} />
          ) : null}
          {stickers.length ? (
            <StickerOverlay key={stickerKey} stickers={stickers} isFromMe={isFromMe} />
          ) : null}
        </View>
      ) : stickers.length > 0 && atts.length === 0 ? (
        // A sticker on a message with nothing else to render (no text, no subject, no attachment)
        // still needs a positioned anchor, or the overlay has nothing to attach to and vanishes.
        <View style={[styles.anchor, { alignSelf: isFromMe ? 'flex-end' : 'flex-start' }]}>
          <View style={styles.stickerOnlySpacer} />
          <StickerOverlay key={stickerKey} stickers={stickers} isFromMe={isFromMe} />
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

/**
 * Unknown attributed-body styling is intentionally rendered as plain text. Merge adjacent plain
 * runs so a URL/phone/date split only by such metadata remains one entity; mentions and attachment
 * placeholders stay as hard boundaries and keep their existing styling/ownership.
 */
function mergeAdjacentPlainRuns(runs: TextRun[]): TextRun[] {
  const merged: TextRun[] = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    const plain = !run.mention && !run.attachment;
    if (plain && previous && !previous.mention && !previous.attachment) {
      merged[merged.length - 1] = { text: previous.text + run.text };
    } else {
      merged.push(run);
    }
  }
  return merged;
}

/** Plain body text from the parsed runs (attachments excluded, U+FFFC placeholder stripped). */
function bodyTextOf(runs: TextRun[]): string {
  return runs
    .filter((r) => !r.attachment)
    .map((r) => r.text.replace(OBJECT_REPLACEMENT, ''))
    .join('');
}

/**
 * Render the bubble text from the parsed attributedBody runs: mentions in the accent color,
 * validated entities actionable, everything else plain. Rendering from the runs (not `msg.text`)
 * is what makes EDITED messages show — their edited text lives in attributedBody while the `text`
 * column is empty.
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
    return <React.Fragment key={i}>{renderEntityText(text, color)}</React.Fragment>;
  });
}

function runMessageEntityAction(
  request: MessageEntityActionRequest,
  failureMessage: string,
  successMessage?: string,
): void {
  void performMessageEntityAction(request).then((completed) => {
    if (!completed) {
      showDialog('Couldn’t complete action', failureMessage);
    } else if (successMessage) {
      showToast(successMessage);
    }
  });
}

function activateMessageEntity(entity: MessageEntity): void {
  switch (entity.kind) {
    case 'url':
      runMessageEntityAction(
        { action: 'open-url', entity },
        'No browser on this device could open that link.',
      );
      return;
    case 'phone':
      showDialog('Phone number', entity.text, [
        {
          text: 'Call',
          onPress: () =>
            runMessageEntityAction(
              { action: 'dial-phone', entity },
              'No phone app on this device could open that number.',
            ),
        },
        {
          text: 'Message',
          onPress: () =>
            runMessageEntityAction(
              { action: 'message-phone', entity },
              'No messaging app on this device could open that number.',
            ),
        },
        {
          text: 'Copy',
          onPress: () =>
            runMessageEntityAction(
              { action: 'copy-phone', entity },
              'Couldn’t copy that phone number.',
              'Phone number copied',
            ),
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
      return;
    case 'date':
      showDialog('Date', entity.text, [
        {
          text: 'Add to Calendar',
          onPress: () =>
            runMessageEntityAction(
              { action: 'open-calendar-draft', entity },
              'No calendar app on this device could create a draft.',
            ),
        },
        {
          text: 'Copy',
          onPress: () =>
            runMessageEntityAction(
              { action: 'copy-date', entity },
              'Couldn’t copy that date.',
              'Date copied',
            ),
        },
        { text: 'Cancel', style: 'cancel' },
      ]);
  }
}

function entityAccessibility(entity: MessageEntity): {
  label: string;
  hint: string;
  role: 'button' | 'link';
} {
  switch (entity.kind) {
    case 'url':
      return { label: `Link ${entity.text}`, hint: 'Opens in your browser', role: 'link' };
    case 'phone':
      return {
        label: `Phone number ${entity.text}`,
        hint: 'Shows call, message, and copy actions',
        role: 'link',
      };
    case 'date':
      return {
        label: `Date ${entity.text}`,
        hint: 'Shows calendar and copy actions',
        role: 'button',
      };
  }
}

function renderEntityText(text: string, color: string): React.ReactNode {
  return splitMessageEntitySpans(text).map((span, index) => {
    if (span.kind === 'text') return <React.Fragment key={index}>{span.text}</React.Fragment>;
    const accessibility = entityAccessibility(span.entity);
    return (
      <Text
        key={`${span.entity.kind}:${span.entity.start}`}
        style={{ color, textDecorationLine: 'underline' }}
        onPress={() => activateMessageEntity(span.entity)}
        accessibilityRole={accessibility.role}
        accessibilityLabel={accessibility.label}
        accessibilityHint={accessibility.hint}
      >
        {span.entity.text}
      </Text>
    );
  });
}

const styles = StyleSheet.create({
  messageActionAccessibilityTarget: StyleSheet.absoluteFill,
  anchor: { position: 'relative', marginHorizontal: 10, maxWidth: '78%' },
  bubble: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    marginVertical: 1,
  },
  text: { lineHeight: 22 },
  // Bold subject line above the body inside a bubble.
  subject: { fontWeight: '700', marginBottom: 2 },
  // Emoji-only message: enlarged, no bubble; sits where the bubble would.
  // Reserves the overlay's own box so a sticker-only message has something to anchor against.
  stickerOnlySpacer: { width: 72, height: 72 },
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
