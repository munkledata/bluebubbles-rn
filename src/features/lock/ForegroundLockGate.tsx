import { useEffect, useRef, type PropsWithChildren } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { BootState } from '@/services/boot/bootStateMachine';
import { readableTextOn } from '@ui/theme/adaptiveFromImage';
import { useTheme } from '@ui/theme/ThemeProvider';
import { LockScreen } from './LockScreen';
import { completeNativeForegroundPrivacyTransition } from '@native/screenSecurity';

interface ForegroundLockGateProps {
  /** Sanitized coordinator state; it never contains a password, origin, or raw error. */
  readonly bootState: BootState;
  /** False until the vault-backed App Lock choice has been read. Unknown is fail-closed. */
  readonly lockHydrated: boolean;
  readonly locked: boolean;
  /** Changes only after a successful foreground authentication decision. */
  readonly foregroundUnlockId: number;
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
  foregroundUnlockId,
  onColdUnlock,
  onWarmUnlock,
  onRetry,
  children,
}: PropsWithChildren<ForegroundLockGateProps>): React.JSX.Element {
  const theme = useTheme();
  const acknowledgedUnlockId = useRef(foregroundUnlockId);

  useEffect(() => {
    const protectedTreeVisible = bootState.status === 'ready' && lockHydrated && !locked;
    if (protectedTreeVisible && foregroundUnlockId === acknowledgedUnlockId.current) return;

    // Generic/locked trees are always safe to acknowledge. A protected tree may acknowledge only
    // a fresh biometric unlock decision; an Activity recreation remounts with the current id and
    // therefore cannot silently clear the Android 12-and-older native privacy hold.
    if (protectedTreeVisible) acknowledgedUnlockId.current = foregroundUnlockId;
    completeNativeForegroundPrivacyTransition();
  }, [bootState.runId, bootState.status, foregroundUnlockId, lockHydrated, locked]);

  if (bootState.status === 'idle' || bootState.status === 'loading') {
    return (
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
  }

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

  if (!lockHydrated) {
    return (
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
  }

  if (locked) {
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
