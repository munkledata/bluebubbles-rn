import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { useTheme } from '../theme';
import { QrCode } from './QrCode';

/**
 * Reveal-gated pairing QR (used by Server Management → Show Pairing QR).
 *
 * The payload embeds the server password, so the code is NEVER rendered by
 * default: the user must tap "Reveal QR Code" past a one-line warning, and the
 * reveal is dropped again whenever the screen loses focus (useFocusEffect
 * cleanup) so navigating away doesn't leave the secret on screen. The payload
 * itself must never be logged (it never touches logger/console here).
 */
export interface PairingQrProps {
  /** The full setup payload (see buildSetupQr) — or null when credentials are missing. */
  payload: string | null;
}

export function PairingQr({ payload }: PairingQrProps): React.JSX.Element {
  const theme = useTheme();
  const [revealed, setRevealed] = useState(false);

  // Hide again on blur/unfocus — the cleanup runs when this screen loses focus.
  useFocusEffect(
    useCallback(() => {
      return () => setRevealed(false);
    }, []),
  );

  if (!payload) {
    return (
      <View style={styles.body}>
        <Text style={[styles.warning, { color: theme.color.secondaryLabel }]}>
          Connect to a server first — there are no credentials to share yet.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.body}>
      <Text style={[styles.warning, { color: theme.color.secondaryLabel }]}>
        Anyone who scans this code gets full access to your server. Only show it to a device you
        trust.
      </Text>
      {revealed ? (
        <QrCode value={payload} size={260} testID="pairing-qr-code" />
      ) : (
        <Pressable
          onPress={() => setRevealed(true)}
          accessibilityRole="button"
          style={[styles.revealButton, { backgroundColor: theme.color.tint }]}
        >
          <Text style={styles.revealText}>Reveal QR Code</Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: 'center', gap: 20, padding: 24 },
  warning: { fontSize: 14, lineHeight: 19, textAlign: 'center' },
  revealButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 },
  revealText: { color: '#FFFFFF', fontSize: 16, fontWeight: '600' },
});
