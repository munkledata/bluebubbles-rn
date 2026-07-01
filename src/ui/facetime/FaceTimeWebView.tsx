import { useEffect } from 'react';
import { PermissionsAndroid, Platform, StyleSheet } from 'react-native';
import WebView from 'react-native-webview';

// FaceTime-for-web gates on a supported browser; the bare Android System WebView UA is
// rejected, so spoof a current Chrome-on-Android UA. (Verify on-device — Apple may also
// probe capabilities beyond the UA.)
const CHROME_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

/**
 * The embedded FaceTime-web client. Imported lazily (it pulls in the native
 * react-native-webview module) so a build that hasn't linked it yet falls back to the
 * system browser via the overlay's LoadErrorBoundary instead of crashing.
 */
export function FaceTimeWebView({ uri }: { uri: string }): React.JSX.Element {
  useEffect(() => {
    // getUserMedia in the WebView needs the app to hold CAMERA + RECORD_AUDIO at runtime;
    // react-native-webview then grants the page's permission request.
    if (Platform.OS !== 'android') return;
    void PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.CAMERA,
      PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
    ]);
  }, []);

  return (
    <WebView
      source={{ uri }}
      style={styles.flex}
      // FaceTime redirects across apple.com subdomains during join.
      originWhitelist={['*']}
      userAgent={CHROME_UA}
      javaScriptEnabled
      domStorageEnabled
      // Start media without a user gesture so the call connects immediately.
      mediaPlaybackRequiresUserAction={false}
      allowsInlineMediaPlayback
      // iOS-only (Android-only target, but harmless): grant capture without a prompt.
      mediaCapturePermissionGrantValue="grant"
      allowsProtectedMedia
    />
  );
}

const styles = StyleSheet.create({ flex: { flex: 1, backgroundColor: '#000' } });
