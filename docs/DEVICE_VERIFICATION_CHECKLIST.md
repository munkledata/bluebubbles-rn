# Device Verification Checklist

> **Status (2026-08-23): PREPARED ONLY — NO VERSION-CODE-56 DEVICE OR PLAY RESULTS.** This
> document does not authorize or prove an upload, submission, tester invitation, server deployment,
> Play install, or device result. The old behavior matrix below is quarantined as historical and
> must not be executed until `DEVICE-01B-CURRENT-FLOW-MATRIX` reconciles it with the current app and
> staged-data rules.

This is the evidence record for the exact Google Play Internal Testing candidate. Host tests can
support a result, but notifications, Firebase Cloud Messaging (FCM), encrypted storage, native
bridges, process death, and Play delivery need evidence from the exact installed candidate. Never
copy a result from a development build or an older Play build into the candidate record.

## Exact version-code-56 candidate boundary

| Field                      | Frozen value                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| App/package                | Gator / `com.bluegreengatorapps.messages`                                                         |
| App version                | `0.1.40`                                                                                          |
| Android version code       | `56`                                                                                              |
| Candidate source commit    | `5d367eb58e38126258423f1cd9ce0da42b179f7f`                                                        |
| Local AAB                  | `gator-release-0.1.40-v56-5d367eb.aab` — ignored; never commit it                                 |
| Size                       | `55,729,707` bytes                                                                                |
| AAB SHA-256                | `926ce40c8ada2b69b093aaafb7a5f3a2a08bd7f5ae061c526c8a33b5462b9eac`                                |
| Upload certificate SHA-256 | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43` |
| Build provenance           | Local EAS production build, 2026-08-23; tracking ID `0c5e82fe-e8d2-4dfa-ad94-38f9e805df7e`        |
| Packaged Android boundary  | `arm64-v8a` only; minimum SDK 24; target SDK 36                                                   |
| Distribution boundary      | Private Google Play Internal Testing only; no promotion                                           |
| Current external state     | Not proven uploaded, accepted, published, Play-installed, or device-tested                        |

Do **not** rebuild this candidate. The production profile auto-increments, so another production
build would consume version code `57` and create a different artifact. If a separate upload is later
approved, select this exact local file by name and recompute its digest immediately beforehand;
never select an ambiguous "latest" artifact. The newest recorded hosted EAS build is code `54`, with
zero hosted builds recorded for codes `55` and `56`. GitHub Actions and development artifacts are
disposable supporting builds, not this candidate.

The AAB digest identifies the local file, and the upload-certificate fingerprint identifies its
upload signature. Google Play delivers split APKs signed with the separate **Play App Signing
delivery certificate**. Record that certificate and verify the installed package against it; do not
expect an installed split APK hash to equal the original AAB hash. A local or sideloaded install can
exercise behavior but cannot prove Google Play Internal Testing delivery.

## Candidate session and evidence ledger

Leave every field `OPEN` until a separate approved Play/device session produces evidence. Use an
alias rather than a tester's email address or device serial.

| Field                                  | Safe value to record                                                   | Status |
| -------------------------------------- | ---------------------------------------------------------------------- | ------ |
| Evidence-record commit/date            | `[OPEN — commit containing the completed results]`                     | OPEN   |
| Tester evidence alias                  | `[OPEN — no account address]`                                          | OPEN   |
| Device model                           | `[OPEN]`                                                               | OPEN   |
| Android version / API level            | `[OPEN]`                                                               | OPEN   |
| Device ABI                             | `[OPEN]`                                                               | OPEN   |
| Navigation mode                        | `[OPEN — gesture or three-button]`                                     | OPEN   |
| Display/font/TalkBack state            | `[OPEN]`                                                               | OPEN   |
| Permission baseline                    | `[OPEN — fresh, denied, or previously granted]`                        | OPEN   |
| Test branch                            | `[OPEN — clean Play install or approved prior-build Play update]`      | OPEN   |
| Approved prior-build baseline          | `[OPEN — version, version code, and source label]`                     | OPEN   |
| Live Play inventory alias/date         | `[OPEN — private evidence reference]`                                  | OPEN   |
| Internal release status/artifact       | `[OPEN]`                                                               | OPEN   |
| Tester-list label/count                | `[OPEN — never tester identities]`                                     | OPEN   |
| Opt-in evidence alias                  | `[OPEN — never the link]`                                              | OPEN   |
| Install source                         | `[OPEN — must prove Google Play delivery]`                             | OPEN   |
| Installed package/version/version code | `[OPEN — must equal com.bluegreengatorapps.messages / 0.1.40 / 56]`    | OPEN   |
| Play delivery-certificate SHA-256      | `[OPEN — separate from the upload certificate]`                        | OPEN   |
| Installed signing fingerprint/result   | `[OPEN — compare with the Play delivery certificate]`                  | OPEN   |
| Server environment label/version       | `[OPEN — no hostname, URL, or credential]`                             | OPEN   |
| Synthetic fixture / Firebase labels    | `[OPEN — no message content or key material]`                          | OPEN   |
| Feedback route alias                   | `[OPEN — no private address or token]`                                 | OPEN   |
| Tester notice version/approval         | `[OPEN]`                                                               | OPEN   |
| Test halt owner role                   | `[OPEN]`                                                               | OPEN   |
| Test window / credential expiry        | `[OPEN]`                                                               | OPEN   |
| Server/feedback dry-run evidence       | `[OPEN — private evidence aliases]`                                    | OPEN   |
| Cleanup/teardown owner role            | `[OPEN]`                                                               | OPEN   |
| Cleanup evidence alias                 | `[OPEN — local, server, FCM, credential, tester, and capture cleanup]` | OPEN   |
| Test date / result                     | `[OPEN]`                                                               | OPEN   |
| Private evidence reference             | `[OPEN — approved private storage only]`                               | OPEN   |

Evidence must use the approved isolated server and synthetic conversations. Never put accounts,
endpoints, credentials, QR payloads, opt-in links, message bodies, private filenames, device
serials, raw logs, or unredacted screenshots in Git or public feedback. Record a sanitized result
and a private evidence reference; delete temporary captures after the approved reviewer has checked
them.

### Historical evidence — not version-code-56 credit

The 2026-07-23 remote ADB session used installed Play build `0.1.28` / version code `39` on a Galaxy
S25 Ultra with Android 16. Later database checks used a local API-35 arm64 development emulator.
Every existing `[x]` below is historical supporting evidence only, even when the checked line does
not repeat this label. None satisfies `DEVICE-01` or the version-code-56 release gate.

---

## (a) Exact-candidate and session preflight — do not rebuild

These boxes remain open until the release owner separately approves the Play/device session.

- [ ] Confirm `STORE-01G-TESTER-READINESS` records an approved tester notice and access plan, halt
      owner, test window/credential expiry, and successful staged-server and feedback dry runs.
      Device-session approval does not replace those still-open prerequisites.
- [ ] Recompute the SHA-256 of `gator-release-0.1.40-v56-5d367eb.aab` immediately before any
      approved upload and stop unless it matches the frozen value above.
- [ ] Before any separately approved submission, use a read-only Play preflight to confirm the
      selected app/package, intended track inventory, tester-list label/count, feedback destination,
      and opt-in state. Record version code `56` as absent, draft, or another observed state; do not
      invent acceptance and do not save unrelated Console changes.
- [ ] After a separately approved upload and Play acceptance, confirm the Internal Testing release
      identifies exact version code `56` before enrollment or install evidence begins.
- [ ] Select either the clean-install branch or the separately approved prior-build Play-update
      branch. For an update, record the prior version, version code, and authorized source first;
      never silently use the old `0.1.28` / code `39` record as the baseline.
- [ ] Confirm the staged server, synthetic fixture, Firebase environment, tester alias, feedback
      route, and evidence custodian are approved without recording their private values here.
- [ ] Keep local, CI, and development installs off both Play candidate branches. They may support
      separate native debugging, but they do not prove candidate delivery and may replace or wipe
      the Play-installed app state.
- [ ] After installation from Play, record the installer/source, exact package, version name, and
      version code, then verify the installed signing fingerprint against the Play App Signing
      delivery certificate.
- [ ] Record permissions, display/font/TalkBack state, Android/API, ABI, navigation mode, test date,
      and private evidence reference before executing a refreshed behavior matrix.

Stop immediately on a wrong file digest, package, version, version code, install source, or signing
certificate; an unapproved update baseline; an unexpected active later track; unintended tester
access; production data or credentials; or private information entering public evidence.

### Separate development/native lane — supporting evidence only

Native debug harnesses may require a fresh **local** development build on disposable device state.
That lane must have its own artifact identity and cannot run on the clean-install or update branch.
Do not check a candidate box from a `__DEV__` marker, emulator-only harness, sideloaded build, or
GitHub Actions artifact.

---

## Historical behavior matrix — DO NOT EXECUTE UNTIL `DEVICE-01B-CURRENT-FLOW-MATRIX`

Sections (b)–(z) are retained only as an inventory of past checks. They mix version-code-39 results,
development-only harnesses, removed settings, real-account prompts, stale full-screen-intent claims,
and evidence commands that may expose private data. Do not run, tick, or use them as tester
instructions. `DEVICE-01B-CURRENT-FLOW-MATRIX` must reconcile each flow against the current app,
synthetic-only staged environment, permission behavior, and safe evidence rules first.

---

## (b) Notifications (via notify-kit)

Send yourself (or have someone send) a normal iMessage while the app is in the background.

- [ ] The notification renders in **thread/conversation style** — it shows the **sender's
      name and their avatar**, not a generic app icon (this is the Android `MESSAGING` style
      in `postNotification`, `src/services/notifications/notifeeService.ts`).
- [ ] Tap the **Reply** field on the notification, type a message, send it — it actually goes
      out and appears in the chat (routes to `sendTextMessage`).
- [ ] Tap **Mark as read** — the notification clears and the chat's unread marker advances.
- [ ] Tap **♥ Love** — a Love tapback is applied to that message (routes to
      `sendReactionMessage`).
- [ ] Open **per-chat notification settings**: from a conversation's settings, open its
      notification channel — Android's system settings for _that chat's own channel_ open, so
      you can give one conversation a custom sound/importance.
- [ ] Turn on **Hide preview / redacted mode** (Settings), then trigger a notification. The
      body, chat title, sender name, and avatar are all masked (generic "New message"). Check
      this for **every** notification path, not just a normal message: a reminder, a FaceTime
      call, and an alias-removed notice should all redact too.
- [ ] Leave a normal private message **already visible in the tray**, then turn Hide preview on.
      The existing notification is replaced immediately with generic text; turning the setting
      off again does **not** restore the old private text. Only notifications posted afterwards
      may show fresh content.
- [ ] Schedule a reminder, turn Hide preview on **before it fires**, and let it fire. It must show
      generic Reminder text and still open the correct chat/message when tapped. Repeat once with
      the alarm due while you are flipping the setting; no briefly fired private reminder should
      remain in the tray.
- [ ] On an upgrade from an older build, launch once with Hide preview **off** and verify any legacy
      GUID-derived per-chat channel is removed. After enabling Hide preview, verify a current
      local-key per-chat channel is named the generic **Conversation**, not the person's/group's
      name. Deleting a legacy channel loses its old custom sound once; reopen that chat's
      notification settings after turning privacy off to recreate it under the new private id.
- [ ] With a message, reminder, and FaceTime notice present, run
      `adb shell dumpsys notification --noredact` and inspect this app's records. Notification ids,
      `data`, `Person.id`, trigger ids,
      and channel ids must contain only `gator-*`, the `gatorOwner/gatorSchema/gatorKind` marker,
      local numbers, or random tokens — **no** chat/message GUID, phone number, email address, or
      FaceTime UUID. Visible title/body/avatar may still show content when Hide preview is off.
- [ ] While Hide preview is on, trigger the server RCS warning and push self-test paths. Their text
      must be the app-authored generic status (the server cannot inject arbitrary lock-screen text).
- [ ] Re-test Reply, Mark as read, Love, a reminder tap, and FaceTime Answer/Decline after the
      transition. Privacy-safe route keys must not break actions or deep links.
- [ ] With **app-lock enabled**, get a push while locked: you should see a single
      **content-less** "You have new messages" notice (from `postLockedNotification`) — no
      sender, no content. The real per-chat notifications appear only after you unlock.

---

## (c) FaceTime incoming call

Have someone FaceTime the linked Apple ID (or trigger one from the server).

- [ ] A **full-screen incoming-call** notification appears (full-screen intent, `CALL`
      category) — not just a small heads-up banner. (If it's only a small banner, the
      `USE_FULL_SCREEN_INTENT` permission didn't take — recheck the rebuild.)
- [ ] Tap **Answer** — the call is answered on the server and the FaceTime link opens (in a
      Chrome custom tab). The ringing notification clears.
- [ ] Tap **Decline** — the ringing notification clears and nothing else happens.

---

## (d) Reminders

- [ ] Set a message reminder for ~1–2 minutes out, then wait: the reminder notification
      **fires** near that time. (It uses an _inexact_ alarm that survives Doze, so it may be a
      little late — that's expected and needs no special permission.)
- [ ] Tap the fired reminder — it routes to the right chat and the reminder is cleared (its DB
      row is deleted).

---

## (e) Killed-app FCM push

This is the important one — it proves push works when the app isn't running at all.

- [ ] Open Gator once, background it, then run `adb shell am kill <package>`. **Never use
      `am force-stop` for this test:** force-stop puts the app in Android's stopped state and blocks
      broadcasts until the user launches it again, so it cannot prove killed-process FCM delivery.
- [ ] Send yourself a message. A notification should **still arrive** (the killed-app wake
      re-runs the FCM background handler).
- [ ] Repeat with an **encrypted** push (server's `encryptComs` setting on): the encrypted
      payload is decrypted on-device (AEAD_GCM_V1) and the notification arrives with real
      content. If decryption ever fails, the message still shows up on the next foreground
      sync — that's the intended fallback, not a silent drop.

---

## (f) Dev native-contract proofs

Run a **dev** build (`npx expo run:android`, dev client) with Metro on port 8081. The crypto marker
remains a manual boot-log check:

- [ ] `[crypto] self-test { ok: true, detail: 'round-trip + tamper-reject OK' }`

The database checks now have deterministic ADB harnesses. With exactly one authorized device, or an
explicit serial, run:

```sh
ANDROID_SERIAL=<serial> npm run test:android:db
ANDROID_SERIAL=<serial> npm run test:android:db:relaunch
ANDROID_SERIAL=<serial> npm run test:android:db:wal-write-death
ANDROID_SERIAL=<serial> npm run test:android:db:active-migration-death
```

The first harness cold-launches the debuggable app, accepts exactly one finite
`GATOR_DB_CONTRACT_V3` marker after a unique log boundary, and writes only allowlisted target/check,
migration-count, and migration-head metadata under the ignored
`android/app/build/reports/db-contract/` directory. The relaunch harness exclusively claims a
zero-byte DEV request before ordinary boot, requires one READY marker from process A and one final
marker from a different process B, and retains the same finite metadata under the ignored
`android/app/build/reports/db-relaunch/` directory. The active-WAL mode uses distinct scenario
markers and the finite `GATOR_DB_WAL_WRITE_DEATH_V1` schema, requires physical WAL growth before
exact `adb shell am crash <PID A>`, and retains only allowlisted target/check metadata under the
ignored `android/app/build/reports/db-wal-write-death/` directory. The active-migration mode uses a
third distinct marker family and finite `GATOR_DB_ACTIVE_MIGRATION_DEATH_V1` schema, requires WAL
beyond its header both before and after crashing exact A, and retains only allowlisted target/check
and migration-head/count metadata under the ignored
`android/app/build/reports/db-active-migration-death/` directory.

- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** Local API-35 arm64 emulator: **PASS**, schema 3,
      38 migrations at head `0038`, all 28 checks
      true; retained artifact `android-db-contract-2026-08-20T05-04-33-795Z.json`.
- [ ] Repeat on the exact release candidate and a supported physical device.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03A: run the exact current production
      migration registry from `0001` through `0038`, prove
      per-migration `0030` rollback/retry, and validate audited head-`0029` upgrade data.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03B1: on the local API-35 arm64 DEV emulator,
      emit READY while process A retains its fixed
      encrypted throwaway handle, force-stop A, observe no process, launch a distinct PID B, and
      require B to verify the existing head-`0029` state through `readOnly: true` before any
      read-write reopen or exact `0030`–`0038` retry. All 7 prepare, 12 resume, and 3 host checks are
      true in retained artifact `android-db-relaunch-2026-08-20T02-09-52-914Z.json`.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03B2A: pin three reviewed repository logical
      heads (`0024`, `0027`, `0029`) to full Git
      objects. On API 35, construct encrypted `0024`/`0027` fixtures, close and verify them read-only,
      then apply their exact tails through `0038`; retain the existing `0029` migration path. V3 is
      28/28 in the artifact above.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03B2B1: on the local API-35 arm64 DEV emulator,
      process A commits an exact WAL baseline,
      checkpoints, opens a bounded ordinary write transaction, and emits READY while it and the
      encrypted handle remain open. The host proves physical WAL growth, crashes exact A, observes no
      process, and launches distinct B. B first proves the exact baseline-only state read-only, then
      commits and reopens one recovery row and cleans every fixed database/sidecar/marker path. All 9
      READY, 12 final, and 5 host checks are true in retained artifact
      `android-db-wal-write-death-2026-08-20T16-46-24-970Z.json`.
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** DB-03B2B2: on the local API-35 arm64 DEV emulator,
      process A prepares exact head `0037` and an
      exact 133-row fixture, then emits READY only after the exact production migration `0038`
      `UPDATE` resolves inside its open transaction while the ledger remains at `0037` and before the
      runner can issue its ledger insert or commit. The host proves WAL beyond its header before and
      after crashing exact A and launches distinct B. B first proves the exact original head-`0037`
      state read-only, then applies exact `[0038]`, verifies the head-`0038` data, idempotency and
      persistence, and cleans all eight fixed paths. All 11 READY, 15 final, and 6 host checks are true
      in retained artifact
      `android-db-active-migration-death-2026-08-21T09-05-01-344Z.json`.
- [ ] Parent DB-03B2B/DB-03B remains open; power-loss and torn-write recovery remain unproved.
      DB-03C/DEVICE-01 still own scheduled CI, actual signed prior-build install-over,
      production-file continuity, spontaneous process death, and repetition of the active-migration
      crash on the exact release candidate and a supported physical device.

The disposable check deliberately fails the second statement of migration `0030`, proves only that
migration rolls back while `0001`–`0029` remain committed, then same-process reopens and applies exact
`0030`–`0038` over an audited fixture. It validates the ledger/data changes, real `messages_fts`
insert/update/delete triggers, foreign keys, integrity, idempotency, encrypted open, wrong-key
rejection, commit/rollback reactive convergence, all three private Drizzle adapter routes, rekey,
key-specific reopen, and cleanup without touching `gator.db`. A failed marker stops the lane with a
finite failure code; raw logs, database paths, keys, serials, and device model are not retained.

The V3 history extension uses fixed disposable `driver-history-selftest.db`, never `gator.db`. The
host test proves that the three canonical prefixes equal three reviewed repository commit objects;
there are no retained old APK/AAB/database samples or release tags. For `0024` and `0027`, the native
lane proves the exact boundary/rollback, closes the encrypted fixture, rejects the wrong key, verifies
unchanged state through `readOnly: true`, and applies the exact current tail with data, FTS5, foreign
key, integrity, idempotence, and cleanup checks. The aggregate V3 `historicalReadOnly` result covers
only `0024`/`0027`; head-`0029` read-only/process continuity is the separate DB-03B1 relaunch proof.

The relaunch lane uses its own fixed `driver-relaunch-selftest.db`, not `gator.db`. Its zero-byte
request/phase files make interrupted prepare/resume states fail closed and recoverable. Process B's
first encrypted open is read-only, so a missing file cannot be silently recreated before continuity
is checked. This proves a controlled force-stop/relaunch across two PIDs and preserved database
state; it does not prove inode identity, spontaneous OS death, crash-mid-write/power-loss behavior,
the production database, scheduled CI, old signed-app install-over, or release/physical-device
behavior.

The active-WAL lane uses its own fixed `driver-wal-write-death-selftest.db`, never `gator.db`, and
scenario-specific zero-byte phase files in the same exclusive DEV dispatcher. A commits the exact
baseline, requires WAL plus a successful truncate checkpoint, begins `BEGIN IMMEDIATE`, writes a
bounded multi-page uncommitted canary, and stays open at READY. The host requires the WAL file to
exceed its header before exact `am crash`; B's first encrypted open is read-only and requires the
exact baseline-only row set, after which read-write integrity/foreign-key checks, recovery commit,
read-only reopen, WAL retirement, and the unchanged pre-fallback eight-path absence gate all pass.
This is controlled ordinary active-WAL write-death evidence only—not active-migration crash,
power-loss/torn-write recovery, spontaneous OS death, production-file behavior, signed/store
provenance, scheduled CI, or release/physical-device proof.

The active-migration lane uses its own fixed `driver-active-migration-death-selftest.db`, never
`gator.db`, and its own scenario-specific zero-byte phase files in the same exclusive DEV dispatcher.
A constructs exact production head `0037`, commits an exact 133-row original fixture containing 128
bounded spill targets and five controls, checkpoints WAL, then enters the exact production `0038`
transaction. Its private wrapper awaits the real `0038` `UPDATE`, proves the exact migrated
in-transaction rows while the ledger is still exactly at `0037`, and enters a non-settling READY
callback before returning, so the ledger insert and commit cannot start. The host requires WAL beyond
its header both before and after exact `am crash`; B's first encrypted open is read-only and proves the
exact head-`0037` original fixture, after which read-write integrity/foreign-key checks, exact `[0038]`
retry, head-`0038` ledger/data, idempotency, read-only persistence, WAL retirement, and the unchanged
pre-fallback eight-path absence gate all pass. This is controlled post-statement/pre-ledger-and-commit
evidence only—not a statement-in-flight crash, power-loss/torn-write recovery, spontaneous OS death,
production-file behavior, signed/store provenance, scheduled CI, or release/physical-device proof.

---

## (g) App lock (cold boot)

- [ ] Enable app-lock (requires an enrolled fingerprint/face — a bare emulator has none, so do
      this on a real phone).
- [ ] Fully kill the app, then cold-launch it. The **lock screen appears first**, before the
      foreground app opens or renders the message database.
- [ ] Authenticate: the app opens the database and routes you into the app normally.
- [ ] While the UI is locked, send a killed-app push and confirm it posts only the generic locked
      notice without opening the DB; after unlock, sync catches the event up. App Lock is a
      foreground/policy gate, not user-auth-bound key custody or encryption for downloaded
      attachments/app logs.
- [ ] Unlock, background the app, wait longer than the configured lock timeout **without bringing
      it foreground**, then send a push. It must post only the generic locked notice; a background
      FCM delivery must enforce timeout expiry even before the AppState resume listener runs.

---

## (h) Inbound Android sharing — deliberately disabled (IPC-01 containment)

`expo-share-intent@8.0.1` reads provider metadata/media and can copy a stream without byte or time
limits before JavaScript receives an event. The release candidate therefore must not accept text,
files, `SEND_MULTIPLE`, or Direct Share targets until an owned bounded native intake replaces it.

- [ ] Inspect the exact candidate manifest: MainActivity has no `android.intent.action.SEND` or
      `android.intent.action.SEND_MULTIPLE` filter.
- [ ] Inspect the exact candidate manifest/resources: MainActivity has no `android.app.shortcuts`
      meta-data and the generated `shortcuts.xml` contains no `<share-target>`.
- [ ] Run Expo autolinking for the exact candidate: `expo-share-intent` is absent.
- [ ] Open another app's Android share sheet with text, one image, multiple images, and a PDF:
      Gator and its conversation chips do not appear as destinations.
- [ ] Confirm ordinary **outbound** sharing (for example, exporting a backup or sharing downloaded
      media) still opens Android's share sheet. Outbound sharing uses `expo-sharing` and is not part
      of this containment.

---

## (i) Background sync + FCM token

- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** After you connect to a server, confirm the
      **background sync task registered**: the dev
      log shows `[bg] background sync registered` (this is the ~15-minute catch-up sync).
      _(2026-07-23 adb, v0.1.28: line observed in logcat on a cold start of the release build.)_
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** Confirm **FCM token registration** succeeds after
      connecting — the device token is
      fetched (`getToken`, Firebase v25 API) and sent to the server. On failure you'd see
      `[fcm] device token registration failed` in the log; a clean connect should not log
      that. _(2026-07-23 adb, v0.1.28: cold start + 20s observation — no failure line logged.
      Release build has no positive success line, so this is verified by absence, as written.)_

---

## (j) SDK 57 general smoke test

A quick pass over the screens most likely to be disturbed by the RN 0.86 upgrade:

- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** Open a chat and scroll — messages scroll smoothly
      and, when you tap the composer, the
      keyboard pushes the input up instead of hiding it behind the keyboard.
      _(2026-07-23 adb, v0.1.28: scrolled a long thread both directions — reply-quotes, reactions,
      date pills all render; keyboard open showed the composer above it. Smoothness/fps is a feel
      judgment adb can't make — re-confirm by hand if it ever feels off.)_
- [x] **HISTORICAL / NOT VERSION-CODE-56 CREDIT —** Open a chat that has a **wallpaper/background** —
      the header and composer bars are the
      frosted/translucent style and the message list runs under them without a smoky fringe.
      _(2026-07-23 adb, v0.1.28: verified on a wallpapered group chat — frosted chips, edge-fade
      dissolve under both bars, sender/date pills legible over the photo.)_
- [ ] Open an **image/video in the media viewer** — it opens and plays.
      _(2026-07-23 adb, v0.1.28: IMAGE verified — full-screen viewer, "n of n" counter,
      share/save controls. VIDEO playback still open.)_
- [ ] Send a message with a **send effect** (slam / confetti / balloons, etc.) — the effect
      animates once and cleans up (no leftover animation bleeding onto other rows).
- [ ] In Settings → Downloads, change the **parallel-downloads** stepper, then open a chat with
      many attachments — no more than that many download at once (the cap lives in
      `featureSettingsStore` as `maxConcurrentDownloads`, applied in the download service).

## (j.1) Ordinary attachment-cache limits and recovery (`DL-01`)

These checks require a fresh build containing the current `gator-bounded-download` module. Host
tests prove the state machine and bounds; only a real Android filesystem can prove the bridge,
process-death, low-storage, and upgrade behavior.

- [ ] On Android 8+ with an existing pre-ledger install, download several attachments using the old
      two-level `attachments/<guid>/<name>` layout, upgrade in place, and launch. Every exact DB
      reference still renders; an unreferenced legacy file is removed without deleting its sibling
      or parent directory.
- [ ] With canonical files from two account generations for the same attachment GUID/name, launch
      recovery. The exact path stored in the DB survives; the unreferenced duplicate retires. Repeat
      with identical mtimes and confirm the outcome is deterministic.
- [ ] Kill the process with `adb shell am kill <package>` during a download (never `force-stop`),
      relaunch, and confirm the `.part` file and durable `reserved` owner are cleaned. The attachment
      must remain retryable and must not have a false `localPath`.
- [ ] Place a zero-byte file at an otherwise valid managed path before launch. Recovery clears the
      stale reference, removes that exact file, and a tap performs a new download instead of treating
      zero bytes as a cache hit.
- [ ] Exercise a hostile server that omits or lies about Content-Length and sends chunked/endless
      bytes. Automatic unknown-size download is refused; manual transfer stops at its actual-byte or
      time cap, cancels native work, removes partials, and never commits `localPath`.
- [ ] Fill the ordinary cache past **4,096 files** or **2 GiB** using a controlled fixture, and test
      with less than **512 MiB** free. Old unprotected files retire in deterministic least-recently-
      used order until all three constraints hold. Failed native deletes stay charged and cause new
      admissions to refuse rather than overfill storage.
- [ ] Keep one attachment visible in the media viewer while creating pressure; also queue an outgoing
      send/retry using another cached path. Neither protected file is removed. If those protected
      files alone prevent conformance, the next download fails cleanly and the app remains usable.
- [ ] Start launch recovery, then Disconnect/account-switch before it completes. No old-account DB
      mutation or native delete lands in account B; reconnecting B performs a fresh inventory before
      downloads open.
- [ ] Open Settings → Storage & File Privacy and confirm the 2 GiB/4,096-file, 512 MiB free-space,
      protected-file, and Android-version limitations are visible and understandable.
- [ ] On Android 7/API 24 or 25, confirm the inbox/sync remains usable but persistent attachment
      downloads fail closed. Before release, explicitly choose and document either this limitation
      or raising `minSdkVersion` from 24 to 26.

## (k) Reaction / action menu placement

Long-press a message bubble in a chat. This is a JS-only change (no rebuild needed); the _math_ is
node-tested (`reactionMenuLayout.test.ts`) but the on-screen placement is device-only.

- [ ] The chat dims and the pressed bubble stays **bright** ("lifts"), with the **tapback bar
      floating just above that bubble** and the **Reply / Copy / … menu as a card below it** —
      positioned to that specific message, not down at the bottom of the screen.
- [ ] Long-press the **very first (top) message** — the tapback bar flips to just **below** the
      bubble instead of clipping off the top edge.
- [ ] Long-press a message **near the bottom** (just above the composer) — the action menu stacks
      **above** the bar, and a very long menu scrolls inside its card.
- [ ] Long-press your **own** (right-side) vs **the other person's** (left-side) bubble — the bar
      and menu hug the correct side.
- [ ] Tapping a reaction applies it and **dismisses immediately**; tapping the dimmed area (or the
      bright bubble) dismisses **without** reacting.
- [ ] The bar + menu sit at the **right height** (not shifted up/down by the status bar). If they're
      off, it's the Android edge-to-edge window-coordinate caveat noted in `AGENTS.md` — the
      `measureInWindow` vs `Modal` origin offset (adjust the safe-area clamp in `MessageActionsOverlay`).

---

---

## (z) Batch 1 defect fixes — branch `bb2-batch1-defects` (2026-07-30)

Three bugs from `BB_APP_2.0_COMPARISON_2026-07-30.md`. All three were INVISIBLE to the test
suite before this work, and two of them are things jest fundamentally cannot prove (a real
Android intent, a real screenshot). This section is the part of the fix that a machine can't
sign off.

Needs a **clean rebuild** (`npm run android` / a fresh dev client) — a JS reload is enough for
the redaction and sticker items, but the document-open path touches native FileProvider
plumbing, so build fresh to be sure of what you're testing.

### Received documents can be opened (DOC-1 / DOC-2)

- [ ] Have someone send you a **PDF**. Tap the chip in the thread. It should OPEN in a viewer
      (or, if you have no PDF app, show the share sheet). Before this fix the tap did
      **nothing at all** — no error, no toast, no log line.
- [ ] Repeat with a **contact card (.vcf)** — expect the contacts importer or the share sheet.
- [ ] With **no PDF viewer installed** (or after clearing defaults), confirm you get either the
      share sheet or a toast reading "No app on this device can open PDF files" — never silence.
- [ ] Clear the app's cache so the file is gone, then tap the chip: it should **re-download**
      rather than error (that's the `missing` branch self-healing).
- [ ] While tapping, watch logcat for `[openFile]`. A `no viewer for this attachment` warn line
      is expected on the share-sheet fallback; an `error`-level line is a real failure worth
      reporting.

### Redacted mode hides locations (REDACT-1 / REDACT-2)

- [ ] Settings → turn **Redacted Mode ON**. Open **Find My**.
- [ ] The map is replaced by a panel reading "Map hidden in Redacted Mode". No pins anywhere.
- [ ] Device rows read "Device" / "Item" (People tab: "Person"), with "Location available" or
      "No location" — **no street address**, and **no battery percentage**.
- [ ] There is **no "Open ↗" button**, and tapping a row does nothing (no map recenter).
- [ ] **Take an actual screenshot and look at it.** Nothing in the image should identify where
      any device is. This is the whole point of the mode, and it's the check only a human can do.
- [ ] Open a chat containing a **shared location** card: it should read "Hidden in Redacted
      Mode" instead of coordinates, and tapping it must NOT open Maps.
- [ ] Turn Redacted Mode **OFF** and confirm everything comes back (map, pins, address,
      battery, Open ↗). If it doesn't, the fail-closed guard is stuck — say so.

### Received stickers are visible (STICKER-1..3)

The dev seed includes a sticker on Craig's "Morning! ☀️" message, so you can check the
rendering without waiting for someone to send one.

- [ ] On a **dev build**, open the seeded Craig conversation. A small sticker image sits on the
      corner of the "Morning! ☀️" bubble.
- [ ] **Tap it** — it fades to ~25% so the bubble text underneath is readable. Tap again to
      restore.
- [ ] **Long-press it** — it disappears for this session.
- [ ] Confirm the sticker does **not** also appear as its own separate bubble in the thread
      (that would be a double-render).
- [ ] Now the real thing: have someone on iMessage **send you a sticker** onto one of your
      messages. It should appear on that bubble. Note whether it shows up **immediately** or
      only after you leave and re-open the chat — the live push carries no image, so a delay
      here is EXPECTED and is what decides whether the follow-up item `STICKER-4` is worth
      building. **Please record which you saw.**
- [ ] Check **Photos / the Gator album**: the received sticker must **NOT** be saved there, and
      you should get no "Downloaded 1 image" toast for it. (Ordinary received photos should
      still save as before — check one to be sure the skip is sticker-only.)
- [ ] With Redacted Mode **ON**, confirm the sticker imagery is **not** rendered.

_Historical report note only: do not use the old request for screenshots or raw logcat output. A
future version-code-56 result must use the candidate ledger above, a sanitized summary, and an
approved private evidence reference._

_No combination of boxes in this quarantined matrix signs off version code 56. Candidate sign-off
requires a refreshed matrix plus exact Google Play install and signing provenance._
