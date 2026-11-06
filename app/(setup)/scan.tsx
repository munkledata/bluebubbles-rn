import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Linking, StyleSheet, Text, View } from 'react-native';
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
  const [permission, requestPermission, getPermission] = useCameraPermissions();
  const scanned = useRef(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [insecureCode, setInsecureCode] = useState(false);
  const [awaitingRescan, setAwaitingRescan] = useState(false);
  // A scanned code waits for the user to confirm the server it names. A QR code is just a picture:
  // one on a poster or in a chat would otherwise hand this phone's password to whatever address it
  // chose the moment the camera saw it.
  const [pending, setPending] = useState<{ origin: string; password: string } | null>(null);
  const status = useSessionStore((s) => s.status);
  const connectError = useSessionStore((s) => s.error);

  useEffect(() => {
    if (status === 'connected') router.replace('/syncing');
    // A failed connection waits for Scan Again. Re-arming at once retried the same code in a loop
    // while it stayed in view, so its error (and the Forget action) kept vanishing.
    if (status === 'error' && scanned.current) setAwaitingRescan(true);
  }, [status, router]);

  // Coming back from Android Settings: read the camera permission again.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void getPermission?.();
    });
    return () => subscription.remove();
  }, [getPermission]);

  const scanAgain = (): void => {
    scanned.current = false;
    setAwaitingRescan(false);
    setScanError(null);
    setPending(null);
  };

  const connectPending = (): void => {
    if (!pending) return;
    setPending(null);
    void connect(pending.origin, pending.password);
  };

  const onBarcodeScanned = ({ data }: BarcodeScanningResult): void => {
    if (scanned.current || status === 'connecting') return;
    try {
      const { origin, password } = parseSetupQr(data);
      // connect() refuses http:// before it reports 'connecting', so scanning would stay locked.
      // Insecure connections are allowed only by the explicit switch on the Manual screen.
      if (/^http:\/\//i.test(origin)) {
        setInsecureCode(true);
        setScanError(i18n.text('scan.error.insecure'));
        return;
      }
      scanned.current = true;
      setInsecureCode(false);
      setScanError(null);
      setPending({ origin, password });
    } catch (error) {
      setInsecureCode(false);
      setScanError(scanErrorText(i18n, error));
    }
  };

  if (!permission) {
    return <Screen />; // permission state loading
  }

  if (!permission.granted) {
    // Once Android stops asking ("Don't allow" twice), only Settings can grant the camera.
    const blocked = permission.canAskAgain === false;
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
            {blocked
              ? i18n.format('scan.permission.blocked', { appName: i18n.text('welcome.brand') })
              : i18n.text('scan.permission.message')}
          </Text>
          {blocked ? (
            <Button
              title={i18n.text('scan.permission.action.settings')}
              onPress={() => void Linking.openSettings()}
            />
          ) : (
            <Button
              title={i18n.text('scan.permission.action.grant')}
              onPress={() => void requestPermission()}
            />
          )}
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
        {pending ? (
          <View
            style={[styles.confirm, { backgroundColor: theme.color.secondaryBackground }]}
            accessibilityRole="alert"
          >
            <Text style={[styles.confirmTitle, { color: theme.color.label }]}>
              {i18n.text('scan.confirm.title')}
            </Text>
            {/* The host only: never the password, and never the raw QR text. */}
            <Text style={[styles.confirmHost, { color: theme.color.secondaryLabel }]}>
              {hostOf(pending.origin)}
            </Text>
            <Button title={i18n.text('scan.confirm.action.connect')} onPress={connectPending} />
            <Button
              title={i18n.text('scan.action.scanAgain')}
              variant="plain"
              onPress={scanAgain}
              style={styles.spaced}
            />
          </View>
        ) : null}
        {message ? <Text style={styles.error}>{message}</Text> : <View />}
        {awaitingRescan && status === 'error' ? (
          <Button
            title={i18n.text('scan.action.scanAgain')}
            onPress={scanAgain}
            style={styles.spaced}
          />
        ) : null}
        {insecureCode && scanError ? (
          <Button
            title={i18n.text('scan.action.manual')}
            variant="plain"
            onPress={() => router.replace('/manual')}
            style={styles.spaced}
          />
        ) : null}
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

/** The address the user is about to trust, shown without scheme, path or credentials. */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  confirm: { borderRadius: 16, padding: 16, marginVertical: 12, gap: 8 },
  confirmTitle: { fontSize: 18, fontWeight: '700' },
  confirmHost: { fontSize: 16, marginBottom: 8 },
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
