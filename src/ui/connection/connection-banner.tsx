import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TransportHealthStatus } from '@state/transportHealthStore';
import { useTransportHealthStore } from '@state/transportHealthStore';
import { Button } from '../primitives';
import { useTheme } from '../theme';

interface TransportHealthPresentation {
  readonly label: string;
  readonly showBanner: boolean;
  readonly retryable: boolean;
  readonly tone: 'tint' | 'destructive';
}

const PRESENTATION: Record<TransportHealthStatus, TransportHealthPresentation> = {
  idle: { label: 'Paused', showBanner: false, retryable: false, tone: 'tint' },
  connecting: { label: 'Connecting…', showBanner: true, retryable: false, tone: 'tint' },
  connected: { label: 'Connected', showBanner: false, retryable: false, tone: 'tint' },
  reconnecting: { label: 'Reconnecting…', showBanner: true, retryable: false, tone: 'tint' },
  offline: { label: 'Offline', showBanner: true, retryable: true, tone: 'destructive' },
  error: {
    label: 'Connection problem',
    showBanner: true,
    retryable: true,
    tone: 'destructive',
  },
};

/** Shared wording for the global banner and Settings' truthful Live Updates row. */
export function transportHealthStatusLabel(status: TransportHealthStatus): string {
  return PRESENTATION[status].label;
}

interface ConnectionBannerProps {
  /** Service-owned Retry action; this component never mutates auth or transport state directly. */
  readonly onRetry: () => unknown;
}

/** Compact protected-route overlay that appears only while live updates are degraded. */
export function ConnectionBanner({ onRetry }: ConnectionBannerProps): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const status = useTransportHealthStore((state) => state.status);
  const presentation = PRESENTATION[status];

  if (!presentation.showBanner) return null;

  const tone = theme.color[presentation.tone];
  return (
    <View pointerEvents="box-none" style={styles.host}>
      <View
        style={[
          styles.banner,
          {
            top: insets.top + 4,
            backgroundColor: theme.color.secondaryBackground,
            borderColor: tone,
            borderRadius: theme.radius.pill,
          },
        ]}
      >
        <View
          accessible
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          accessibilityLabel={`Live updates: ${presentation.label}`}
          style={styles.status}
        >
          <Text style={[styles.label, { color: tone }]}>{presentation.label}</Text>
        </View>
        {presentation.retryable ? (
          <Button
            title="Retry"
            variant="plain"
            accessibilityLabel="Retry live updates"
            accessibilityHint="Reconnects to the saved server without changing your account"
            onPress={() => {
              onRetry();
            }}
            style={styles.retry}
          />
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  host: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    alignItems: 'center',
    // Above the native navigation surface, below full-screen call overlays and the app toast.
    elevation: 8,
    zIndex: 50,
  },
  banner: {
    position: 'absolute',
    width: '58%',
    maxWidth: 280,
    minWidth: 180,
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 14,
    paddingRight: 4,
    borderWidth: StyleSheet.hairlineWidth,
  },
  status: { flex: 1, paddingVertical: 8 },
  label: { flexShrink: 1, fontSize: 14, fontWeight: '600', textAlign: 'center' },
  retry: { minHeight: 44, paddingHorizontal: 8 },
});
