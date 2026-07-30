import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useUploadStore } from '@state/uploadStore';
import { isTransferStalled, rollupTransfers, uploadBarLabels } from '@utils';
import { useTheme, withAlpha } from '../theme';

interface UploadStatusBarProps {
  /** Only this chat's uploads are summarised — the bar belongs to the thread on screen. */
  chatGuid: string;
  /** A chat wallpaper is set → frost the bar so the image shows through (matches the composer). */
  translucent?: boolean;
}

/** Re-render cadence for stall detection only — see the note in the effect below. */
const STALL_TICK_MS = 1000;

/**
 * A slim bar above the composer summarising this chat's in-flight attachment uploads: what is
 * being sent, how many bytes have gone, and how far along.
 *
 * Renders NOTHING when nothing is uploading — the upload store removes an entry as soon as its
 * attempt settles, so an empty set is the whole "no bar" condition and no extra state is needed.
 *
 * Complements the per-bubble ring rather than duplicating it: the ring answers "where is MY
 * photo" and scrolls away with its message, while this stays put and answers "is anything still
 * going out", which is the question you have when the thread has scrolled on.
 */
export function UploadStatusBar({
  chatGuid,
  translucent,
}: UploadStatusBarProps): React.JSX.Element | null {
  const theme = useTheme();
  // Select the MAP, not a derived array: a selector returning a fresh array every call re-renders
  // forever under zustand's identity comparison. The map's identity changes on each progress
  // event, which is exactly when this bar should re-render.
  const byGuid = useUploadStore((s) => s.byGuid);
  const rows = useMemo(
    () => Object.values(byGuid).filter((e) => e.chatGuid === chatGuid),
    [byGuid, chatGuid],
  );
  const active = rows.length > 0;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // A stall is the ABSENCE of progress events, so nothing in the store will ever wake us to
    // notice one — it takes a clock. Runs ONLY while something is uploading, so an idle chat
    // holds no timer, and one timer serves the whole screen (a per-bubble ticker would mean one
    // per row in a recycling list).
    // No re-seed of `now` on the way in, deliberately: a stale clock is always EARLIER than a
    // fresh upload's `updatedAt`, so the difference goes negative and can never read as a stall.
    // The first tick corrects it a second later, which is well inside the 20 s threshold.
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), STALL_TICK_MS);
    return () => clearInterval(id);
  }, [active]);

  const stalled = rows.some((e) => isTransferStalled(e.updatedAt, now));
  const labels = uploadBarLabels(rows, { stalled });
  const roll = rollupTransfers(rows);
  if (!labels) return null;

  const chip = withAlpha(theme.color.background, 0.62);
  // An unknown total has no honest width to draw, so the track stays empty rather than guessing.
  const fillPercent = roll.ratio == null ? 0 : Math.round(roll.ratio * 100);

  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: translucent ? chip : theme.color.background,
          borderTopColor: translucent ? 'transparent' : theme.color.separator,
        },
      ]}
      // `accessible` is load-bearing, not decoration: without it a plain View is not an
      // accessibility element at all, so the role and value are dropped and TalkBack reads the two
      // Text children as separate unlabelled nodes instead of one progress bar.
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={`${labels.title}. ${labels.detail}`}
      accessibilityValue={roll.ratio == null ? undefined : { min: 0, max: 100, now: fillPercent }}
    >
      <View style={[styles.track, { backgroundColor: theme.color.separator }]}>
        <View
          style={[
            styles.fill,
            {
              width: `${fillPercent}%`,
              backgroundColor: stalled ? theme.color.destructive : theme.color.tint,
            },
          ]}
        />
      </View>
      <Text numberOfLines={1} style={[styles.title, { color: theme.color.label }]}>
        {labels.title}
      </Text>
      <Text
        numberOfLines={1}
        style={[
          styles.detail,
          { color: stalled ? theme.color.destructive : theme.color.secondaryLabel },
        ]}
      >
        {labels.detail}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  track: { height: 3, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2 },
  title: { fontSize: 13, fontWeight: '600', marginTop: 6 },
  detail: { fontSize: 12, marginTop: 1 },
});
