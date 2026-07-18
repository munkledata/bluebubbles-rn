# Release Checklist

> **STATUS UPDATE (2026-07-17):** This doc is largely SUPERSEDED. The app is now on **Expo SDK 57 /
> RN 0.86** (notifee → react-native-notify-kit, zod 4, RNFB 25 — see
> `docs/REACT_PATTERNS_AUDIT_2026-07-16.md`), and many boxes below were completed after they were
> written: the FCM glue file exists (`src/services/notifications/fcmMessaging.ts`), the firebase
> packages are installed, §3.2 swipe actions, §4.4 group add/remove/rename UI, §5.2 audio playback /
> voice recording / document send / share-intent receive, and §9.3's Find My map (shipped keylessly
> via WebView/Leaflet — no Maps key needed) are all DONE — each is ticked/annotated in place below.
> What genuinely remains: on-device verification (`docs/DEVICE_VERIFICATION_CHECKLIST.md`) and the
> credential-gated items (Sentry DSN, cert-pin SPKI hash, EAS/Play signup).

> **STATUS UPDATE (2026-06-30):** Code foundations are complete; several checkboxes below are STALE.
> **FCM is fully wired** (firebase app+messaging, `google-services.json`, `FCM_ENABLED=true`,
> background handler at module top, **AES-256-GCM encrypted-payload decrypt**) — the §0.2 "blocked"
> FCM items are done. §4.4 group management, §5.2 audio/voice/document, and §8.4 DB-key rotation are
> DONE. The large remaining bucket is **needs-device / EAS** (builds, native rebuilds, on-device
> spikes) plus credential-gated items (Sentry DSN, Maps key, cert-pin hash). NOTE: `repositories.ts`
> was split into a **`src/db/repositories/` directory** — links below to `./src/db/repositories.ts`
> point at the moved file. Test counts here are historical (current: **104 suites / 532 tests**).

Two tiers of remaining work:

- **Phase 0 — critical path to a *working* app** (below): FCM push, the crypto backend, and live-server
  connectivity. These gate "the app actually delivers messages and is secure." See
  [GAP_ANALYSIS.md](./GAP_ANALYSIS.md) for the full rationale.
- **Phase 9 — release infra** (further down): EAS build and Sentry — each blocked on one external
  credential. (The Find My map is no longer blocked — see §9.3, shipped keylessly.)

Where an item is "done in code," the wiring is committed and tested; only a credential, a native
rebuild, or your server is left. Don't stub a fake secret — surface the blocker.

---

# Phase 0 — critical path

## 0.1 Crypto backend (XChaCha20-Poly1305 + Argon2id) — **done in code; needs a native rebuild**

The AEAD backend is now implemented and tested — the Critical "crypto unwired" gap is closed in code.

**Already done:**
- `react-native-libsodium` installed; [src/native/crypto.ts](./src/native/crypto.ts) implements the
  production `CryptoBackend` (a 1:1 mirror of the test backend, loaded via a deferred dynamic import so
  it never touches native at startup).
- [getSecretBox()](./src/services/index.ts) lazily builds the `SecretBox` at the composition root;
  [runCryptoSelfTest()](./src/services/index.ts) is a device round-trip + tamper-reject proof.
- [test/native/crypto.test.ts](./test/native/crypto.test.ts) round-trips the real arg-wiring through
  XChaCha20-Poly1305 + Argon2id (3 tests, green).

**Left to do (you):**
- [ ] Approve the `react-native-libsodium` install script (its postinstall extracts the native build):
      `npm rebuild react-native-libsodium` (or your `allow-scripts`/CI flow) before building.
- [ ] **Native rebuild** so the native module links (`eas build --profile development` or
      `npx expo run:android`) — libsodium is a native module; a JS reload won't activate it.
- [ ] On the rebuilt app, call `runCryptoSelfTest()` once (wire it to a dev button) → expect
      `{ ok: true, detail: 'round-trip + tamper-reject OK' }`. That's the Phase 0 device proof.
