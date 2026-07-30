import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useToastStore } from './toastStore';

/**
 * Beyond this, a queued toast is assumed to be a leftover rather than something the user is
 * waiting to read. `showToast` is callable from headless service code (auto-download runs on a
 * killed-app FCM wake), where nothing renders and nothing dismisses; if Android later reuses that
 * JS context for a real launch, the backlog would replay as ghost pills long after the fact.
 * Dropping by AGE rather than resetting the store on mount keeps a toast that was legitimately
 * enqueued in the same commit as the host mounting. Comfortably clear of a real burst: the tail of
 * a FIFO queue only ages out past ~6 back-to-back toasts, and nothing enqueues that many (the
 * auto-download path emits ONE batched toast per burst).
 */
const MAX_TOAST_AGE_MS = 15_000;

/**
 * The single host for the app-wide toast (see {@link useToastStore}). Mounted once at the root,
 * inside ThemeProvider + SafeAreaProvider. A floating, NON-blocking pill near the bottom that fades
 * in and auto-dismisses after its duration. Unlike {@link AppDialog} it is NOT a Modal — it must
 * never capture touches (the whole overlay is pointerEvents="none").
 */
export function AppToast(): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const current = useToastStore((s) => s.current);
  const dismiss = useToastStore((s) => s.dismiss);
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!current) return;
    // Stale backlog → skip it and promote the next one (which gets the same test, so a whole
    // hostless burst drains at once). No animation was started, so `opacity` is still 0 and the
    // pill never becomes visible for the frame it takes to unmount.
    if (Date.now() - current.createdAt > MAX_TOAST_AGE_MS) {
      dismiss();
      return;
    }
    const anim = Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true });
    anim.start();
    const timer = setTimeout(dismiss, current.durationMs);
    return () => {
      clearTimeout(timer);
      anim.stop();
      opacity.setValue(0);
    };
  }, [current, dismiss, opacity]);

  if (!current) return null;

  return (
    <View style={styles.wrap} pointerEvents="none">
      <Animated.View
        style={[
          styles.pill,
          { backgroundColor: theme.color.secondaryBackground, bottom: insets.bottom + 24, opacity },
        ]}
      >
        <Text style={[styles.text, { color: theme.color.label }]} numberOfLines={2}>
          {current.message}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'flex-end',
    alignItems: 'center',
    // THE HOST MUST DECLARE ITS OWN STACKING, not rely on being a later JSX sibling.
    // `<AppToast/>` sits after `<ThemedStack/>`, but the stack renders through
    // react-native-screens as NATIVE views, and Android does not order a plain sibling View
    // above a native/elevated one by JSX position alone — so the pill was painted UNDERNEATH
    // the current screen and never appeared on device. `AppDialog` never hit this because it is
    // a `Modal` (its own native window), which is exactly why dialogs showed and toasts did not.
    // Found on-device: three dialogs rendered fine while zero toasts ever did, and the toast's
    // text never even reached the accessibility tree. Jest can't catch this — there is no native
    // stack under react-test-renderer, so `appToast.test.tsx` passes either way.
    // elevation (Android) + zIndex (iOS/Yoga) so it wins on both.
    elevation: 24,
    zIndex: 9999,
  },
  pill: {
    position: 'absolute',
    maxWidth: '86%',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 22,
    // Subtle elevation so the pill reads above content on both light and dark themes.
    elevation: 6,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
  },
  text: { fontSize: 14, fontWeight: '500', textAlign: 'center' },
});
