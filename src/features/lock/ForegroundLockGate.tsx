import type { PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BootState } from '@/services/boot/bootStateMachine';
import { readableTextOn } from '@ui/theme/adaptiveFromImage';
import { useTheme } from '@ui/theme/ThemeProvider';
import { LockScreen } from './LockScreen';

interface ForegroundLockGateProps {
  /** Sanitized coordinator state; it never contains a password, origin, or raw error. */
  readonly bootState: BootState;
  /** False until the vault-backed App Lock choice has been read. Unknown is fail-closed. */
  readonly lockHydrated: boolean;
  readonly locked: boolean;
  /** The run whose cold unlock passed biometrics and is still finishing startup, if any. */
  readonly coldUnlockPendingRunId?: number | null;
  readonly onColdUnlock: (runId: number) => void | Promise<void>;
  readonly onWarmUnlock: () => void | Promise<void>;
  readonly onRetry: (runId: number) => void | Promise<void>;
}

/**
 * Root presentation gate for both the unknown lock decision and an active lock. Protected content
 * is deliberately UNMOUNTED while blocked: React Native Modals live in a separate native window,
 * so an ordinary View overlay cannot reliably cover or disable one that is already open.
 */
export function ForegroundLockGate({
  bootState,
  lockHydrated,
  locked,
  coldUnlockPendingRunId = null,
  onColdUnlock,
  onWarmUnlock,
  onRetry,
  children,
}: PropsWithChildren<ForegroundLockGateProps>): React.JSX.Element {
  const theme = useTheme();

  const loadingCover = (
    <View
      style={[styles.fill, styles.center, { backgroundColor: theme.color.background }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Loading Gator"
      accessibilityState={{ busy: true }}
    >
      <ActivityIndicator
        color={theme.color.tint}
        accessible={false}
        importantForAccessibility="no"
      />
    </View>
  );

  if (bootState.status === 'idle' || bootState.status === 'loading') return loadingCover;

  if (bootState.status === 'failed') {
    const retryable = bootState.failure.kind === 'retryable';
    return (
      <View
        style={[
          styles.fill,
          styles.center,
          styles.failure,
          { backgroundColor: theme.color.background },
        ]}
      >
        <View
          style={styles.failureCopy}
          accessible
          accessibilityRole="alert"
          accessibilityLabel={`Gator startup failed. ${bootState.failure.userMessage}`}
        >
          <Text style={[styles.failureTitle, { color: theme.color.label }]}>
            Couldn’t start Gator
          </Text>
          <Text style={[styles.failureMessage, { color: theme.color.secondaryLabel }]}>
            {bootState.failure.userMessage}
          </Text>
        </View>
        {retryable ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void onRetry(bootState.runId)}
            style={[styles.retryButton, { backgroundColor: theme.color.tint }]}
          >
            <Text style={[styles.retryLabel, { color: readableTextOn(theme.color.tint) }]}>
              Try Again
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  if (bootState.status === 'locked') {
    return <LockScreen onUnlock={() => onColdUnlock(bootState.runId)} />;
  }

  if (!lockHydrated) return loadingCover;

  if (locked) {
    // This run already passed its cold-unlock biometrics. The coordinator announces 'ready' a few
    // microtasks before that unlock resolves and clears the lock, so keep the cover rather than
    // mount a second LockScreen, which would prompt for biometrics again.
    if (coldUnlockPendingRunId === bootState.runId) return loadingCover;
    return <LockScreen onUnlock={onWarmUnlock} />;
  }

  return <>{children}</>;
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { alignItems: 'center', justifyContent: 'center' },
  failure: { padding: 28, gap: 12 },
  failureCopy: { alignItems: 'center', gap: 12 },
  failureTitle: { fontSize: 22, fontWeight: '700', textAlign: 'center' },
  failureMessage: { fontSize: 15, lineHeight: 21, textAlign: 'center' },
  retryButton: { marginTop: 8, borderRadius: 22, paddingHorizontal: 28, paddingVertical: 12 },
  retryLabel: { fontSize: 16, fontWeight: '600' },
});
