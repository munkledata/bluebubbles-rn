import type { ExpoConfig } from 'expo/config';

import pkg from './package.json';

const DEVELOPMENT_ANDROID_ARCHITECTURES = 'arm64-v8a,x86_64';
const androidArchitectures =
  process.env.GATOR_ANDROID_ARCHITECTURES ?? DEVELOPMENT_ANDROID_ARCHITECTURES;

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
  // Single source of truth for the user-visible version is package.json. The release runner applies
  // the chosen version only inside an isolated Git worktree; it never mutates the shared checkout.
  // The Play versionCode is managed remotely by EAS (autoIncrement).
  version: pkg.version,
  orientation: 'portrait',
  icon: './assets/icon.png',
  // THEME-01A: the shipped product is dark-only. Keep native Android surfaces on the
  // same appearance before React mounts instead of following the phone's light setting.
  userInterfaceStyle: 'dark',
  backgroundColor: '#000000',
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
    // Opt into Android's current back dispatcher. Route-level authored-data guards use
    // Expo Router's native-stack prevention so protected authored-data routes do not silently
    // drop work on a committed Back.
    // Interactive preview/progress still depends on the installed RN/Router native stack and
    // remains an exact-device verification item (ANDROID-02).
    predictiveBackGestureEnabled: true,
    // No adb/device-transfer backups (SEC-6): the SQLCipher key lives in the Android Keystore
    // and never leaves the device, so a restored DB would be undecryptable anyway. This must be
    // the top-level Expo android option; expo-build-properties has no allowBackup setting.
    allowBackup: false,
    // RECORD_AUDIO + MODIFY_AUDIO_SETTINGS: the composer records voice messages; CAMERA is
    // declared by expo-camera for setup QR scanning and composer photo capture.
    // All need a native rebuild to take effect.
    permissions: [
      // Keep the API 33+ runtime notification permission as an explicit product contract even
      // though the current notify-kit version also merges it transitively.
      'android.permission.POST_NOTIFICATIONS',
      'android.permission.RECORD_AUDIO',
      'android.permission.MODIFY_AUDIO_SETTINGS',
    ],
    // Keep permissions that transitive config plugins may merge out of the final manifest.
    // Contacts are read-only; the attachment tray browses photos/videos, never the music library.
    blockedPermissions: [
      'android.permission.WRITE_CONTACTS',
      'android.permission.READ_MEDIA_AUDIO',
      // Incoming FaceTime remains an actionable high-importance heads-up notification. Never let
      // a notification dependency restore automatic full-screen launch.
      'android.permission.USE_FULL_SCREEN_INTENT',
      // Dev tooling and notify-kit merge these special permissions transitively. Production
      // Gator never draws over other apps or requests Do Not Disturb policy access.
      'android.permission.SYSTEM_ALERT_WINDOW',
      'android.permission.ACCESS_NOTIFICATION_POLICY',
      // Gator reminders deliberately use SET_AND_ALLOW_WHILE_IDLE (inexact). The notification
      // library declares exact-alarm access transitively, but no app flow needs that special grant.
      'android.permission.SCHEDULE_EXACT_ALARM',
      'android.permission.USE_EXACT_ALARM',
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
    'expo-image',
    // Cold-start splash: black background (matches the default oled-dark theme + the welcome
    // screen) with the gator icon, so launching a closed app no longer flashes white. Same
    // color in OS light + dark. The config plugin is the SDK 57 way (legacy `splash` keys are
    // deprecated); backgroundColor controls res/values/colors.xml `splashscreen_background`.
    // Android 12+ masks windowSplashScreenAnimatedIcon into a circle (inner ~2/3 safe zone),
    // so `splash-icon.png` is a safe-zone-padded CIRCULAR gator badge (the gator sits within
    // ~64% of the canvas with transparent margins) — a full-bleed icon gets clipped on all four
    // sides. imageWidth = 288 (the full A12 icon canvas dp) renders the already-padded source
    // 1:1 so the baked padding is preserved on a clean rebuild.
    [
      'expo-splash-screen',
      {
        backgroundColor: '#000000',
        image: './assets/splash-icon.png',
        imageWidth: 288,
        resizeMode: 'contain',
        dark: { backgroundColor: '#000000', image: './assets/splash-icon.png' },
      },
    ],
    // Injects the dedicated Android notification status-bar icon (ic_stat_gator) into the
    // regenerated native res/ folders at prebuild. See plugins/withNotificationIcon.js.
    './plugins/withNotificationIcon',
    // Inbound Android sharing is deliberately NOT configured here. `expo-share-intent@8.0.1`
    // performs provider reads and an unbounded cache copy before JavaScript can enforce file,
    // aggregate, or time limits. Until an owned bounded native intake replaces it, the release
    // manifest must contain neither ACTION_SEND filters nor a Direct Share declaration (IPC-01).
    // Keep production arm64-v8a-only to bound the release compile, but retain x86_64 in
    // development/preview so the supported emulator path actually exists. EAS profile `env`
    // values are available while this dynamic config is evaluated; a plain local prebuild has no
    // selected profile and deliberately defaults to the development list above.
    ['./plugins/withArm64Only', { architectures: androidArchitectures }],
    // FCM push: the firebase plugin wires google-services.json + the messaging SDK
    // into the native build (the receive pipeline is already in JS).
    '@react-native-firebase/app',
    '@react-native-firebase/messaging',
    // react-native-notify-kit is autolinked (no config plugin needed here — the plugin is
    // only for iOS extensions / Android foregroundService, neither of which this app uses;
    // the native core compiles from source). POST_NOTIFICATIONS is also declared explicitly in
    // android.permissions above rather than relying only on the library merge. No Google Play
    // Services required.
    // Background catch-up sync (WorkManager).
    'expo-task-manager',
    'expo-background-task',
    [
      'expo-camera',
      {
        // Setup QR scanning and composer photo capture; no microphone.
        cameraPermission:
          'Gator uses the camera to scan your server’s setup QR code and take photos for conversations.',
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
        granularPermissions: ['photo', 'video'],
      },
    ],
    [
      'expo-contacts',
      {
        // Requested only by explicit contact actions (Sync Contacts or Send Contact); adds
        // READ_CONTACTS. Automatic startup sync checks an existing grant without prompting.
        contactsPermission:
          'Gator uses your contacts to show names and photos for your conversations.',
      },
    ],
    '@react-native-community/datetimepicker',
    // expo-web-browser began shipping a config plugin in SDK 57.0.2 and now requires explicit
    // registration (`expo install --fix` can't add it itself — it refuses to edit a dynamic
    // TypeScript config, so this is a manual step on every such bump). Used by the FaceTime
    // in-app browser tab (`src/features/facetime/useFaceTime.ts`).
    'expo-web-browser',
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
