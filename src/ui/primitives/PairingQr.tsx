import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { readableTextOn, useTheme } from '../theme';
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
  // A reveal grant belongs to one exact payload revision. The opaque object changes whenever the
  // payload changes without copying the password-bearing string into component state.
  const payloadIdentity = useMemo<object>(() => ({ present: payload != null }), [payload]);
  const revocationRef = useRef(0);
  const [committedRevocation, setCommittedRevocation] = useState(0);
  const currentGrant = useMemo<object>(
    () => ({ payloadIdentity, revocation: committedRevocation }),
    [committedRevocation, payloadIdentity],
  );
  const [revealedGrant, setRevealedGrant] = useState<object | null>(null);
  const revealed = payload != null && revealedGrant === currentGrant;

  const revokeReveal = useCallback(() => {
    const next = revocationRef.current + 1;
    // Ref first: a retained pre-revocation Pressable callback is inert immediately, even before
    // React commits the state-backed generation and renders a fresh control.
    revocationRef.current = next;
    setRevealedGrant(null);
    setCommittedRevocation(next);
  }, []);

  // Hide again on blur/unfocus — the cleanup runs when this screen loses focus.
  useFocusEffect(
    useCallback(() => {
      return revokeReveal;
    }, [revokeReveal]),
  );

  // Navigation focus can remain active while Android backgrounds the app or opens Recents. Revoke
  // the credential display on that independent lifecycle too.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') revokeReveal();
    });
    return () => subscription.remove();
  }, [revokeReveal]);

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
          onPress={() => {
            if (revocationRef.current !== committedRevocation) return;
            setRevealedGrant(currentGrant);
          }}
          accessibilityRole="button"
          style={[styles.revealButton, { backgroundColor: theme.color.tint }]}
        >
          <Text style={[styles.revealText, { color: readableTextOn(theme.color.tint) }]}>
            Reveal QR Code
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  body: { alignItems: 'center', gap: 20, padding: 24 },
  warning: { fontSize: 14, lineHeight: 19, textAlign: 'center' },
  revealButton: { paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10 },
  revealText: { fontSize: 16, fontWeight: '600' },
});
