import type { ExpoConfig } from 'expo/config';

import pkg from './package.json';

/**
 * Expo app config (Android-only target, iOS-styled UI).
 *
 * Native modules are added incrementally per the phased roadmap; each installed
 * one that needs native config is registered in `plugins` below.
 */
const config: ExpoConfig = {
  name: 'Gator',
  slug: 'bluegreengatorappsmessages',
  // EAS account/org that owns the build/project (matches the app package + Firebase
  // project naming; your personal `bluegreengator` account is the alternative).
  owner: 'bluegreengatorapps',
  // Single source of truth for the user-visible version is package.json; the
  // release:android[:local] scripts bump it (npm version patch) on every release.
  // The Play versionCode is separate and managed remotely by EAS (autoIncrement).
  version: pkg.version,
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  // Deep-link / protocol activation scheme (mirrors the Flutter app's imessage:// handling).
  scheme: ['gator', 'imessage'],
  assetBundlePatterns: ['**/*'],
  android: {
    package: 'com.bluegreengatorapps.messages',
    // FCM (Firebase Cloud Messaging): the Firebase Android config. Place
    // `google-services.json` (from the Firebase console, package
    // com.bluegreengatorapps.messages) in the repo root, or set GOOGLE_SERVICES_JSON to
    // a file secret for EAS builds. The native build FAILS without this file.
    googleServicesFile: process.env.GOOGLE_SERVICES_JSON ?? './google-services.json',
    predictiveBackGestureEnabled: false,
    // USE_FULL_SCREEN_INTENT (Android 14+): the incoming-FaceTime full-screen-intent
    // notification degrades to heads-up without it.
    // RECORD_AUDIO + MODIFY_AUDIO_SETTINGS: the in-app FaceTime call WebView needs mic
    // capture (getUserMedia); CAMERA is already declared by the expo-camera plugin.
    // REQUEST_IGNORE_BATTERY_OPTIMIZATIONS: lets the Settings "Disable battery optimization"
    // action show the one-tap OS allow-dialog (via expo-intent-launcher) instead of only the
    // battery-optimization list — for reliable background FCM/notification delivery under Doze.
    // All need a native rebuild to take effect.
    permissions: [
      'android.permission.USE_FULL_SCREEN_INTENT',
      // notify-kit does NOT auto-merge POST_NOTIFICATIONS (notifee did), so add it
      // explicitly for the API 33+ runtime notification permission.
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
      'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
    ],
    adaptiveIcon: {
      backgroundColor: '#193154',
      foregroundImage: './assets/android-icon-foreground.png',
      backgroundImage: './assets/android-icon-background.png',
      monochromeImage: './assets/android-icon-monochrome.png',
    },
  },
  plugins: [
    'expo-router',
    'expo-secure-store',
    // FCM push: the firebase plugin wires google-services.json + the messaging SDK
    // into the native build (the receive pipeline is already in JS).
    '@react-native-firebase/app',
    '@react-native-firebase/messaging',
    // react-native-notify-kit is autolinked (no config plugin needed here — the plugin is
    // only for iOS extensions / Android foregroundService, neither of which this app uses;
    // the native core compiles from source). Unlike notifee it does NOT auto-merge
    // POST_NOTIFICATIONS, so that permission is declared explicitly in android.permissions
    // above. No Google Play Services required.
    // Android share-target: registers SEND / SEND_MULTIPLE intent filters so Gator appears in the
    // system share sheet for text, images, video, AND any file (*/*, e.g. a PDF from Downloads).
    // iOS share extension disabled — this is an Android-only app. Needs a native rebuild.
    [
      'expo-share-intent',
      {
        disableIOS: true,
        androidIntentFilters: ['text/*', 'image/*', 'video/*', '*/*'],
        androidMultiIntentFilters: ['image/*', 'video/*', '*/*'],
      },
    ],
    // Background catch-up sync (WorkManager).
    'expo-task-manager',
    'expo-background-task',
    [
      'expo-camera',
      {
        // QR-code setup scanning only; no microphone.
        cameraPermission: 'Gator uses the camera to scan your server’s setup QR code.',
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission:
          'Gator needs access to your photos so you can send images in your conversations.',
      },
    ],
    [
      'expo-video',
      {
        // In-bubble + fullscreen video playback only; no background/PiP.
        supportsBackgroundPlayback: false,
        supportsPictureInPicture: false,
      },
    ],
    'expo-sharing',
    [
      'expo-audio',
      {
        // Voice-memo recording (the in-bubble player needs no permission).
        microphonePermission: 'Gator uses the microphone to record voice messages.',
      },
    ],
    [
      'expo-media-library',
      {
        // Save-to-gallery AND the inline attachment tray, which browses recent photos/videos
        // (getAssetsAsync). The plugin adds the Android READ_MEDIA_IMAGES/VIDEO perms by default.
        savePhotosPermission:
          'Gator needs permission to save photos and videos from your conversations to your gallery.',
        photosPermission:
          'Gator needs access to your photos so you can attach them to conversations.',
        isAccessMediaLocationEnabled: false,
      },
    ],
    [
      'expo-contacts',
      {
        // Requested only on an explicit "Sync Contacts" tap; adds READ_CONTACTS.
        contactsPermission:
          'Gator uses your contacts to show names and photos for your conversations.',
      },
    ],
    '@react-native-community/datetimepicker',
    [
      'expo-build-properties',
      {
        android: {
          // Cleartext HTTP is permitted at the OS level so the app CAN reach a direct-LAN
          // server over http:// (Android API 28+ blocks cleartext by default, which made
          // direct-LAN connections impossible). It is NOT used blindly: connect() default-DENIES
          // http:// origins and only proceeds when the user explicitly enables the per-connection
          // "Allow insecure connection" toggle (services/index.ts + the manual-setup screen).
          // HTTPS / a tunnel remains the recommended path, especially for remote access.
          usesCleartextTraffic: true,
          // No adb/device-transfer backups (SEC-6): the SQLCipher key lives in the Android
          // Keystore and never leaves the device, so a backed-up DB is undecryptable anyway —
          // but message metadata and the kv table shouldn't ride along in a backup either.
          allowBackup: false,
          minSdkVersion: 24,
          // react-native-notify-kit needs no extraMavenRepos: since 9.2.0 the native
          // core compiles from source (autolinked), so the old notifee local-AAR maven
          // repo workaround is gone.
        },
      },
    ],
  ],
  experiments: {
    // Disabled until the dev server generates route types; we use string hrefs.
    typedRoutes: false,
  },
  extra: {
    eas: {
      projectId: '1acb4aee-0769-4d59-81e9-ffe0c302af94',
    },
  },
};

export default config;
