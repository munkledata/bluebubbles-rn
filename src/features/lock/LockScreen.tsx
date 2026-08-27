import React, { useEffect, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { logger } from '@core/secure';
import { authenticate } from '@native/biometrics';
import { useLockStore } from '@state/lockStore';
import { useTheme } from '@ui/theme/ThemeProvider';

interface LockScreenProps {
  /**
   * Called after a successful biometric auth. Defaults to clearing the gate; the
   * root layout passes `completeUnlock` so a foreground cold-boot unlock also opens the DB +
   * routes. A locked headless push posts a generic notice and leaves DB work for post-unlock sync.
   */
  onUnlock?: () => void | Promise<void>;
}

/** Full-screen biometric gate shown while the app is locked. */
export function LockScreen({ onUnlock }: LockScreenProps = {}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const storeUnlock = useLockStore((s) => s.unlock);
  const [failed, setFailed] = useState(false);
  // Set when biometric auth SUCCEEDED but unlocking still failed (see below) — a different
  // situation from a failed prompt, and "Try again" would be a lie.
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const appActiveRef = useRef(AppState.currentState === 'active');
  const awaitInitialActiveRef = useRef(
    AppState.currentState !== 'active' &&
      AppState.currentState !== 'background' &&
      AppState.currentState !== 'inactive',
  );
  const authorityEpochRef = useRef(0);
  const nextAttemptRef = useRef(0);
  const inFlightAttemptRef = useRef<number | null>(null);

  /**
   * Both awaits are guarded, because an unhandled rejection here strands the user on this screen
   * with no error and no way out — this is the ONLY route past the app-lock gate.
   *
   * The two failures are NOT the same:
   *  - `authenticate()` REJECTING (native bridge throwing: changed enrolment, module missing on a
   *    stale bundle) used to skip `setFailed(true)` entirely, so the button still read "Unlock" and
   *    nothing on screen changed. Retrying is reasonable, so it is treated like a declined prompt.
   *  - `onUnlock()` REJECTING is worse. The cold-boot path passes `completeUnlock`, which OPENS
   *    THE SQLCIPHER DB; if that throws (corrupt DB, Keystore key-unwrap failure, migration error)
   *    the prompt has ALREADY succeeded, so the `else` branch below is unreachable and the user is
   *    stuck forever — pressing the button just re-prompts and fails the same silent way. Retrying
   *    cannot fix a corrupt database, so this gets its own message instead of "Try again".
   */
  const tryUnlock = async (): Promise<void> => {
    if (!mountedRef.current || !appActiveRef.current || inFlightAttemptRef.current !== null) {
      return;
    }
    const attemptId = ++nextAttemptRef.current;
    const authorityEpoch = authorityEpochRef.current;
    inFlightAttemptRef.current = attemptId;
    const isCurrentAttempt = (): boolean =>
      mountedRef.current &&
      appActiveRef.current &&
      authorityEpochRef.current === authorityEpoch &&
      inFlightAttemptRef.current === attemptId;

    setFailed(false);
    setUnlockError(null);
    try {
      let ok = false;
      try {
        ok = await authenticate('Unlock Gator');
      } catch (e) {
        if (!isCurrentAttempt()) return;
        logger.warn(`[lock] biometric prompt threw: ${e instanceof Error ? e.message : String(e)}`);
        setFailed(true);
        return;
      }
      if (!isCurrentAttempt()) return;
      if (!ok) {
        setFailed(true);
        return;
      }
      try {
        await (onUnlock ?? storeUnlock)();
        if (!isCurrentAttempt()) return;
      } catch (e) {
        if (!isCurrentAttempt()) return;
        logger.error('[lock] unlock failed after successful auth', 'sfnkpmyuai', e);
        setUnlockError('Couldn’t open your messages. Close Gator and open it again.');
      }
    } finally {
      if (inFlightAttemptRef.current === attemptId) inFlightAttemptRef.current = null;
    }
  };

  // Prompt automatically when the lock screen appears.
  useEffect(() => {
    mountedRef.current = true;
    const subscription = AppState.addEventListener('change', (state) => {
      appActiveRef.current = state === 'active';
      if (!appActiveRef.current) {
        awaitInitialActiveRef.current = false;
        authorityEpochRef.current += 1;
        return;
      }
      if (!awaitInitialActiveRef.current) return;
      awaitInitialActiveRef.current = false;
      void tryUnlock();
    });
    // Mounting the gate intentionally starts the external biometric prompt; tryUnlock's state
    // changes reflect that native prompt's result and are also shared by the retry button.
    if (appActiveRef.current) void tryUnlock();
    return () => {
      mountedRef.current = false;
      appActiveRef.current = false;
      awaitInitialActiveRef.current = false;
      authorityEpochRef.current += 1;
      subscription.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <View
      style={[styles.root, { backgroundColor: theme.color.background, paddingTop: insets.top }]}
    >
      <View style={styles.center}>
        <Text style={styles.lock}>🔒</Text>
        <Text style={[styles.title, { color: theme.color.label }]}>Gator is locked</Text>
        <Text style={[styles.sub, { color: theme.color.secondaryLabel }]}>
          {unlockError ?? 'Authenticate to continue'}
        </Text>
        <Pressable
          onPress={() => void tryUnlock()}
          style={[styles.btn, { backgroundColor: theme.color.tint }]}
          accessibilityRole="button"
        >
          <Text style={styles.btnText}>{failed ? 'Try again' : 'Unlock'}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, padding: 24 },
  lock: { fontSize: 56 },
  title: { fontSize: 22, fontWeight: '700' },
  sub: { fontSize: 15, marginBottom: 12 },
  btn: { paddingHorizontal: 28, paddingVertical: 12, borderRadius: 22, marginTop: 8 },
  btnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
