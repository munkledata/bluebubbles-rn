import { useLayoutEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { isFaceTimeLink } from '@core/facetime';
import { logger } from '@core/secure';
import { useFaceTimeStore, type ActiveFaceTimeCall } from '@state/faceTimeStore';
import { safeOpenUrl } from '@utils';
import { showExternalOpenFailure } from '../toast/external-open-feedback';

interface FaceTimeOpenOperation {
  token: symbol;
  call: ActiveFaceTimeCall;
  generation: number;
}

/**
 * Safe FaceTime handoff for an active call. The embedded WebView remains deliberately disabled;
 * POST-FACE-01 defers reconsidering that unreliable experience until after remediation. The link
 * has already passed the FaceTime allowlist before entering the store, and the system browser owns
 * its navigation and media permission prompts.
 */
export function FaceTimeCallOverlay(): React.JSX.Element | null {
  const call = useFaceTimeStore((s) => s.call);
  const generation = useFaceTimeStore((s) => s.generation);
  const close = useFaceTimeStore((s) => s.close);
  const insets = useSafeAreaInsets();
  const mountedRef = useRef(true);
  const activeSourceRef = useRef({ generation, call });
  const sourceLifetimeRef = useRef(0);
  const [renderSourceLifetime, setRenderSourceLifetime] = useState(0);
  const openingRef = useRef<FaceTimeOpenOperation | null>(null);
  const sourceTransitionPending =
    activeSourceRef.current.generation !== generation || activeSourceRef.current.call !== call;

  useLayoutEffect(() => {
    if (!sourceTransitionPending) return;
    activeSourceRef.current = { generation, call };
    const nextLifetime = sourceLifetimeRef.current + 1;
    sourceLifetimeRef.current = nextLifetime;
    openingRef.current = null;
    setRenderSourceLifetime(nextLifetime);
  }, [call, generation, sourceTransitionPending]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      openingRef.current = null;
    };
  }, []);

  if (!call) return null;

  const openInBrowser = (): void => {
    const operationCall = call;
    const operationGeneration = generation;
    const operationSourceLifetime = renderSourceLifetime;
    const operationIsCurrent = (): boolean => {
      const current = useFaceTimeStore.getState();
      const activeSource = activeSourceRef.current;
      return (
        mountedRef.current &&
        sourceLifetimeRef.current === operationSourceLifetime &&
        activeSource.generation === operationGeneration &&
        activeSource.call === operationCall &&
        current.generation === operationGeneration &&
        current.call === operationCall
      );
    };
    if (!operationIsCurrent()) return;
    if (!isFaceTimeLink(operationCall.link)) {
      logger.warn('[facetime] refused non-FaceTime browser handoff');
      showExternalOpenFailure();
      return;
    }
    const activeOpen = openingRef.current;
    if (activeOpen?.call === operationCall && activeOpen.generation === operationGeneration) return;
    const token = Symbol('facetime-browser-open');
    openingRef.current = {
      token,
      call: operationCall,
      generation: operationGeneration,
    };
    void (async () => {
      try {
        const opened = await safeOpenUrl(operationCall.link);
        if (!opened && openingRef.current?.token === token && operationIsCurrent()) {
          showExternalOpenFailure();
        }
      } catch {
        if (openingRef.current?.token === token && operationIsCurrent()) {
          showExternalOpenFailure();
        }
      } finally {
        if (openingRef.current?.token === token) openingRef.current = null;
      }
    })();
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
          accessibilityState={{ disabled: sourceTransitionPending }}
          disabled={sourceTransitionPending}
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
  container: { backgroundColor: '#000', elevation: 16, zIndex: 100 },
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
