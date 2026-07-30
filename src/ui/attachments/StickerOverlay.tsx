import { Image } from 'expo-image';
import * as Network from 'expo-network';
import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { download } from '@/services/download';
import type { StickerRow } from '@db/repositories';
import { useDownloadStore } from '@state/downloadStore';
import { useFeatureSettingsStore } from '@state/featureSettingsStore';
import { useTheme } from '../theme';

/** A sticker tile is a fixed dp box — never a percentage, which would resolve to width 0. */
const STICKER_SIZE = 72;

interface StickerOverlayProps {
  stickers: StickerRow[];
  isFromMe: boolean;
}

/**
 * Stickers other people placed ON a message, drawn over the target bubble (iMessage-style).
 *
 * Sits on the bubble's OWN side (right for your messages, left for theirs) — the opposite side from
 * the reaction cluster, so the two don't collide. Tap fades a sticker so the bubble underneath
 * stays readable; long-press dismisses it for this session.
 *
 * Lives in `@ui/attachments` rather than `@ui/conversations` deliberately: it imports
 * `@/services/download`, which pulls `ky` (ESM, untransformed in the components jest project), and
 * the suites that render a real MessageBubble already mock `@ui/attachments` wholesale.
 */
export function StickerOverlay({
  stickers,
  isFromMe,
}: StickerOverlayProps): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState<Record<string, true>>({});
  const visible = stickers.filter((s) => !dismissed[s.stickerMessageGuid]);
  if (visible.length === 0) return null;

  return (
    <View
      testID="sticker-overlay"
      pointerEvents="box-none"
      style={[styles.wrap, isFromMe ? styles.right : styles.left]}
    >
      {visible.map((s) => (
        <StickerTile
          key={s.stickerMessageGuid}
          sticker={s}
          onDismiss={() => setDismissed((d) => ({ ...d, [s.stickerMessageGuid]: true as const }))}
        />
      ))}
    </View>
  );
}

function StickerTile({
  sticker,
  onDismiss,
}: {
  sticker: StickerRow;
  onDismiss: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const att = sticker.attachment;
  const status = useDownloadStore((s) => (att ? s.status[att.guid] : undefined));
  const autoDownload = useFeatureSettingsStore((s) => s.autoDownloadAttachments);
  const wifiOnly = useFeatureSettingsStore((s) => s.autoDownloadOnWifiOnly);
  const netType = Network.useNetworkState().type;
  const [faded, setFaded] = useState(false);

  useEffect(() => {
    if (!att) return;
    if (!autoDownload) return;
    if (wifiOnly && netType !== Network.NetworkStateType.WIFI) return;
    // Only auto-fetch when this attachment hasn't been tried yet this session. A prior 'error' is
    // left for the user to retry by tapping — otherwise a permanently-failing sticker would
    // re-download on EVERY reactive flush and hog the download concurrency slots.
    if (status !== undefined) return;
    void download(att);
    // Keyed on guid/localPath/status, NOT the whole `att` — useMessages rebuilds every row object
    // on each reactive flush, and that identity churn is what caused a re-download storm before.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [att?.guid, att?.localPath, autoDownload, wifiOnly, netType, status]);

  const local = att?.localPath ?? null;

  // The tap outcome differs by state, so the label has to say which — a Pressable whose label only
  // names the kind is an anonymous button under TalkBack.
  const label = !local
    ? 'Sticker, not downloaded — tap to download'
    : faded
      ? 'Sticker, faded — tap to restore, long press to remove'
      : 'Sticker — tap to fade, long press to remove';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      delayLongPress={350}
      onLongPress={onDismiss}
      onPress={() => {
        if (!local) {
          if (att) void download(att);
          return;
        }
        setFaded((f) => !f);
      }}
      style={[styles.tile, { opacity: faded ? 0.25 : 1 }]}
    >
      {local ? (
        <Image
          source={{ uri: local }}
          placeholder={att?.blurhash ? { blurhash: att.blurhash } : undefined}
          contentFit="contain"
          style={styles.image}
        />
      ) : (
        // Pending tile: a sticker arriving on the LIVE path has no attachment row yet (it lands on
        // the next chat-open sync), so "no image" is an expected state, not an error.
        // `secondaryBackground`, not `groupedBackground` — the latter is byte-identical to
        // `background` in both shipped presets, so the tile would vanish.
        <View style={[styles.pending, { backgroundColor: theme.color.secondaryBackground }]}>
          {/* An unstyled <Text> is near-black on Android; the colour must be explicit. */}
          <Text style={[styles.glyph, { color: theme.color.secondaryLabel }]}>
            {status === 'downloading' ? '…' : '★'}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
  },
  left: { left: 0 },
  right: { right: 0 },
  tile: { width: STICKER_SIZE, height: STICKER_SIZE },
  image: { width: '100%', height: '100%' },
  pending: {
    width: '100%',
    height: '100%',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyph: { fontSize: 22 },
});
