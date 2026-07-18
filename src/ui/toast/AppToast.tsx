import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme';
import { useToastStore } from './toastStore';

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
