import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  connect,
  disconnectFailureMessage,
  forgetOnThisPhoneOnly,
  PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE,
  previousUnrevokedServerOrigin,
} from '@/services';
import { parseSetupQr, SetupQrParseError, type SetupQrParseErrorCode } from '@features/setup/qr';
import { useSessionStore } from '@state/sessionStore';
import { Button, Screen, useTheme } from '@ui';
import { ForgetPreviousServerAction } from '@ui/connection';
import { createI18n, type I18n, type TranslationKey } from '@utils/i18n';

const SCAN_ERROR_KEYS = {
  empty: 'scan.error.empty',
  'invalid-json': 'scan.error.invalidJson',
  'invalid-shape': 'scan.error.invalidShape',
  'missing-credentials': 'scan.error.missingCredentials',
} satisfies Record<SetupQrParseErrorCode, TranslationKey>;

function scanErrorText(i18n: I18n, error: unknown): string {
  if (!(error instanceof SetupQrParseError)) return i18n.text('scan.error.invalid');
  return i18n.format(SCAN_ERROR_KEYS[error.code], {
    appName: i18n.text('welcome.brand'),
  });
}

export default function Scan(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const i18n = useMemo(() => createI18n(), []);
  const [permission, requestPermission] = useCameraPermissions();
  const scanned = useRef(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const status = useSessionStore((s) => s.status);
  const connectError = useSessionStore((s) => s.error);

  useEffect(() => {
    if (status === 'connected') router.replace('/syncing');
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
    } catch (error) {
      setScanError(scanErrorText(i18n, error));
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
          <Text style={[styles.permTitle, { color: theme.color.label }]}>
            {i18n.text('scan.permission.title')}
          </Text>
          <Text style={[styles.permText, { color: theme.color.secondaryLabel }]}>
            {i18n.text('scan.permission.message')}
          </Text>
          <Button
            title={i18n.text('scan.permission.action.grant')}
            onPress={() => void requestPermission()}
          />
          <Button
            title={i18n.text('scan.action.manual')}
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
          {i18n.text(
            status === 'connecting' ? 'scan.status.connecting' : 'scan.instruction.pointCamera',
          )}
        </Text>
        <View style={styles.reticle} />
        {message ? <Text style={styles.error}>{message}</Text> : <View />}
        {!scanError && connectError === PREVIOUS_CREDENTIAL_UNREVOKED_MESSAGE ? (
          <ForgetPreviousServerAction
            previousServerOrigin={previousUnrevokedServerOrigin}
            forgetOnThisPhoneOnly={forgetOnThisPhoneOnly}
            failureMessage={disconnectFailureMessage}
          />
        ) : null}
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
