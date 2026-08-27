# Native Dependencies by Phase

The foundation deliberately installs only framework-agnostic libraries (zod, ky,
drizzle-orm, jest, libsodium-wrappers for tests) so the `core/` layer stays Node-testable.
Native modules are added per phase with `npx expo install` (which pins versions compatible
with the current Expo SDK). Packages with configuration work are registered in `app.config.ts` or
applied by Expo's default prebuild plugins; ordinary runtime/peer packages are autolinked.

| Phase | Add | Purpose |
|---|---|---|
| 0 (done) | — | core SDK, schema, design tokens, tests |
| 1 — Setup & auth | `expo-secure-store`, `expo-local-authentication`, `expo-router`, `react-native-safe-area-context`, `react-native-screens`, `@react-native-firebase/app` | secure vault, biometric lock, navigation (server-URL discovery is handled by the `new-server` EventRouter path / zrok tunnel, not Firebase RTDB/Firestore) |
| 1 — Security | `react-native-libsodium`, `expo-build-properties`, `jail-monkey` | AEAD crypto, native build configuration, root check |
| 2 — DB + sync | `@op-engineering/op-sqlite` (SQLCipher build), `socket.io-client`, ~~`@react-native-community/netinfo`~~ (dropped — never installed, zero usages as of 2026-07-17; connectivity is handled without it) | encrypted DB, realtime socket, connectivity |
| 2 — State | `zustand`, `@tanstack/react-query` | client state + server cache |
| 3/4 — Lists & gestures | `@shopify/flash-list` (swipe/long-press use RN `Animated`/`Pressable`, no Reanimated/gesture-handler) | conversation/message lists, swipe/long-press |
| 4 — Push | `@react-native-firebase/messaging`, `react-native-notify-kit` | FCM background handler, rich notifications |
| 5 — Attachments | `expo-file-system`, `expo-image`, `expo-audio`, `expo-video`, `expo-image-picker` | downloads, media, voice memos |
| 7 — Native appearance | `expo-system-ui` | applies `userInterfaceStyle: dark` and the native root background from `app.config.ts` |
| 8 — Advanced | `react-native-webview` (Find My map via Leaflet/OSM) | message effects (JS particles via RN `Animated`, no Skia), Find My map |

After adding native modules, rebuild the Dev Client locally (config plugins change native code):
`npx expo run:android` with the local Android SDK. Hosted EAS builds are not a supported project path.

## Direct packages with no app-level import

These dependencies look unused in a source-import search but are intentional root contracts. Do not remove them merely
because Expo currently hoists another copy through a transitive edge; that would make native/runtime availability depend
on package-manager layout instead of this app's manifest.

| Direct package | Owner and concrete use | Why it stays direct |
| --- | --- | --- |
| `expo-asset` | Expo's asset pipeline plus the `expo-audio` peer; app config bundles icons, splash media, and packaged assets | Expo core currently depends on it and audio declares it as a peer, but Gator owns both asset packaging and audio playback/recording |
| `expo-font` | `@expo/vector-icons` font loader; `src/ui/primitives/Icon.tsx` renders `Ionicons` throughout the app | Vector Icons and Router's `expo-symbols` declare font peer edges, so the app must provide the SDK-compatible native module explicitly |
| `expo-system-ui` | Expo's default prebuild plugin consumes `userInterfaceStyle: dark` and `backgroundColor: '#000000'` from `app.config.ts` | Removing it makes prebuild warn and stops those native root-view/style settings from being applied |
| `expo-linking` | Expo Router deep-link and scheme runtime for the `gator://` and `imessage://` schemes | `expo-router` declares `expo-linking` as a peer, so Gator owns the peer rather than relying on incidental hoisting |
| `react-native-screens` | Expo Router/React Navigation native screen hosts used by every `Stack` route | Router declares it as both a dependency and peer; keeping the SDK-bundled root version makes autolinking and native navigation explicit |

All five remain required at the root and within Expo SDK 57 compatibility ranges. `npm explain` confirms the owner edges
above. The 2026-08-27 `SDK-01` host milestone aligned the newer SDK 57 patches for `expo-asset`, `expo-linking`, and
`expo-system-ui` (along with the rest of Expo's expected patch set); dependency ownership did not change. No package was
removed in `DEPS-02`, so no removal-specific prebuild/rebuild gate was triggered; any future removal must be isolated
and run through Expo Doctor, Metro export, clean prebuild/build, and the directly affected runtime flow.
