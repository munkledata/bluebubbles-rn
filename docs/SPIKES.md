# Phase 0 De-risking Spikes

These four spikes validate the riskiest assumptions before feature work. Each needs a
real Android device/emulator (Android SDK + JDK) or an EAS Dev Client build, so they are
**deferred** until that toolchain is available — they could not be run in the
foundation pass (which is Node-only). Each has a binary pass/fail gate.

## 1. Encrypted DB + reactive list at scale
**Goal:** prove op-sqlite + SQLCipher with a reactive query feeds a smooth list at volume.
- Seed 100k synthetic messages into an encrypted DB.
- Render a FlashList v2 bound to a reactive query (v2 has no `inverted` prop — use `maintainVisibleContentPosition={{ startRenderingFromBottom: true }}`).
- **Pass:** scroll stays ~60fps; jump-to-message works; DB file is unreadable without the key.
- If variable-height jank appears, evaluate Legend List.

## 2. Headless FCM write to the encrypted DB
**Goal:** prove a background data message can update the DB with no React tree, then notify.
- Send an FCM data message with the app force-killed.
- `setBackgroundMessageHandler` opens SQLCipher, runs `EventRouter`, writes the message,
  posts a notify-kit (`react-native-notify-kit`) notification — all from `core/` + `native/` only.
- **Pass:** message persists and the notification appears within the OS time budget; the
  same row is visible when the app is reopened.

## 3. Header-auth negotiation against the server
**Goal:** prove the auth token can move out of the URL into a header end-to-end.
- Point `HttpClient` at a modified Gator Server advertising header auth.
- **Pass:** authenticated requests succeed with `Authorization: Bearer …` and **no**
  `?guid=` in any URL; a packet/proxy capture confirms the token never appears in a URL.

## 4. libsodium crypto interop
**Goal:** confirm `react-native-libsodium` matches the test backend and (if used) the server.
- Round-trip `SecretBox.seal`/`open` on-device; decode a payload sealed by the Node backend.
- **Pass:** ciphertext from `libsodium-wrappers-sumo` (tests) opens with
  `react-native-libsodium` (device) and vice-versa; Argon2id params agree.

---

The `core/` logic these spikes exercise (event routing, crypto envelope, sync cursor,
auth header injection) is already unit-tested in Node — the spikes validate the **native
integration** around it.
