# Gator RN

Gator is an Android-only, iOS-styled messaging client built with React Native, Expo SDK 57,
TypeScript, and a compatible self-hosted Mac server.

> **Release status:** active hardening; not yet release-ready. The authoritative backlog, item
> status, acceptance criteria, and release blockers are in
> [`docs/WORK_PLAN_2026-08-03.md`](./docs/WORK_PLAN_2026-08-03.md). The short candidate gate is
> [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md). Historical phase/audit documents are research,
> not current status.

## What is in the app

The codebase includes conversation sync, sending and retry, reactions/replies, group management,
search, contacts, attachments and voice messages, scheduled messages/reminders, Android
notifications, FaceTime entry points, Find My views, dark themes, backups, redacted mode, and an
optional App Lock screen. Receiving text/files from Android's share sheet is deliberately disabled
until Gator owns a native intake that can cap bytes and time while streaming.

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

The reviewed toolchain is exact:

- Node `24.19.0`
- npm `11.17.0`
- Android target only; JDK 17 and the Android SDK are needed for a local native build

```sh
nvm install
nvm use
npm ci
npm run check:toolchain
```

For an Android build, provide a Firebase config whose package is
`com.bluegreengatorapps.messages`. Local builds can place an ignored `google-services.json` at the
repo root; EAS should use a `GOOGLE_SERVICES_JSON` file variable in each named environment.

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
  SQLCipher-encrypted SQLite database. Server credentials, its random key, the App Lock flag, and
  a few boot-time secrets live separately in Android SecureStore/Keystore.
- **App Lock:** this is a foreground/policy screen gate, not biometric-bound key custody. Locked
  pushes post a generic notice and catch up after unlock. When enabled, it keeps protected content
  out of Android Recents, including during its grace period. The independent Secure Screen setting
  blocks screenshots and screen recording. Neither setting adds encryption to files.
- **Files:** attachments, wallpapers/backgrounds, cached contact images, app logs, incoming-share
  copies, and image/WebView caches are ordinary plaintext files in Android app-private storage.
  Files explicitly saved—or images automatically exported—to Photos/the Gator album are plaintext
  copies in Android shared media storage and are not removed by disconnect or uninstall. Settings →
  Storage & File Privacy explains cleanup and backup behavior.
- **Backups:** the current UI encrypts settings/customization backups with a user passphrase before
  writing the temporary share file, then deletes that temporary file after sharing.
- **Transport TLS:** HTTPS uses Android’s normal certificate and hostname validation. There is no
  application-level certificate pinning or bad-certificate bypass.
- **Push/providers:** Firebase Cloud Messaging may carry push data. User-opened links, Find My map
  tiles, and other provider-backed features can contact their respective services; do not claim
  that no third party is involved.
- **Previews:** automatic remote URL-preview fetching is contained; cached metadata may render, but
  a message appearing on screen must not silently contact an arbitrary link host.
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
- [`RELEASE_CHECKLIST.md`](./RELEASE_CHECKLIST.md) — exact-candidate release gate
- [`docs/README.md`](./docs/README.md) — subsystem contracts, runbooks, focused research, and historical-evidence map

## License

Project ownership/license selection and the complete third-party notice inventory are still an
explicit release decision (`DEC-02` / `LEGAL-01`). Do not treat the inherited template copyright in
the current `LICENSE` file as final project ownership or publish until the owner resolves it.
