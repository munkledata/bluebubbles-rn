# Gator RN — agent orientation

A React Native (Expo) + TypeScript rebuild of the Flutter iMessage client.
Android-only, iOS-styled. See `README.md` for the full picture and `docs/` for the spikes
and per-phase dependency plan. The authoritative rebuild plan lives at
`~/.claude/plans/i-ve-changed-to-the-robust-pine.md`.

## Expo HAS CHANGED
This project targets **Expo SDK 57** (React Native 0.86, React 19). Read the exact
versioned docs at https://docs.expo.dev/versions/v57.0.0/ before writing native/config code.
- **`expo-contacts` root API throws in SDK 57.** The imperative `getContactsAsync` (and
  friends) from the package root are deprecated and now *throw* (the error message is the
  deprecation/migration text, so it surfaces as a runtime failure, not a warning). Import from
  `expo-contacts/legacy` to keep the imperative API, or move to the new class-based API. The
  `Contacts.Fields` enum + `requestPermissionsAsync` are still fine. See
  `src/services/contacts/contactsService.ts`.

## Conventions
- **`src/core/` is React-free.** No `react`/`react-native` imports there — it must run in
  Node (tests) and the headless FCM handler. Native primitives are injected via interfaces
  (e.g. `CryptoBackend`, `SecureVault`) implemented in `src/native/`.
- **DB is the source of truth.** Network/FCM write into the encrypted DB; UI observes it.
- **One auth-injection point:** `HttpClient` puts the password in a header — never the URL.
- **One realtime entry point:** `EventRouter` normalizes both socket and FCM events. To add a
  server event: add the name to `SERVER_EVENTS` (constants.ts), a `NormalizedEvent` variant +
  `normalize()` case (eventRouter.ts), and handle it in a sink (DB write → `DbEventSink`;
  connection/UI side-effect → a thin injected sink like `ServerUrlEventSink`/`TypingEventSink`).
  `message-send-error` (→ `markMessageSendError`) and `new-server` (→ `applyNewServerUrl`, reconnect
  to the rotated tunnel URL) are wired this way. App↔server API/feature parity — including the
  intentional non-alignments (`imessage-aliases-removed` app-ready but no server source;
  server-side `scheduled-message-update` vs the app's LOCAL scheduling; participant-collage group
  avatars vs `group-icon-*`) — is tracked in `docs/APP_SERVER_PARITY.md`.
- Path aliases: `@core`, `@db`, `@ui`, `@utils`, and `@core/*` etc. (tsconfig + jest mapped;
  Expo Metro resolves tsconfig paths automatically).
- Strict TS (`noUncheckedIndexedAccess` on). Prefer `charAt`/explicit guards over `!` where
  reasonable.

## op-sqlite gotchas (learned the hard way — don't rediscover)
- **FTS5 must be opted in.** op-sqlite only compiles FTS5 when `"op-sqlite": { "fts5": true }`
  is set in package.json (alongside `"sqlcipher": true`). Without it, the `messages_fts`
  migration throws `no such module: fts5` **only on device** (better-sqlite3 has FTS5, so
  Node tests pass — a real test-vs-device divergence). Changing these flags needs a clean
  native rebuild (`rm -rf android && expo run:android`).
- **drizzle ↔ op-sqlite v17 mismatch.** No drizzle-orm version targets op-sqlite v17's API
  (drizzle calls `executeAsync`/`executeRawAsync` + `rows._array`; v17 has async `execute`,
  `executeSync`, `executeRaw` with `rawRows`, and `rows` as a plain array). `src/db/database.ts`
  wraps the raw handle in a `drizzleAdapter` Proxy that presents the legacy interface. Keep it.
- **Reactive queries need a flush.** `reactiveExecute` callbacks don't fire until
  `flushPendingReactiveQueries()` runs; the adapter calls it after every write so the live
  conversation list updates. `getRawDatabase()` (migrations, reactiveExecute) uses the
  UN-adapted handle.
- **Migrations are transactional** (`src/db/migrate.ts`) so a partial failure rolls back
  instead of leaving "table already exists" on retry.
- **Drizzle + op-sqlite v17 reactive lists:** use raw `db.all(sql\`…\`)` for read queries
  (works on both drivers); reactive hooks (`useReactiveQuery`) subscribe to table names and
  re-run the query — the write→flush is automatic via the adapter.