- [ ] _(optional, Phase 1)_ Use `getSecretBox()` to wrap the SQLCipher DB key behind the app-lock
      biometric. Today the DB key is already safe (random, Keystore-only); wrapping ties to app-lock.

> Note: `SecretBox` is XChaCha20-Poly1305, **not** the Flutter server's legacy AES-256-CBC. It does not
> interop with a server that AES-encrypts socket payloads — rely on TLS for transport, `SecretBox` for
> at-rest. (Most servers don't enable payload encryption.)

## 0.2 FCM push / killed-app delivery — **needs `google-services.json` (+ a native rebuild)**

The transport ([FcmPushTransport](./src/core/realtime/pushTransport.ts)) and the receive pipeline
(EventRouter → DbEventSink → Notifee) are ready. What's missing is the native Firebase module, which
**cannot be added without `google-services.json`** (the Android build fails otherwise) — so it stays
deferred until you have it.

**Left to do (you), in order:**
- [x] Create a Firebase project, add an Android app with the Gator package id, download
      **`google-services.json`** into the repo root. _(done 2026-06 — project
      `bluegreengatorapps-35710`; file present in the repo root.)_
- [x] `npx expo install @react-native-firebase/app @react-native-firebase/messaging` _(done — now on
      RNFB **25.1.0** after the SDK 57 pass.)_
- [x] In [app.config.ts](./app.config.ts): add `'@react-native-firebase/app'` to `plugins`, and set
      `android.googleServicesFile`. _(done — see app.config.ts.)_
- [x] ~~Create `src/native/fcmMessaging.ts` (the firebase-importing glue)~~ **OBSOLETE — the file
      exists at [src/services/notifications/fcmMessaging.ts](./src/services/notifications/fcmMessaging.ts)**
      (modular RNFB 25 API, `setBackgroundMessageHandler` at module top level, wrapped in try/catch
      so a misconfigured Firebase project degrades to socket-only). The inline code sample this box
      carried is superseded by that file.
- [x] Flip `FCM_ENABLED = true` in [pushTransport.ts](./src/core/realtime/pushTransport.ts) and call
      `startFcm()`. _(done — FCM enabled and wired per the 2026-06-30 banner.)_
- [ ] **Native rebuild**, then the Phase 0 spike: with the app **killed**, send a push and confirm it
      writes to the encrypted DB and posts a notification. _(Still pending on-device — see
      `docs/DEVICE_VERIFICATION_CHECKLIST.md` §(e).)_

> Until this lands, killed-app delivery falls back to the ~15-min `backgroundSync` catch-up
> ([src/services/background](./src/services/background)) — fine for a spike, not for production.

## 0.3 Live-server connectivity — **done in code; needs your server**

The REST + socket auth is secure-by-default (password in an `Authorization` header / socket `auth`
payload, never the URL) and now **coherent across both transports**.

**Already done:**
- [src/core/api/http.ts](./src/core/api/http.ts) sends header auth (single injection point); legacy
  `?guid=` query only when header auth is disabled, over HTTPS, with a warning hook.
- [src/services/realtime/socketService.ts](./src/services/realtime/socketService.ts) now mirrors that:
  secure `auth` payload by default, or a legacy `?guid=` handshake query
  (`legacyQueryAuth`, driven by `http.usesHeaderAuth()`) for a stock server. Covered by
  [test/realtime/socketAuth.test.ts](./test/realtime/socketAuth.test.ts).

**Left to do (you) — pick the path that matches your server:**
- [ ] **Modified/secure server (recommended, the plan's premise):** make the Gator server read the
      password from the `Authorization` header (REST) and `socket.handshake.auth.password` (socket).
      Then the app connects securely with no URL-borne credentials. Set the min server version gate
      accordingly.
- [ ] **Stock/unmodified server:** it only reads `?guid=` (REST) and `handshake.query.guid` (socket).
      Wire `useHeaderAuth: () => false` on the `HttpClient` config in
      [src/services/index.ts](./src/services/index.ts) (ideally behind a "legacy auth" setting) — the
      socket follows automatically. ⚠️ This puts the password in the (TLS-encrypted) URL/handshake; it's
      the documented fallback, not the default.
- [ ] Run the e2e spike against the live server: connect → full sync → send → receive a message. Repeat
      after FCM (0.2) lands, with the app killed.

---

# Phase 1 — security foundation

## 1.1 Redaction logger — **done**
All logging goes through a single redacting logger ([src/core/secure/logger.ts](./src/core/secure/logger.ts)):
every message + meta is scrubbed (guid / password / token / authorization / `?guid=` URL params) before
any sink. All 11 prior `console.*` sites were migrated, and CI now fails on a raw `console.*` outside the
sink ([.github/workflows/ci.yml](./.github/workflows/ci.yml)). To add Sentry, wrap/extend the sink (§9.2).

## 1.2 App lock (biometric gate + DB-key withholding) — **done in code; biometric e2e needs a device**
- The setting persists in the **vault** (not the encrypted DB — it must be readable before the DB key is
  released) and is toggled in Settings → "App Lock" (guarded by `isBiometricAvailable()` so a user can't
  lock themselves out).
- Cold boot now reads the lock setting first ([boot()](./src/services/index.ts)); when enabled it withholds
  the SQLCipher key until `completeUnlock()` runs after a successful biometric auth — closing the audit's
  "DB key released before auth" gap. The gate is a root-layout overlay; resume re-locks after the timeout.
- Covered by [test/state/lockStore.test.ts](./test/state/lockStore.test.ts).
- **Left to do (you):** verify the biometric flow on a real device with an enrolled fingerprint/PIN (the
  bare emulator has none, so enabling lock there would lock you out — keep it off on the emulator).

## 1.3 Build / CI guards — **done**
`preview` + `production` EAS profiles pin `NODE_ENV=production` ([eas.json](./eas.json)) so `__DEV__` is
false and the dev-fixture bypass can't ship. CI guards against raw `console.*` and stray `dev.local`
references outside the known `__DEV__`-gated entry points.

## 1.4 TLS certificate pinning — **foundation done in code; needs your SPKI hash + a rebuild**
- The pin store + enforcement + mismatch listener are implemented:
  [src/native/certPinning.ts](./src/native/certPinning.ts) (lazy `initializeSslPinning` + a possible-MITM
  warning), pins persisted in the vault, applied at boot before any network call
  ([boot()](./src/services/index.ts) → `applyStoredCertPins`). Pure logic covered by
  [test/native/certPinning.test.ts](./test/native/certPinning.test.ts). No-op until pins are set, so the
  current build is unaffected.
- **Left to do (you):**
  - [ ] Native rebuild (so `react-native-ssl-public-key-pinning` links).
  - [ ] Get the server's base64 SHA-256 **SPKI hash** (the file header-comment in `certPinning.ts` has the
        exact `openssl` one-liner) and store it: `setCertPins({ 'your.server.com': ['sha256/…='] })`
        (wire this into a setup/settings field, or call it once).
  - [ ] _(Note: the library validates KNOWN pins but can't observe a cert, so auto-TOFU "pin-on-first-
        connect" isn't available — you supply the hash. A LAN/IP cleartext exception via
        `network_security_config.xml` is still a separate to-do.)_

## 1.5 Root/jailbreak advisory — **done in code; needs a rebuild (+ compat check)**
- A best-effort advisory is wired: [src/native/deviceIntegrity.ts](./src/native/deviceIntegrity.ts)
  (`isJailBroken` / `canMockLocation` → redacted `logger.warn`), called fire-and-forget at boot, lazy +
  try/caught so it's a silent no-op until linked. Covered by
  [test/native/deviceIntegrity.test.ts](./test/native/deviceIntegrity.test.ts).
- **Left to do (you):** native rebuild, and **verify `jail-monkey` v3 links on RN 0.86 / new-arch** (it's
  an older bridge module — if it fails to build, remove it; the wiring degrades to a no-op).

> Reminder: items 0.1 (crypto), 1.4 (pinning) and 1.5 (root) all install native modules. Before the next
> native build, approve their install scripts (`npm rebuild react-native-libsodium jail-monkey react-native-ssl-public-key-pinning`).

# Phase 2 — reliability

## 2.1 Outgoing-queue retry + crash recovery — **done**
A crash/kill mid-send no longer strands a message. [outgoingQueueService.ts](./src/services/send/outgoingQueueService.ts)
`runOutgoingQueue` retries every stranded/failed text + reaction send with exponential backoff
(30s→60s→…→1h cap), leases each row (`claimOutgoing`) so two runners never double-send, and retires a row
to the 'error' bubble after 5 attempts. Runs at launch ([home.tsx](<./app/(app)/home.tsx>)) and from the
~15-min background task ([backgroundSync.ts](./src/services/background/backgroundSync.ts)). Migration `0008`
adds `outgoing_queue.next_retry_at`. Covered by
[test/services/outgoingQueueService.test.ts](./test/services/outgoingQueueService.test.ts) (5 tests).
- _Follow-up: attachment re-send from the queue is skipped (needs the file at `localPath`); the error
  bubble's manual retry still covers it._

## 2.2 Server-URL failover (Firebase RTDB) — **blocked on Firebase (same as FCM)**
ngrok/zrok/Cloudflare URL rotation needs `@react-native-firebase/database`, which needs the
`google-services.json` from §0.2. A `ServerUrlResolver` interface exists but isn't wired.
- [ ] After §0.2 lands: install `@react-native-firebase/database`, implement `fetchNewUrl()` against your
      `config/serverUrl` node, and call it from the socket's disconnect/error handler to re-resolve + reconnect.

# Phase 3 — conversation-list parity

## 3.1 Pin / mute / archive / delete + pinned grid + archived view — **done**
Long-press a conversation tile → an action sheet (Pin · Mute · Archive · Delete-with-confirm),
all client-local mutations ([setChatPin/setChatArchive/deleteChatLocal](./src/db/repositories.ts);
pin/archive seed from the server on first sync but survive a re-sync — they're out of the upsert
conflict set, like mute/custom). Pinned chats render in an iOS-style grid above the list
([PinnedGrid.tsx](./src/ui/conversations/PinnedGrid.tsx)); a 🗄️ Archived footer opens an
[archived screen](<./app/(app)/archived.tsx>). Covered by
[test/db/chatActionsRepo.test.ts](./test/db/chatActionsRepo.test.ts) (4 tests, incl. re-sync survival).
Verified on-device: long-press → Pin moves a chat into the grid reactively.

## 3.2 Remaining Phase-3 polish — **follow-ups**
- [x] **Swipe-to-reveal actions** on tiles (the iOS swipe gesture). _(done 2026-07 —
      [SwipeableRow.tsx](./src/ui/conversations/SwipeableRow.tsx), PanResponder-based, wired into
      `ConversationTile`.)_
- [ ] **Collapsing large-title header** (the header is currently static). Pure JS (scroll-driven
      `Animated`), lower priority.
- [ ] _(If you want pin/archive to sync across devices, they'd need server endpoints — currently local.)_

# Phase 4 — group + real-time UI

## 4.1 Typing indicators (receive/display) — **done**
A `typing-indicator` socket event now flows through a `TypingEventSink` decorator
([typingEventSink.ts](./src/services/realtime/typingEventSink.ts)) → a [typingStore](./src/state/typingStore.ts)
(auto-clears after a 12s TTL if no stop arrives) → an animated [TypingBubble](./src/ui/conversations/TypingBubble.tsx)
in the chat. Covered by 7 tests (store + sink). Verified on-device via a `__DEV__` ⌨️ inject button.

## 4.2 Interactive reply threads — **done**
A reply quote is now tappable ([ReplyQuote.tsx](./src/ui/conversations/ReplyQuote.tsx)) → the
[MessageList](./src/ui/conversations/MessageList.tsx) scrolls to the original message (`scrollToIndex` via a
`FlashListRef`) and briefly highlights it ([MessageRow](./src/ui/conversations/MessageRow.tsx)). Stable
callback + per-row `isHighlighted` so the memoized rows hold. Verified the chat + list-scroll on-device.

## 4.3 Typing indicators (SEND) — **code-complete; server-gated**
The Composer debounces a `started/stopped-typing` emit ([Composer.tsx](./src/ui/conversations/Composer.tsx) →
`onTyping`) → `sendTyping` → `SocketService.emit` (`{chatGuid}`). Covered by a socket-emit test. **Needs the
Gator private API** on the server to relay it — can't be verified without a live server.

## 4.4 Group management — **DONE (endpoints + full UI)**
- Endpoints added ([chats.ts](./src/core/api/endpoints/chats.ts)): `updateParticipant` (add/remove),
  `renameChat` (PUT), `leaveChat`. **Private-API / server-gated.**
- chat-settings now shows a **GROUP** section (participant roster + **Leave Group** → `leaveChat` + local
  delete) for group chats.
- [x] **Add/remove participant + rename UI** — _(done 2026-07 —
      [chat-settings/[guid].tsx](<./app/(app)/chat-settings/[guid].tsx>) wires `renameChat` (~L228),
      `updateParticipant 'add'` (~L241) and `'remove'` (~L259).)_

## 4.5 Per-message delivery/read — **optional**
`statusFor` exists and last-message status is iMessage-correct; revisit only if you want per-message read
receipts like the Flutter app.

# Phase 5 — attachments

## 5.1 vCard / vLocation rendering + multi-select + live-photo badge — **done**
- **Contact (vCard) + location (vLocation) cards.** Pure parsers `parseVCard` / `parseVLocation`
  ([src/utils/vcard.ts](./src/utils/vcard.ts), [vlocation.ts](./src/utils/vlocation.ts)) — note Apple
  encodes `ll=longitude,latitude` (lon first, comma backslash-escaped). Rendered by
  [ContactCard](./src/ui/attachments/ContactCard.tsx) / [LocationCard](./src/ui/attachments/LocationCard.tsx)
  (download the file, read it via `expo-file-system` `File.text()`, parse, render; location opens a `geo:`
  URL — no Maps key). Wired into `AttachmentView` via `attachmentKind` (`text/vcard`→contact,
  `text/x-vlocation`→location, tested in order). 7 parser tests.
- **Multi-select image send.** Picker uses `allowsMultipleSelection` + `selectionLimit:10`; `sendImages`
  ([send/index.ts](./src/services/send/index.ts)) fans out one optimistic message/attachment/queue-row per
  asset. Tested (N picks → N rows).
- **Live-photo badge.** `ImageAttachment` shows a "◉ LIVE" badge when `hasLivePhoto` (column already exists
  — no migration).

## 5.2 Remaining attachment work — **mostly DONE (2026-07); one polish item left**
- [x] **Audio playback** — _(done — `expo-audio ~57.0.2` installed;
      [AudioAttachment.tsx](./src/ui/attachments/AudioAttachment.tsx) shipped.)_
- [x] **Voice-memo recording** — _(done —
      [VoiceRecorder.tsx](./src/ui/conversations/VoiceRecorder.tsx) shipped.)_
- [x] **Document send** — _(done — `expo-document-picker` wired in
      [chat/[guid].tsx](<./app/(app)/chat/[guid].tsx>) (~L331).)_
- [x] **Android share-intent / content-URI** receive — _(done — `expo-share-intent ^8.0.1`
      installed and wired; on-device check in `docs/DEVICE_VERIFICATION_CHECKLIST.md` §(h).)_
- [ ] **LocationCard static-map thumbnail** + **live-photo video sidecar playback** — need a Maps key /
      `expo-video` sidecar respectively (see the Find My + native-rebuild notes).

# Phase 6 — settings · privacy · secondary features

## 6.1 Redacted (privacy) mode — **done**
A `redactedModeStore` ([src/state/redactedModeStore.ts](./src/state/redactedModeStore.ts), kv-persisted,
default OFF — mirrors `smartReplyStore`) drives masking via pure helpers
([src/utils/privacy.ts](./src/utils/privacy.ts): `redactPreview`/`redactTitle`/`redactMessageText`, 3 tests).
When ON it masks: inbox tile title + preview (ConversationTile), the pinned grid + conversation header
titles, the chat bubble text + URL preview (MessageBubble), and the notification body (the existing
`hidePreview` flag is now pushed from the store at boot + on toggle, via a subscription in
[app/_layout.tsx](./app/_layout.tsx)). Toggle in **Settings → Privacy**.
- _Deferred (Flutter does more): avatar/photo hiding, attachment-thumbnail opacity, fake contact names,
  sender-name masking in group rows. The high-value glance surfaces are covered._

## 6.2 Settings panels — **done**
[settings.tsx](<./app/(app)/settings.tsx>) gains a **Privacy** section (Redacted Mode) and an **About**
section (Server URL, server version, macOS version, Private API enabled/disabled — from
`sessionStore.serverInfo` — plus a **Disconnect** action → `forget()`).

## 6.3 Scheduled-message edit — **done**
`updateScheduled` + `getScheduledById` ([repositories.ts](./src/db/repositories.ts)) with a
`status='pending'` guard (can't edit a claimed/sent row; preserves the reply target through the JSON
payload). Tap a pending row in [scheduled.tsx](<./app/(app)/scheduled.tsx>) → an edit screen
([scheduled-edit/[id].tsx](<./app/(app)/scheduled-edit/[id].tsx>)) to change the text + reschedule (reuses
`pickFutureDateTime`). No Notifee reschedule needed — scheduled sends are DB-polled by `runDueScheduled`,
not a trigger. 3 repo tests.

# Phase 8/9 — security hardening (item 14)

These are the JS-doable hardening items; the rest of item 14 is credential/rebuild-gated (below).

## 8.1 URL-open scheme validation — **done**
`isSafeUrl`/`safeOpenUrl` ([src/utils/urls.ts](./src/utils/urls.ts)) — an ALLOWLIST (https, http,
tel, mailto, sms, facetime, geo, file; default-deny) parsed off the trimmed string with smuggling
defences (leading-whitespace/control-char rejection). All six `Linking.openURL` sites
(MessageBubble, UrlPreviewCard, ContactCard, FileChip, LocationCard) now route through it; the
FaceTime gate in `actions.ts` stays stricter (host-pinned). 9 tests.

## 8.2 Encrypted backups — **done** (unblocked by the working crypto backend)
`sealBackup`/`openBackup` ([backup.ts](./src/services/backup/backup.ts)) wrap the existing
settings/theme backup in a SecretBox envelope (XChaCha20-Poly1305 + Argon2id) under a user
passphrase; `exportEncryptedBackup`/`importBackupAuto` ([backupService.ts](./src/services/backup/backupService.ts))
do the IO + auto-detect encrypted vs legacy plaintext. Backups still **exclude all secrets** (the
vault is never read; `isSecretKey` filters on export AND import — a test proves the guard survives
the encrypt→decrypt→restore round-trip). UI requires a passphrase + confirm. 11 backup tests.

## 8.3 Automation-intents hardening (JS core) — **done; native receiver = rebuild**
[src/core/secure/intents.ts](./src/core/secure/intents.ts): a ROTATING per-install
`automationToken` (CSPRNG, vault-stored — NOT the server password), CONSTANT-TIME compare
(`timingSafeEqual`), default-deny action allowlist, and per-action param sanitization (length cap,
control-char strip, scheme/URL-shaped rejection). 12 tests. The exported Android BroadcastReceiver
that feeds this is a **native-rebuild** item (batch with [native-rebuild]).

## 8.4 DB-key rotation — **primitive proven on-device; full rotation is the follow-up**
op-sqlite SQLCipher `PRAGMA rekey` is **verified on device** via `runDbRekeySelfTest`
([src/db/key.ts](./src/db/key.ts), dev-boot, throwaway db): rekey + reopen(new) + reject(old) all
pass. **Left to do:** the crash-safe rotation state machine (stage new key → rekey → promote →
clear; boot-recovery tries both keys) + a settings trigger. Built on the now-proven primitive.

## Still blocked (separate credential / rebuild)
- ~~**Find My embedded map** — Google **Maps** Android API key + `react-native-maps`~~ **DONE
  DIFFERENTLY (2026-07):** shipped keylessly via
  [FindMyMap.tsx](./src/ui/findmy/FindMyMap.tsx) (WebView + Leaflet/OSM) — no Maps key or
  react-native-maps needed. See §9.3.
- **Sentry** redacted breadcrumbs — a Sentry **DSN** + `@sentry/react-native` (rebuild).
- **Launcher shortcuts** + the **exported Tasker receiver** — native config (rebuild).

# Phase 9 — release infra

## 9.1 EAS build & submit — needs an **Expo account**

- [ ] `eas login` (create/sign in to an Expo account)
- [ ] Configure Android signing + Google Play credentials (`eas credentials`)
- [ ] Build a preview APK: `eas build --profile preview --platform android`
- [ ] (later) Production AAB + submit: `eas build --profile production --platform android` → `eas submit`

**One-command release path (preferred):** `npm run release:android` bumps the patch version
(`npm version patch --no-git-tag-version`), builds a production AAB on EAS Cloud, and
auto-submits it to the Play internal track (`eas build … --auto-submit`). Use
`npm run release:android:local` to build the AAB locally (`--local --output ./gator-release.aab`)
and then `eas submit --path ./gator-release.aab`. Submit credentials come from
`submit.production.serviceAccountKeyPath: ./play-service-account.json` in [eas.json](./eas.json).

**Already done:** [eas.json](./eas.json) has `development` / `preview` / `production` profiles
(internal APK / store AAB) + a `submit.production` track. CI ([.github/workflows/ci.yml](./.github/workflows/ci.yml))
runs typecheck + prettier + jest on every push/PR.

## 9.2 Sentry crash reporting — needs a **Sentry DSN**

- [ ] Create a Sentry project → copy the **DSN**
- [ ] `npx expo install @sentry/react-native` + add its config plugin to `app.config.ts`
- [ ] `Sentry.init({ dsn })` at app entry
- [ ] Send the captured error from the error boundary's `componentDidCatch` (the hook is already there)
- [ ] Reuse the central log-redaction scrubber on Sentry breadcrumbs (scrub guid/token/URL/phone)

**Already done:** [src/ui/ErrorBoundary.tsx](./src/ui/ErrorBoundary.tsx) `componentDidCatch` has the
`// Hook for redacted crash reporting (Sentry) later` placeholder ready to forward the error.

## 9.3 Embedded Find My map — **DONE DIFFERENTLY (2026-07, no Maps key needed)**

The embedded map shipped without Google Maps: [FindMyMap.tsx](./src/ui/findmy/FindMyMap.tsx)
renders device/friend locations in a **WebView + Leaflet (OpenStreetMap)** — no API key, no
`react-native-maps`, no extra native module. The boxes below are OBSOLETE and kept only for history:

- ~~[ ] Get a Google Maps **Android** API key~~ — not needed (Leaflet/OSM).
- ~~[ ] `npx expo install react-native-maps` + key in `app.config.ts`~~ — not needed.
- ~~[ ] Replace the `geo:`-URL fallback with an in-screen `<MapView>`~~ — done via `FindMyMap.tsx`
      (the "Open in Maps" `geo:` URL remains as a per-item action).
- ~~[ ] Requires a native rebuild~~ — WebView was already linked.

---

_Last updated: 2026-07-17 (checkbox-truth pass; original body 2026-06-20). See the top banner for
what changed — the remaining open items are device verification, the cert-pin SPKI hash, EAS/Play
signup, and Sentry. Once you have a secret, ask the agent to wire that one piece._
