# Gator RN

Gator is an Android-only, iOS-styled messaging client built with React Native, Expo SDK 57,
TypeScript, and a compatible self-hosted Mac server.

> **Release status:** active hardening; not yet release-ready. Remediation status and acceptance
> criteria are in [`docs/WORK_PLAN_2026-08-03.md`](./docs/WORK_PLAN_2026-08-03.md); the four
> release-operation tasks are in [`docs/RELEASE_PLAN.md`](./docs/RELEASE_PLAN.md). The short
> candidate gate is [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md). Historical phase/audit
> documents are research, not current status.

## What is in the app

The codebase includes conversation sync, sending and retry, reactions/replies, group management,
search, contacts, attachments and voice messages, scheduled messages/reminders, privacy-aware
Android notifications, Find My views, dark themes, backups, and an optional App Lock screen.
Receiving text/files through Android's share sheet and Direct Share uses Gator's owned native
intake, with bounded streaming and durable batch ownership. See
[`docs/SHARE_INTENT_RELIABILITY.md`](./docs/SHARE_INTENT_RELIABILITY.md) for its acceptance boundary.

Many capabilities depend on a compatible server version or private server APIs. Native behavior
such as killed-process push, notifications, SQLCipher, WebViews, permissions, and outbound file
sharing must be verified on the exact Android build; passing Jest alone is not release evidence.

## Architecture

The app is offline-first. Its encrypted database is the UI’s source of truth: network, socket, and
eligible FCM events write durable rows, and React observes those rows. Both socket and push input go
through one `EventRouter`; REST authentication is injected in one `HttpClient` boundary.

```text
app/        Expo Router screens and layouts
src/core/   platform-free TypeScript: API, events, sync, crypto contracts, models
src/db/     Drizzle schema, migrations, repositories, op-sqlite/SQLCipher adapter
src/native/ native-module adapters
src/services/ composition and side effects: connection, sync, send, files, notifications
src/state/  Zustand/TanStack state
src/ui/     design system and reusable UI
src/utils/  shared pure helpers
test/       Node and jest-expo tests
modules/    local Android Expo modules
plugins/    Expo config plugins
```

Important invariants:

- `src/core` imports no React, React Native, Expo, Zustand, native DB, or UI code. Native primitives
  are injected through interfaces.
- Network and realtime input write the database before UI side effects.
- `HttpClient` owns credential injection; credentials do not belong in URLs by default.
- `EventRouter` is the only realtime ingress.
- Database transactions use one process-wide coordinator. Nested transactions can deadlock, so
  transaction callbacks stay short, DB-only, and bounded.
- Set replacement is add-then-prune, and local deletion uses tombstones that server sync cannot
  resurrect.
- FCM/notification/background registrations load from `index.js` before `expo-router/entry`.

Read [`AGENTS.md`](./AGENTS.md) before changing DB, notification, native, keyboard, attachment, or
share-intent code; it records device-only failure modes that Node tests cannot reproduce.

## Local setup

CI and EAS cloud builds use the exact reviewed toolchain (`.nvmrc`, `eas.json` and
`packageManager`):

- Node `24.19.0`
- npm `11.17.0`
- Android target only; JDK 17 and the Android SDK are needed for a local native build

On your own machine, `check-toolchain.mjs` also accepts later releases of the same major line
(Node 24.x from 24.19.0, npm 11.x from 11.17.0), so newer security patches do not fail the check.
That includes local release builds: `eas build --local` uses the machine's Node and npm (it only
warns when `eas.json` names another Node), and release receipts record the exact versions used.

```sh
nvm install
nvm use
node scripts/check-toolchain.mjs
npm ci
```

For an Android build, provide a Firebase config whose package is
`com.bluegreengatorapps.messages`. Local builds can place an ignored `google-services.json` at the
repo root; EAS should use a `GOOGLE_SERVICES_JSON` file variable in each named environment.

Native Find My maps also require `GOOGLE_MAPS_ANDROID_API_KEY`. Use a dedicated key restricted to
the Gator Android package, every intended signing certificate, and Maps SDK for Android only. The
project-scoped EAS Secret supports hosted builds, but EAS does not download Secret values for
`eas build --local`; the supported local release runner therefore requires the caller to export the
key in its environment and binds only its SHA-256 fingerprint into the release receipt.

```sh
# Native development build
npx expo run:android

# Metro for an existing dev client
npm start
```

Do not commit Firebase config, service-account JSON, signing files, `.env` files, or generated
native/build output. [`.env.example`](./.env.example) documents the only current variable shape.

## Verification

Common local gates:

```sh
npm run check:toolchain
npm run typecheck
npm run lint -- --max-warnings=0
npm run format:check
npm run check:architecture
npm run check:secret-hygiene
npm run check:migrations
npm test -- --runInBand
CI=1 ./node_modules/.bin/expo install --check
npm run doctor
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
```

Package, config, native-module, and candidate changes also require a clean prebuild, Kotlin-module
compilation, debug APK, release AAB, merged-manifest checks, and the device matrix. See the release
checklist for the exact commands and evidence fields.

This project does not currently install `expo-updates` or publish over-the-air (OTA) JavaScript
updates. Every release therefore requires a new signed Android build and Play/EAS distribution;
the EAS profiles intentionally have no update-channel fields.

## Security and privacy boundaries

- **Credentials:** server credentials use Android-backed SecureStore and normally travel in an
  authorization header/socket auth payload. The explicitly selected legacy compatibility mode can
  put credentials in a TLS-protected URL and is not the default.
