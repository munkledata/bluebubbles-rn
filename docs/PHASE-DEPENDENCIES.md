# Native Dependencies by Phase

The foundation deliberately installs only framework-agnostic libraries (zod, ky,
drizzle-orm, jest, libsodium-wrappers for tests) so the `core/` layer stays Node-testable.
Native modules are added per phase with `npx expo install` (which pins versions compatible
with the current Expo SDK) and registered as Expo config plugins in `app.config.ts`.

| Phase | Add | Purpose |
|---|---|---|
| 0 (done) | — | core SDK, schema, design tokens, tests |
| 1 — Setup & auth | `expo-secure-store`, `expo-local-authentication`, `expo-router`, `react-native-safe-area-context`, `react-native-screens`, `@react-native-firebase/app` | secure vault, biometric lock, navigation (server-URL discovery is handled by the `new-server` EventRouter path / zrok tunnel, not Firebase RTDB/Firestore) |
| 1 — Security | `react-native-libsodium`, `react-native-ssl-public-key-pinning`, `expo-build-properties` (set `usesCleartextTraffic=false`), `jail-monkey` | AEAD crypto, cert pinning, TLS posture, root check |
| 2 — DB + sync | `@op-engineering/op-sqlite` (SQLCipher build), `socket.io-client`, `@react-native-community/netinfo` | encrypted DB, realtime socket, connectivity |
| 2 — State | `zustand`, `@tanstack/react-query` | client state + server cache |
| 3/4 — Lists & gestures | `@shopify/flash-list` (swipe/long-press use RN `Animated`/`Pressable`, no Reanimated/gesture-handler) | conversation/message lists, swipe/long-press |
| 4 — Push | `@react-native-firebase/messaging`, `react-native-notify-kit` | FCM background handler, rich notifications |
| 5 — Attachments | `expo-file-system`, `expo-image`, `expo-audio`, `expo-video`, `expo-image-picker` | downloads, media, voice memos |
| 7 — Secondary | `expo-system-ui` | smart replies (JS heuristic store, no ML Kit), menus, Monet |
| 8 — Advanced | `react-native-webview` (Find My map via Leaflet/OSM) | message effects (JS particles via RN `Animated`, no Skia), Find My map |

After adding native modules, rebuild the Dev Client (config plugins change native code):
`eas build -p android --profile development` (or `npx expo run:android` with a local SDK).
