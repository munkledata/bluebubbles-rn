import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MediaDownloadIntent } from './mediaViewerModel';
import { ProgressRing } from './ProgressRing';

/** Close, the "N of M" counter, and the Share/Save pills along the top of the media viewer. */
export function MediaViewerTopBar({
  pageNumber,
  pageCount,
  actionsAvailable,
  actionsBusy,
  onClose,
  onShare,
  onSave,
}: {
  pageNumber: number;
  pageCount: number;
  actionsAvailable: boolean;
  actionsBusy: boolean;
  onClose: () => void;
  onShare: () => void;
  onSave: () => void;
}): React.JSX.Element {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.bar, { top: insets.top + 6 }]} pointerEvents="box-none">
      <Pressable
        onPress={onClose}
        hitSlop={12}
        style={styles.pill}
        accessibilityRole="button"
        accessibilityLabel="Close media viewer"
      >
        <Text style={styles.glyph}>✕</Text>
      </Pressable>
      {/* "N of M" while paging through more than one photo. */}
      {pageCount > 1 ? (
        <View style={styles.counter} pointerEvents="none">
          <Text style={styles.counterText}>
            {pageNumber} of {pageCount}
          </Text>
        </View>
      ) : null}
      <View style={styles.actions} pointerEvents="box-none">
        <Pressable
          onPress={onShare}
          disabled={!actionsAvailable}
          hitSlop={12}
          style={[styles.pill, !actionsAvailable && styles.disabled]}
          accessibilityRole="button"
          accessibilityLabel="Share media"
          accessibilityHint="Downloads this media first when needed"
          accessibilityState={{ disabled: !actionsAvailable, busy: actionsBusy }}
        >
          <Text style={styles.glyph}>⤴</Text>
        </Pressable>
        <Pressable
          onPress={onSave}
          disabled={!actionsAvailable}
          hitSlop={12}
          style={[styles.pill, !actionsAvailable && styles.disabled]}
          accessibilityRole="button"
          accessibilityLabel="Save media"
          accessibilityHint="Downloads this media first when needed"
          accessibilityState={{ disabled: !actionsAvailable, busy: actionsBusy }}
        >
          <Text style={styles.glyph}>⤓</Text>
        </Pressable>
      </View>
    </View>
  );
}

/**
 * Covers a page whose row is being re-read (`checking`) or could not be re-read. The "Checking
 * media…" spinner appears only when `showIndicator` says the check is slow.
 */
export function MediaPageCheckOverlay({
  checking,
  showIndicator,
  onRetry,
}: {
  checking: boolean;
  showIndicator: boolean;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {checking ? (
        showIndicator ? (
          <View
            accessible
            accessibilityRole="progressbar"
            accessibilityLabel="Checking current media"
            accessibilityLiveRegion="polite"
            style={styles.panel}
            pointerEvents="none"
          >
            <ProgressRing progress={null} />
            <Text style={styles.message}>Checking media…</Text>
          </View>
        ) : null
      ) : (
        <View style={styles.panel}>
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            Couldn’t refresh media
          </Text>
          <Pressable
            onPress={onRetry}
            style={styles.button}
            accessibilityRole="button"
            accessibilityLabel="Retry media refresh"
          >
            <Text style={styles.buttonText}>Retry</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

/**
 * Covers a page whose file is not on the device: download progress while `busy`, otherwise a
 * Download (or Retry) button. `intent` names what the download is for, so the progress and retry
 * labels say "to share" or "to save" when the user tapped Share or Save.
 */
export function MediaDownloadOverlay({
  intent,
  busy,
  progress,
  failed,
  fileMissing,
  onDownload,
}: {
  intent: MediaDownloadIntent;
  busy: boolean;
  progress: number | null | undefined;
  /** The last attempt failed, or its result could not be shown. */
  failed: boolean;
  /** The row names a device file that can no longer be used. */
  fileMissing: boolean;
  onDownload: () => void;
}): React.JSX.Element {
  const purpose =
    intent === 'share'
      ? 'Downloading media to share'
      : intent === 'save'
        ? 'Downloading media to save'
        : 'Downloading media';
  const retryLabel =
    intent === 'share'
      ? 'Retry download and share media'
      : intent === 'save'
        ? 'Retry download and save media'
        : 'Retry media download';
  const retry = failed || fileMissing;
  return (
    <View style={styles.overlay} pointerEvents="box-none">
      {busy ? (
        <View
          accessible
          accessibilityRole="progressbar"
          accessibilityLabel={purpose}
          accessibilityLiveRegion="polite"
          accessibilityValue={
            typeof progress === 'number'
              ? { min: 0, max: 100, now: Math.round(progress * 100) }
              : undefined
          }
          style={styles.panel}
          pointerEvents="none"
        >
          <ProgressRing progress={progress ?? null} />
          <Text style={styles.message}>{purpose}…</Text>
        </View>
      ) : (
        <View style={styles.panel}>
          <Text accessibilityLiveRegion="polite" style={styles.message}>
            {failed ? 'Download failed' : fileMissing ? 'Media file unavailable' : 'Not downloaded'}
          </Text>
          <Pressable
            onPress={onDownload}
            style={styles.button}
            accessibilityRole="button"
            accessibilityLabel={retry ? retryLabel : 'Download media'}
          >
            <Text style={styles.buttonText}>{retry ? 'Retry' : 'Download'}</Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 12,
    right: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  counter: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  counterText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  panel: {
    minWidth: 164,
    maxWidth: '80%',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.72)',
  },
  message: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center' },
  button: {
    minHeight: 44,
    minWidth: 112,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
    borderRadius: 22,
    backgroundColor: '#fff',
  },
  buttonText: { color: '#000', fontSize: 15, fontWeight: '700' },
  actions: { flexDirection: 'row', gap: 10 },
  pill: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.5)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  disabled: { opacity: 0.35 },
  glyph: { color: '#fff', fontSize: 20, fontWeight: '600' },
});