- **Database:** messages, contacts, drafts, reminders, and most non-secret preferences live in a
  SQLCipher-encrypted SQLite database. Server credentials, its random key, the authoritative App Lock
  setting, and a few boot-time secrets live separately in Android SecureStore/Keystore. A native
  app-private preferences file mirrors only the App Lock and Secure Screen on/off state so those
  protections can apply before JavaScript starts.
- **App Lock:** this is a foreground/policy screen gate, not biometric-bound key custody. Enabling
  clears displayed notifications; new message notices stay generic whenever enabled, including after
  unlock and during its grace period. Verified generic scheduled reminders remain scheduled.
  Server-state-backed message content may catch up after unlock and
  sync, but one-time events such as `message-send-error` are not reconstructed unless another live
  transport delivers them. When enabled, App Lock keeps protected content out of Android Recents,
  including during its grace period. The independent Secure Screen setting blocks screenshots and
  screen recording. Neither setting adds encryption to files.
- **Files:** attachments, wallpapers/backgrounds, cached contact images, app logs, legacy
  incoming-share copies, and image or other Android/Expo-managed caches are ordinary plaintext files in Android
  app-private storage.
  Android and bundled SDKs also keep ordinary app-private operational preferences and databases for
  permissions, tasks, media/web-view state, notifications, and scheduling; Firebase stores
  installation and push tokens there. Disconnect requests FCM-token deletion, but SDK metadata may
  remain until app data is cleared or the app is uninstalled. A non-secret, zero-byte account-
  revocation marker remains after Disconnect until a replacement account fully activates.
  Files explicitly saved—or images automatically exported—to Photos/the Gator album are plaintext
  copies in Android shared media storage and are not removed by disconnect or uninstall. When
  Gallery or Gator Album is selected, background delivery of an eligible incoming non-sticker image
  skips the immediate Photos call, but before its private-cache download Gator stores a bounded,
  destination-bound receipt in the encrypted database. If that download commits, a later active,
  unlocked, connected foreground session can retry the Photos/Gator Album copy after permission has
  already been granted. A process stop between Android saving the copy and receipt completion can
  cause duplicates; three total attempts can produce at most two duplicate copies after the first
  save. Settings → Storage & File Privacy explains cleanup and backup behavior.
- **Backups:** the current UI encrypts settings/customization backups with a user passphrase before
  writing the temporary share file, then deletes that temporary file after sharing.
- **Transport TLS:** HTTPS uses Android’s hostname validation and built-in system certificate
  authorities. Certificate authorities added by the user in Android Settings are not trusted.
  There is no application-level certificate pinning or bad-certificate bypass.
- **Push/providers:** Firebase Cloud Messaging may carry push data. The visible, unlocked Find My
  screen uses the native Google Maps Android SDK for server-provided coordinates; Find My does not
  read the phone's own location. Google can receive those precise coordinates, the phone IP,
  displayed map region, device/request metadata, a Maps-specific identifier, Maps SDK crash
  diagnostics, and map interactions. FaceTime entry points and embedded FaceTime web surfaces are
  retired; explicit Find My system-map actions can contact external mapping services. Do not claim
  that no third party is involved.
- **Current Location sharing:** In a supported one-to-one conversation, an explicit confirmed action
  can request one approximate or precise foreground fix and send it through the connected server.
  Gator does not collect location in the background. Denial, cancellation/account retirement,
  disabled services, acquisition error, or the 15-second timeout queues and sends nothing. After a
  successful fix, the exact coordinate lives only in the SQLCipher-encrypted outgoing queue; an
  ordinary temporary failure may retry that same snapshot for no more than 15 minutes without
  acquiring a new location.
- **Previews:** no client Open Graph fetch/parser or arbitrary-host fallback exists. When the paired
  server advertises the preview capability, the app automatically requests bounded text and an
  optional validated JPEG/PNG data image through its authenticated `HttpClient`; it never mounts a
  remote image URL. Results use bounded app-private positive/negative caches, and an explicit tap
  hands the immutable original URL to the external browser.
- **Server rotation:** an event cannot silently persist or contact a different/downgraded server
  origin. A future cross-origin rotation flow requires explicit foreground approval.
- **Logging:** application logging goes through the redacting logger; raw `console.*` calls in app
  source fail CI. Redaction reduces exposure but is not a substitute for inspecting device logs.

The Play listing, privacy policy, Data safety answers, and screenshots must be derived from observed
candidate behavior—not from this summary.

## Server compatibility

Gator requires a compatible self-hosted server. Header/socket-auth support and several private APIs
are version-gated. The app/server event and capability contract, including deliberate
nonalignments, is tracked in [`docs/APP_SERVER_PARITY.md`](./docs/APP_SERVER_PARITY.md).

Gator is not affiliated with, endorsed by, or sponsored by Apple.

## Documentation map

- [`docs/WORK_PLAN_2026-08-03.md`](./docs/WORK_PLAN_2026-08-03.md) — authoritative remediation plan
- [`docs/RELEASE_PLAN.md`](./docs/RELEASE_PLAN.md) — authoritative release-operation plan
- [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md) — exact-candidate release gate
- [`docs/README.md`](./docs/README.md) — subsystem contracts, runbooks, focused research, and historical-evidence map

## License

Gator is currently a private project. The root [`LICENSE`](./LICENSE) grants no public license for
Gator-authored code or assets. Confirmed inherited licensing text is preserved separately in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

The current private scope is binary distribution through Google Play Internal Testing only to
owner-approved private testers. Before publishing source or distributing outside that scope,
complete the ownership, exact dependency/asset notice, distribution-terms, and approval checklist in
[`docs/PUBLIC_RELEASE_LICENSING.md`](./docs/PUBLIC_RELEASE_LICENSING.md). Private testing does not
waive third-party license terms.