- **`db.run(sql\`…\`)` DOES work on op-sqlite v17** (corrected — the earlier note claiming it
  throws on device was wrong). Drizzle's query-builder `.run()` routes through `executeAsync`,
  which the `drizzleAdapter` Proxy DOES override (alongside `execute`/`executeRawAsync`), so a
  non-returning raw write (`db.run(sql\`UPDATE …\`)`) commits on device. Two production sites rely
  on this: `reconcileOutgoingSuccess` (outgoing.ts) and `reconcileServerScheduled` (scheduled.ts) —
  both use `db.run` precisely because `db.all` on a non-returning UPDATE throws "use run()" under
  better-sqlite3 (Node tests). Use `db.run` for a non-returning raw write, `db.all(sql\`… RETURNING\`)`
  when you need rows back, or a builder (`db.delete(t).where(…)`, `db.update(t).set({…})`,
  `db.insert(t).values({…}).returning({…})`).

## UI gotchas
- **Android edge-to-edge keyboard:** Expo SDK 57 / RN 0.86 enable edge-to-edge by default, so
  legacy `windowSoftInputMode=adjustResize` does NOT push content up — a bottom composer hides
  behind the keyboard. Wrap chat-style screens in `<KeyboardAvoidingView behavior="padding">`
  (not `undefined`/`height`) to consume the keyboard inset. See `app/(app)/chat/[guid].tsx`.
- **FlashList v2 has no `inverted` prop.** For chat (newest at bottom), render chronological
  (oldest→newest) data with `maintainVisibleContentPosition={{ startRenderingFromBottom: true }}`.
