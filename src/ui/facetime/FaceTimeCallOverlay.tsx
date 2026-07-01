import { lazy, Suspense } from 'react';
import { ActivityIndicator, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFaceTimeStore } from '@state/faceTimeStore';
import { LoadErrorBoundary } from '@ui/LoadErrorBoundary';

// Lazy so the native react-native-webview module is only pulled in when a call is on
// screen; a build that hasn't linked it falls through to the LoadErrorBoundary fallback.
const FaceTimeWebView = lazy(() =>
  import('./FaceTimeWebView').then((m) => ({ default: m.FaceTimeWebView })),
);

/**
 * Full-screen in-app FaceTime call overlay (Phase 1). Renders whenever a call is active
 * (`faceTimeStore.call`). Hosts the FaceTime-web client in an embedded WebView; if that
 * can't load (module not linked yet, or Apple rejects the in-app browser) it falls back
 * to opening the validated link in the system browser, so the call still works.
 */
export function FaceTimeCallOverlay(): React.JSX.Element | null {
  const call = useFaceTimeStore((s) => s.call);
  const close = useFaceTimeStore((s) => s.close);
  const insets = useSafeAreaInsets();

  if (!call) return null;

  const openInBrowser = (): void => {
    void Linking.openURL(call.link);
  };

  const fallback = (
    <View style={styles.fallback}>
      <Text style={styles.fallbackText}>Open this FaceTime call in your browser to continue.</Text>
      <Pressable
        style={styles.fallbackBtn}
        onPress={openInBrowser}
        accessibilityRole="button"
        accessibilityLabel="Open FaceTime call in browser"
      >
        <Text style={styles.fallbackBtnText}>Open in browser</Text>
      </Pressable>
    </View>
  );

  return (
    <View style={[StyleSheet.absoluteFill, styles.container]}>
      <LoadErrorBoundary fallback={fallback}>
        <Suspense fallback={<ActivityIndicator style={styles.flex} color="#fff" />}>
          <FaceTimeWebView uri={call.link} />
        </Suspense>
      </LoadErrorBoundary>
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
  flex: { flex: 1 },
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
