/**
 * FaceTimeWebView (src/ui/facetime/FaceTimeWebView.tsx): the embedded FaceTime-web client. This
 * suite locks in the WebView PROPS CONTRACT the source configures (the parts that make FaceTime-web
 * actually work):
 *   - the join `source.uri` is the passed `uri`;
 *   - a spoofed current Chrome-on-Android User-Agent (FaceTime-web rejects the bare System WebView);
 *   - `originWhitelist: ['*']` (join redirects across apple.com subdomains);
 *   - autoplay/inline media so the call connects without a user gesture
 *     (mediaPlaybackRequiresUserAction=false, allowsInlineMediaPlayback, allowsProtectedMedia);
 *   - JS + DOM storage enabled; the capture-grant hint;
 *   - and the runtime CAMERA/RECORD_AUDIO permission request is GUARDED to android (no request on
 *     the default ios test platform; issued when forced to android).
 *
 * In-file mock: `react-native-webview` — the real default export is a native component. Swap it for
 * a marker host View that re-exposes every prop it received via a testID node, so the test reads the
 * contract straight off the rendered node's props (no mock-variable capture needed).
 */
import React from 'react';
import { Platform, PermissionsAndroid } from 'react-native';
import { renderWithTheme, screen } from '../support/renderWithTheme';
import { FaceTimeWebView } from '@ui/facetime/FaceTimeWebView';

jest.mock('react-native-webview', () => {
  const ReactLocal = require('react');
  const { View } = require('react-native');
  return {
    __esModule: true,
    default: (props: Record<string, unknown>) =>
      ReactLocal.createElement(View, { testID: 'webview', ...props }),
  };
});

const URI = 'https://facetime.apple.com/join#session-token';

describe('FaceTimeWebView — props contract', () => {
  it('configures the WebView for FaceTime-web (uri, UA spoof, media autoplay, storage)', async () => {
    await renderWithTheme(<FaceTimeWebView uri={URI} />);
    const props = screen.getByTestId('webview').props as Record<string, unknown>;

    expect(props.source).toEqual({ uri: URI });
    // Spoofed current Chrome-on-Android UA (bare System WebView UA is rejected).
    expect(String(props.userAgent)).toContain('Chrome/');
    expect(String(props.userAgent)).toContain('Android');
    expect(props.originWhitelist).toEqual(['*']);
    expect(props.javaScriptEnabled).toBe(true);
    expect(props.domStorageEnabled).toBe(true);
    // Connect immediately: inline autoplay without a user gesture.
    expect(props.mediaPlaybackRequiresUserAction).toBe(false);
    expect(props.allowsInlineMediaPlayback).toBe(true);
    expect(props.allowsProtectedMedia).toBe(true);
    expect(props.mediaCapturePermissionGrantValue).toBe('grant');
  });
});

describe('FaceTimeWebView — runtime permission request is android-guarded', () => {
  it('does NOT request permissions on the (default) ios platform', async () => {
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({} as never);
    await renderWithTheme(<FaceTimeWebView uri={URI} />);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('requests CAMERA + RECORD_AUDIO on android', async () => {
    const originalOS = Platform.OS;
    // Platform.OS is a plain settable property on the RN mock.
    (Platform as { OS: string }).OS = 'android';
    const spy = jest.spyOn(PermissionsAndroid, 'requestMultiple').mockResolvedValue({} as never);
    try {
      await renderWithTheme(<FaceTimeWebView uri={URI} />);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith([
        PermissionsAndroid.PERMISSIONS.CAMERA,
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO,
      ]);
    } finally {
      (Platform as { OS: string }).OS = originalOS;
      spy.mockRestore();
    }
  });
});