- **expo-video: calling a method on a released player crashes** ("Cannot use shared object that
  was already released" — surfaces only on-device, not in tsc/jest). `useVideoPlayer` auto-
  releases on unmount, so a `useFocusEffect` cleanup that calls `player.pause()` can hit an
  already-released player when the row unmounts. Wrap such calls in `try/catch`. See
  `src/ui/attachments/VideoPlayer.tsx`.
- **Download progress is presentation-only.** Byte progress flows expo-file-system
  `createDownloadTask({onProgress})` → `downloadStore` (zustand) → ring/spinner. The actual
  image/video swap MUST stay driven by the reactive `localPath` DB write (`updateAttachmentLocalPath`),
  never the store — rendering from store state bypasses the op-sqlite reactive flush.
- **Notifications use `react-native-notify-kit`** (the Invertase-recommended, TurboModules-only drop-in
  fork of the archived `@notifee/react-native`; the named exports + API are 100% identical, so imports
  are just `from 'react-native-notify-kit'`). It's autolinked and, since 9.2.0, its native core COMPILES
  FROM SOURCE — so there is NO local `app.notifee:core` AAR and NO `extraMavenRepos` workaround (the old
  notifee note here was obsolete and is deleted). Its Expo config plugin is NOT needed either — the plugin
  only covers iOS extensions / an Android foregroundService, neither of which this app uses. GOTCHA: unlike
  notifee it does NOT auto-merge `POST_NOTIFICATIONS`, so that permission is declared EXPLICITLY in
  `app.config` `android.permissions` (API 33+ runtime notification permission). Needs no Google Play Services.
- **RN/Metro can't do dynamic `import(variable)`** — a `const x='lit'; import(x)` is constant-folded
  and resolved (fails for uninstalled pkgs), and a runtime-built specifier throws "Invalid call".
  For a deferred/optional native module (e.g. the gated FCM transport), don't import it at all —
  inject the dependency (pass the module instance into a constructor) so the bundle never references it.
- **notify-kit `AndroidStyle.MESSAGING` person.icon must be a string when present.** Passing
  `icon: undefined` throws at displayNotification; spread it conditionally. EventType values differ
  from some docs — always compare against the `EventType.ACTION_PRESS` constant, never a literal.
- **notify-kit background handler (`onBackgroundEvent`) + TaskManager.defineTask must be module top-level**,
  imported for side effect at the top of `app/_layout.tsx` — not inside a component — or killed-app delivery drops.
- **A notification tap only reaches `onForegroundEvent` when the Activity is RESUMED.** notify-kit routes a
  PRESS to the foreground emitter ONLY if the app is truly on-screen; a tap while the app is
  alive-but-backgrounded (the COMMON case) is delivered to the headless `onBackgroundEvent`, which has no
  router and cannot deep-link. So navigating to the chat must happen at foreground time, not in the press
  handler: `onBackgroundEvent` stashes the tapped chat via `stashPendingNotification` (`pendingNav.ts`), and
  `app/(app)/_layout.tsx` DRAINS it on every AppState `active` (plus `getInitialNotification()` for the
  killed-app cold-start) through `drainNotificationTap`, which reads both sources and opens the chat exactly
  once. Reading `getInitialNotification()` only once on mount is NOT enough — it never re-fires for a
  background-alive resume, so the thread never opens. Keep `drainNotificationTap` idempotent (no-op when
  nothing is pending; single navigation when both sources describe the same press).
- **Send-contact posts STRUCTURED fields; the SERVER builds the vCard.** The `send-contact` endpoint
  (`POST /api/v1/message/contact`) takes `{ firstName, lastName, organization, phones[], emails[] }` and
  the server assembles the vCard 3.0 + sends it as an attachment (client builds no file). Gate the UI on
  `serverInfo.supports_send_contact` (`useSendContactSupported`) — the tray's "Contact" button is only
  passed a handler when true. The optimistic bubble is a TEXT placeholder (the contact's display name)
  until the live `new-message` echo swaps in the rendered `.vcf` card; that brief text-then-card is
  expected. See `sendContactService.ts` + `pickContact` (`contactsService.ts`).
- **Additive migrations are appended to `MIGRATIONS` by name** (`src/db/migrations.ts`); `runMigrations`
  skips already-applied names and wraps each in BEGIN/COMMIT. Use `ALTER TABLE ADD COLUMN` (no
  `IF NOT EXISTS` — SQLite lacks it; the name-guard is the idempotency). Never edit an applied migration.
  Mirror new columns into schema.ts + the zod model + `upsertMessages` (value + conflict set) +
  `listMessagesWithSenders` + the `MessageRow` interface — and any test helper that builds a `MessageRow`
  literal (tsc passes but ts-jest fails on the missing required field).
- **Theme is preset-driven, not OS-scheme:** `useThemeStore` (preset key persisted in `kv`) → `ThemeProvider`
  → `resolvePreset(key)` tokens. Every component reads `useTheme().color.*`, so switching the preset recolors
  the whole tree with no per-component edits. Hydrate the store in the root mount effect.
- **URL-preview fetch hits an attacker-controlled URL** — guard it: http(s)-only, `content-type: text/html`,
  size + AbortController-timeout caps, render as plain `<Text>` (no HTML interpretation), and do NOT route it
  through `HttpClient` (keeps the server auth header off third-party sites). RN `fetch` is not CORS-limited.
- **notify-kit `TimestampTrigger.timestamp` must be STRICTLY in the future** — it throws
  `'trigger.timestamp' date must be in the future` otherwise (device-only; the jest mock can't catch
  it). A minute-granularity picker that floors to `:00` yields a past timestamp once seconds elapse,
  so clamp the picked time to `max(picked, now + 60s)` before scheduling (see `pickFutureDateTime`).
  Use `alarmManager: { type: AlarmType.SET_AND_ALLOW_WHILE_IDLE }` for an INEXACT doze-friendly alarm
  that needs NO `SCHEDULE_EXACT_ALARM` permission (exact alarms throw a SecurityException on API 31+).
- **kv-hydrated zustand stores must guard `getDatabase()`** — it throws if the DB isn't open yet, and
  the root `_layout` effect runs the hydrate before connect. Wrap hydrate/persist in try/catch (leave
  `hydrated` false on failure) and re-hydrate once the DB is open (home mount). See `smartReplyStore`/
  `themeStore`. Forgetting the guard crashes the app with a LogBox "Database not initialized" overlay.
- **attributedBody runs may not tile the whole string** — iMessage often emits a single mention run
  inside a longer message, leaving gaps. A parser that only emits each run's range silently DROPS the
  uncovered text. Track a cursor and emit `[cursor, run.start)` + the trailing remainder as plain runs
  (see `parseAttributedRuns`). The upstream format carries NO bold/italic/underline attributes (grep the
  Flutter `lib/` for `kIMText*` → zero hits), so rich text is mentions + links only.
- **Backups must filter secret-looking kv keys + delete the cache export file.** The export reads only
  `kv`/`themes`/whitelisted `chats` columns (never SecureVault/messages/handles) and drops any key
  matching `/password|token|secret|credential|auth|key/i`; the plaintext file written to `Paths.cache`
  is deleted in a `finally` after the share sheet so it doesn't linger. See `src/services/backup/`.
- **iMessage send-effects ship JS-only via RN `Animated` (no Reanimated/Skia).** Bubble effects
  (slam/loud/gentle) animate `scale`/`opacity` once on mount; invisible-ink hides text behind a
  tap-to-reveal `Pressable`. Full-screen effects (confetti/balloons/…) are JS particles driven by ONE
  native-driver `Animated.Value` interpolated per-particle (cheap). Always `return () => anim.stop()`
  from the `useEffect` — `MessageBubble` lives in a recycling FlashList, so an uncleaned animation
  bleeds transform state onto a recycled row. The overlay must be `pointerEvents="none"` (it floats
  over the chat and auto-dismisses; a touch-catching `Pressable` would freeze scrolling for ~2.6s).
  Map effects from `expressiveSendStyleId` (the 12 exact ids in `src/core/effects/effectsMapper.ts`).
- **A server-supplied URL opened via `Linking.openURL` MUST be scheme-validated.** The FaceTime answer
  endpoint returns a `link` (zod `z.string()`); a compromised server could return `intent://`/`tel:`/a
  deep link. Whitelist (`facetime:` / `https://facetime.apple.com/`) before `openURL`. Same principle as
  the URL-preview hardening — never trust server/3rd-party content blindly.
- **Every notification body must honor the `hidePreview` toggle.** When adding a new notify-kit path
  (FaceTime caller name, etc.), redact under `hidePreview` like `postNotification`/the reminder path do —
  it's easy to leak identity on the lock screen by forgetting it. Android full-screen-intent call
  notifications (`fullScreenAction`, `AndroidCategory.CALL`) need `USE_FULL_SCREEN_INTENT` in
  `app.config` `android.permissions` on API 34+, else they degrade to heads-up (and that needs a rebuild).
- **Deferred native transports/modules are dependency-INJECTED so Metro never bundles the uninstalled
  package** and the build stays green. `FcmPushTransport` takes the `@react-native-firebase/messaging`
  instance via its constructor; `pushTransport.ts` imports none of it (enabling FCM means installing the
  package + `google-services.json`, then wiring it from a new module — see the file's doc).
- **Timer-driven deferred work needs a DB-level claim, not just a `useRef` guard.** The scheduled-message
  ticker fires from BOTH `home.tsx` (mount) and every open `chat/[guid].tsx` (mount + 20s interval), and a
  send can outlast the 20s interval — so two runs can read the same `pending` row before either marks it sent.
  The fix is an atomic claim (`UPDATE scheduled_messages SET status='sending' WHERE id=? AND status='pending'
  RETURNING id`): exactly one caller gets the row back, the rest skip — this is the real lock (a component
  `useRef` only de-dupes within one screen). Pair it with an `attempts` cap → `status='error'` so a row whose
  send always throws (deleted chat) stops retrying, and a startup `sending → pending` reset to recover crashes.
  See `runDueScheduled` (`src/services/send/scheduleService.ts`) + `claimScheduled`/`markScheduledFailed`/`resetStuckScheduled` (`src/db/repositories/scheduled.ts`).
- **`React.memo` on a list row is INERT unless the list passes STABLE callbacks.** Memoizing `MessageRow`/
  `MessageBubble`/`ConversationTile` does nothing if `renderItem` hands them a fresh `() => …` closure each
  render (the new function fails the shallow prop compare). Pattern: wrap the parent handler in `useCallback`
  AND make it take the item (`onRetry?: (msg) => void`), then bind the item INSIDE the memoized row
  (`onRetry={onRetry ? () => onRetry(msg) : undefined}`) — that binding closure is created on the row's own
  render, which the memo gates. The payoff is decoupling: rows then re-render only on a real message change,
  not on every composer/reply/selection state change in the chat screen. See `MessageList` + `MessageRow`.
- **The item-taking callback's param type must match the ACTUAL type passed (contravariance), not a wider
  local alias.** `MessageRow` originally typed its rows as a local `EnrichedRow` (reactions optional); the list
  passes `EnrichedMessage` (reactions required). A handler `(m: EnrichedMessage) => void` is NOT assignable to
  `(m: EnrichedRow) => void` (the target may call it with the wider type). Fix: type the row's `msg` + callbacks
  with the same `EnrichedMessage` the list actually feeds — don't invent a wider local alias.
- **A class `ErrorBoundary` needs `override` on `state`/`componentDidCatch`/`render`** (tsconfig
  `noImplicitOverride`), else tsc errors TS4114. Mount it ABOVE the providers (it must catch a `ThemeProvider`
  throw too), so its fallback uses literal colors, not theme tokens. See `src/ui/ErrorBoundary.tsx`.
- **FlashList v2 auto-sizes — do NOT add `estimatedItemSize`** (removed/ignored in v2; it was a v1 prop).
- **Mark avatars `accessible={false}`** — they sit next to a label that already announces the name (tile title,
  chat header), so a labeled avatar double-announces under TalkBack. Decorative-by-default is correct here.
- **Never call `console.*` directly — use `logger` from `@core/secure`** (the redacting logger over a
  `ConsoleSink`). It scrubs guid/password/token/authorization keys + `?guid=` URL params before any sink, and
  CI fails on a raw `console.*` outside `logger.ts`. `__DEV__`-only noise → `logger.debug` (the sink drops it
  in prod). GOTCHA: `__DEV__` is a RN runtime global that is **undefined under Jest** — never write a bare
  `!__DEV__` (it throws `ReferenceError` in tests, surfacing only when a test exercises that path); guard with
  `typeof __DEV__ !== 'undefined' && __DEV__` (see `ConsoleSink`).
- **App-lock cold-boot DB-key gating: the lock-enabled flag lives in the VAULT, not the encrypted DB/kv.**
  Chicken-and-egg — to withhold the SQLCipher key until biometric auth, you must read the setting BEFORE
  opening the DB, so it can't live in the encrypted kv table. `boot()` (`src/services/bootstrap.ts`, re-exported
  from the `src/services/index.ts` barrel) reads it from the vault first and only calls `hydrateSession()` (which opens the DB via `getOrCreateDbKey`) when NOT
  locked; `completeUnlock()` opens the DB + routes after a successful auth. The lock gate is a **root-layout
  overlay** (`app/_layout.tsx`), not the `(app)` layout — it must cover the pre-DB boot, where `(app)` hasn't
  mounted. Enabling app-lock requires `isBiometricAvailable()` (else a user with no enrolled biometric locks
  themselves out — and the bare emulator has none, so never enable it there).
- **The outgoing-queue retry processor leases rows via `next_retry_at`, and skips FRESH rows via a grace
  window.** `runOutgoingQueue` (the crash-recovery for optimistic sends) must NOT re-send a row whose UI send
  is still in flight. Two guards: (1) `claimOutgoing` atomically pushes `next_retry_at` into the future
  (`UPDATE … WHERE id=? AND next_retry_at<=now RETURNING id` — one runner wins, like `claimScheduled`), and
  (2) `listRetryableOutgoing` only returns rows that are already-failed (`attempts>=1`) OR older than
  `OUTGOING_GRACE_MS` (a just-inserted row is assumed owned by the live UI send). Backoff via
  `outgoingBackoffMs`; retire at `OUTGOING_MAX_ATTEMPTS`. Run it at boot (home) + the background task — NOT
  per-send. Uses `db.all(sql\`… RETURNING\`)` for the claim because it must read back the claimed
  row (`db.run` works too but returns no rows; use it only for non-returning writes).
- **Wallpaper-chat chrome: RN 0.86 has BUILT-IN CSS gradients** (`experimental_backgroundImage`,
  new-arch) — no expo-linear-gradient/masked-view needed. Over a chat background the header/composer
  go transparent (frosted chips), the message list runs UNDER them (absolute-overlay layout in
  `chat/[guid].tsx`, bar heights measured via onLayout), and `EdgeFade` veils dissolve rows into
  the bar zones. The veil's transparent end must be the SAME colour at alpha 0 — `transparent` is
  black@0 and interpolates a smoky fringe on light themes. Non-bubble labels (sender/date/status/
  "Edited"/tombstone) get frosted pills (`overlayPillStyle`, theme bg @ 62%) — a text halo/shadow
  alone does NOT survive busy photos. GOTCHA 1: the wallpaper flag arrives ASYNC (reactive query,
  null on first render; a participant-set background can land mid-chat) — keep ONE structural tree
  and flip only STYLES + zIndex. Branching element types (View vs Fragment) on the flag remounts
  the whole subtree, wiping the composer draft/staged attachments/scroll position. GOTCHA 2:
  macOS's case-insensitive FS makes tsc reject sibling files differing only in case
  (`EdgeFade.tsx` + `edgeFadeStops.ts` → TS1261).
- **Native security modules are dependency-deferred + advisory, so the build stays green pre-rebuild.**
  `react-native-libsodium` (crypto), `jail-monkey` (`deviceIntegrity`), `react-native-ssl-public-key-pinning`
  (`certPinning`) are all installed but only touched via a lazy `import()` inside a `try/catch` (root check)
  or behind a "no config → no-op" guard (pinning skips the native call when no pins are stored). So a JS
  bundle on a build that hasn't linked them doesn't crash — they activate after the next native rebuild. When
  adding such a module, never top-level `import` it from a startup path.
- **`expo-media-library` SDK 57: the ROOT imperative API THROWS.** Like `expo-contacts`, SDK 57 moved
  media-library to a class-based API and turned the root `saveToLibraryAsync`/`createAssetAsync`/… into
  throwing deprecation stubs — so importing `expo-media-library` (root) silently broke Save-to-Photos on
  device (caught → `{status:'error'}`, invisible in jest since the module is mocked). Import from
  `expo-media-library/legacy` (as `AttachmentTray` does). `src/services/media.ts` uses it for both the
  gallery save AND the "Gator" album path (`createAssetAsync` → `getAlbumAsync`/`createAlbumAsync`/
  `addAssetsToAlbumAsync` with `copy=false` to MOVE, not duplicate; Android can't create an empty album, so
  the first save seeds it).
- **In-app toast: `AppToast` is a non-Modal host mounted once at the app root.** `showToast(msg)` (zero-React,
  callable from services) enqueues into `useToastStore` (FIFO, mirrors `dialogStore`); `AppToast`
  (`src/ui/toast/`) is an absolutely-positioned, `pointerEvents="none"`, auto-dismiss pill — NOT a `Modal`
  (a Modal would capture touches). Mount it after `<AppDialog/>` in `app/_layout.tsx` (inside
  ThemeProvider+SafeAreaProvider). Headless FCM has no React host, so `showToast` just enqueues and nothing
  renders — harmless.
- **Auto-download attachments runs on the INGESTION path via an injected callback.** `DbEventSink` takes an
  optional `onMessageStored?(messageId)` (2nd ctor arg) — undefined in unit tests so their Node import graph
  never pulls natives; the app wires it from `realtimeControl.ts` to `autoDownloadMessageAttachments`
  (`src/services/download/autoDownloadAttachments.ts`). That fn LAZILY `import()`s the fetcher / `expo-network`
  (Wi-Fi gate) / `expo-media-library` only AFTER its early returns, so importing it stays Node-safe. Gated by
  `shouldAutoDownload` (image/* ≤5MB) + the `autoDownloadAttachments`/`autoDownloadOnWifiOnly` flags; the
  `autoDownloadDestination` enum ('app'|'gallery'|'album', default 'album') decides the extra saved copy; a
  single toast is BATCHED per burst (module-level debounce), never one-per-image. Hydrates the feature store
  once if headless (defaults otherwise ignore the user's Wi-Fi-only/destination choice).
- **In-app App Logs persist across restarts via an INJECTED file sink.** `MemorySink` (heap-only) is wiped on
  app close; `FileLogSink` (`src/services/logging/fileLogSink.ts`, OUTSIDE `core` so it can use
  expo-file-system — lazily) is attached to the logger's `TeeSink` at `boot()` via `logSinks.add(...)`, after
  `memoryLogSink.hydrate(...)` seeds the viewer from `Paths.document/app-logs.json`. `write()` stays sync
  (buffers + debounced flush); capped at 500 lines; the viewer's Clear wipes the file too. Lines are
  already-redacted before any sink, so the file holds no secrets. `core/` must never import expo-file-system.
- **Chat opens at the newest message via a one-shot, keyboard-follow is near-bottom-gated** (`MessageList`).
  A normal open can't rely on `startRenderingFromBottom` alone (the list first mounts EMPTY on the async DB
  read), so a guarded `scrollToEnd` fires on the first `[]→populated` transition — but ONLY when `!focusReady`,
  so a notification/search open keeps its `initialScrollIndex` jump. A `keyboardDidShow` listener re-pins to
  the newest message only when the user was within `KEYBOARD_FOLLOW_THRESHOLD` of the bottom (else a reader is
  left alone). Both are device-only to verify (jest fakes keyboard + FlashList layout).
- **"Disable Battery Optimization" opens the settings SCREEN, not the one-shot request.**
  `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` only shows its dialog when NOT already exempt and silently no-ops
  forever after (looks broken on repeat presses; there's no exemption-state query without a native module).
  `src/services/battery.ts` fires `IGNORE_BATTERY_OPTIMIZATION_SETTINGS` (fallback `APPLICATION_DETAILS_SETTINGS`)
  so it always opens something.
- **A Gator-server route the client doesn't back → `UnimplementedEndpointError`, not a scary error.** Pattern:
  `getAccountInfo` remaps a **404** to `UnimplementedEndpointError` so `account.tsx` shows a neutral "not
  supported on this server yet" state instead of blaming the Private API (same as `/server/update/check`).
- **iMessage Account (`icloud/account`) IS implemented server-side now** (2026-07-18, `packages/bbd`
  `icloudOperations.ts`) — the Settings row is gated on `serverInfo.supports_icloud_account`
  (`useIcloudAccountSupported`), emitted by the server as `enablePrivateApi` (the endpoints need the helper).
  Two things to know: (1) the **snake→camel normalization is done SERVER-side** (helper returns
  `apple_id`/`account_name`/`active_alias`/`vetted_aliases:[{Alias}]`; the bbd route maps to the app's
  camelCase `AccountInfo` — a raw passthrough parses as 200-but-all-null since the app schema is loose +
  nullish). (2) Keep the 404 fallback in `account.tsx` as defense-in-depth: the flag hides the *entrance*,
  but the screen is still reachable via deep link or a stale/null `serverInfo`, and Private-API-off servers
   404. Helper-off (flag on, helper crashed) surfaces as a generic 500, not 404 — acceptable. See
  `docs/IMESSAGE_ACCOUNT_PLAN.md` + `docs/APP_SERVER_PARITY.md`.

## FCM gotchas (verified against the Flutter/Kotlin reference)
- **Envelope shape:** the server's FCM *data* message is `{ type: '<event>', data: '<JSON body>',
  encrypted?, partial?, encoding?, subtype?, encryptionType? }`. The event name is under `type`;
  the body is under **`data`** (a JSON string), with metadata as siblings — there is NO top-level
  `payload` key. Mirrors Flutter `ServerPayload.fromJson` (`json['data'] ?? json`). Parsing lives in
  the firebase-free, unit-tested `src/services/notifications/fcmPayload.ts`. `EventRouter.coerceData`
  JSON-parses the string body; do NOT double-parse.
- **Headless wake has NO React tree.** A killed-app FCM push re-evaluates the JS entry (top-level
  side-effect imports run) but RootLayout's component/`useEffect` do NOT. So anything seeded only by
  a boot effect is at its module default headlessly. Consequences already handled: the notification
  hide-preview (redacted) flag is re-synced from the persisted setting inside `dispatchRealtimeEvent`;
  the DB is opened with `ensureDatabase()` (lazy, headless-safe) — never `getDatabase()` (throws if
  never inited). Use `ensureDatabase()` in any background/notification-action handler.
- **Encrypted FCM payloads** (`encrypted: 'true'`) ARE decrypted now, via the shared `AEAD_GCM_V1`
  scheme (`encryptionType: 'AEAD_GCM_V1'`): AES-256-GCM, key = SHA-256(salt‖password), frame =
  `ver(1)‖salt(16)‖iv(12)‖tag(16)‖ciphertext` base64. `src/services/notifications/fcmDecrypt.ts` uses
  expo-crypto's NATIVE AES (`AESSealedData.fromParts` + `aesDecryptAsync`) — so it runs on-device only
  (not jest); the server's round-trip test proves the frame. Do NOT use libsodium AES here (react-native-
  libsodium's native layer is XChaCha-only) or CBC/CryptoJS (unavailable in RN). Any OTHER
  `encryptionType` is logged + skipped (the message still arrives on the next sync). The server side is
  `packages/bbd/src/notifications/fcm/fcmPayloadCrypto.ts`, gated by the `encryptComs` setting.
- **App-lock is a UI gate, not key custody:** a headless push decrypts the DB + posts (content gated
  only by redacted/locked mode) even while app-locked. Acceptable for delivery, but the lock does NOT
  withhold the key from the push path — don't claim otherwise. NOTE: `keychainAccessible: WHEN_UNLOCKED`
  on the secure-store options is iOS-only and INERT on Android (the Android Keystore applies no
  "accessible only when unlocked" attribute here), so it is NOT an at-rest key-custody guarantee on
  Android. `requireAuthentication` is intentionally OFF so the headless-while-locked decrypt works
  (see `src/native/secureVault.ts`).
- **Register the FCM token on EVERY (re)connect, not once.** `registerFcmToken` runs from every
  `startRealtime()` (NOT gated by `realtimeOneTimeSetupDone` — only the permission prompt is, to avoid
  the GrantPermissionsActivity loop). The server de-dupes by token, so re-registering is idempotent, and
  it is the only thing that recovers push when a one-shot registration silently broke: a transient failure
  at first boot (server briefly unreachable → server has NO token → zero pushes all session), a reconnect
  to a DIFFERENT server after `forget()`, or an FCM token rotation that landed while disconnected.
- **EventRouter dedup: CLAIM the guid before the sink, RELEASE it if the sink throws.** `new-message` is
  deduped by guid (socket + FCM deliver the same message). The claim is recorded synchronously BEFORE
  `await sink.onEvent` (so a concurrent redelivery is still deduped mid-flight) but removed in a `catch`
  if the sink throws — otherwise a delivery that failed on a transient DB error burned the guid forever
  and every redelivery was silently deduped away, so the notification was never posted (the DB-write path
  from a later full sync does NOT run through the notify layer). See `hasSeen`/`recordSeen`/`unrecordSeen`.
- **Hydrate the redacted/feature stores at most ONCE per JS context on the push path.**
  `dispatchRealtimeEvent` gates `hydrate()` on each store's `hydrated` flag (`if (!store.getState().hydrated)
  …`) — a killed-app wake must hydrate once (no UI boot effect ran), but re-reading kv on every event
  (incl. the frequent silent `updated-message` receipts) was pure redundant work; the in-memory store is
  authoritative after the first hydrate and its setters keep it current. Likewise `ensureDatabase()`
  returns the cached handle via `getDatabase()` before ever calling `resolveDbKey` (two Keystore reads).

## Crypto gotchas (react-native-libsodium, verified on-device)
- **AAD must be a `string`.** The NATIVE binding throws `crypto_aead_xchacha20poly1305_ietf_encrypt:
  input type not yet implemented` if `additional_data` is `null` or a `Uint8Array` — only a string is
  accepted (and ciphertext for decrypt must be a Uint8Array, never a string). The Jest backend
  (`libsodium-wrappers`) is lenient and accepts `null`, so this ONLY surfaces on device. We pass `''`
  when there's no AAD (`src/native/crypto.ts`). Lesson: a green Jest crypto test does NOT prove the
  native backend — run `runCryptoSelfTest()` on device (it logs at dev boot from `boot()`).
- **Expected dev-boot proof:** `[crypto] self-test { ok: true, detail: 'round-trip + tamper-reject OK' }`.
- **op-sqlite SQLCipher `PRAGMA rekey` works on-device** (proven 2026-06-20): rekey re-encrypts in
  place, the new key opens it, the old key is rejected. Dev boot logs `[db] rekey self-test { ok: true }`
  (a THROWAWAY db, never the real one — `runDbRekeySelfTest` in `src/db/key.ts`). The rekey passphrase
  format must match the open `encryptionKey` (both the plain 64-char hex string). Crash-safe full key
  rotation can be built on this; jest can't test rekey (better-sqlite3 has no codec).

## Verify before claiming done
```bash
npm run typecheck   # tsc --noEmit
npm test            # jest — runs BOTH projects (node + components)
```
On-device behavior (DB, FCM, screens) is verified via the spikes in `docs/SPIKES.md` once
the Android toolchain / EAS is available.

### Component tests (jest-expo + React Native Testing Library)
- `npm test` now runs TWO jest projects: `node` (ts-jest, `.test.ts`, the React-free core/db/services
  layer) and `components` (jest-expo, `test/components/**/*.test.tsx`, the RN/RNTL world). The
  **file extension is the router** — `.test.ts` → node, `.test.tsx` → components.
- **`renderWithTheme(ui, { preset? })` is the entry point** (`test/components/support/renderWithTheme.tsx`):
  it wraps RNTL `render()` in a hydrated `ThemeProvider` and re-exports every RNTL helper, so a test
  imports from that ONE module. The shared setup (`support/setup.ts`) mocks `@db/database` and resets
  the theme store after each test.
- **`__DEV__` IS defined here** (unlike the ts-jest `node` project where it's undefined) — jest-expo
  provides it. Don't "fix" a `typeof __DEV__ !== 'undefined'` guard on the components side.
- **RNTL 14 under React 19 is ASYNC — always `await`:** `render()` (via `renderWithTheme`) returns a
  Promise; `cleanup()` and unmount-effect flushes are async too. After a `fireEvent`, assert via
  `findBy*`/`waitFor`.
- **Store mutations that re-render a MOUNTED tree need `await act(async () => …)`** (a bare sync `act()`
  drops the "not wrapped in act" warning on the floor). **Reset stores in `beforeEach`, not `afterEach`**
  — an afterEach setState fires on the still-mounted tree and trips an act warning.
- **NEVER assert `jest.getTimerCount() === 0`.** The jest-expo `Animated` mock leaves residual
  frame-loop timers regardless of mounting. Either measure a baseline in-situ and drain back TO it
  (see `messageBubble.test.tsx`) or assert the cleanup contract via start/stop spies
  (see `typingBubble.test.tsx` / `bubbleEffectCleanup.test.tsx`).
- **Regression guards for the UI gotchas above** live in `test/components/`: memo-with-stable-callbacks
  (`conversations/messageRowMemo.test.tsx`), effect cleanup on FlashList recycle
  (`conversations/bubbleEffectCleanup.test.tsx`), and redacted-mode masking (`redaction.test.tsx`).
- **UI coverage floor: `npm run coverage:ui` must stay ≥ 70%** (statements over `src/ui/**`, barrel
  `index.ts` files excluded; both jest projects count — see `docs/UI_COVERAGE_70_PLAN.md`, met at
  ~74% in 2026-07). Files intentionally below the line are native-mock territory (VoiceRecorder,
  VideoPlayer, AudioAttachment, ThemeStudio, FindMyMap) — don't chase them with mock-testing-a-mock
  tests; on-device verification covers them.
- **An un-awaited `fireEvent` can corrupt every LATER test in the file** (React 19 "overlapping
  act()"), especially for components rendering inside a RN `Modal` — the failures appear only in
  full-file runs, never in isolation. `await waitFor(...)`/`findBy*` after EVERY state-mutating
  fireEvent. Related VM limits: `React.lazy`/dynamic `import()` REJECTS under jest (test the lazy
  child directly; the boundary fallback is the only reachable branch), and helpers doing
  `await import('react-native')` (e.g. `safeOpenUrl`) are unobservable — mock at the helper
  boundary via `jest.mock('@utils', () => ({ ...jest.requireActual('@utils'), safeOpenUrl: jest.fn() }))`.
