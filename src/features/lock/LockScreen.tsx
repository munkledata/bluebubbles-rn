import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { authenticate } from '@native/biometrics';
import { useLockStore } from '@state/lockStore';
import { useTheme } from '@ui';

interface LockScreenProps {
  /**
   * Called after a successful biometric auth. Defaults to clearing the gate; the
   * root layout passes `completeUnlock` so a cold-boot unlock also opens the DB +
   * routes (the SQLCipher key is withheld until this runs).
   */
  onUnlock?: () => void | Promise<void>;
}

/** Full-screen biometric gate shown while the app is locked. */
export function LockScreen({ onUnlock }: LockScreenProps = {}): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const storeUnlock = useLockStore((s) => s.unlock);
  const [failed, setFailed] = useState(false);

  const tryUnlock = async (): Promise<void> => {
    setFailed(false);
    const ok = await authenticate('Unlock Gator');
    if (ok) await (onUnlock ?? storeUnlock)();
    else setFailed(true);
  };

  // Prompt automatically when the lock screen appears.
  useEffect(() => {
    void tryUnlock();
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
          Authenticate to continue
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
