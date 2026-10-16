import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TransportHealthStatus } from '@state/transportHealthStore';
import { useTransportHealthStore } from '@state/transportHealthStore';
import { Button } from '../primitives';
import { useTheme } from '../theme';

/** Non-actionable connection churn must persist this long before it interrupts the user. */
export const CONNECTION_BANNER_TRANSIENT_DELAY_MS = 1_000;

type TransientTransportHealthStatus = Extract<TransportHealthStatus, 'connecting' | 'reconnecting'>;

interface TransportHealthPresentation {
  readonly label: string;
  readonly showBanner: boolean;
  /** Retry reconnects with the saved credential; manage-server opens Server Management. */
  readonly action: 'retry' | 'manage-server' | null;
  readonly tone: 'tint' | 'destructive';
}

const PRESENTATION: Record<TransportHealthStatus, TransportHealthPresentation> = {
  idle: { label: 'Paused', showBanner: false, action: null, tone: 'tint' },
  connecting: { label: 'Connecting…', showBanner: true, action: null, tone: 'tint' },
  connected: { label: 'Connected', showBanner: false, action: null, tone: 'tint' },
  reconnecting: { label: 'Reconnecting…', showBanner: true, action: null, tone: 'tint' },
  offline: { label: 'Offline', showBanner: true, action: 'retry', tone: 'destructive' },
  error: {
    label: 'Connection problem',
    showBanner: true,
    action: 'retry',
    tone: 'destructive',
  },
  // Retrying would re-send the same refused credential (review M118).
  'auth-rejected': {
    label: 'Password rejected',
    showBanner: true,
    action: 'manage-server',
    tone: 'destructive',
  },
};

/** Shared wording for the global banner and Settings' truthful Live Updates row. */
export function transportHealthStatusLabel(status: TransportHealthStatus): string {
  return PRESENTATION[status].label;
}

function isTransientStatus(
  status: TransportHealthStatus,
): status is TransientTransportHealthStatus {
  return status === 'connecting' || status === 'reconnecting';
}

interface ConnectionBannerProps {
  /** Service-owned Retry action; this component never mutates auth or transport state directly. */
  readonly onRetry: () => unknown;
  /** Opens Server Management, where a rejected credential can be replaced or the account left. */
  readonly onManageServer?: () => unknown;
  /** Reserve the measured banner height above routed content, including scaled text. */
  readonly onHeightChange?: (height: number) => void;
}

interface ConnectionBannerSurfaceProps extends ConnectionBannerProps {
  readonly status: TransportHealthStatus;
}

function ConnectionBannerSurface({
  status,
  onRetry,
  onManageServer,
  onHeightChange,
}: ConnectionBannerSurfaceProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const presentation = PRESENTATION[status];
  const tone = theme.color[presentation.tone];
  React.useEffect(() => () => onHeightChange?.(0), [onHeightChange]);
  return (
    <View pointerEvents="box-none" style={styles.host}>
      <View
        onLayout={(event) => onHeightChange?.(event.nativeEvent.layout.height + 8)}
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
        {presentation.action === 'retry' ? (
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
        {presentation.action === 'manage-server' && onManageServer ? (
          <Button
            title="Fix"
            variant="plain"
            accessibilityLabel="Open Server Management"
            accessibilityHint="Pair this phone with the server again, or disconnect"
            onPress={() => {
              onManageServer();
            }}
            style={styles.retry}
          />
        ) : null}
      </View>
    </View>
  );
}

interface DelayedConnectionBannerProps extends ConnectionBannerProps {
  readonly status: TransientTransportHealthStatus;
}

/** One transient connection episode; unmounting it cancels both the timer and visible banner. */
function DelayedConnectionBanner({
  status,
  onRetry,
  onHeightChange,
}: DelayedConnectionBannerProps): React.JSX.Element | null {
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(true);
    }, CONNECTION_BANNER_TRANSIENT_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  return visible ? (
    <ConnectionBannerSurface status={status} onRetry={onRetry} onHeightChange={onHeightChange} />
  ) : null;
}

/** Compact protected-route overlay that appears only while live updates are degraded. */
export function ConnectionBanner({
  onRetry,
  onManageServer,
  onHeightChange,
}: ConnectionBannerProps): React.JSX.Element | null {
  const status = useTransportHealthStore((state) => state.status);

  if (!PRESENTATION[status].showBanner) return null;
  if (isTransientStatus(status)) {
    // The key makes connecting → reconnecting a fresh delay. Recovery unmounts this child, so
    // returning to the same status later also starts a new episode instead of reusing old state.
    return (
      <DelayedConnectionBanner
        key={status}
        status={status}
        onRetry={onRetry}
        onHeightChange={onHeightChange}
      />
    );
  }
  return (
    <ConnectionBannerSurface
      status={status}
      onRetry={onRetry}
      onManageServer={onManageServer}
      onHeightChange={onHeightChange}
    />
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
