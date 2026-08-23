import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isFaceTimeLink } from '@core/facetime';
import { logger } from '@core/secure';
import { useFaceTimeStore } from '@state/faceTimeStore';

/**
 * Safe FaceTime handoff for an active call. The embedded WebView is deliberately disabled while
 * FACE-01 is open: it granted camera/microphone access while allowing broad navigation. The link
 * has already passed the FaceTime allowlist before entering the store, and the system browser owns
 * its navigation and media permission prompts.
 */
export function FaceTimeCallOverlay(): React.JSX.Element | null {
  const call = useFaceTimeStore((s) => s.call);
  const close = useFaceTimeStore((s) => s.close);
  const insets = useSafeAreaInsets();

  if (!call) return null;

  const openInBrowser = (): void => {
    if (!isFaceTimeLink(call.link)) {
      logger.warn('[facetime] refused non-FaceTime browser handoff');
      return;
    }
    void Linking.openURL(call.link).catch((error) => {
      logger.warn('[facetime] browser handoff failed', error);
    });
  };

  return (
    <View style={[StyleSheet.absoluteFill, styles.container]}>
      <View style={styles.fallback}>
        <Text style={styles.fallbackText}>
          Open this FaceTime call in your browser to continue.
        </Text>
        <Pressable
          style={styles.fallbackBtn}
          onPress={openInBrowser}
          accessibilityRole="button"
          accessibilityLabel="Open FaceTime call in browser"
        >
          <Text style={styles.fallbackBtnText}>Open in browser</Text>
        </Pressable>
      </View>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
        <Text style={styles.title} numberOfLines={1}>
          FaceTime
        </Text>
      </View>
      <Pressable
        style={[styles.endBtn, { bottom: insets.bottom + 24 }]}
        onPress={close}
        accessibilityRole="button"
        accessibilityLabel="End FaceTime call"
        hitSlop={12}
      >
        <Text style={styles.endText}>End</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#000', zIndex: 100 },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingBottom: 8,
  },
  title: { color: '#fff', fontSize: 15, fontWeight: '600' },
  endBtn: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 999,
    backgroundColor: '#FF3B30',
  },
  endText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  fallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 20,
  },
  fallbackText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  fallbackBtn: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: '#0A84FF',
  },
  fallbackBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
