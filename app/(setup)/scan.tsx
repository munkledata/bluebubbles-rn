import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { connect } from '@/services';
import { parseSetupQr } from '@features/setup/qr';
import { useSessionStore } from '@state/sessionStore';
import { Button, Screen, useTheme } from '@ui';

export default function Scan(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const status = useSessionStore((s) => s.status);
  const connectError = useSessionStore((s) => s.error);

  useEffect(() => {
    if (status === 'connected') router.replace('/home');
    // Allow re-scanning after a failed connection.
    if (status === 'error') scanned.current = false;
  }, [status, router]);

  const onBarcodeScanned = ({ data }: BarcodeScanningResult): void => {
    if (scanned.current || status === 'connecting') return;
    try {
      const { origin, password } = parseSetupQr(data);
      scanned.current = true;
      setScanError(null);
      void connect(origin, password);
    } catch (e) {
      setScanError(e instanceof Error ? e.message : 'Invalid QR code.');
    }
  };

  if (!permission) {
    return <Screen />; // permission state loading
  }

  if (!permission.granted) {
    return (
      <Screen>
        <View
          style={[
            styles.permission,
            { paddingTop: insets.top + 64, paddingBottom: insets.bottom + 24 },
          ]}
        >
          <Text style={[styles.permTitle, { color: theme.color.label }]}>Camera access needed</Text>
          <Text style={[styles.permText, { color: theme.color.secondaryLabel }]}>
            Allow camera access to scan your server’s setup QR code.
          </Text>
          <Button title="Grant Camera Access" onPress={() => void requestPermission()} />
          <Button
            title="Enter Manually"
            variant="plain"
            onPress={() => router.replace('/manual')}
            style={styles.spaced}
          />
        </View>
      </Screen>
    );
  }

  const message = scanError ?? connectError;

  return (
    <View style={styles.flex}>
      <CameraView
        style={styles.flex}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={onBarcodeScanned}
      />
      <View
        style={[styles.overlay, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}
      >
        <Text style={styles.hint}>
          {status === 'connecting' ? 'Connecting…' : 'Point your camera at the server QR code'}
        </Text>
        <View style={styles.reticle} />
        {message ? <Text style={styles.error}>{message}</Text> : <View />}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  permission: { flex: 1, justifyContent: 'center', paddingHorizontal: 24 },
  permTitle: { fontSize: 26, fontWeight: '700', marginBottom: 12 },
  permText: { fontSize: 16, lineHeight: 22, marginBottom: 24 },
  spaced: { marginTop: 8 },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  hint: { color: '#FFFFFF', fontSize: 16, textAlign: 'center', paddingHorizontal: 24 },
  reticle: {
    width: 240,
    height: 240,
    borderWidth: 3,
    borderColor: '#FFFFFF',
    borderRadius: 24,
  },
  error: {
    color: '#FFFFFF',
    backgroundColor: '#FF3B30CC',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
    marginHorizontal: 24,
    textAlign: 'center',
  },
});
