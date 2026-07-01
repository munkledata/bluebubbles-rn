import type { ExpoConfig } from 'expo/config';

/**
 * Expo app config (Android-only target, iOS-styled UI).
 *
 * Native modules are added incrementally per the phased roadmap; each installed
 * one that needs native config is registered in `plugins` below.
 */
const config: ExpoConfig = {
  name: 'BlueBubbles',
  slug: 'bluegreengatorappsmessages',
  // EAS account/org that owns the build/project (matches the app package + Firebase
  // project naming; your personal `bluegreengator` account is the alternative).
  owner: 'bluegreengatorapps',
  version: '0.1.0',
  orientation: 'portrait',
  icon: './assets/icon.png',
  userInterfaceStyle: 'automatic',
  // Deep-link / protocol activation scheme (mirrors the Flutter app's imessage:// handling).
  scheme: ['bluebubbles', 'imessage'],
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
    // All need a native rebuild to take effect.
    permissions: [
      'android.permission.USE_FULL_SCREEN_INTENT',
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
    ],
    adaptiveIcon: {
      backgroundColor: '#4990de',
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
    // Notifee is autolinked (no config plugin); it adds POST_NOTIFICATIONS at build
    // time. No Google Play Services required.
    // Background catch-up sync (WorkManager).
    'expo-task-manager',
    'expo-background-task',
    [
      'expo-camera',
      {
        // QR-code setup scanning only; no microphone.
        cameraPermission: 'BlueBubbles uses the camera to scan your server’s setup QR code.',
        recordAudioAndroid: false,
      },
    ],
    [
      'expo-image-picker',
      {
        photosPermission:
          'BlueBubbles needs access to your photos so you can send images in your conversations.',
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
        microphonePermission: 'BlueBubbles uses the microphone to record voice messages.',
      },
    ],
    [
      'expo-media-library',
      {
        // Save-to-gallery AND the inline attachment tray, which browses recent photos/videos
        // (getAssetsAsync). The plugin adds the Android READ_MEDIA_IMAGES/VIDEO perms by default.
        savePhotosPermission:
          'BlueBubbles needs permission to save photos and videos from your conversations to your gallery.',
        photosPermission:
          'BlueBubbles needs access to your photos so you can attach them to conversations.',
        isAccessMediaLocationEnabled: false,
      },
    ],
    [
      'expo-contacts',
      {
        // Requested only on an explicit "Sync Contacts" tap; adds READ_CONTACTS.
        contactsPermission:
          'BlueBubbles uses your contacts to show names and photos for your conversations.',
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
          minSdkVersion: 24,
          // Notifee ships its `app.notifee:core` AAR as a local maven repo; register
          // it so `:app` can resolve it. The url resolves relative to the :app project
          // dir (android/app), so two levels up reaches the project-root node_modules.
          extraMavenRepos: ['../../node_modules/@notifee/react-native/android/libs'],
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
