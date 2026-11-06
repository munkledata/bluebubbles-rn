# Work plan 2026-08-03 — status log

Moved on 2026-11-06 from section 18 of [`STATUS.md`](../STATUS.md), which keeps
the task register and specifications. Dated entries only; the register's status lines remain the authority.
New entries go at the end of this file.
- **2026-08-03:** Plan created from the Codex architecture/security/feature/package/design audit. No app code
  changed. At creation, `MIG-00` recorded the one-time migration baseline and `MIG-01` was unchecked pending the
  permanent merge-time allocation guard/process; the 2026-08-04 entries below supersede that original status.
- **2026-08-04 — `MIG-00`:** `git fetch --all` succeeded against the sole configured remote (`origin`). The
  worktree and every visible local/remote branch contain no `0030+` migration; the observed head is
  `0029_chats_deleted_at`. The old planned numbers are explicitly retired: `0030_message_part_columns` → future
  `FEAT-03` merge-time allocation; `0031_message_error_message` → future `SEND-01B` merge-time allocation;
  `0032_push_retry_queue` → future `PUSH-RETRY-01` merge-time allocation; `0033_inbox_page_indexes` → future
  `PERF-02` merge-time allocation if measurement proves it necessary; `0034_chats_pin_index` → future `PIN-01`
  merge-time allocation; and `0035_custom_groups` → future `FEAT-04` merge-time allocation.
- **2026-08-04 — `MIG-01`:** `scripts/migration-registry.json` records the immutable baseline and no future
  reservation. `npm run check:migrations` now enforces sequential/unique names, a matching merge-time allocation,
  name-based upgrade test, schema/cache-wipe evidence, and rejects allocations not present in source. CI runs the
  guard. The live check and all five guard tests pass across 29 migrations, with head
  `0029_chats_deleted_at`; mutations prove gaps, duplicates, unregistered migrations, and distant reservations fail.
- **2026-08-04 — `BASE-01`, `GUARD-01`, `REL-011A`:** Typecheck, zero-warning lint, and `format:check` pass. Two
  consecutive baseline Jest runs each passed 335 suites / 2,840 tests; the then-current expanded suite passed 361 suites /
  3,360 tests. The architecture guard passes all five tests and its live scan of 63 core files. `REL-011` remains
  open for slices B–D and native killed-app composition proof.
- **2026-08-04 — `REL-006`, `REL-009A`:** HTTP retries now bind URL, password, auth mode, query, and custom headers
  to one logical request, re-read the full identity before retry, and retire the request if it changed; a new request
  then uses the coherent replacement identity. This deliberately supersedes the original plan wording that said an
  old request should continue against a new account, which would mix account ownership. Separately, failed database
  initialization closes and forgets its native handle before a clean retry. Focused evidence is 4 suites / 41 HTTP
  tests and 2 suites / 5 DB-open tests, with typecheck, lint, formatting, and diff checks green.
- **2026-08-04 — background attachment deadline:** Headless retries alone pass a shared 60-second deadline through
  queue lookup/stat and uploader preflight/gate/native-response stages; foreground sends and ordinary drains remain
  intentionally unbounded. Queued gate waits abort without consuming a slot, an active native transfer retains its
  slot and exact cancellation handle until it settles, first stop reason wins, and timeout maps to retryable error
  10003 ("Network Timed Out") rather than "Connection Refused." The five focused suites pass 65 tests, the wider
  send/retry set passes 14 suites / 119 tests, and the then-current full suite passed 361 suites / 3,360 tests; typecheck, lint,
  formatting, and the five-test/63-file architecture guard are green. Whole-wake and physical-device limits remain
  open as recorded under `REL-001` and `SCHED-01`.
- **2026-08-04 — `REL-007A`:** Added the pure foreground core-gate state machine and 16 focused Node tests. It
  proves ordered connected/setup/locked branches, retry generation, fatal closure, stale/out-of-order rejection,
  explicit invalidation before reset, and bounded priority-aware issue retention. Two independent reviews caught
  and drove fixes for late same-run core issues and severity downgrade during message enrichment. The then-current full
  suite passed 361 suites / 3,360 tests. No production boot wiring changed; `REL-007B2/C` and the parent remain open.
- **2026-08-04 — `REL-007B1`:** Added an entirely unwired, dependency-injected foreground coordinator around the
  pure reducer. It provides exact-Promise single-flight, locked pause/resume, fresh retry generations, retained
  terminal cancellation ownership, fail-closed normalized failures/issues, listener isolation, and stale-settlement
  suppression. Independent reviews caught and drove fixes for a lost settled-run abort controller, classifier and
  issue object/reference leakage, stale outer listener emission, async-listener rejection, and synchronous abort
  re-entry before successor ownership. The final two boot suites pass 52 tests, including late resolve/reject during
  all five stages; the full suite passes 361 suites / 3,360 tests, with typecheck, lint, formatting, architecture,
  and diff checks green. No production file imports it. Real adapters/classification, stage deadlines, durable
  session handoff, commit/disposal guards, singleton bootstrap replacement, Zustand/UI, and device proof remain
  `REL-007B2/C`; the umbrella and parent stay open.
- **2026-08-04 — truthful local privacy/support slices:** `LOCK-01A` and `ENVFILE-01` are complete. `FILE-01A` has
  truthful, linked app/README/store copy and 2 focused route suites / 26 tests, but remains open for exact-candidate
  offline file inspection. Settings now distinguishes installed App Version/App Build from Server Version; its
  25-test suite passes, while `SUPPORT-01` remains open for owner-approved privacy/license/support destinations.
  The secret-hygiene guard passes 4/4 tests and scans 779 tracked plus 814 historical paths. Draft store copy now
  says outbound sharing explicitly instead of the ambiguous “share-sheet integration” claim.
- **2026-08-04 — static/dependency/supply evidence:** `check:toolchain` passes all four tests with Node 24.19.0,
  npm 11.17.0, and EAS CLI 21.5.0. `check:secret-hygiene` passes all four tests while scanning 779 tracked and 814
  historical files. `expo install --check` reports dependencies up to date, Expo Doctor passes 20/20,
  `npm ls --depth=0` is clean, and both full and production-only high-level audits report zero vulnerabilities.
  The workflow guard passes its live scan and all 17 tests, with seven immutable action references; the
  Android build guard also passes its live scan and all nine mutation tests.
- **2026-08-04 — export/native preparation evidence:** The Android production Expo export passes. Its 6.2 MB
  Hermes bytecode has SHA-256 `16613903d958f4329cadab44f05d729f33ce6bccfdfa4e7e4836b93f587871c2`.
  An isolated clean Android prebuild and Expo-module autolinking pass, all three local modules are present, and
  custom notification icons are generated. Those early artifacts predated the final paste/wallpaper review fixes;
  the final local smoke rebuild recorded below supersedes them.
- **2026-08-04 — contained but still open at that checkpoint:** `NET-00` awaited its Android proxy capture. Embedded
  Find My and FaceTime WebViews were disabled with safe external handoff, but exact-candidate reachability proof
  remained. `TLS-00`/`TLS-01A` awaited a real HTTPS Android connection, and `NOTIF-01..03` awaited their
  foreground/background/killed-process device matrix. Exact Play v63 later closed `NET-00`; exact Play v64 has
  since closed `TLS-00` and repeated `TLS-01A`'s normal-HTTPS gate. The notification matrix remains open under
  its current entries.
- **2026-08-04 — local native release-variant smoke evidence (not a production candidate):**

  | Evidence item                                      | Result                                                                                                                                                                                                                                                                          |
  | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Native Gradle tasks and final result               | Paste and bounded-download unit suites pass; all three owned modules compile. `:app:assembleDebug`: **PASS**, 716 tasks in 10m 10s. `:app:bundleRelease`: **PASS**, 1,227 tasks in 12m 59s.                                                                                     |
  | Debug APK path, size, and SHA-256                  | `/private/tmp/gator-native.Dbc8FS/android/app/build/outputs/apk/debug/app-debug.apk`; 111,526,171 bytes; `3e5693b7143807e811f43a71d37e76ae2708c5a6a70a2ad91b28f37ca7837d40`.                                                                                                    |
  | Release-variant AAB path, size, and SHA-256        | `/private/tmp/gator-native.Dbc8FS/android/app/build/outputs/bundle/release/app-release.aab`; 55,522,327 bytes; `5b201b330a39e949dad2b68160a64240580c5b7bef95227ec1e1b56a112e526e`. Uses `test/fixtures/google-services.ci.json` and Android debug signing (`CN=Android Debug`). |
  | Packaged-artifact guard/manifest inspection output | **PASS under Node 24.19.0.** Debug/release manifests and the packaged AAB satisfy backup, permission, component, and headless-entry contracts; no inbound `SEND` filter, shortcuts metadata/`<share-target>`, or removed share-intent DEX marker is present.                    |
  | Hosted CI/EAS run URL and result                   | _PENDING — requires the hosted project/repository lane plus production Firebase/signing inputs._                                                                                                                                                                                |
  | Exact-candidate Android/Play device matrix         | _PENDING — requires target Android devices/emulators and owner Play-console evidence._                                                                                                                                                                                          |

  The smoke directory is intentionally disposable, has no `.git` source snapshot, and no 106 MiB APK or 53 MiB AAB
  was added to Git. The recorded paths and hashes distinguish these local outputs, but they are not reproducible
  production-candidate provenance and must not be used as Play/signing/Firebase evidence. They also predate the
  background attachment-timeout and `REL-007A/B1` JavaScript slices recorded above: they remain valid for the
  native/configuration build they exercised, but are no longer current-app artifacts. Re-export and rebuild before
  candidate/device claims.

- **2026-08-04 — `LEGACY-01/02`:** Reconciled every one of the 73 July-30 ids and every July-17 numbered item against
  HEAD, code/tests/migrations, history, and current device evidence. Added exact owners for all twelve previously
  orphaned July-30 items plus the per-send-alias blocker; recorded four July-30 decision gates and the remaining
  cross-repo/hardware/owner decisions without presenting them as client work. No app code changed.

- **2026-08-05 — current settled verification:** Two independent full Jest runs each pass **363 suites / 3,396
  tests**. Typecheck, zero-warning lint, Prettier, `git diff --check`, and conflict-marker inspection are green. The
  architecture guard passes 5/5 tests while scanning 63 core files; secret hygiene passes 4/4 while scanning 779
  tracked and 814 historical paths; the migration guard passes 5/5 across 29 migrations with head
  `0029_chats_deleted_at`; workflow and Android-build guards pass; `npm ls --depth=0` is clean; pinned Expo Doctor
  passes 20/20; and both full and production-only high-level npm audits report zero vulnerabilities.
- **2026-08-05 — guarded settings activation and `REL-008`:** Saved-session boot, explicit connection, and inbox
  re-hydration now carry revocable ownership guards through every kv-backed store. Connected UI, sync, and realtime
  stay closed until Feature, Sync, and Redacted Mode are confirmed; delayed runs cannot publish store/runtime effects,
  and the final durable identity must still match the one that opened the DB. The shared realtime dispatcher now
  requires callers to label `fcm` versus `dev` explicitly. Killed-app FCM routes legitimate events into the DB
  pipeline without waiting for preference reads, starts from hidden notification content, and suppresses message
  presentation/attachment auto-download while Feature settings remain unconfirmed. A final native Photos save now
  holds the account teardown drain so it cannot finish behind a replacement account.
  Focused evidence includes 7 hydration/Bootstrap/Home suites with 136 tests before the final identity/failure cases,
  the final headless/Bootstrap set at 5 suites / 135 tests, and the current full run at **363 suites / 3,420 tests**.
  `REL-007B2/C` and `REL-008` remain open for the unified boot/retry UI and same-GUID/two-account physical-device
  matrices respectively.
- **2026-08-05 — ordinary attachment-cache quota audit:** Confirmed that streamed byte/time/file limits and partial
  cleanup are bounded, but completed ordinary attachments can still grow without a global ceiling. `DL-01` now records
  a three-slice implementation plan: encrypted crash-safe ledger, reservation/eviction/native-delete coordinator, then
  access tracking/startup adoption/device proof. No quota code or migration was added in this audit; allocate the next
  migration at merge time and keep outgoing/retry-critical files protected.
- **2026-08-05 — `DL-01` quota-ledger foundation:** Allocated and implemented
  `0030_attachment_cache_entries` with its schema mirror, merge-time registry evidence, transaction-neutral
  active/retiring/retry repository, duplicate-path accounting, partial attachment-path index, and account-wipe dirty
  checks. The named real-upgrade test plus lifecycle/maintenance coverage pass in 4 suites / 28 tests; TypeScript,
  touched-file lint/format, `git diff --check`, and the migration guard (30 migrations, 5/5 guard tests) are green.
  The full repository run passes 365 suites / 3,426 tests.
  Three independent read-only reviews found no slice-1 blocker. They confirmed that production writes must wait for
  slice 2's complete lifecycle: atomically reserve and commit verified bytes + `localPath`, clear every duplicate
  reference while marking retirement, delete only a canonical owned-root path outside the DB transaction, and keep a
  per-path reservation through confirmation to prevent an old completion from recreating a just-deleted file. The
  table therefore remains empty/unwired by design until that coordinator exists; the global quota and device proof
  remain open.
- **2026-08-05 — current production export:** Expo exported 2,227 modules. The Android Hermes bytecode is
  `/tmp/gator-export.bTDOLQ/_expo/static/js/android/index-2a1a808c99a4dd8e5fbd8e09d5eeb990.hbc`, 6,465,325
  bytes, SHA-256 `54f753eab73cc14f71a1e22bf1678079f93a6a1ffd94fe0ed548461dc49c5d0f`; `metadata.json` is
  3,173 bytes, SHA-256 `76c34bbfcdb4f5fa201a411195f3db02d61f22ad44591398f9bdc94b1a940109`.
- **2026-08-05 — corrected current native smoke (not a production candidate):** An initial disposable copy was
  rejected as invalid when its unanchored root `android` exclusion also removed the Android source directories
  inside local modules. The corrected anchored snapshot preserved those sources; Expo autolinking resolved
  `gator-bounded-download`, `gator-paste-input`, and `gator-share-shortcuts`; clean prebuild passed; and Gradle
  compiled all three modules in debug and release. `:app:assembleDebug :app:bundleRelease` finished
  **BUILD SUCCESSFUL in 19m 31s** with 1,878 actionable tasks (1,846 executed, 32 up to date). The two native policy
  suites (`gator-bounded-download` and `gator-paste-input`) separately finished **BUILD SUCCESSFUL in 26s** with
  94 tasks (11 executed, 83 up to date). A source dry-run matched the repository content; only build-created
  directory timestamps differed.

  | Current evidence item            | Result                                                                                                                                                                                                                                                                                        |
  | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Debug APK                        | `/tmp/gator-native-final.N5ZKO5/android/app/build/outputs/apk/debug/app-debug.apk`; 111,526,183 bytes; SHA-256 `5d16165fc098f03daa630c130229f017a4ac6dc057a350aa51384aac097b81d4`.                                                                                                            |
  | Release-variant AAB              | `/tmp/gator-native-final.N5ZKO5/android/app/build/outputs/bundle/release/app-release.aab`; 55,525,783 bytes; SHA-256 `88c07bb770508899e14b93ce64e66bc103ce13ef3260a10a68e2a629b954d4d7`.                                                                                                      |
  | Packaged/manifest/DEX inspection | **PASS.** The guard passes against debug/release manifests and the AAB; all three owned module classes are present in packaged DEX; inbound ACTION_SEND filters, Direct Share declarations/resources, and removed `expo-share-intent` markers are absent.                                     |
  | Signing/configuration scope      | Uses `test/fixtures/google-services.ci.json` and Android debug signing (`CN=Android Debug`; SHA1withRSA warning). This proves local compilation and containment only—not production Firebase/signing, Play provenance, hosted CI/EAS enforcement, clean install, or physical-device behavior. |

  The earlier 2026-08-04 artifact table was superseded at this date. Both tables are now historical and predate
  `9d97eab`, so neither proves that the current pinned-shortcut cleanup is packaged. Neither disposable artifact is a
  release candidate, and neither was added to Git.

- **2026-08-05 — `REL-007B2/C` production boot and `REL-005A/B` teardown containment:** The one module-owned
  foreground coordinator now drives root startup through deterministic loading, lock, setup, retryable, fatal,
  degraded, and connected states. Real adapters enforce durable-session identity, guarded settings, stage deadlines,
  cleanup, and stale-run rejection; the retry and error surfaces have accessibility contracts. Public Disconnect
  synchronously revokes explicit Connect, while marker-backed credential cleanup, FCM-token retirement, and the
  complete DB/reminder/wipe chain quarantine their exact timed-out promises. A replacement account remains blocked
  until those tails settle and a new full sweep succeeds; marker failure keeps the only remaining vault proof
  unbounded and fail-closed. Independent skeptical review found no concrete high-severity late-account-B race. The
  focused boot/forget/DB single-flight set passes **3 suites / 95 tests**; the final full run passes **372 suites /
  3,656 tests**. Typecheck, zero-warning lint, Prettier, `git diff --check`, architecture (5/5; 63 core files),
  migrations (5/5; 30 migrations; head `0030_attachment_cache_entries`), secret hygiene (4/4; 779 tracked and 814
  historical paths), and toolchain checks are green. Current-tree `:app:assembleDebug` passes **716 tasks in 1m 34s**
  and `:app:bundleRelease` passes **1,227 tasks in 2m 20s**; the packaged manifest/AAB guard passes all 9 tests. The
  local APK is 111,558,939 bytes (`8e81f3fc721db6482aace9798aa4ca4ef50f4c7dfdbb8e15ba7d14d1222be88d`) and the
  AAB is 55,587,320 bytes (`cb486a3705f67330c507957433796352a59ef57ac9302c67ef03035d6693ce91`). These
  generated artifacts prove local compilation/containment only; exact-candidate physical-device, production signing,
  Firebase, hosted CI/EAS, lock/retry/TalkBack, synchronous-JSI, and A→B inspection remain open.
- **2026-08-05 — `PUSH-RETRY-01A` durable incoming-queue foundation:** Allocated migration
  `0031_incoming_event_queue` and added the encrypted, payload-scrubbing intake/receipt table, Drizzle mirror,
  guarded repository, account-wipe/dirty integration, and stable name-based `0030`/`0031` upgrade tests. Intake
  rejects future local-receipt times and malformed identity metadata, validates lowercase digest syntax, parses
  in-budget JSON, and size-checks oversized input before parsing. It refuses rather than evicts at count/byte
  capacity, preserves FIFO per ordering key, leases with token/version fencing, records the DB-applied crash
  checkpoint inside the caller's domain
  transaction, and bounds claim materialization to 2 MiB. Age/count receipt pruning preserves pending work and its
  duplicate-suppression boundary is tested. Two independent skeptical reviews found no remaining Slice A defect.
  The focused migration/repository/wipe set passes **4 suites / 40 tests**; the final full run passes **374 suites /
  3,673 tests**. Typecheck, zero-warning lint, Prettier, `git diff --check`, architecture (5/5; 63 core files), and
  migrations (5/5; 31 migrations; head `0031_incoming_event_queue`) are green. This is foundation only: no live
  socket/FCM path imports the repository yet, and Slices B–D plus real op-sqlite/SQLCipher and killed-process device
  evidence remain open.
- **2026-08-05 — `PUSH-RETRY-01B/C` host pipeline and partial Slice D native proof:** Socket, eligible FCM, and DEV
  events now enter one canonical durable dispatcher before DB, UI, network-recovery, or notification effects. The
  bounded drain resumes after startup/wake, checkpoints DB work inside the domain transaction, retries presentation
  from current DB truth, preserves phase-aware ordering, fences account/lock handoffs at commit time, requests
  recovery for missing durable prerequisites, and cancels notifications for durable deletions. Fault, duplicate,
  poison, timeout, edit/delete convergence, phase ordering, and stale-account cases are covered. The client also
  accepts a future server `attemptGuid` for exact temp-only/RCS send-error identity. Independent review found no
  remaining P0/P1 host-code blocker; immutable server attempt identity remains a protocol dependency.

  The API-35 emulator then loaded this worktree over Metro on the installed matching op-sqlite dev client. SQLCipher
  open/rekey and migration `0031` succeeded. The first DEV message exposed a real SDK-57 bridge error before enqueue:
  `digest-failure`, caused by passing an `ArrayBuffer` where Android's Expo Crypto bridge requires a typed array. The
  adapter now copies the exact input view and passes the `Uint8Array`, with a focused regression test. The DEV seed
  shortcut also now reopens delivery admission before Home captures its account lease. After those fixes, three
  messages reached the encrypted DB and reactive Mom chat (`Live update #1/#2/#3`). With notification permission
  denied, the first message remained visible while presentation recorded `retry-scheduled`; after granting the test
  permission, later delivery produced an active Gator `new_messages` Android notification record with no filtered
  queue, SQLite/SQLCipher, permission, or fatal error.

  A DEV-fixture-only process-death seam now uses the same encoder, encrypted repository, dispatcher, and account/lock
  gates while deliberately omitting only the handler. It refuses non-fixture sessions, non-DEV sources, non-empty
  pending queues, and any row claim that does not match its just-persisted queue id at attempt 1. It targets only the
  known `c-mom` fixture with the existing Mom participant, returns/logs aggregate counts only, sanitizes UI action
  failures to an error name, and its composition opt-in defaults closed. One-way identity/account/lock checks remain
  active across every await. The first full verification run caught a plain-Node portability defect (`__DEV__` is not
  defined outside React Native); the composition root now uses the safe exact-fixture `isDevServer()` predicate.

  The emulator first proved unleased recovery (`pending=1`, `due=1`, `leased=0`, `completed=3` → `pending=0`,
  `completed=4`). The stronger run then claimed attempt 1 and reported `pending=1`, `due=0`, `leased=1`, `completed=4`.
  After `adb shell am kill --user 0` removed PID `25604` and the app stayed dead beyond the 120-second lease, fresh PID
  `26167` reopened SQLCipher and converged to `pending=0`, `due=0`, `leased=0`, `completed=5`. The target chat gained
  one bubble and stayed unchanged through another resume. A host test also fixes the real `startRealtime` recovery
  trigger in place; the device run itself used the contained DEV Home trigger, so it does not substitute for connected
  FCM/headless candidate evidence.

  The current full run passes **380 suites / 3,796 tests**. Typecheck, zero-warning lint, Prettier,
  `git diff --check`, architecture (5/5; 64 core files), and migrations (5/5; 31 migrations; head
  `0031_incoming_event_queue`) are green. Slice D is still open for connected killed-app FCM and an exact current
  release candidate; the parent remains unchecked.

- **2026-08-06 — `PUSH-RETRY-01` exact-ID claim hardening and final dev-client rerun:** Replaced the contained
  proof harness's health → enqueue → generic-claim sequence with one repository transaction that refuses a non-empty
  pending queue, inserts a validated event, and leases only its returned row id. The transaction preserves the DB
  mutex no-nesting rule and rolls back if its account/App Lock guard closes before commit. Real SQLite coverage proves
  an unrelated pending row is never leased or altered and a guard revocation after insertion leaves no proof row.
  Dispatcher/composition tests assert the exact id/token/source/attempt contract and the 120-second expiry path.

  On the API-35 emulator, the final helper moved aggregate health from `pending=0`, `leased=0`, `completed=5` to
  `pending=1`, `due=0`, `leased=1`, `completed=5`. After `adb shell am kill --user 0` removed PID `26167`, the app
  stayed dead beyond the real lease. Fresh PID `27263` reopened SQLCipher and recovered to `pending=0`, `due=0`,
  `leased=0`, `completed=6`; the Mom chat gained exactly one third recovery bubble. A further full JavaScript
  restart/resume left both `completed=6` and the bubble count unchanged. The final full run passes **380 suites /
  3,796 tests**; typecheck, zero-warning lint, Prettier, architecture (5/5; 64 core files), migrations (5/5; 31,
  head `0031_incoming_event_queue`), and diff checks are green. Connected killed-app FCM, exact release-candidate
  evidence, and server-issued immutable `attemptGuid` remain open.

- **2026-08-06 — `NET-00` Android proxy closure:** The two containment suites pass **23 tests**. On the API-35
  emulator, the received `https://github.com/munkledata` fixture was scrolled into view and visibly mounted while a
  global HTTP proxy captured dev-server, socket, attachment, and Chrome traffic. More than ten seconds of the mounted
  bubble produced zero `github.com` records; explicitly opening the same URL in Chrome immediately produced repeated
  `CONNECT github.com:443` records as a positive control. The emulator's originally unset proxy was restored. This
  closes the immediate no-automatic-fetch blocker; the optional bounded/user-initiated `NET-01` design remains open.

- **2026-08-06 — `PLAY-01` Android settings closure:** Source, generated manifests, and packaged-AAB checks remain
  free of `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` and direct-exemption calls. On the API-35 emulator, tapping the
  battery-settings row opened `com.android.settings/.spa.SpaActivity` and showed Android's general **App battery
  usage** screen with the **All apps** list, not a direct-exemption dialog. The first development attempt exposed a
  stopped-Metro lazy-chunk error rather than a product defect; the final fresh-process run with Metro available
  completed the native handoff. The emulator's proxy and contact-permission state were restored afterward.

- **2026-08-06 — `PERM-01` release containment and partial device matrix:** Fixed a source/config contradiction where
  automatic startup contact sync could show a runtime dialog despite the documented explicit-action policy: background
  sync now only checks an existing grant, while Settings/Send Contact may request one. Added recovery copy for denied
  composer camera and microphone requests. Removed unused production overlay and Do Not Disturb policy permissions,
  added Android's limited-photo permission to the required artifact contract, corrected stale camera/audio/contact/
  notify-kit comments, and made the guard allow the overlay only in a debuggable dev client while rejecting it in
  release/AAB artifacts.

  Clean SDK-57 prebuild plus debug/release APK and release-AAB compilation succeeded. The exact non-debug release APK
  hash was `8e0b327a0f93ab88efeb7ff25002477614fa49f2b7bbe941624a5f21ceefbb9c`; after install, the device-side `base.apk`
  hash matched it. The AAB hash was `d2e3fa7e10f54b3abe2396697971a2f5dabaaf8e08d8f8b46d7885c8320f8d90` and the strengthened artifact guard passed all
  three artifacts. API-35 `dumpsys` showed the expected runtime permissions, none of the release-forbidden permissions,
  and no `DEBUGGABLE` flag. The release QR flow showed rationale plus manual fallback before the camera dialog and
  returned to that fallback after denial. Connected dev-fixture proof separately exercised contacts no-prompt startup,
  explicit allow/success, and explicit deny/recovery. The emulator was returned to the debug client with its original
  notification grant, promptable-denied contacts/camera state, and unset proxy. PERM-01 remains open for the exact
  signed-production and remaining dialog/API-32 matrix listed above.

  The follow-up host slice separated Send Contact cancellation from denied access, added visible recovery for its
  denial, and gave all three chat-settings photo flows the same explicit permission/error handling. Microphone request
  rejection and stale-unmount behavior now have component coverage, while the route suite pins both recovery dialogs.
  The artifact guard now rejects required permissions whose every declaration has `android:maxSdkVersion`, including
  the packaged binary-manifest path; all 10 guard tests pass. A fresh exact-tree release rebuild completed 1,234 Gradle
  tasks and bundled 2,244 modules. Its local APK is 72,262,871 bytes with SHA-256
  `41f30aadf613473a2a04bf7df27dd033819a2fc7b0f112a10ff8e37748639d1c`; its AAB is 55,629,030 bytes with SHA-256
  `ffb5a7036dd94d689d7cf3fa524d87135525f40a9b302e9175b3be7a681b426f`. The latest full run passes **381 suites /
  3,806 tests**. Exact production signing/hosted provenance and the remaining device matrix are not claimed.

- **2026-08-06 — `DB-02A` exact write/call inventory foundation:** Added a fail-closed direct mutation scanner plus
  symbol-resolved mutator call graph without adding a package. The guard inventories Drizzle/raw/migration/native
  writes and follows aliases, re-exports, transitive wrappers, callbacks, and indirect call shapes; unsafe writer
  escapes and unresolved transaction forwarding remain visible rather than being approved from prose. Seventeen
  mutation tests pass, including proof that adding a new call to an already-inventoried writer breaks exact
  membership and that same-named local callbacks remain distinct. The live registry exactly matches 847 findings
  with zero structural/stale errors. It preserves 85 proven temporal exclusions and 46 coordinated writes, while
  leaving 716 entries unproven; the resulting 2,148 approval errors are the intended release-blocking queue, not a
  green-gate claim. No production database behavior changed in this foundation slice.

- **2026-08-06 — `DB-02A` Mark All Read containment:** `markAllChatsReadLocal` now claims the shared serialized
  transaction before its one bounded bulk update, so it cannot silently join and disappear with an unrelated
  transaction's rollback. A real in-memory SQLite test holds a neighbouring transaction open, starts Mark All Read,
  proves the marker does not change early, rolls the neighbour back, and then proves the queued write commits. The
  database and UI caller suites pass 43 tests, TypeScript passes, and all 17 scanner tests remain green. The exact
  inventory now matches 849 findings with zero structural errors: 85 temporal exclusions + 49 coordinated entries
  are proved, 715 remain unproven, and the intentional approval queue is 2,145 errors.

- **2026-08-06 — `DB-02A` Pin/Archive containment:** The UI-only `setChatPin` and `setChatArchive` helpers now claim
  the serialized transaction for their single bounded updates. A focused SQLite test starts both while a neighbouring
  transaction is open, proves neither flag changes early, rolls the neighbour back, and then proves both queued writes
  commit in call order. TypeScript, all 17 scanner tests, and the repository plus two UI suites pass (62 tests). The
  exact inventory is 853/853 with zero structural errors: 85 temporal exclusions + 55 coordinated entries are proved,
  713 remain unproven, and 2,139 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` Mute containment:** `setChatMute` now serializes its one bounded UI-owned update. Its
  SQLite regression holds a neighbouring transaction open, proves the requested mute remains unapplied, rolls the
  neighbour back, and then proves the queued mute commits. TypeScript, all 17 scanner tests, and the repository plus
  two UI suites pass (42 tests). The exact inventory is 855/855 with zero structural errors: 85 temporal exclusions +
  58 coordinated entries are proved, 712 remain unproven, and 2,136 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` Custom Name/Color containment:** `setChatCustomization` keeps validation outside the
  lock and serializes only its one bounded update. The existing rollback-neighbour test now queues customization and
  mute together, proves neither leaks into the open transaction, rolls that transaction back, and then proves both
  queued writes commit. TypeScript, all 17 scanner tests, and the focused repository suite are green. The exact
  inventory is 857/857 with zero structural errors: 85 temporal exclusions + 61 coordinated entries are proved, 711
  remain unproven, and 2,133 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` Theme/Luminance containment:** `setChatTheme` and `setBackgroundIsLight` now serialize
  their bounded device-local updates. The focused SQLite test queues both behind a neighbouring transaction, proves
  neither field changes early, rolls the neighbour back, and then proves the requested background URI and luminance
  both commit. TypeScript, all 17 scanner tests, and both database suites pass (40 tests). The exact inventory is
  861/861 with zero structural errors: 85 temporal exclusions + 67 coordinated entries are proved, 709 remain
  unproven, and 2,127 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` Reminder containment:** The four reminder mutations (`createReminder`,
  `updateReminderTime`, and both delete keys) now serialize only their bounded DB statements. A real SQLite test queues
  create, move, delete-by-ID, and delete-by-notification-ID behind one rolling-back neighbour, proves the three
  existing rows remain unchanged while blocked, then proves the four queued operations commit in call order.
  TypeScript, all 17 scanner tests, the zero-nested-coordinator scan, and four reminder/notification/delete-chat suites
  pass (82 tests). The exact inventory is 869/869 with zero structural errors: 85 temporal exclusions + 79 coordinated
  entries are proved, 705 remain unproven, and 2,115 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` Scheduled create/edit/delete containment:** `insertScheduled`, `updateScheduled`,
  `deleteScheduled`, and `deleteScheduledHistory` now serialize their bounded database work. Claim, terminal-state,
  failure, and background-recovery helpers remain transaction-neutral because their production owners already call
  them inside guarded transactions; wrapping those leaves would deadlock the process-wide mutex. A real SQLite test
  queues create, edit, delete, and completed-history clearing behind one rolling-back neighbour, proves none changes
  early, then proves all four commit afterward. TypeScript, all 17 scanner tests, the zero-nested-coordinator scan,
  and six scheduled/delete-chat suites pass (92 tests). The exact inventory is 877/877 with zero structural errors:
  85 temporal exclusions + 91 coordinated entries are proved, 701 remain unproven, and 2,103 approval errors
  intentionally remain.

- **2026-08-06 — `DB-02A` Optimistic edit/unsend containment:** `applyLocalEdit`, `applyLocalUnsend`,
  `revertLocalEdit`, and `revertLocalUnsend` now serialize their one-row optimistic and compare-and-set writes, so
  a neighboring rollback cannot erase the local state while the network operation continues. A real SQLite test uses
  four distinct messages, queues all four operations behind one rolling-back neighbour, verifies every row stays
  unchanged while blocked, then verifies each requested write commits. TypeScript, all 17 scanner tests, the
  zero-nested-coordinator scan, and four repository/service/dev-account suites pass (36 tests). The exact inventory is
  885/885 with zero structural errors: 85 temporal exclusions + 103 coordinated entries are proved, 697 remain
  unproven, and 2,091 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` Synced-background pointer containment:** The direct synced URI setter and the guarded
  URI/luminance compare-and-swap helpers now serialize only their final bounded updates; network downloads, image
  measurement, and file deletion remain outside the database mutex. This prevents a successful-looking URI promotion
  from joining a neighbour that later rolls back after the service has already deleted the previous file. A real
  SQLite test queues all three shapes behind one rolling-back neighbour and proves their pointer/contrast fields stay
  unchanged until the neighbour releases, then commit. TypeScript, all 17 scanner tests, the zero-nested-coordinator
  scan, and both repository/service suites pass (37 tests). The exact inventory is 891/891 with zero structural
  errors: 85 temporal exclusions + 112 coordinated entries are proved, 694 remain unproven, and 2,082 approval errors
  intentionally remain.

- **2026-08-06 — `DB-02A` Outgoing attachment echo containment:**
  `reconcileOutgoingAttachmentByContent` now performs its bounded candidate checks, retry-queue deletion, and
  temp-to-real message identity promotion in one serialized transaction. A real SQLite regression holds a neighbour
  open, proves the queue row and temp message remain together, rolls the neighbour back, then proves the queue delete
  and GUID promotion commit together. TypeScript, all 17 scanner tests, the zero-nested-coordinator scan, and three
  repository/send/sync suites pass (41 tests). The exact inventory is 893/893 with zero structural errors: 85 temporal
  exclusions + 116 coordinated entries are proved, 692 remain unproven, and 2,076 approval errors intentionally
  remain.

- **2026-08-06 — `DB-02A` Mark Unread containment:** `setChatUnreadLocal` now serializes the one-row update that
  clears the read marker and records the durable unread timestamp before the service attempts its best-effort server
  call. A real SQLite test queues the action behind a rolling-back neighbour, verifies both columns stay unchanged
  while blocked, then verifies the unread marker commits afterward. TypeScript, all 17 scanner tests, the
  zero-nested-coordinator scan, and three repository/reconciliation/service suites pass (39 tests). The exact
  inventory is 895/895 with zero structural errors: 85 temporal exclusions + 119 coordinated entries are proved, 691
  remain unproven, and 2,073 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` Server-avatar compare-and-swap containment:** `setHandleServerAvatar` now serializes a
  one-row `avatar IS NULL` compare-and-swap and returns whether it actually installed the server URI. The backfill
  service increments its result only on that true commit, so a device contact photo that arrives during the network
  download wins and is reported honestly. SQLite coverage proves the write waits behind a rolling-back neighbour and
  rejects a second overwrite; the service race test installs a device photo during download and verifies a zero write
  count plus the untouched device URI. TypeScript, all 17 scanner tests, the zero-nested-coordinator scan, and both
  repository/service suites pass (30 tests). The exact inventory is 897/897 with zero structural errors: 85 temporal
  exclusions + 122 coordinated entries are proved, 690 remain unproven, and 2,070 approval errors intentionally
  remain.

- **2026-08-06 — `DB-02A` unsafe legacy message-writer removal:** A skeptical follow-up rejected the temporary
  serialization of two test-only exports because locking did not make their behavior safe. `deleteMessageByGuid`
  hard-deleted server-backed rows that sync could resurrect and could destroy an outgoing row held by the retry
  ladder; `clearLocalUnsend` blindly revealed content even when a newer server retraction owned the row. Both dead
  APIs are removed. Their tests now exercise the production-safe tombstone/discard paths and the compare-and-set
  `revertLocalUnsend` path instead. TypeScript, all 17 scanner tests, and three message/outgoing suites pass (38
  tests). The exact inventory is 894/894 with zero structural errors: 85 temporal exclusions + 122 coordinated
  entries are proved, 687 remain unproven, and 2,061 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` transitive nested-coordinator guard:** The scanner now computes which helpers can open
  the process-wide transaction/write-lock coordinator through any resolved call chain. A call to any such helper
  from an existing transaction is labeled `nested-coordinator`, including a transaction-opening helper passed as a
  named callback and also used elsewhere; dynamic namespace dispatch preserves the same possible-opener fact. This
  closes the earlier lexical-only blind spot that could miss a
  permanently wedged DB mutex after a repository helper became self-serializing. The new regression proves both a
  forwarded wrapper and the mixed named-callback shape fail closed. All 18 scanner tests and TypeScript pass; the
  stronger live scan still finds 894 exact entries, zero structural errors, and zero nested coordinator calls.

- **2026-08-06 — `DB-02A` dead attachment-promotion removal:** Removed `promoteAttachmentGuid`, an exported
  repository helper with no production caller. The upload acknowledgement contains a message GUID, never an
  attachment GUID, so the function's only executable contract was two isolated tests; production reconciliation
  already promotes the message and lets `upsertAttachments` reconcile the temp attachment while preserving its
  local path. Removing the duplicate API avoids inviting a future unsafe wrapper around the mixed-ownership live
  path. Three attachment/send/echo suites pass (31 tests), all 18 scanner tests and TypeScript pass, and the exact
  inventory is 892/892 with zero structural errors: 85 temporal exclusions + 122 coordinated entries are proved,
  685 remain unproven, and 2,055 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` URL-preview cache containment:** `setUrlPreview` now serializes its one bounded cache
  UPSERT. The network-preview feature remains deliberately disabled under `NET-00`; this preserves the dormant cache
  primitive for a future bounded, user-initiated `NET-01` design without allowing it to join an unrelated database
  transaction. A real SQLite regression holds a neighbouring transaction open, verifies the old preview remains
  visible, rolls the neighbour back, and then verifies the queued replacement commits. The URL-preview/cache suites
  pass (26 tests), all 18 scanner tests and TypeScript pass, and the exact inventory is 894/894 with zero structural
  errors: 85 temporal exclusions + 125 coordinated entries are proved, 684 remain unproven, and 2,052 approval
  errors intentionally remain.

- **2026-08-06 — `DB-02A` read-marker ownership split:** `setLastReadMessageGuid` now owns a serialized transaction
  for ordinary UI/service calls. The realtime sink, which must atomically commit the remote read marker with its
  durable-event DB phase and account-generation guard, uses the explicitly named
  `setLastReadMessageGuidWithinTransaction` primitive instead; this preserves one transaction rather than nesting
  the process-wide mutex. A real SQLite regression queues Mark Read behind a rolling-back neighbour, proves both
  the read marker and deliberate-unread stamp stay unchanged while blocked, then proves the queued write commits
  and retires the stamp. Six read/reconcile/realtime suites pass (94 tests), all 18 scanner tests and TypeScript pass,
  and the stronger scan reports zero nested coordinator calls. The exact inventory is 897/897 with zero structural
  errors: 85 temporal exclusions + 128 coordinated entries are proved, 684 remain unproven, and 2,052 approval
  errors intentionally remain.

- **2026-08-06 — `DB-02A` scheduled crash-recovery ownership transfer:** `resetStuckScheduled` now owns its one
  bounded transaction and accepts an optional final account commit guard. Background sync passes its live account
  lease directly instead of wrapping the helper, then awaits the reset before starting `runDueScheduled`; this keeps
  later terminal schedule transactions separate and avoids a nested process-wide mutex. Real SQLite coverage proves
  the reset waits behind a rolling-back neighbour and that a revoked guard leaves the row in `sending`. Six
  scheduled/background suites pass (81 tests), all 18 scanner tests and TypeScript pass, and the stronger scan finds
  zero nested coordinator calls. The exact inventory is 897/897 with zero structural errors: 85 temporal exclusions
  and 131 coordinated entries are proved, 681 remain unproven, and 2,043 approval errors intentionally remain.

- **2026-08-06 — `DB-02A` bounded theme-restore containment:** `restoreThemes` no longer reads an unbounded snapshot
  or issues ordinary writes that can join a neighbouring transaction. A serialized `MAX(id)` cutoff captures the
  original custom-theme generation; a cursor per `(name, mode)` then updates or inserts one theme in one short
  transaction at a time. This preserves same-named twin palettes, excludes themes created after the cutoff, and
  avoids holding the process-wide mutex across the 500-item import limit. Real SQLite regressions prove rollback
  isolation, interleaved identity pairing, and the post-cutoff editor case. The three backup suites pass (58 tests),
  all 18 scanner tests, TypeScript, formatting, and the zero-nested-coordinator scan pass. The exact inventory is
  900/900 with zero structural errors: 85 temporal exclusions + 136 coordinated entries are proved, 679 remain
  unproven, and 2,037 approval errors intentionally remain. Backup-wide atomic staging and measured op-sqlite/index
  timing remain open; this slice deliberately preserves the prior retryable prefix-commit behavior.

- **2026-08-06 — `DB-02A` cache-wipe coordinator fence:** Every `clearLocalCache` marker/delete statement now takes
  and releases the shared write queue without opening one giant SQL transaction; the separate `localCacheDirty`
  confirmation takes its own queue slot and uses early-exit `EXISTS` probes. A neighbouring transaction can therefore
  neither absorb a delete into a later rollback nor expose an uncommitted empty view that is accepted as clean. Real
  SQLite regressions prove both rollback orderings and prove a forced mid-wipe SQL failure releases the queue while
  residue remains detectable. The cache/disconnect suites pass (106 tests), all 18 scanner tests, TypeScript,
  formatting, and the zero-nested-coordinator scan pass. The exact inventory is 932/932 with zero structural errors:
  85 temporal exclusions + 185 coordinated entries are proved, 662 remain unproven, and 1,986 approval errors
  intentionally remain. This is containment, not final account-isolation proof: ordinary writers still under review
  can interleave, remaining queue/ledger/scoped-kv deletes still need bounded batches, and logical deletion does not
  yet prove forensic page scrubbing (`secure_delete`/compaction remains an explicit release question).

- **2026-08-06 — `DB-02A` cache-wipe relational batching:** The five potentially largest relational wipes now delete
  at most 500 `attachments`, `messages`, `chat_handles`, `chats`, or `handles` rows per autocommit statement and
  release the shared write queue between batches. A trigger-driven SQLite regression seeds 1,205 handles, aborts the
  first row of batch two, proves batch one committed exactly 500 while 705 remain, then retries and reaches a clean
  cache. This pins both the bound and process-restart semantics; the existing FTS test still proves message batches
  fire the delete trigger. The cache/disconnect suites pass (107 tests), all 18 scanner tests, TypeScript, formatting,
  and the zero-nested-coordinator scan pass. The exact inventory remains 932/932 with zero structural errors: 85
  temporal exclusions + 185 coordinated entries are proved, 662 remain unproven, and 1,986 approval errors
  intentionally remain. The smaller account-state tables and scoped kv deletes remain the next batching slice, and
  real SQLCipher/op-sqlite timing plus interrupted-device proof remain release blockers.

- **2026-08-06 — `DB-02A` cache-wipe account-state batching:** Incoming-event envelopes, attachment-cache ledger
  rows, outgoing work, scheduled messages, reminders, URL previews, error reports, composer drafts, and encrypted
  notification routes now use the same fixed 500-row autocommit batches. The deletion watermark remains a bounded
  exact-key delete and the sync marker remains a bounded one-row update. A second trigger-driven regression seeds
  1,205 drafts, aborts batch two, proves 705 drafts remain while a global setting survives, then retries to a clean
  result without deleting that setting. The cache/disconnect suites pass (108 tests), all 18 scanner tests,
  TypeScript, formatting, and the zero-nested-coordinator scan pass. The exact inventory remains 932/932 with zero
  structural errors: 85 temporal exclusions + 185 coordinated entries are proved, 662 remain unproven, and 1,986
  approval errors intentionally remain. The repository wipe is now statement-bounded and rollback-fenced; ordinary
  writers still under `DB-02A` review, op-sqlite/device interruption timing, and forensic page-scrubbing proof remain
  open before account-isolation or physical-erasure acceptance can close.

- **2026-08-06 — `DB-02A` contact generation and full-match containment:** `upsertContacts` now takes one shared
  write-queue slot for its generation cutoff, each at-most-100-row insert, and each at-most-500-row old-generation
  prune, so a neighbouring rollback cannot erase an apparently successful contact refresh and a large address book
  never holds the mutex for the whole pass. `matchContactsToHandles` similarly gives every one-handle match/revert
  its own short transaction. Because its intentionally unlocked bulk reads can observe another transaction's
  temporary rows, each positive write atomically rechecks both the expected handle link and the matched contact's
  continued existence; each revert rechecks the expected link and the old contact's continued absence. Two real
  SQLite regressions first reproduced a rolled-back phantom name/dangling contact id and a valid link hidden by a
  rolled-back delete, then prove both become no-ops. Five contact/repository/service suites pass 57 tests; all 18
  scanner tests, TypeScript, formatting, diff checks, and the zero-nested-coordinator scan pass. The exact inventory
  is 944/944 with zero structural errors: 85 temporal exclusions + 198 coordinated entries are proved, 661 remain
  unproven, and 1,983 approval errors intentionally remain. The newly exposed
  `upsertHandles` → `linkHandlesToContacts` → `applyContactMatch` ownership chain stays explicitly unproven; its
  public/within-transaction split is the next handle-focused containment slice.

- **2026-08-06 — `DB-02A` attachment local-path ownership split:** The public
  `updateAttachmentLocalPath` now owns one short transaction, so standalone DEV/example writes cannot silently join
  and disappear with an unrelated rollback. Its SQL body moved to the explicit transaction-only
  `updateAttachmentLocalPathWithinTransaction`; the download service uses that form inside its existing guarded
  transaction so cache-ledger promotion and the reactive attachment path still commit or roll back together without
  nesting the process-wide mutex. A real SQLite regression holds a rolling-back neighbour, proves the public update
  remains queued and invisible, then proves it commits after release. Three attachment/download suites pass 68 tests;
  all 18 scanner tests, TypeScript, formatting, diff checks, and the zero-nested-coordinator scan pass. The exact
  inventory is 947/947 with zero structural errors: 85 temporal exclusions + 207 coordinated entries are proved, 655
  remain unproven, and 1,965 approval errors intentionally remain. `upsertAttachments` stays a separate mixed-owner
  problem, and the attachment-cache adoption/repair bulk-reference caps remain open for a later boundedness slice.

- **2026-08-06 — `DB-02A` KV ownership foundation / search completion marker:** The key/value UPSERT now has a
  private transaction-neutral SQL body plus an explicit `kvSetWithinTransaction` entry point. Search-text backfill
  uses that transaction-only form for its completion marker, preserving the existing atomic terminal-row check and
  account-generation commit guard without risking a future nested wrapper. The legacy public `kvSet` deliberately
  remains non-transacting while the other five transaction-internal call sites are migrated; making it self-owning
  sooner would deadlock those paths. Two KV/backfill suites pass 11 tests; all 18 scanner tests, TypeScript,
  formatting, diff checks, and the zero-nested-coordinator scan pass. The exact inventory is 949/949 with zero
  structural errors: 85 temporal exclusions + 210 coordinated entries are proved, 654 remain unproven, and 1,962
  approval errors intentionally remain. Notification routing is the next transaction-internal KV migration; the
  four theme-screen calls follow before the public setter can safely own its transaction.

- **2026-08-06 — `DB-02A` encrypted notification-route KV migration:** FaceTime route lookup and creation now share
  one short `withDbTransaction` callback and use `kvSetWithinTransaction`, so a route read from a neighbouring
  transaction can never be returned after that neighbour rolls back. Expo Crypto token generation stays outside the
  mutex, and realtime FaceTime posting supplies its account-generation check as the transaction commit guard. Real
  SQLite regressions prove a phantom route remains queued then is replaced by a durable token after rollback, and a
  revoked queued route commits nothing. Four routing/presentation/privacy/realtime suites pass 103 tests; all 18
  scanner tests, TypeScript, formatting, diff checks, and the zero-nested-coordinator scan pass. The exact inventory
  remains 949/949 with zero structural errors: 85 temporal exclusions + 213 coordinated entries are proved, 651
  remain unproven, and 1,953 approval errors intentionally remain. Only the four theme-screen transaction-internal
  KV calls remain before the public setter can take ownership; their persisted-pointer versus Zustand-memory delete
  race is tracked in the next slice.

- **2026-08-06 — `DB-02A` theme-screen KV migration and delete ownership race:** Theme create, select, and revert
  now use `kvSetWithinTransaction` inside their existing guarded commits. Delete re-reads the persisted custom-theme
  pointer in the same transaction as the row deletion and clears it only when it still names that row; after commit,
  it independently clears Zustand only when memory still names the deleted row. This prevents either a retained
  confirmation or a newer in-memory selection from overwriting the other account-owned state. The dialog callback is
  awaitable, and the React Native Testing Library 14 tests now await every asynchronous `fireEvent`, eliminating the
  overlapping-`act` leak that originally blanked the following test. Three theme screen/repository/store suites pass
  33 tests; all 18 scanner tests, TypeScript, scoped lint/format checks, and the zero-nested-coordinator scan pass.
  The exact inventory remains 949/949 with zero structural errors: 85 temporal exclusions + 230 coordinated entries
  are proved, 634 remain unproven, and 1,902 approval errors intentionally remain. The public `kvSet` still cannot
  take ownership until the theme store's multi-key updates are converted to one atomic transaction; that is the next
  KV slice and closes the remaining ordinary-KV bystander window.

- **2026-08-06 — `DB-02A` public KV ownership and atomic theme preference:** The public `kvSet` now owns one short
  transaction, while the theme store writes `theme.preset` and clears `theme.custom` together through two
  `kvSetWithinTransaction` calls in one commit. The regressions first proved both defects: an ordinary KV write
  changed a neighbouring transaction's uncommitted value, and a forced second-key failure left the new preset beside
  the old custom pointer. They now prove the standalone write waits for rollback and the two theme keys roll back
  together, while the optimistic in-memory choice remains deliberate. Six KV/theme/settings/draft/deletion/backup
  suites pass 132 tests; TypeScript, scoped lint/format/diff checks, and the transitive scan pass with zero nested
  coordinators. The scanner deliberately leaves transaction-neutral bodies and unresolved outer wrapper calls
  unproven until its effect model can prove that every callee write is contained; it does not invent approval merely
  because the runtime regression is green.

- **2026-08-06 — `DB-02A` server-scheduled reconciliation containment:** The server list now captures exact
  pre-request `{id, serverId}` exposure pairs, reconciles each response item in one short guarded transaction, and
  prunes one exact pair per transaction. A stale GET therefore cannot resurrect an old UUID after the same local row
  is repointed, delete a new identity, or commit queued old-account work after Disconnect; earlier one-row prunes
  remain durable if a later prune fails and a retry resumes cleanly. Skeptical review caught a second-order flaw in
  the first implementation: the exposure read itself could consume a neighbouring row that later rolled back and
  then suppress a real server response. A failing regression observed that capture settling inside the neighbour;
  exposure now takes committed, account-guarded 500-row read transactions and the regression proves it waits, sees
  no phantom, and inserts the real server row. Six scheduled/repository/account/route/delete-chat suites pass 100
  tests; all 18 scanner tests, TypeScript, formatting, and the zero-nested-coordinator scan pass. The combined exact
  inventory is 960/960 with zero structural errors: 85 temporal exclusions + 245 coordinated entries are proved,
  630 remain unproven, and 1,890 approval errors intentionally remain. A `server_id` index/legacy-duplicate policy is
  still a separate schema/performance item; no uniqueness migration is implied by this containment slice.

- **2026-08-06 — `DB-02A` handle/chat ownership split and production caller migration:** Handle ingestion now has
  an explicit `upsertHandlesWithinTransaction` primitive and a public self-owning `upsertHandles`; the unbounded
  device-contact index is rebuilt only after the domain commit, and every actual match is a short compare-and-set
  transaction that rechecks both the expected handle link and the contact generation. Realtime message/group events,
  new-chat creation, group-management responses, incremental/full/on-demand sync, `persistServerChat`, and
  `clearChatTombstone` use explicit public-versus-transaction-only entry points with no nested queue acquisition.
  Focused repository/service matrices, TypeScript, lint/format/diff checks, and the scanner are green with zero nested
  coordinators.

- **2026-08-06 — `DL-01` reference boundedness and deletion ownership:** Attachment-cache adoption/repair rejects a
  1,001st matching reference before mutation and verifies the exact cleared count plus absence of survivors before
  commit; exact 1,000/1,001 and recovery no-mutation regressions pass. Deletion catch-up now reads/seeds its watermark
  in committed guarded transactions, keeps each tombstone and watermark write account-owned, and performs no network
  work under the mutex. The focused cache/recovery and deletion/account matrices are green. At this checkpoint, two
  deletion correctness items remained open: an unknown GUID had no durable pending tombstone before later message
  ingestion, and a buggy over-cap/unordered server response needed to fail closed rather than advance from a sliced
  prefix. The larger combined Jest matrix also exposed an intermittent trigger-based rollback test whose failure
  injection needed to be made deterministic before the full gate was honestly green. The next entry closes both
  deletion gaps and records the test-harness diagnosis.

- **2026-08-06 — `DELETE-SYNC-01` durable deletion ordering and fail-closed paging** (reclassified from the earlier
  `DL-01` implementation bucket on 2026-08-08): Allocated migration
  `0033_message_deletion_ledger`, backfilled existing message tombstones, added account-wipe/dirty handling, and made
  `markMessageDeleted` retain the greatest timestamp even when no message row exists. Message upsert now consults
  that ledger before its initial INSERT, so delete-before-message ingestion is born hidden without a reactive gap.
  Unknown durable realtime deletions checkpoint this authoritative marker in the same transaction, complete in one
  attempt without false recovery/poisoning, and do not run attachment retirement; rollback/checkpoint failures remove
  both marker and receipt. Ingestion auto-download alone opts into `m.date_deleted IS NULL`, while generic attachment
  reads remain available for cleanup/reconciliation. The deletion REST schema caps pages at 500 and strictly rejects
  malformed timestamps; the engine validates the whole response before writing and rejects over-cap, invalid-GUID,
  non-finite, pre-watermark, or decreasing rows without sorting/slicing. Equal timestamps remain valid, and a full
  page containing null stops without an unsafe cursor advance. Migration tests pass 39/39 with all 33 migrations
  sequential and all 5 registry guards; the deletion/database matrix passes 106/106, realtime sink/drain 34/34,
  attachment repository branches 17/17, and auto-download 14/14. The prior fault-test flake was a Jest cross-VM
  matcher issue: native SQLite rejected correctly, but `.rejects.toThrow` misclassified its cross-realm error; matching
  the rejection text directly is deterministic. Remaining protocol work requires a server composite/continuation
  cursor for a full 500-row tie page and a snapshot-consistent server-issued first-run cursor; exact-device op-sqlite
  proof remains. **2026-08-08 ownership note:** those protocol/cursor residuals now belong to `DELETE-SYNC-01` plus
  its `DEVICE-01` evidence; `DL-01` retains only attachment download/cache boundedness and lifecycle ownership.

- **2026-08-06 — `DB-02A` post-ledger exact-inventory refresh:** Stable-ID refresh preserved 984 reviewed entries,
  added 13, removed 7, and reset no semantically changed review. The current inventory is exact at 997 findings:
  260 direct mutations, 714 resolved mutator calls, 19 mutator references, and 4 dynamic coordinator callbacks.
  Membership has 0 structural/stale errors; 86 temporal exclusions plus 302 coordinated entries are proved, while
  609 remain deliberately unproven and therefore produce the expected 1,827 approval errors. All 20 scanner mutation
  tests pass. The approval gate remains intentionally open rather than auto-approving new writes.

- **2026-08-06 — `REL-003` / `DB-02A` full-sync account and lock containment:** Chat-list, initial full sync,
  incremental sync, and on-demand backfill recheck the captured session around every network result and at transaction
  admission/commit. Chat mutations use at most five chats per lock; message work stays in bounded 50-row slices;
  contact matching runs once per fetched page rather than once per slice. Retired runs cannot publish progress,
  done/error banners, launch a replacement account's contacts sync, or continue after a late server-version response.
  The initial-sync setting now distinguishes the safe 100-message default from the user's explicit `0 = All`, honors
  finite caps exactly, and stops on any previously seen page fingerprint. Five focused suites pass 62 tests;
  TypeScript, formatting, scoped lint/diff checks, and the zero-nested scan pass.

- **2026-08-06 — `DB-02A` exact-inventory refresh:** The current source produces 988 exact findings with zero
  structural/membership errors and zero nested coordinators. Exact stable IDs preserved 906 prior reviews through the
  large ownership rewrite; only reviewed scanner-recognized transaction contexts were promoted. The honest current
  split is 85 proven temporal exclusions + 300 coordinated entries + 603 deliberately unproven entries, leaving
  1,809 expected approval errors. All 18 mutation/scanner tests pass; CI approval remains open until the unproven set
  reaches zero rather than being papered over.

- **2026-08-06 — `DELETE-SYNC-01` deletion-ledger identity handoff and suite-order hardening** (reclassified from
  the earlier `DL-01` implementation bucket on 2026-08-08): Skeptical review found that
  retaining `messages.date_deleted` during a `temp-*` → real-GUID promotion was insufficient: a later chat purge
  removed the row while the durable ledger remained keyed by the obsolete temp GUID, so a real-GUID re-ingest could
  resurrect it. All three in-place promotion paths now merge the temp ledger, real ledger, and legacy row tombstone,
  write the greatest timestamp under the real GUID, update the row, and remove the old key in the same owned
  transaction. The HTTP-ack duplicate branch also repairs an already-materialized real row when purge happened
  before the late ack. Regressions cover HTTP ack, live content echo, sync-safe attachment promotion,
  purge-before-ack, purge-after-promotion, and later-timestamp precedence; the focused outgoing suite passes 28/28.
  The full Jest gate passes 384 suites / 3,901 tests. Its earlier scheduled-prune failure was the same cross-Jest-VM
  native SQLite matcher issue as cache wipe: the operation rejected correctly, but `.rejects.toThrow` misclassified
  the foreign-realm error; the test now captures the rejection and matches its text. Static type/lint/format/diff,
  architecture, migration, and 20 scanner tests pass. The exact inventory is 1,004 findings with 0 membership errors:
  86 temporal exclusions + 302 coordinated entries are proved, 616 remain deliberately unproven, and 1,848 approval
  errors remain expected. Open protocol work is explicit: a content-only no-GUID echo cannot correlate a temp ledger
  after the temp row itself was purged; a full 500-row timestamp-tie page can starve continuation; and the first-run
  deletion cursor needs a snapshot-consistent server value (or history responses that exclude/mark deleted rows).
  Exact-device op-sqlite/SQLCipher proof remains under `DELETE-SYNC-01`/`DEVICE-01`.

- **2026-08-06 — `DB-02A` closed-world wrapper inference and server-error ownership:** The scanner now proves one
  layer of callback-forwarding transaction wrappers instead of leaving safe custom coordinators unresolved. It
  accepts only stable free functions/direct `const` bindings whose anonymous non-generator coordinator callback
  directly awaits or returns the forwarded lifetime; wrapper/callback escapes, `arguments`, named self-reference,
  mutable aliases, spreads, computed namespace dispatch, methods/overrides, and unresolved call sites all fail
  closed. Independent review first reproduced three false approvals (a fire-and-forget async task, an `arguments` or
  named-callback leak, and an overridable method) before the new regressions closed them; the final scanner suite
  passes 35/35 and recognizes all 5 production `withCurrentDeliveryTransaction` openers with 0 unresolved or nested
  realtime findings.

  That visibility exposed a genuine nested-ownership ambiguity in `message-send-error`: public
  `reconcileOutgoingError` and `applyServerSendError` now always own one transaction, while the realtime sink uses
  explicit `*WithinTransaction` bodies. A skeptical review then caught a non-SQL rollback leak: the in-memory
  retry-cycle cap was incremented before the durable checkpoint/COMMIT. Re-enqueue now returns an idempotent effect
  applied only after the owning transaction resolves. A regression fails the same-generation checkpoint twice,
  proves both queue inserts roll back without spending the cap, then proves the third replay still commits its
  automatic ladder. Rolling-neighbour tests cover both public entry points. Five focused suites pass 94 tests; the
  full Jest gate passes 384 suites / 3,904 tests. TypeScript, scoped lint, format/diff, the 5-test/64-file architecture
  guard, and the 33-migration/5-test migration guard are green.

  The stable-ID inventory refresh preserved 980 semantically unchanged reviews, added 20 findings, removed 12, and
  approved only the 25 paths proved in this slice. It is exact at 1,012 findings: 263 direct mutations, 726 mutator
  calls, 19 mutator references, and 4 dynamic coordinator callbacks; 86 temporal exclusions + 327 coordinated paths
  are proved, 599 remain deliberately unproven, and the expected 1,797 approval errors keep CI gating honestly open.
  The next small containment slice is the three optional dual-mode error-report outcome writers; exact-device
  op-sqlite/SQLCipher verification remains a separate release gate.

- **2026-08-06 — `DB-02A` error-report outcome ownership:** `claimErrorReports`,
  `markErrorReportsFailed`, and `deleteErrorReports` no longer switch between coordinated and naked writes based on
  whether an account guard is present. Each public API now owns one short queued transaction; claim/delete use one
  set-based statement and failure uses one update plus capped-row deletion. Duplicate IDs are explicitly set-like,
  missing IDs remain no-ops, the full 100-row production batch stays below SQLite's 999-variable limit, and the
  exported APIs reject a larger unique-ID set before any row can change.
  Rolling-neighbour regressions prove all three unguarded forms remain unchanged until the neighbour rolls back and
  then commit durably; focused repository/service coverage passes 49 tests. TypeScript, scoped lint/format, all 35
  scanner tests, the zero-nested-coordinator production scan, and the full 384-suite / 3,910-test Jest gate are
  green. The mechanical stable-ID refresh
  preserved 1,003 semantically unchanged reviews, added 2 findings, removed 9, and approved only the 6 wrapper paths
  proved here. The exact inventory is now 1,005 findings: 259 direct mutations, 723 mutator calls, 19 mutator
  references, and 4 dynamic coordinator callbacks; 86 temporal exclusions + 333 coordinated paths are proved, 586
  remain deliberately unproven, and the expected 1,758 approval errors keep CI gating honestly open. Exact-device
  op-sqlite/SQLCipher verification remains a separate release gate.

- **2026-08-06 — `DB-02A` outgoing retirement ownership:** `retireOutgoing` no longer uses the presence of an
  account commit guard to choose between two naked updates and a transaction. Every call now queues one two-statement
  transaction; the optional guard only decides whether it may commit. One regression holds a rolling-back neighbour,
  proves the unguarded retirement cannot mutate inside it, then verifies the retry cap and error bubble commit after
  rollback. A second forces the bubble update to fail and proves the earlier queue cap rolls back too. The existing
  missing-file, unknown-kind, and account-revocation paths remain green in the 2-suite / 62-test focused matrix;
  TypeScript, scoped lint/format, all 35 scanner tests, the zero-nested-coordinator scan, and the full 384-suite /
  3,913-test Jest gate pass.

  The stable-ID refresh preserved 1,002 semantically unchanged reviews, reset 2 findings whose detected context
  changed from unresolved to `withDbTransaction`, removed the obsolete naked callback call, and approved only the 4
  retire paths proved here. The exact inventory is now 1,004 findings: 259 direct mutations, 722 mutator calls, 19
  mutator references, and 4 dynamic coordinator callbacks; 86 temporal exclusions + 337 coordinated paths are
  proved, 581 remain deliberately unproven, and the expected 1,743 approval errors keep CI gating honestly open.
  `outgoing_queue.temp_guid` still lacks an index/unique constraint, so formal one-row/scan boundedness is recorded as
  a separate schema-hardening follow-up rather than silently expanding this slice into migration work.

- **2026-08-06 — `DB-02A` automatic outgoing-claim ownership:** Replaced the exported transaction-neutral
  `claimOutgoing` and `markOutgoingSending` halves with one self-transacting `claimOutgoingForSend`. Its lease UPDATE
  returns the winning queue row's `temp_guid`, and the same short transaction flips that exact bubble from `error` to
  `sending`; the account commit guard reaches that owner rather than selecting a naked path. The service no longer
  opens an outer transaction, so future callers cannot accidentally compose the new helper into a nested global
  mutex.

  Independent review caught one regression before handoff: the first version evaluated its clock before waiting for
  the write lock, so a wait longer than the two-minute lease could commit an already-expired claim and admit a second
  sender. The helper now accepts a clock callback and evaluates it after lock acquisition. Focused regressions hold a
  rolling-back neighbour, force the second write to fail, and advance the injected clock by more than one lease while
  queued; the 3-suite / 56-test matrix passes. The full Jest gate passes 384 suites / 3,916 tests. TypeScript, full
  lint/format, diff whitespace, the 35-test scanner, zero-nested production scan, 5-test/64-file architecture guard,
  and 33-migration/5-test migration guard are all green.

  The stable-ID refresh preserved 996 existing entries (22 moved by line only), remapped 2 semantically unchanged
  unproven callback edges, removed 8 obsolete findings, added 7, and approved only the 4 repository paths proved by
  this slice. The scanner-unresolved service call remains unproven. The exact inventory is now 1,003 findings: 259
  direct mutations, 721 mutator calls, 19 mutator references, and 4 dynamic coordinator callbacks; 86 temporal
  exclusions + 341 coordinated paths are proved, 576 remain deliberately unproven, and the expected 1,728 approval
  errors keep CI gating honestly open.

- **2026-08-06 — `DB-02A` error-report ingestion and trim ownership:** Public `insertErrorReports`,
  `insertErrorReport`, and `trimErrorReports` now always take the shared transaction queue; `clearErrorReports`
  already owned it. `insertErrorReport` delegates to the batch owner without opening a second lock. The guarded
  account-generation sink calls the explicit `insertErrorReportsWithinTransaction` body inside its existing outer
  transaction, and list-time cleanup calls a private trim body inside its existing guarded transaction, avoiding
  nested entry while preserving account-reset rollback.

  Rolling-neighbour regressions launch public batch and single inserts together, public trim, and public clear while
  another transaction is open; they prove no write joins the neighbour and each change persists only after its
  rollback. The sink regression pauses after the real insert+trim but before COMMIT, advances the account generation,
  and proves the entire old-account batch rolls back. Independent review found the split clean and confirmed every
  mutex callback remains DB-only and bounded: a public batch retains at most 500 rows in five <=100-row INSERTs plus
  one trim, while the sink remains two INSERTs plus one trim. The 3-suite / 52-test focused matrix and the full
  384-suite / 3,919-test Jest gate pass. TypeScript, full lint/format, diff whitespace, all 35 scanner tests, the
  zero-nested production scan, 5-test/64-file architecture guard, and 33-migration/5-test migration guard are green.

  The stable-ID refresh preserved 994 entries (14 moved by line only), removed 9 obsolete findings, added 15, and
  approved 9 new wrapper/sink findings plus 2 previously unreviewed clear-wrapper edges. The transaction-only
  primitive definitions, three re-keyed list-cleanup findings, and unresolved single-to-batch call remain
  deliberately unproven. The exact inventory is now 1,009 findings: 259 direct mutations, 727 mutator calls, 19
  mutator references, and 4 dynamic coordinator callbacks; 86 temporal exclusions + 352 coordinated paths are
  proved, 571 remain unproven, and the expected 1,713 approval errors keep CI gating honestly open.

- **2026-08-06 — `DB-02A` custom-theme CRUD ownership:** Public `createCustomTheme`, `updateCustomTheme`, and
  `deleteCustomTheme` now always claim the shared transaction queue. The connected theme screen instead calls
  explicit row-only `*WithinTransaction` primitives inside its existing account-guarded commits, preserving the
  atomic row + `THEME_CUSTOM_KEY` create/delete behavior without nesting. Rolling-neighbour regressions prove a
  standalone create, update, or delete cannot join and disappear with another transaction's rollback. Independent
  review found the split clean: the raw bodies are bounded single-row statements, the screen retains every account
  commit guard, and its repository mocks cover the renamed boundary.

  The 3-suite / 37-test focused matrix and the full 384-suite / 3,921-test Jest gate pass. TypeScript, full
  lint/format, diff whitespace, all 35 scanner tests, the zero-nested production scan, the 5-test/64-file
  architecture guard, and the 33-migration/5-test migration guard are green. The mechanical inventory refresh
  preserved 995 stable IDs (6 moved by line only), re-keyed 11 already-reviewed screen edges, replaced 3 naked raw
  definitions with 3 deliberately unproven transaction-only definitions, and added only 9 proved public-wrapper
  findings. The exact inventory is now 1,018 findings: 259 direct mutations, 736 mutator calls, 19 mutator references,
  and 4 dynamic coordinator callbacks; 86 temporal exclusions + 361 coordinated paths are proved, 571 remain
  deliberately unproven, and the expected 1,713 approval errors keep CI gating honestly open.

- **2026-08-06 — `DB-02A` message-ingestion ownership split:** Public `upsertMessages` now always owns one
  transaction and accepts an optional account commit guard. The five composed production sites—one realtime sink
  and four sync phases—call `upsertMessagesWithinTransaction` inside their existing guarded
  handle/chat/message/receipt-or-cursor commits, so the split introduces no nested mutex. The four executable dev
  fixture batches stay on the public owner, and eight deliberately composed test fixtures use the explicit
  transaction-only form. A rolling-neighbour regression proves public ingestion waits rather than joining another
  transaction's rollback; an attachment trigger that fails after the message INSERT proves the entire public upsert
  rolls back atomically.

  Independent review confirmed the important ordering did not move: realtime's durable receipt and incremental
  sync's final cursor still share the message commit, while contact linking, progress publication, and auto-download
  launch remain post-commit. Production message counts are capped at 1, 5, or 50 and dev batches at 5, but an
  individual message's attachment array is not yet schema-capped; response/attachment-count hardening therefore
  remains explicitly open. At this checkpoint `upsertAttachments` and `clearSupersededTombstones` were both
  transaction-neutral; the next entry closes the attachment half with an explicit transaction-only form, while the
  tombstone helper remains coupled to the future `upsertChats` ownership split.

  The 6-suite / 120-test focused matrix and the full 384-suite / 3,923-test Jest gate pass. TypeScript, full
  lint/format, diff whitespace, all 35 scanner tests, the zero-nested production scan, the 5-test/64-file
  architecture guard, and the 33-migration/5-test migration guard are green. The mechanical inventory refresh
  preserved 988 stable IDs (50 moved by line only), re-keyed 25 already-reviewed production paths and 5 deliberately
  unproven raw-body findings, and added only the 3 public-wrapper findings proved here. The exact inventory is now
  1,021 findings: 259 direct mutations, 739 mutator calls, 19 mutator references, and 4 dynamic coordinator
  callbacks; 86 temporal exclusions + 364 coordinated paths are proved, 571 remain deliberately unproven, and the
  expected 1,713 approval errors keep CI gating honestly open.

- **2026-08-06 — `DB-02A` attachment-ingestion ownership split:** Public `upsertAttachments` now always owns one
  transaction and forwards an optional account commit guard. Message ingestion calls the explicit
  `upsertAttachmentsWithinTransaction` body from its existing transaction, so temp-guid promotion, retained local
  path state, and the final attachment insert still share the message owner's commit without nesting the global
  mutex. A rolling-neighbour regression proves a standalone public upsert waits instead of joining another
  transaction's rollback. A forced final-insert failure proves earlier temp-guid/local-path reconciliation rolls
  back, and a trigger that revokes the account guard during insertion proves the entire operation is rejected before
  commit. Independent review found the ownership split and rollback coverage clean. Per-message attachment counts
  remain uncapped at the wire boundary. At this checkpoint `clearSupersededTombstones` was still
  transaction-neutral; the coupled chat-ingestion migration in the next entry closes that remaining half.

  The 6-suite / 129-test focused matrix and the full 384-suite / 3,926-test Jest gate pass. TypeScript, full
  lint/format, diff whitespace, all 35 scanner tests, the zero-nested production scan, the 5-test/64-file
  architecture guard, and the 33-migration/5-test migration guard are green. The mechanical inventory refresh added
  7 findings, removed 4 obsolete findings, and moved 10 stable entries by line only. It approved only the 3 public
  wrapper findings proved here; the 3 raw transaction-only statements and their message-parent edge remain
  deliberately unproven. The exact inventory is now 1,024 findings: 259 direct mutations, 742 mutator calls, 19
  mutator references, and 4 dynamic coordinator callbacks; 86 temporal exclusions + 367 coordinated paths are
  proved, 571 remain deliberately unproven, and the expected 1,713 approval errors keep CI gating honestly open.

- **2026-08-06 — `DB-02A` chat-ingestion and tombstone-handover ownership:** Public `upsertChats` now owns one
  transaction and forwards an optional account commit guard. Seven composed production sites use
  `upsertChatsWithinTransaction` inside their existing handle/chat/message/receipt-or-cursor commits; the one-chat
  dev fixture remains the sole standalone public caller. Both chat and message ingestion now call the explicitly
  transaction-only `clearSupersededTombstonesWithinTransaction` body as their final tombstone/read-floor handover.
  It deliberately has no standalone wrapper: moving the handover after ingestion would create a crash window, while
  making it self-transact inside ingestion would deadlock the process-wide mutex.

  A rolling-neighbour regression proves a standalone public upsert waits instead of joining and disappearing with
  another transaction's rollback. A forced participant-prune failure proves an earlier chat update and participant
  addition roll back. A stronger final-statement regression lets the chat update, participant add and prune, and
  tombstone/read-floor handover all complete, then revokes the account guard from an AFTER trigger and proves every
  change rolls back before COMMIT. Independent review also caught a test that had begun intercepting the new owner's
  `BEGIN`; the corrected test hooks the baseline `db.all` result, injects a synthetic transaction-scoped marker
  change after that snapshot is captured, and genuinely exercises the UPDATE's live-row guard. Queue-test cleanup
  now releases and drains the neighbour even if its observation fails.

  The 9-suite / 152-test focused matrix and the full 384-suite / 3,929-test Jest gate pass. TypeScript, full
  lint/format, diff whitespace, all 35 scanner tests, the zero-nested production scan, the 5-test/64-file
  architecture guard, and the 33-migration/5-test migration guard are green. The primary ownership refresh removed
  34 obsolete stable IDs, added 37 replacements/findings, and moved 57 stable entries by line only. Nine unresolved
  transaction-only edges retained their unproven metadata, 25 already-coordinated callback rekeys retained their
  evidence, and only the 3 new public-wrapper findings were approved. Final comment-accuracy cleanup then re-keyed 2
  unproven callback descriptors and refreshed 42 stable line numbers without changing a classification. The exact
  inventory is now 1,027 findings: 259
  direct mutations, 745 mutator calls, 19 mutator references, and 4 dynamic coordinator callbacks; 86 temporal
  exclusions + 370 coordinated paths are proved, 571 remain deliberately unproven, and the expected 1,713 approval
  errors keep CI gating honestly open. Chat-list/participant counts remain uncapped in some embedded/realtime wire
  payloads, so absolute transaction boundedness and exact-device op-sqlite/SQLCipher proof remain open release work.

- **2026-08-06 — `LOG-01A` strict ERROR diagnostic boundary:** Replaced retained/uploaded free-form ERROR prose
  and raw stacks with 19 developer-owned events and event-specific typed fields. The same idempotent projector now
  runs before the logger fan-out and defensively at console, memory, plaintext file, encrypted queue, and HTTP
  boundaries. Unknown/error-shaped hostile input fails closed to `diagnostic.unclassified`; known socket delivery
  events include only a finite event-name qualifier for server grouping. Legacy plaintext ERROR rows are rewritten
  on restore, legacy encrypted rows are rebuilt at upload, device-model context is omitted, and timestamps are
  minute-rounded with the rounded upload time replacing an invalid legacy value.

  Independent review found and the implementation fixed a partial-ack loss case: because the server reports only a
  count, any acknowledgement smaller than the claimed batch now retains and backs off every row rather than guessing
  which rows were accepted. A second review hardened the source guard against imported aliases, bracket access,
  destructured methods, and direct ERROR writes to known sink singletons. The sibling server accepted the canonical
  envelope in a real handler exercise; a committed cross-repository golden contract remains open.

  The focused matrix passes 12 suites / 143 tests, including 250 generated free-form cases, phone/account
  enumeration, huge/deep/proxy/getter input, legacy file/DB rebuilding, partial acknowledgement, and stale socket
  regressions. The full Jest gate passes 385 suites / 3,965 tests. TypeScript, zero-warning production lint, full
  format/diff checks, the 6-test/20-call/19-event ERROR guard, 5-test/65-file architecture guard, 33-migration/5-test
  migration guard, toolchain and secret-hygiene guards are green. The DB scanner passes all 35 tests and reports
  1,027 findings with zero structural/membership drift; its inventory refresh moved 16 line numbers and changed no
  classification. At this slice boundary, `LOG-01` remained open for non-error containment, an opaque privacy-safe
  crash-site token, durable queued-row rewrite/purge, device/export/network inspection, and the committed app↔server
  fixture; `LOG-01B` below subsequently closed release non-error persistence/export.

- **2026-08-06 — `LOG-01B` release diagnostics containment/export:** Free-form `debug`/`info`/`warn` now require an
  explicit `__DEV__ === true` and are dropped before traversal at the app logger and tee, plus defensively at console,
  memory, and file sinks. Historical plaintext non-error rows and unsafe timestamps are purged during restore; restore
  fails visibly if the file can neither be rewritten nor deleted, and manual Clear reports an unconfirmed deletion.
  Direct Tee ERROR writes are strictly reprojected before any injected child. The App Logs share action exports only
  reprojected ERROR rows from the full snapshot, uses minute timestamps or an explicit unknown value, and never exports
  development breadcrumbs. Native paste-input logcat calls now use six finite static messages with no Throwable prose.

  The source guard now has 10 mutation tests and scans owned JS/TS plus native Java/Kotlin source: it rejects raw console,
  dynamic/unknown native logs, direct writes at every level to known sinks, and call/apply/bind evasions; the live scan
  passes 20 ERROR calls / 19 events / 6 native events. The focused regression matrix passes 21 suites / 321 tests, and
  the complete Jest gate passes 388 suites / 3,998 tests. TypeScript, zero-warning lint, format/diff, architecture,
  migration, toolchain, secret-hygiene, diagnostic, and DB scanner gates are green; the DB inventory remains 1,027
  findings with no classification change or structural/membership drift. `LOG-01` remains open for the opaque
  crash-site token, durable queued-row cleanup, committed cross-repo fixture, selected finite non-error events, and
  exact-candidate device/export/logcat/network proof.

- **2026-08-08 — `LOG-01C` renderer, persistent-file, and diagnostic-guard hardening:** React Native 0.86's renderer
  sends caught render/lazy errors directly to `ExceptionsManager` before either app ErrorBoundary can project them.
  The bundle's first side effect now installs a release-only exception decorator and console boundary that construct
  fresh finite payloads, preserve safe exception ID/fatal state plus an allowlisted error class, and discard raw
  Error/component/cause/stack data
  before the normal runtime-ready native/logcat path. ErrorUtils and Hermes rejection hooks install independently and
  each present-but-throwing hook gets one bounded deferred retry. The known C++ pre-runtime/bundle-evaluation path
  bypasses this JavaScript boundary and remains explicitly open for a native decision and device canary.

  The persistent sink now attaches synchronously as the second bundle side effect, positively validates file state via
  `File.info()`, fails visibly before a file handle can be obtained, fences every late asynchronous continuation, and
  times out asynchronous import/read promises after five seconds. Expo's synchronous `info`/`write`/`delete` methods
  cannot be timer-cancelled. Failed writes remain dirty; an explicit flush joins an already-running disk operation; and
  background sync, FCM, and notify-kit headless callbacks each await up to three immediate best-effort flush attempts
  before settling. Clear no longer empties the visible screen before native deletion succeeds; Clear and Share are
  mutually disabled while pending, and a rejected native share sheet is visible. Foreground cleanup failure emits a
  degraded six-second toast that points to App Logs, whose accessible persistent warning keeps Clear-and-restart remediation
  visible. After native deletion succeeds, the warning becomes an explicit restart-verification state that survives route
  remounts; separate wrapping filter/action rows keep Clear reachable on narrow screens and with larger text. Successful
  manual Clear still does not retire the cached process issue until restart, so `LOG-01` is not closed on these host changes
  or described as device-proven killed-process durability.

  Migration `0034_purge_legacy_error_reports` now removes all diagnostics captured before the strict projector was the
  only insertion boundary. Its named upgrade test plants raw message/stack/meta canaries under schema `0033`, proves the
  migration deletes them, and proves a new finite row can still be queued afterward. The migration guard passes **34
  sequential migrations / 5 tests** with `0034_purge_legacy_error_reports` as the head. The DB inventory now contains
  **1,028 findings/entries** (**457 proved, 571 deliberately unproven**) with zero structural or membership drift.

  The JavaScript/native diagnostic guard now passes **26 mutation tests** and the live **20-call / 19-event / 6-native
  event** scan, including all generated Android app source sets after prebuild. It covers awaited/extension-qualified/
  TypeScript import-equals aliases, Kotlin backticked output names, and JLS-eligible Java Unicode-escaped
  identifiers/comments. Approved native output uses a fully qualified Android receiver, exact literal tag, and finite
  literal message; Java identifier-ignorable format/control characters are normalized before matching. This removes
  receiver/identifier ambiguity without pretending the token scanner resolves arbitrary types. Workflow policy passes
  **20 tests** and
  the live scan; Android entry/artifact policy passes **10 tests**; the DB-write scanner passes **35 tests** and its
  exact **1,028-finding** inventory has zero structural/membership drift (line-only refreshes retained their existing
  classifications, and the new startup purge is covered as a proved temporal exclusion). The complete Jest run passes
  **390 suites / 4,032 tests** in one process. TypeScript, zero-warning lint, source/test formatting, architecture
  (**5 tests / 65 core files**), migration (**34 migrations / 5 tests**), toolchain (**4 tests**), secret hygiene
  (**4 tests; 779 tracked + 814 historical paths**), workflow, diagnostic, Android artifact, and diff whitespace gates
  are green at this checkpoint. A fresh production Android export bundles **2,249 modules** into a **6.9 MB** Hermes
  bundle. Exact-candidate release-device proof and the other open `LOG-01` residuals above are unchanged.

- **2026-08-08 — authoritative tracker reconciliation and audit-coverage refresh:** Mechanically reconciled every
  primary `###`/`####` task heading into one status register. The plan now has **114 unique primary tasks: 12 DONE,
  36 IN_PROGRESS, 9 BLOCKED, and 57 TODO**, with no waiver or dropped item. The previous mixed table is retained as
  evidence/child-slice history rather than misrepresented as the whole inventory. `PRIV-03`, `UISEC-01`, and
  `SHARE-01` now have missing active evidence rows; all nine blocked tasks name their external input in §16; and
  `PRIV-02`, `SUPPORT-01`, hosted build/supply work, candidate evidence, and other external tails remain explicit
  without falsely relabeling useful in-repository work as blocked.

  The audit cross-check found that the two known missed-deletion protocol gaps had been buried under the unrelated
  attachment-limit task. New primary task `DELETE-SYNC-01` now owns timestamp-tie starvation and the
  snapshot-inconsistent first cursor, links the app/server parity record, preserves the current client safe stop, and
  is a release blocker until the server continuation/snapshot contract or an honest disabled-claim disposition lands.
  `PARITY-01` now owns the separate finding that remaining confirmed/partial app-server mismatches need an explicit
  implement, defer, or drop disposition instead of living as an unaudited feature list.
  `LOG-01A..D` now have stable child-slice meanings. The tracker recorded the Kotlin implicit-receiver TAG-shadow
  bypass and fail-closed Java Unicode precision limitation instead of claiming complete native scope resolution; the
  subsequent `LOG-01D` entry below closes those two scanner residuals.

  At this checkpoint, architecture passed **5 tests / 65 core files**, workflow policy passed **20 tests / 7
  immutable action uses**, the DB inventory held **1,028 entries** (**457 proved, 571 deliberately unproven**), and
  migration enforcement covered **34 sequential migrations / 5 tests**. Historical dated checkpoints retain their
  original counts. `GUARD-11` is now
  correctly checked because `MIG-01` provides automated enforcement; the non-regression checklist is therefore **2/11
  complete**, with the other nine still open under their owning tasks.

- **2026-08-08 — `LOG-01D` native tag provenance and Java Unicode precision:** Removed the shadowable Kotlin `TAG`
  identifier from all six owned logcat calls. Each now uses fully qualified `android.util.Log.w`; the scanner requires
  that receiver, the exact literal `"GatorPasteInput"` tag, and one reviewed finite literal message. A skeptical review
  rejected the first literal-only revision because a local/parameter/implicit-receiver `Log` could still shadow the
  imported class; native imports and every shadowable form now fail closed. Java Unicode preprocessing follows the JLS
  3.3 eligible-backslash rule rather than decoding every textual `\\u...` sequence and normalizes JLS 3.8
  identifier-ignorable raw/escaped format/control characters. Regressions cover double/triple/escape-produced
  backslashes plus raw and escaped U+200C/control splits in `System` and `Log`.

  The diagnostic guard passes **30/30 tests** and its live **20 production calls / 19 ERROR events / 6 native events**
  scan. The whole-file source contract must be encountered once at the exact repository path; missing owners,
  symlinked native directories/files, nested suffix decoys, and source mutations all fail closed. The owned paste-input
  source contract passes **9/9 tests**, TypeScript passes, Prettier and diff whitespace are clean. The generated Android
  project compiles `:gator-paste-input:compileDebugKotlin` under Kotlin 2.1.20 / compileSdk 36. `LOG-01` remains open for
  the other `LOG-01D` token/server/native/device items.

- **2026-08-08 — `DB-02A` scheduled-delivery transaction ownership transfer:** `claimScheduled`,
  `markScheduledSent`, `rearmScheduled`, and `markScheduledFailed` now each own one short transaction and accept an
  optional account commit guard. `runDueScheduled` calls them directly; removing its three outer transaction wrappers
  in the same patch avoids nesting the process-wide mutex. The failure path's attempts read and status update now share
  one atomic owner, and a committed terminal transition no longer needs an unconditional second write. Foreground
  `recoverStuckScheduled` also passes its live account lease into the existing guarded reset.

  Four focused real-SQLite suites pass **73/73 tests**. They prove all four public transitions wait behind a
  rolling-back neighbour, revoked queued guards leave every row untouched, the service threads the claim guard before
  sending, terminal-write failure retries without duplicating a proven commit, and foreground crash recovery cannot
  re-arm a retired account's row. The DB-write scanner passes **35/35 tests** and reports **1,030 exact entries** (260
  direct sites, 747 calls, 19 references, 4 dynamic callbacks), **0 structural/membership errors**, **0 nested
  coordinators**, 87 proved temporal exclusions, 382 coordinated paths, and **561 deliberately unproven** entries.
  `DB-02A` remains open for the other unproved writers and op-sqlite/device evidence.

- **2026-08-09 — `DB-02A` scheduled-delivery crash and edit ownership host-green:** Skeptical review found that the
  prior transaction transfer still left two duplicate-send windows: the optimistic outgoing rows committed before
  the scheduled terminal/re-arm transition, and a later background reset could steal a live foreground claim. The
  production path now commits the local scheduled CAS, outgoing queue row, optimistic message, and chat bump in one
  guarded transaction, then starts HTTP only after commit. A once-per-database/account-generation recovery
  single-flight runs unconditionally before every due-list/claim, uses at most four bounded reset batches, fails
  closed when its budget is exhausted, and is never repeated after success in that generation. Home and background
  no longer reset independently. Sent/failure transitions also CAS only an owned local `sending` row.

  A second skeptical pass found an edit between due-list and claim could still send the old payload/time. The final
  production claim now atomically rechecks `pending`, local ownership, and due time and returns the authoritative row
  used by the sender. Account ownership is checked again synchronously after handoff and immediately before HTTP.
  Migration `0035_retire_legacy_scheduled_sending` safely retires ambiguous local `sending` rows from internal release
  0.1.40 to delivery-uncertain history; the UI asks users to check the conversation, while server-owned rows and any
  existing outgoing work remain untouched.

  The scheduler architecture guard has **25/25 mutation/live tests**; combined with the 5 core-boundary tests,
  architecture passes **30/30**. It enforces one early top-level barrier, one reset owner, one authoritative claim
  owner, the exact direct atomic-handoff object and network ordering, explicit account scope at every production
  caller, and zero production use/escape of the older broad claim helper.
  Real-SQLite coverage models both sides of the commit boundary and proves rollback/ownership invariants, edited-
  payload and future/server-transfer races, one-shot/reply and recurring handoff, claim loss, pre-network account
  revocation, synchronous same-generation publication with distinct lease objects, live-claim protection, bounded
  backlog retry, and the upgrade repair. The combined focused matrix passes **8 suites / 105 tests**.

  The exact inventory is now **1,041 entries** (**264 direct sites, 754 calls, 19 references, 4 dynamic callbacks**)
  with **0 structural/membership errors** and **0 nested coordinators**: 88 temporal exclusions + 390 coordinated
  paths are proved, while **563 remain deliberately unproven** and the approval gate honestly retains 1,677 review
  errors. `DB-02A` stays open for those other writers plus op-sqlite/SQLCipher `UPDATE … RETURNING`, process-kill,
  migration, and exact-device proof; this entry corrects the narrower 2026-08-08 checkpoint rather than rewriting its
  historical evidence. The settled full Jest gate passes **393 suites / 4,057 tests**; TypeScript, full lint,
  source/test formatting, diff whitespace, architecture, migration, diagnostic, and DB structural gates are green.

- **2026-08-09 — `DB-02A-MSGID` stale destructive-action identity handoff:** Executable review reproduced one
  user-visible race across all four promotion branches: a Delete confirmation could retain a `temp-*` GUID while an
  HTTP ack, duplicate-real ack, live content echo, or sync attachment echo promoted the stored row to its real GUID.
  The stale action then wrote only an orphan temp deletion marker and left the real message visible.

  Migration `0036_message_guid_aliases` adds an encrypted, account-scoped, no-FK identity ledger capped at the 4,096
  newest mappings. Every learned temp→real handoff, deletion-ledger merge, row promotion/removal, and queue cleanup
  now shares one transaction. Reusing an alias for a different canonical message fails closed; deletion resolves an
  exact current GUID before an alias inside its own transaction; account wipe removes the aliases in bounded batches.
  If an extremely old mapping was evicted, the UI asks the user to select the message again instead of silently
  claiming success. The 15-suite/230-test matrix covers all four promotion paths, delete-before-promote,
  purge→delete→re-ingest, identical sends, many aliases, conflict and statement rollback, exact-first collision,
  deterministic cap eviction, account revocation, cache wipe/dirty, and the named migration upgrade. The complete
  host gate passes **394 suites / 4,076 tests**.

  The exact inventory is **1,051 entries** (**270 direct sites, 758 calls, 19 references, 4 dynamic callbacks**) with
  **0 structural/membership errors** and **0 nested coordinators**: 90 temporal exclusions + 400 coordinated paths are
  proved, **561 remain deliberately unproven**, and the approval gate retains 1,671 intentional review errors.
  `DB-02A` remains open for that backlog and op-sqlite/SQLCipher/device evidence. A mapping never learned because a
  content-only echo arrived after its temp row was already purged still requires the server-issued attempt identity
  tracked in `APP_SERVER_PARITY`; finite local state cannot infer it safely.

- **2026-08-09 — `PRIV-03A` message-search redaction:** Message-hit rows now subscribe to Redacted Mode and route
  their resolved chat title and message body through the shared privacy helpers. The redacted branch never calls the
  snippet highlighter, so the raw query-matching fragments do not enter the rendered or accessibility tree. The
  generic row still navigates with the original internal chat/message ids, and normal mode keeps its existing title,
  snippet highlighting, date, and navigation behavior. The focused suite passes **13/13 tests**, including whole-tree
  canaries and a live privacy-toggle regression; the complete gate passes **394 suites / 4,079 tests**. `PRIV-03`
  remains open for the other named surfaces and the TalkBack/screenshot/device sweep.

- **2026-08-09 — `PRIV-03B` shared contact-suggestion redaction:** The shared `ContactSuggestionList` used by both
  new-chat and the FaceTime dialer now subscribes to Redacted Mode and routes display names and addresses through the
  shared privacy resolvers. In redacted mode, real names and addresses never mount; enabling privacy immediately
  removes previously mounted identity nodes, while selecting the generic row still returns the exact internal contact
  pick.
  The focused component suite passes **6/6 tests** and the complete gate passes **394 suites / 4,082 tests**.
  `PRIV-03` remains in progress for account identity, server origin/management, pairing state, the complete
  accessibility tree, and the candidate screenshot/device sweep.

- **2026-08-09 — `PRIV-03C` chosen-recipient redaction:** New Chat's committed recipient chips now subscribe to the
  same Redacted Mode state as their suggestion rows. The visible chip text and accessibility removal label use only
  generic `Contact` copy under redaction and replace already-mounted names/addresses immediately, while removal and
  conversation creation retain the original address internally. The focused New Chat/contact matrix passes **2
  suites / 35 tests**; the complete host gate passes **394 suites / 4,084 tests**. `PRIV-03` remains open for the
  named account, server, pairing, full-accessibility-tree, screenshot, and device surfaces.

- **2026-08-09 — `PRIV-03D` account-screen redaction:** The Account screen now treats unhydrated privacy state as
  hidden and replaces the complete Apple ID, display-name, login-status, and alias-control subtree with one generic
  accessibility node. Enabling Redacted Mode removes already-mounted identity immediately, while confirmed opt-out
  restores the normal controls. The generation-scoped query and account lease continue to prevent old-account results
  or alias mutations from crossing a reconnect. Raw account data may still be fetched and held in the in-memory query
  cache; this slice proves rendered/native-accessibility containment, not absence from process memory. The focused
  route suite passes **15/15 tests**.

- **2026-08-09 — `PRIV-03E` pairing-QR containment:** The password-bearing pairing QR now fails closed before privacy
  hydration and while Redacted Mode is on. A reveal grant is bound to one opaque payload revision and is revoked on a
  payload change, privacy enable, route blur, or non-active Android app state, so opt-out, refocus, resume, and a new
  payload all require another explicit tap. Hidden-tree canaries exclude the raw origin and password from the native
  host/accessibility tree. The focused primitive suite passes **9/9 tests**, and the settled complete host gate passes
  **394 suites / 4,092 tests**. The upstream prop still contains the credential, and exact Recents screenshot timing,
  TalkBack, server-origin/management/share surfaces, active drafts/staged media, and the remaining whole-app/device
  sweep keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03F` Settings About server-identity containment:** Settings now treats unhydrated privacy state
  as hidden and replaces its automatic connected-server origin, server version, macOS version, and Private API status
  rows with one generic intrinsic text node. Enabling Redacted Mode removes already-mounted values immediately, while
  confirmed opt-out restores them; the installed Gator version/build and existing session actions remain available.
  Unique whole-tree and accessibility-role canaries cover enabled, live-toggle, and hydration transitions. The focused
  Settings suite passes **28/28 tests**, and the complete host gate passes **394 suites / 4,095 tests**. This child is
  deliberately narrow: the capability-derived Account link remains, Server Management/Health still render and can
  share diagnostics, raw session values remain in process memory, and those broader surfaces plus device proof keep
  `PRIV-03` open.

- **2026-08-09 — `PRIV-03G` Server Management containment:** Server Management now fails closed before privacy
  hydration and removes its automatic status, origin/share, statistics, Health/log entry points, and raw log/QR modal
  contents while hidden. Live privacy enable clears open modal state without opt-out resurrection; retained
  share/log/Health callbacks consult current privacy; and an epoch fence rejects both success and error from an
  in-flight log request across OFF → ON → OFF. Sync/restart actions and the generic Pairing entry remain available.
  Unique host/accessibility canaries cover origin, password, server/macOS/proxy details, statistics, and logs. The
  focused route suite passes **25/25 tests**, and the complete host gate passes **394 suites / 4,102 tests**. Raw query
  data can remain in process, an already-open OS share sheet cannot be recalled, and Server Health/direct routes plus
  device proof remain open.

- **2026-08-09 — `PRIV-03H` Server Health containment:** Server Health now treats enabled or unhydrated privacy state
  as hidden, keeps only its header/back action, and replaces the complete diagnostics/action subtree with one generic
  intrinsic text node. All ten reads remain generation-keyed and may cache in process, but retained Refresh, Clear
  Alerts, and RCS callbacks consult current privacy/account state. Alert clearing and RCS reconnect also capture a
  synchronous hidden-entry epoch, so late success or error cannot update cache, refetch, or toast across OFF → ON →
  OFF; reconnect failures now always use fixed copy instead of a server exception. Host/accessibility canaries cover
  server/macOS/Node versions, FCM project, tunnel/IP/TLS values, alerts, RCS phone identity, and process-error detail.
  The focused route suite passes **19/19 tests**, and the complete host gate passes **394 suites / 4,110 tests**.
  Scheduled-message bodies/editor, in-process query data, already-open native share sheets, and device proof keep
  `PRIV-03` open.

- **2026-08-09 — `PRIV-03I` scheduled-list containment:** The Scheduled screen now treats enabled or unhydrated
  privacy state as hidden and mounts generic titles/accessibility copy for both pending and completed/history rows.
  `FlashList.extraData` follows the privacy state so recycled cells cannot retain raw bodies; rows introduced on the
  hidden render are generic too. The body target is disabled while hidden, and its imperative current-store guard
  blocks a genuinely retained pre-toggle press from entering `/scheduled-edit/[id]`. Cancel and Clear remain available
  with generic labels while receiving the exact internal row/id. The focused route suite passes **15/15 tests**, and
  the complete host gate passes **394 suites / 4,116 tests**. Raw rows remain in JS/DB memory, and direct access to the
  scheduled editor plus drafts/media and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03J` scheduled-editor containment:** The direct Scheduled editor now treats enabled or
  unhydrated privacy state as hidden and mounts only generic copy plus Back; the raw body, fire time, recurrence controls,
  and Save action are absent from its host/accessibility tree. Live privacy enable dismisses the keyboard. Save and
  reschedule entry points consult current privacy/account ownership, and a synchronous hidden-entry epoch rejects both
  success and error from an in-flight date picker across OFF → ON → OFF. Delayed old-account row/error results are
  disowned. The focused route suite passes **13/13 tests**, and the complete functional gate passes **394 suites / 4,124
  tests**. Raw loaded/typed drafts may remain in process, and an already-admitted Save may finish safely; reminder
  previews, drafts/media, native accessibility/screenshot behavior, and device proof keep `PRIV-03` open. `TEST-01`
  separately records nondeterministic TanStack Query `act(...)` warning debt in the Account/Server Health suites.

- **2026-08-09 — `PRIV-03K` reminder-list containment:** The Reminders screen now treats enabled or unhydrated privacy
  state as hidden and mounts generic reminder titles/accessibility copy instead of saved message previews. FlashList
  receives privacy as `extraData`, so live changes and recycled/new rows cannot retain the raw preview. A retained
  pre-toggle body press consults current privacy/account state, and a synchronous hidden-entry epoch rejects both success
  and error from an in-flight time picker across ON and OFF → ON → OFF. Generic Delete remains available and targets the
  exact internal row. The route suite passes **12/12 tests**, the reminder service suite passes **19/19 tests**, and the
  complete functional gate passes **395 suites / 4,136 tests**. Scheduled times remain visible/announced, raw reminder
  rows remain in DB/JavaScript/FlashList data, and an already-admitted reschedule may finish safely; drafts/media, native
  accessibility/screenshot behavior, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03L` long-press conversation-action containment:** The conversation long-press sheet now treats
  enabled or unhydrated privacy state as hidden and mounts one generic `Conversation` heading instead of the raw resolved
  chat title. Live privacy and hidden target replacement cannot retain either title. Its Delete confirmation is generic
  always, so the global dialog cannot preserve a pre-toggle title after the sheet closes; callbacks created before and
  after privacy still target the exact internal GUID with the sheet's original account lease. Generic mark/read, pin,
  mute, archive, and Delete actions remain available. The focused suite passes **22/22 tests** twice without warnings,
  and the complete functional gate passes **395 suites / 4,142 tests**. Raw targets remain in React/JavaScript memory;
  the separate swipe-Delete dialog, Conversation Details, fullscreen media, drafts, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03M` ordinary conversation-tile containment:** Ordinary `ConversationTile` rows now treat enabled
  or unhydrated privacy state as hidden. Their title, preview, accessibility label, and contact-photo sources become generic
  or deterministic seeded output, and live privacy removes already-mounted raw identity/content. The tile's swipe-Delete
  confirmation is generic always, so a global dialog opened before a privacy transition cannot retain the chat title; exact
  navigation, long-press, read/mute/archive/Delete GUIDs, and the row-instance account lease remain intact. The focused suite
  passes **22/22 tests** repeatedly without warnings, the integration redaction suite passes **12/12 tests**, and the complete
  functional gate passes **395 suites / 4,146 tests**. Raw rows/GUIDs/seeds remain in JavaScript, deterministic avatar output
  stays correlatable, service/time/unread/mute metadata remains visible, and PinnedGrid, Conversation Header contact photos,
  Conversation Details, fullscreen media, drafts, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03N` conversation-header containment:** `ConversationHeader` now fails closed before privacy
  hydration. Its 1:1/group title, handle subtitle, accessibility name, and contact-photo sources become generic or
  deterministic seeded output, and live privacy removes already-mounted identity. The still-unsafe Details target is disabled
  while hidden and its configured callback re-checks current privacy, while Back, FaceTime, Scheduled, and the service badge
  remain available. The corrected `|||` address parser gives distinct group members distinct masked labels. The focused suite
  passes **24/24 tests** repeatedly without warnings, and the complete functional gate passes **395 suites / 4,150 tests**.
  Raw rows/GUIDs/addresses/seeds remain in JavaScript and deterministic avatar output stays correlatable; PinnedGrid,
  Conversation Details, wallpaper/body content, fullscreen media, drafts, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03O` pinned-conversation containment:** `PinnedGrid` now fails closed before privacy hydration.
  Pinned titles, accessibility labels, and single/group contact-photo sources become generic or deterministic seeded output,
  and live privacy removes already-mounted identity. Raw chat GUIDs no longer enter native unread-dot `testID` values; unique
  positional IDs preserve visual testability without identifying a chat. Coarse unread presence plus pinned count/order remain
  intentionally visible, while exact press/long-press callbacks retain their GUID/row only in React. The focused suite passes
  **11/11 tests** repeatedly without warnings, and the complete functional gate passes **395 suites / 4,154 tests**. Masked
  avatar codes remain correlatable pseudonyms and are not globally unique; Conversation Details, wallpaper/body content,
  fullscreen media, drafts, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03P` Conversation Details containment:** The direct Conversation Details route now fails closed
  before privacy hydration and on stale-account rerender. Its raw name/theme/media/member/editor subtree and Theme Studio do
  not mount while hidden; live enable dismisses the keyboard and clears open add/rename/theme editor state. Retained
  navigation/native/group/write callbacks consult current privacy plus the original account lease, while a state-backed epoch
  revokes old picker/dialog callbacks without leaving fresh controls inert after batched OFF → ON → OFF. Image-picker failures
  use fixed copy, the member-removal prompt is generic for its global lifetime, and an admitted successful Leave can still
  perform safe same-account Back navigation. The focused route suite passes **11/11 tests** repeatedly without warnings, and
  the complete functional gate passes **396 suites / 4,165 tests**. Raw rows may remain in DB/JavaScript memory and already-
  open native surfaces cannot be recalled; fullscreen media, chat wallpaper/body content, drafts, and device proof keep
  `PRIV-03` open.

- **2026-08-09 — `PRIV-03Q` fullscreen Media Viewer containment:** Enabled or unhydrated Redacted Mode now mounts only
  generic hidden copy and a labeled Close action. The raw image URI/blurhash carousel, media counter, Share/Save controls,
  cache-reader pins, and native video host/player construction remain outside the hidden tree. Live hiding unmounts media
  and releases its cache pin, while a state-backed revocation epoch plus the original account lease reject retained actions
  and suppress delayed Share/Save results and rejected-Promise errors across OFF → ON → OFF. The focused route suite passes
  **24/24 tests** repeatedly without warnings, and the complete functional gate passes **396 suites / 4,173 tests**; the
  separate `TEST-01` TanStack Query warning debt remains open. Raw rows may remain in DB/JavaScript memory, an already-open
  native share sheet cannot be recalled, an already-admitted save may finish, and DB-local-path action eligibility does not
  independently prove cache-pin admission. Chat wallpaper/body content, active drafts/staged media, native accessibility/screenshot behavior, and device
  proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03R` chat-wallpaper containment:** Enabled or unhydrated Redacted Mode now withholds the raw
  wallpaper URI/Image and resets header, upload-bar, and Composer translucency, MessageList wallpaper state/insets, and both
  overlay positions. Live privacy removes and confirmed opt-out restores that chrome without remounting MessageList/Composer
  and preserves the tested long-press/send callback identities; an invalid original account lease also hides it on the next render. The
  focused route suite passes **43/43 tests** repeatedly without warnings (**4 new privacy cases**), and the complete functional
  gate passes **396 suites / 4,177 tests**; the separate `TEST-01` TanStack Query warning debt remains open. Raw wallpaper data
  may remain in the DB/provider/context/JavaScript process and synced-background work may still fetch it. Android Image
  teardown, TalkBack, screenshot/Recents behavior, chat body content, active drafts/staged media, and device proof keep
  `PRIV-03` open.

- **2026-08-09 — `PRIV-03S` incoming FaceTime overlay containment:** The app-global ring now fails closed before privacy
  hydration and while Redacted Mode is enabled: its raw caller name is absent from the host/accessibility tree, live privacy
  removes an already-mounted name, and generic `FaceTime` plus labeled Answer/Decline controls remain available. Retained
  native Pressability callbacks re-read live call state and no-op after active-call takeover, a different UUID, or an account-
  generation reset even when the UUID is reused; same-generation/same-UUID updates use the current object, and fresh controls
  remain exact. The focused suite passes **14/14 tests** repeatedly without warnings (**7 new privacy/lifecycle cases**), and
  the complete functional gate passes **396 suites / 4,184 tests**; the separate `TEST-01` TanStack Query warning debt remains
  open. Raw call UUID/name/avatar data may remain in Zustand/JavaScript, audio-versus-video type remains visible, and this does
  not recall admitted hook/network work or prove OS notification/full-screen action, Android Pressability, TalkBack,
  screenshot/Recents, or device behavior.

- **2026-08-09 — `PRIV-03T` active-chat MessageBubble containment:** `MessageBubble` now fails closed before privacy
  hydration and while Redacted Mode is enabled. Plain/attributed bodies, big emoji, subjects, named tombstones, reply
  identity/content, payload and cached-link cards, attachment stack/gallery native children, stickers, and arbitrary reaction
  glyphs are replaced by generic `Message`/`Contact`/`Attachment` presentation or removed. Hidden bubbles issue no URL-cache
  lookup, a delayed cache result cannot publish after live hiding, hook order stays stable, and a fresh hidden long-press cannot
  enter the still-ungated message-actions overlay. Confirmed opt-out restores the original content and child paths. The focused
  matrix passes **3 suites / 55 tests** without warnings (**11 new privacy/cache cases**), and the complete functional gate
  passes **396 suites / 4,195 tests**; the separate `TEST-01` TanStack Query warning debt remains open. Raw values may remain
  in DB/upstream/JavaScript state, pre-toggle child callbacks and already-open message-action/reaction-detail sheets remain
  outside this child, and the surrounding MessageRow/swipe-reply path, active drafts/staged media, native teardown,
  TalkBack, screenshot/Recents, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03U` LocationCard containment:** `LocationCard` now fails closed before Redacted Mode hydration
  and after original-account revocation. Hidden cards mount only generic title/subtitle/accessibility state, have no
  configured press action, and perform no local read/parse or download. Parse publication is keyed to attachment GUID,
  exact local path, original account lease, and a state-backed privacy epoch, so late success or rejection cannot replace
  current content across recycled rows or batched OFF → ON → OFF. Retained callbacks re-check live privacy, epoch, lease,
  and source; admitted downloads receive the original lease, and `geo:` intent strings are constructed only after final
  admission checks. The focused suite passes **29/29 tests** repeatedly without warnings (**15 new privacy/ownership
  cases**), and the complete functional gate passes **396 suites / 4,210 tests**; the separate `TEST-01` TanStack Query
  warning debt remains open. Already-admitted download/native map work cannot be recalled, raw attachment/path/file data
  may remain upstream or in DB/JavaScript/native memory, and real Android intent/read cancellation, sibling attachment
  cards, TalkBack, screenshot/Recents, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03V` active-chat MessageRow identity containment:** `MessageRow` now fails closed before
  Redacted Mode hydration for group sender headers, group-event actor/affected-member/renamed-title text, and sender-avatar
  identity/photo sources; deterministic masked avatar tiles preserve row distinction without mounting the raw name or URI.
  The row's own privacy subscription updates it despite `React.memo`. A currently hidden or unhydrated row passes no
  swipe-reply callback into `MessageSwipeWrapper`, while confirmed opt-out restores the exact message action. The focused
  matrix passes **3 suites / 11 tests** repeatedly without warnings (**3 new privacy/action cases**), and the complete
  functional gate passes **396 suites / 4,213 tests**; the separate `TEST-01` TanStack Query warning debt remains open.
  Raw rows/seeds can remain in JavaScript/composite props, and an already-open Composer reply, action/selection state, a
  gesture released before the hidden render commits, native gesture timing, TalkBack, screenshots/Recents, and device proof
  keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03W` reaction-details containment:** `ReactionDetailsSheet` now fails closed before Redacted Mode
  hydration and hides the entire reactor/custom-emoji subtree. Initial or fresh hidden data requests parent closure, and a
  synchronous privacy subscription clears parent-owned open state across live ON and batched OFF → ON → OFF, so stale
  details do not resurrect after opt-out; hydrated-off rendering remains exact. The focused suite passes **8/8 tests**
  repeatedly without warnings (**4 new privacy/lifecycle cases**), and the complete functional gate passes **396 suites /
  4,217 tests**; the separate `TEST-01` TanStack Query warning debt remains open. The sheet's retained data/ref may remain
  until parent closure commits; raw reaction rows continue to exist in the DB and upstream MessageList/JavaScript state.
  Exact native Modal teardown timing, TalkBack, screenshots/Recents, already-open message-action surfaces, and device proof
  keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03X` edit-history containment:** `EditHistorySheet` now fails closed before Redacted Mode hydration
  and hides its entire revision/date/part subtree. Initial or fresh hidden data requests parent closure, and a synchronous
  privacy subscription clears parent-owned open state across live ON and batched OFF → ON → OFF, so stale history does not
  resurrect after opt-out. Hydrated-off revision rendering, empty states, and ordinary backdrop dismissal remain exact. The
  focused suite passes **12/12 tests** repeatedly without warnings (**5 new privacy/lifecycle/dismissal cases**), and the
  complete functional gate passes **396 suites / 4,222 tests**; the separate `TEST-01` TanStack Query warning debt remains
  open. The sheet's selected data/ref may remain until parent closure commits; raw `message_summary_info` remains in the DB
  and upstream MessageList/JavaScript state. Exact native Modal teardown/hardware-Back timing, TalkBack,
  screenshots/Recents, already-open message-action surfaces, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03Y` message-details containment:** `MessageDetailsSheet` now fails closed before Redacted Mode
  hydration and hides its entire sender/service/timestamp subtree. Initial or fresh hidden data requests parent closure, and
  a synchronous privacy subscription clears parent-owned open state across live ON and batched OFF → ON → OFF, so stale
  details do not resurrect after opt-out. Hydrated-off exact rows, service fallback/row omission, null behavior, and ordinary
  backdrop dismissal remain exact. The focused suite passes **10/10 tests** repeatedly without warnings (**5 new privacy/
  lifecycle/dismissal cases**), and the complete functional gate passes **396 suites / 4,227 tests**; the separate `TEST-01`
  TanStack Query warning debt remains open. The sheet's selected message/ref may remain until parent closure commits; the raw
  message remains in the DB and upstream MessageList/JavaScript state. Exact native Modal teardown/hardware-Back timing,
  TalkBack, screenshots/Recents, already-open message-action surfaces, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03Z` thread-sheet containment:** `ThreadSheet` now fails closed before privacy hydration and after
  original-account invalidation, before querying or mounting its reply-count, sender/body/attachment/timestamp,
  accessibility, or row-action subtree. The DB read is admitted inside Disconnect's tracked drain; exact originator,
  original account lease, and committed privacy generation fence delayed success/rejection and retained row presses.
  Synchronous hidden entry clears local rows and requests parent-owned thread selection closure across live ON and batched
  OFF → ON → OFF; a same-originator post-opt-out open receives fresh callbacks. Hydrated-off reply counts, fallbacks,
  exact jump behavior, and ordinary backdrop dismissal remain exact. The focused suite passes **24/24 tests** repeatedly
  without warnings (**18 new privacy/ownership cases**), and the complete functional gate passes **396 suites / 4,245
  tests**; the separate `TEST-01` TanStack Query warning debt remains open. Raw thread rows remain in the DB/upstream
  JavaScript; an ordinary same-account close can retain loaded rows in local component state for a later reopen; and an
  already-admitted, uncapped thread SELECT drains rather than cancels and can delay Disconnect until it settles. Exact
  native Modal/hardware-Back teardown, TalkBack, screenshots/Recents, already-open message-action surfaces, and device proof
  keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03AA` contact-card containment:** `ContactCard` now fails closed before Redacted Mode hydration and
  on privacy or stale-account rerenders: raw display name, phone/email, transfer name, initials, download spinner,
  accessibility identity, reads, and configured actions are replaced by a generic disabled Contact card. Parse state/
  publication and retained actions bind the exact GUID/path, original account lease, and committed privacy epoch; recycled/
  null sources plus delayed success/rejection cannot replace current UI. Token-owned native outcomes suppress stale retry/
  toast/error publication while fresh source/post-opt-out controls preserve exact open/download behavior. The focused suite
  passes **46/46 tests** repeatedly without warnings (**31 new privacy/ownership cases**), and the complete functional gate
  passes **396 suites / 4,276 tests**; the separate `TEST-01` TanStack Query warning debt remains open. Its sole current
  `MessageBubble` parent already unmounts attachment leaves while hidden, so this child is leaf/future-reuse defense. Raw
  vCard/parsed values can remain upstream or in JavaScript; admitted reads, opens, and downloads cannot be recalled;
  standalone stale-account host removal waits for parent unmount or the next rerender; and same-account arbitrary-unmount,
  native-intent/cache, TalkBack, screenshots/Recents, and device lifecycle proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03AB` New Chat composer containment:** The New Chat route now fails closed while privacy is enabled
  or unhydrated and after original-account invalidation. Its raw To query/chips, message draft, staged Image URI, suggestions,
  existing-chat action, transport controls, and Start action leave the host/accessibility tree; only the header, Back, and
  generic privacy copy mount. Ordinary privacy entry preserves unfinished JavaScript state for confirmed opt-out, while a
  committed privacy epoch and original lease fence retained form actions plus delayed availability/existing-chat results.
  Current-account hidden routes may consume and protect a valid share/forward handoff without mounting it; stale-at-mount
  routes do not clear share state or consume/stat that token. A fully successful create plus optional attachment send that
  loses its privacy grant retires recipients/query/message/staged/existing state and releases aggregate pins, including when
  the staged row was removed before a text-only success. The focused route suite passes **45/45 tests** repeatedly without
  warnings (**16 new privacy/ownership cases over the 29-test baseline**), and the complete functional gate passes **396
  suites / 4,292 tests**; the separate `TEST-01` warning debt remains open. Raw drafts, recipients, staged metadata/file names,
  contact-search results, and handoff/stat work may remain or continue in JavaScript; admitted create/send work cannot be
  recalled; consumed pins invalidated after adoption rely on route unmount for release; and create-success followed by
  `sendImages` failure retains retry/idempotency ambiguity. Active-chat Composer state, exact IME/native transitions, TalkBack,
  screenshots/Recents, and device proof keep `PRIV-03` open.

- **2026-08-09 — `PRIV-03AC` message-search hydration containment:** `SearchResultsView` now treats unhydrated Redacted Mode
  as hidden: direct message-hit rows mount generic `Contact`/`Message` copy instead of the resolved title, raw snippet, or
  nested highlighted query token, and the same mounted view reveals them only after hydration confirms privacy is off.
  Existing live-enable removal, exact timestamp, and exact internal message navigation remain unchanged; matched chat rows
  remain separately owned by `ConversationTile`'s existing fail-closed gate. The focused suite passes **14/14 tests**
  repeatedly without warnings (**1 new hydration case over the 13-test baseline**), and the complete functional gate passes
  **396 suites / 4,293 tests**; the separate `TEST-01` warning debt remains open. Search hooks still run, raw query/result rows
  remain in JavaScript, the parent search input still mounts typed query text, and exact downstream Composer/device/TalkBack/
  screenshots remain open under parent `PRIV-03`.

- **2026-08-09 — `PRIV-03AD` removal phase 1, notification decoupling:** Owner decision `DEC-10` removes
  user-configurable Redacted Mode while retaining independent privacy/security boundaries. Normal notifications remain
  detailed and Android controls lock-screen presentation; App Lock still posts a generic **new-delivery** notice, and
  pairing-QR reveal, log redaction, account leases, and stale-result guards remain. Connected-ready startup now runs legacy
  raw payload/GUID-derived channel cleanup and generic missing-reminder repair independently of the setting, serialized on
  the native notification queue and owned by the original account lease. Reminder-id and legacy FaceTime-route DB handoffs
  carry commit guards. The focused matrix passes **8 suites / 227 tests** warning-free, and the measured full functional
  gate passes **396 suites / 4,306 tests**. Existing generic/sanitized notices and repaired missing reminders remain generic;
  App Lock does not retroactively scrub detailed notices or triggers Android already owns; a failed maintenance pass retries
  on the next connected boot run; and the configurable mode remains live until later removal phases. Parent `PRIV-03` and
  the Android/device portion of `NOTIF-02` remain in progress.

- **2026-08-09 — `PRIV-03AE` removal phase 2A, pure render leaves:** Removed Redacted Mode store subscriptions and
  mode-only masking from `ContactSuggestionList`, `SearchResultsView`, and `ReplyQuote`. Ordinary contact names/addresses,
  resolved search titles/snippets/highlights, quoted sender/text/attachment descriptions, accessibility output, and exact
  selection/navigation/press callbacks remain positively covered. The batch removed no independent account/source/native/
  log boundary and adds no DB-write finding. Its focused gate passes **3 suites / 21 tests** twice without warnings. The
  measured full gate passes **396 suites / 4,299 tests**; the seven-test decrease from the phase-1 **4,306-test** checkpoint
  is the deletion of obsolete mode-only cases, not lost ordinary-behavior coverage. The setting, persisted value, store,
  coordinator, parent containment, and other mode-specific UI branches remain live, so parent `PRIV-03` stays in progress.

- **2026-08-09 — `PRIV-03AF` removal phase 2B, pinned/message-row identity leaves:** Removed only Redacted Mode
  identity/title/avatar/group-event and swipe-reply substitutions from `PinnedGrid` and `MessageRow`. Exact resolved pinned
  titles, single/group photos, sender/event text, avatar URIs, GUID/row/message callback payloads, unread visual and
  accessibility semantics, non-identifying positional unread IDs, memoized bindings, selection controls, and
  `MessageBubble` ownership remain positively covered. The focused regression gate passes **4 suites / 16 tests**
  warning-free. The measured full gate passes **396 suites / 4,293 tests**; the six-test decrease from the phase-2A
  **4,299-test** checkpoint is the deletion of obsolete mode-only cases, not a suite or ordinary-behavior regression. The
  batch adds no DB-write finding. Setting/store/coordinator, `MessageBubble`, and other mode-specific UI branches remain
  live, so parent `PRIV-03` stays in progress; known Account/Server Health `act(...)` warnings remain under `TEST-01`.

- **2026-08-09 — `PRIV-03AG` removal phase 2C, parent-owned detail modals:** Removed only Redacted Mode selectors,
  subscriptions, close-dedupe refs/effects, hidden returns, and no-op masking from `ReactionDetailsSheet`,
  `EditHistorySheet`, and `MessageDetailsSheet`. Exact reaction names/glyphs, revision text/dates/removals, sender/service/
  delivery rows and fallbacks, null/empty states, Modal hardware-Back and real-backdrop parent clearing, inner-tap
  swallowing, and fresh reopen remain positively covered. No account/source/native/log boundary existed in these
  prop-driven read-only leaves. The focused gate passes **3 suites / 17 tests** twice warning-free; the measured full gate
  passes **396 suites / 4,280 tests**. The 13-test decrease from the phase-2B **4,293-test** checkpoint reflects removal of
  15 obsolete mode-only cases plus two added ordinary Reaction modal cases, not a suite or behavior regression. The batch
  adds no DB-write finding. Setting/store/coordinator and other mode-specific UI branches remain live, and the known
  Server Health `act(...)` warning stays open under `TEST-01`.

- **2026-08-09 — `PRIV-03AH` removal phase 2D, incoming FaceTime caller presentation:** Removed only the Redacted
  store subscription and generic caller-name substitution from `IncomingFaceTimeOverlay`; exact caller name and
  audio/video subtitle now render normally. The independent store-generation/reset boundary, active-call takeover,
  captured UUID, live-current call lookup, same-UUID updated-object forwarding, retained-callback rejection, fresh-current
  controls, and generic action accessibility labels remain mutation-pinned. The focused suite passes **10/10 tests**
  repeatedly warning-free and the measured full gate passes **396 suites / 4,276 tests**. The four-test decrease from the
  phase-2C **4,280-test** checkpoint is exactly the deletion of obsolete mode-only cases, not a suite or action-guard
  regression. The batch adds no DB-write finding. Setting/store/coordinator and other mode-specific UI branches remain
  live; the known Server Health `act(...)` warning stays open under `TEST-01`.

- **2026-08-09 — `PRIV-03AI` removal phase 2E, conversation shared media:** Removed only the Redacted store
  subscription and mode-only photo/video/link masking from `MediaSections`; ordinary exact image sources, video blurhash
  posters, document/link rows, `safeOpenUrl`, and media-GUID callbacks render normally. Managed local photo/video paths
  remain pinned across native reads and viewer handoff, refusal fails closed, protections release on unmount, and remote/
  dev URLs bypass local-cache protection. The focused gate passes **2 suites / 17 tests** repeatedly without Jest warnings;
  targeted ESLint exits with zero errors and three established test-mock/import warnings. The measured full gate passes
  **396 suites / 4,275 tests**. The one-test decrease from the phase-2D **4,276-test** checkpoint is two obsolete mode-only
  cases removed plus one ordinary remote-source regression added. The batch adds no DB-write finding. Setting/store/
  coordinator and other mode-specific UI branches remain live; the known Server Health `act(...)` warning stays open
  under `TEST-01`.

- **2026-08-09 — `PRIV-03AJ` removal phase 2F, pairing QR reveal ownership:** Removed `PairingQr`'s Redacted store
  dependency without making its password-bearing setup payload automatic: the QR remains absent from the host and
  accessibility trees until an explicit tap. Skeptical review first found that a retained same-payload Reveal callback
  could re-admit after route blur or background; the final opaque grant binds exact payload identity plus a synchronous,
  committed lifecycle revocation generation. Old configured callbacks are inert after blur, non-active AppState, or
  payload replacement; fresh controls reveal the exact current payload; Android listener cleanup, null state, whole-tree
  credential canaries, and the absence of a logging path remain covered. The focused suite passes **7/7 tests** repeatedly
  without warnings, and the measured full gate passes **396 suites / 4,273 tests**. The two-test decrease from the
  phase-2E **4,275-test** checkpoint is three obsolete mode-only cases removed plus one stronger lifecycle/credential
  regression added. The batch adds no DB-write finding. Setting/store/coordinator and other mode-specific UI branches
  remain live; the known Account/Server Health `act(...)` warnings stay open under `TEST-01`.

- **2026-08-09 — `PRIV-03AK` removal phase 2G, conversation actions and header identity:** Removed only the
  Redacted store dependencies and mode-specific title/identity/avatar/Details substitutions from `ChatActionsSheet` and
  `ConversationHeader`. Chat actions still bind the original account lease, reject retained A-account Pin/Mute/Archive
  callbacks while fresh B controls remain exact, drain admitted writes, preserve lease-bearing Mark actions, and keep the
  delayed Delete confirmation generic while forwarding the exact GUID and original lease. The header still validates and
  formats addresses, collapses an A/A/B participant input before choosing the two collage photos, resolves service badges,
  preserves exact configured Details navigation plus Back/FaceTime/Scheduled actions, and renders ordinary exact 1:1/group
  identity, avatar, and accessibility output. The focused gate passes **2 suites / 37 tests** repeatedly without warnings,
  and the measured full gate passes **396 suites / 4,264 tests**. The nine-test decrease from the phase-2F **4,273-test**
  checkpoint is 12 obsolete mode-only cases removed plus three stronger ordinary/account regressions added. Three existing
  `ChatActionsSheet` DB-inventory line fields were mechanically refreshed without changing their unproven dispositions;
  totals remain **1,053 entries / 492 proved / 561 unproven / 0 structural errors / 0 nested coordinators**. Setting/store/
  coordinator and other mode-specific UI branches remain live; the known Server Health `act(...)` warning stays open under
  `TEST-01`.

- **2026-08-09 — `PRIV-03AL` removal phase 2H, conversation-tile identity:** Removed only `ConversationTile`'s
  Redacted store dependency and title/preview/avatar substitutions. Exact 1:1 and A/A/B-deduplicated group title, preview,
  accessibility, avatar-photo, date/service/unread/mute, press/long-press, and memo behavior remain. Mark Read/Unread and
  delayed Delete keep the row-instance original-account lease; retained A-account Mute/Archive callbacks stay inert while
  fresh B controls are exact; and repeated Delete dialogs remain generic while forwarding the exact GUID and same original
  lease. The direct suite passes **22/22 tests** and the shared Redacted suite passes **11/11 tests**, together **2 suites /
  33 tests** repeatedly without warnings. Direct arithmetic is **22 - 4 obsolete mode cases + 4 stronger ordinary/account
  cases = 22**; exactly one obsolete shared masking case was also removed, so the measured full gate moved from the phase-2G
  **4,264-test** checkpoint to **396 suites / 4,263 tests**. Two existing `ConversationTile` DB-inventory line fields were
  mechanically refreshed without changing their unproven dispositions; totals remain **1,053 entries / 492 proved / 561
  unproven / 0 structural errors / 0 nested coordinators**. Setting/store/coordinator and other mode-specific runtime
  branches remain live; established Account/Server Health `act(...)` warnings stay open under `TEST-01`.

- **2026-08-09 — `PRIV-03AM` removal phase 2I, iMessage account presentation:** Removed only `AccountScreen`'s
  Redacted store dependency and privacy placeholder, restoring its existing loading, unsupported, error, Apple ID/name/
  status, and alias-picker states unconditionally. The account query remains keyed by its captured generation; delayed
  old-account GET success and rejection remain discarded; and alias selection retains the original-account lease,
  tracked POST drain, guarded cache/dialog/finally publication, vetted-alias admission, failure cleanup/retry, and Back
  behavior. The focused suite passes **13/13 tests** repeatedly without warnings. Exact arithmetic is **15 - 3 obsolete
  mode cases + 1 Back regression = 13**, so the measured full gate moved from the phase-2H **4,263-test** checkpoint to
  **396 suites / 4,261 tests**. This batch adds or shifts no DB-write finding; totals remain **1,053 entries / 492 proved /
  561 unproven / 0 structural errors / 0 nested coordinators**. Setting/store/coordinator and other mode-specific runtime
  consumers remain live; the established Server Health `act(...)` warning stays open under `TEST-01`.

- **2026-08-09 — `PRIV-03AN` removal phase 2J, scheduled-list presentation and navigation:** Removed only
  `ScheduledScreen`'s Redacted store dependency and title/accessibility/editor-navigation substitutions. Exact pending and
  completed bodies, exact editor IDs, reactive pending/sent/error/legacy-uncertain status, date/recurrence labels, empty
  state, and Back remain. Mount sync and Cancel retain the same captured original-account lease; Clear retains tracked
  Disconnect drain, exact DB/id forwarding, current fixed-copy error publication, and stale-account suppression. The direct
  suite passes **12/12 tests** and the unchanged service account-scope suite passes **7/7 tests**, together **2 suites / 19
  tests** repeatedly without warnings. Direct arithmetic is **15 - 6 obsolete mode cases + 3 action/ownership regressions
  = 12**, so the measured full gate moved from the phase-2I **4,261-test** checkpoint to **396 suites / 4,258 tests**. One
  existing ScheduledScreen DB-inventory callback entry was mechanically remapped to its new stable ID/symbol/line without
  changing its unproven disposition; totals remain **1,053 entries / 492 proved / 561 unproven / 0 structural errors / 0
  nested coordinators**. Setting/store/coordinator and other mode-specific runtime consumers remain live. This full run
  emitted no `act(...)` warning, but the intermittent Account/Server Health debt remains open under `TEST-01`.

- **2026-08-09 — `PRIV-03AO` removal phase 2K, reminder-list presentation and actions:** Removed only
  `RemindersScreen`'s Redacted store dependency, privacy-revocation epoch/subscription, and title/accessibility/disabled
  substitutions. Exact previews, times, accessibility names, second-row Reschedule/Delete bindings, picker cancellation,
  and Back remain. Both actions retain the same mounted original-account lease; Reschedule checks it before and after the
  native picker and passes it into `rescheduleReminder`, while Cancel passes it into `cancelReminder`. Retained stale
  callbacks, delayed picker success/rejection, and already-admitted service failures cannot act or publish dialogs after
  account replacement; current picker/Cancel failures retain fixed generic copy. The direct suite passes **10/10 tests**,
  the unchanged reminder-service suite passes **19/19**, and the unchanged picker suite passes **3/3**, together **3
  suites / 32 tests** repeatedly without warnings. Direct arithmetic is **12 - 6 obsolete mode cases + 4 stronger
  ordinary/account cases = 10**, so the measured full gate moved from the phase-2J **4,258-test** checkpoint to **396
  suites / 4,256 tests**. This batch adds or shifts no DB-write finding; totals remain **1,053 entries / 492 proved / 561
  unproven / 0 structural errors / 0 nested coordinators**. Setting/store/coordinator and other mode-specific runtime
  consumers remain live. This full run emitted no `act(...)` warning, but the intermittent Account/Server Health debt
  remains open under `TEST-01`.

- **2026-08-09 — `PRIV-03AP` removal phase 2L, scheduled-editor presentation and actions:** Removed only
  `ScheduledEditScreen`'s Redacted store dependency, privacy-revocation epoch/subscription, privacy-only keyboard
  dismissal, callback privacy checks, and hidden editor branch. Loading still targets the exact route ID (42 in the
  focused fixture) and current database; ordinary body/date/recurrence/accessibility/Back and the current fixed load error
  remain. One mounted original-account
  lease fences delayed load success/error/finally, picker admission/results/errors, and Save admission/completion/errors.
  Save still forwards trimmed text, exact date, recurrence, and that lease. Current picker/Save failures retain fixed copy;
  failed Save does not navigate and keeps the form, while stale picker and already-admitted Save success/error publish no
  late date, Back, or dialog. The direct suite passes **16/16 tests** and the unchanged scheduled account-scope suite passes
  **7/7**, together **2 suites / 23 tests** repeatedly without warnings. Eight obsolete mode cases were removed and 11
  stronger ordinary/account/picker cases were added: **13 - 8 + 11 = 16**, so the measured full gate moved from the
  phase-2K **4,256-test** checkpoint to **396 suites / 4,259 tests**. This batch adds or shifts no DB-write finding; totals
  remain **1,053 entries / 492 proved / 561 unproven / 0 structural errors / 0 nested coordinators**. Setting/store/
  coordinator and other mode-specific runtime consumers remain live. The established Server Health `act(...)` warning
  appeared in this full run and remains open under `TEST-01`.

- **2026-08-09 — `PRIV-03AQ` removal phase 2M, chat-wallpaper presentation:** Removed only `ChatScreen`'s Redacted
  store dependency and mode-specific wallpaper masking. Exact wallpaper URI, header/upload/composer translucency,
  `MessageList` background state and both insets, and both top/bottom overlay styles now render normally. Reactive URI-to-
  null-to-new-URI changes retain the same list/composer instances and exact long-press/send callback identities. The
  mounted original-account lease still hides stale-account wallpaper and resets every chrome consumer on the next screen
  render. The direct suite passes **41/41 tests**; the unchanged read-marker, deleted-backfill, theme-provider, and synced-
  background account-scope suites pass **43/43**, together **5 suites / 84 tests** repeatedly without warnings. Direct
  arithmetic is **43 - 3 obsolete mode cases + 1 stronger continuity case = 41**, so the measured full gate moved from the
  phase-2L **4,259-test** checkpoint to **396 suites / 4,257 tests**. Three existing `ChatScreen` DB-inventory line fields
  were mechanically refreshed without changing their stable IDs, symbols, owners, evidence, or unproven dispositions;
  totals remain **1,053 entries / 492 proved / 561 unproven / 0 structural errors / 0 nested coordinators**. Setting/store/
  coordinator and other mode-specific runtime consumers remain live. The established Server Health `act(...)` warning
  appeared in this full run and remains open under `TEST-01`.

- **2026-08-09 — `PRIV-03AR` removal phase 2N, Find My presentation and routing:** Removed only `FindMyScreen`'s
  Redacted store dependency and mode-specific identity/location/map masking. Exact device/item/friend names, addresses and
  no-location fallbacks, finite battery values, finite-coordinate markers, source-namespaced `d:`/`i:`/`p:` focus IDs, and
  explicit encoded `geo:` actions through `safeOpenUrl` now render or route normally. The real `FindMyMap` remains a
  no-WebView/no-coordinate-hosting disabled panel under `WEB-02`; route load/polling/refresh/Back wiring and store-
  generation reset ownership remain covered. The shared direct suite passes **12/12 tests**; five unchanged containment,
  polling, store, session-account, and URL-allowlist suites pass **28/28**, together **6 suites / 40 tests** repeatedly
  without warnings. Direct arithmetic is **11 - 4 obsolete Find My mode cases + 5 stronger ordinary/routing cases = 12**,
  so the measured full gate moved from the phase-2M **4,257-test** checkpoint to **396 suites / 4,258 tests**. This batch
  adds or shifts no DB-write finding; totals remain **1,053 entries / 492 proved / 561 unproven / 0 structural errors / 0
  nested coordinators**. Unused `FindMyMapHidden`, setting/store/coordinator, and other mode-specific runtime consumers
  remain cleanup/open work. The established Server Health `act(...)` warning appeared in this full run and remains open
  under `TEST-01`.

- **2026-08-09 — `PRIV-03AS` removal phase 2O, Thread Sheet presentation and controlled-open ownership:** Removed only
  `ThreadSheet`'s Redacted store dependency, privacy generation/subscription, and mode-triggered parent close. Ordinary
  exact thread rows, sender/body/attachment/time/accessibility output, reply counts, fallbacks, backdrop/null behavior,
  and exact GUID/date jump remain. The replacement generic open lifetime revokes retained native row callbacks and delayed
  read results across A→null→same-A reopen, direct A→B replacement, row/backdrop/Modal close, and account invalidation.
  The original account lease, account-close dedupe, tracked DB read/drain, and exact originator/result/action checks remain
  mutation-pinned. The direct suite passes **18/18 tests** and the unchanged message-repository suite passes **32/32**,
  together **2 suites / 50 tests** repeatedly without warnings. Direct arithmetic is **24 - 8 obsolete mode cases + 2
  stronger open-lifetime/error cases = 18**, so the measured full gate moved from the phase-2N **4,258-test** checkpoint
  to **396 suites / 4,252 tests**. This batch adds or shifts no DB-write finding; totals remain **1,053 entries / 492
  proved / 561 unproven / 0 structural errors / 0 nested coordinators**. The admitted uncapped thread SELECT still drains
  rather than cancels and may delay Disconnect; arbitrary same-account unmount, exact native Modal/hardware-Back timing,
  setting/store/coordinator, and other mode-specific runtime consumers remain open. This full run was quiet, but the
  intermittent Account/Server Health `act(...)` warning debt remains open under `TEST-01`.

- **2026-08-09 — `PRIV-03AT` removal phase 2P, Location Card presentation and source ownership:** Removed only
  `LocationCard`'s Redacted store dependency and mode-specific filename/coordinate/action masking. Exact ordinary
  filename/finite-coordinate output and map/download behavior remain, while a generic committed source lifetime, exact
  `{guid, localPath}` tuple, original-account lease, and account-invalidation subscription fence initial-stale mounts,
  recycled A→B→A rows, bounded parse success/error publication, retained configured callbacks, and manual downloads. The
  direct suite passes **24/24 tests** and three unchanged vlocation/privacy/download-account suites pass **35/35**,
  together **4 suites / 59 tests** repeatedly without warnings. Direct arithmetic is **29 - 10 obsolete mode cases + 5
  stronger source/account/action cases = 24**, moving the measured full gate from the phase-2O **4,252-test** checkpoint
  to **396 suites / 4,247 tests**. A proposed A→B→A parse-settlement mutation test was retracted because effect cleanup
  would make it vacuous; the retained configured-press case isolates the lifetime, and parse lifetime is source-audited
  defense in depth. Scanner validation also caught an initial context-mismatched inventory line edit, after which the
  unrelated fields were restored and only the two LocationCard entries were remapped to lines 149 and 187 without changing
  their unproven dispositions. Totals remain **1,053 entries / 492 proved / 561 unproven / 0 structural errors / 0 nested
  coordinators**. Arbitrary same-account unmount, already-admitted native map/download work, the parent mode gate, and the
  remaining setting/store/coordinator and mode-specific runtime graph remain open. The Server Health `act(...)` warning
  appeared in this full run and remains open under `TEST-01`.

- **2026-08-09 — `PRIV-03AU` removal phase 2Q, Contact Card presentation and source ownership:** Removed only
  `ContactCard`'s Redacted store dependency and mode-specific vCard identity/action masking. Ordinary exact filename,
  parsed name, phone/email, initials, accessibility, native-open, and manual-download behavior remain. A generic
  ref-plus-committed source lifetime, exact `{guid, localPath}` tuple, original-account lease, and account-invalidation
  subscription fence initial-stale mounts, recycled A→B→A rows, bounded parse success/error publication, retained open/
  download callbacks, native-open token ownership, and missing-file re-download. The direct suite passes **35/35 tests**;
  four unchanged vCard/open-file/download-account/privacy suites pass **48/48**, together **5 suites / 83 tests**
  repeatedly without warnings. Direct arithmetic is **46 - 12 obsolete mode cases + 1 initial-stale case = 35**, moving
  the measured full gate from the phase-2P **4,247-test** checkpoint to **396 suites / 4,236 tests**. The four existing
  ContactCard inventory line fields moved **158→156, 178→176, 184→182, and 221→222** without changing their unproven
  dispositions; totals remain **1,053 entries / 492 proved / 561 unproven / 0 structural errors / 0 nested coordinators**.
  Arbitrary same-account unmount, an already-admitted Android open that cannot be recalled, the parent `MessageBubble`
  mode gate, and the remaining setting/store/coordinator and mode-specific runtime graph remain open. Intermittent Account/
  Server Health `act(...)` warning debt remains open under `TEST-01`; the full run is not described as warning-free.

- **2026-08-09 — `PRIV-03AV` removal phase 2R, fullscreen Media Viewer presentation and ownership:** Removed only the
  Media Viewer's Redacted store dependency, privacy epoch/subscription, and mode-specific hidden subtree. Ordinary exact
  image/video URI, blurhash, counter, Close, Share, Save, zoom, and carousel behavior remain. The original-account lease,
  tracked exact-route DB read and native actions, synchronous route/account/mount/Close revocation, alive cleanup, exact
  visible-attachment/gallery ownership, route-tagged load state, keyed and clamped no-fallback carousel, per-page callback/
  zoom lifetime, local-path validation, cache protection/refusal/release, protect-before-player ordering, and independent
  non-reentrant Share/Save tokens retain fixed-copy current failure/retry behavior plus stale success/error/finally
  suppression. The direct
  suite passes **34/34 tests** and the unchanged cache-protection and media-service suites pass **33/33**, together **3
  suites / 67 tests** repeatedly without warnings. Direct arithmetic is **24 - 8 obsolete mode cases + 18 stronger route/
  page/account/cache/action cases = 34**, moving the measured full gate from the phase-2Q **4,236-test** checkpoint to
  **396 suites / 4,246 tests**. No DB-write finding was added or shifted; totals remain **1,053 entries / 492 proved / 561
  unproven / 0 structural errors / 0 nested coordinators**. The direct matrix covers exact image/video gallery output,
  route/account replacement, page A→B→A callbacks and zoom, clamp/no fallback, retained and admitted Share/Save outcomes,
  current rejection plus retry, remote-wrapper rejection, protect-before-player, and pin refusal/release. React Native
  Testing Library cannot directly prove the native
  composite FlatList's physical keyed remount; exact replacement index/counter/actions are host-proved while key/remount
  and token-specific `finally` ownership remain source-audited. Delayed route-query coverage also shares effect-local
  alive cleanup and therefore does not isolate the numeric route-lifetime check by mutation. An admitted uncapped
  attachment SELECT still drains rather than cancels; admitted native Share/Save and already-open OS surfaces cannot be
  recalled; action eligibility still follows DB `localPath`, so operation pin/re-stat refusal can yield a fixed generic
  failure; ordinary raw media remains in DB/JavaScript; and exact device carousel/player timing, setting/store/coordinator,
  and other mode-specific runtime consumers remain open. The measured full gate passed, but intermittent Account/Server
  Health `act(...)` warning debt remains open under `TEST-01`; it is not described as warning-free.

- **2026-08-09 — `PRIV-03AW` removal phase 2S, Server Management presentation and account ownership:** Removed only
  `ServerManagementScreen`'s Redacted store dependency and mode-specific status/statistics/origin/sync/action/log masking.
  Ordinary exact server identity, status, statistics, origin sharing, sync copy, actions, and deliberately opened logs
  remain. The `ping`/`stats`/`info` queries keep one captured generation in their keys and discard delayed old-account
  success/rejection; generation invalidation reactively removes mounted old-account status, QR, and log hosts. Share,
  Sync, Health, Pairing, log, and restart callbacks retain the original-account lease. Restart/log work retains tracked
  Disconnect drain, stale success/error/dialog suppression, fixed current failure copy, and retry/finally release, while
  `PairingQr` still requires an explicit exact-payload reveal and revokes it on blur/AppState. The direct suite passes
  **23/23 tests** and the unchanged Pairing QR/server-endpoint suites pass **25/25**, together **3 suites / 48 tests**
  repeatedly without warnings. Direct arithmetic is **25 - 7 obsolete mode cases + 5 stronger account/query/action cases
  = 23**, moving the measured full gate from the phase-2R **4,246-test** checkpoint to **396 suites / 4,244 tests**. No
  DB-write finding was added or shifted; totals remain **1,053 entries / 492 proved / 561 unproven / 0 structural errors /
  0 nested coordinators**. Admitted network/native work drains rather than cancels, an already-open OS Share sheet cannot
  be recalled, arbitrary same-account unmount/global-callback lifetime is not fenced, and the password-bearing setup
  payload exists in JavaScript before deliberate Reveal while remaining outside the host/QR boundary. Ordinary detailed
  server data/logs, exact device lifecycle behavior, and the remaining setting/store/coordinator/mode runtime stay open.
  The established Server Health `act(...)` warning appeared in the measured full run and remains open under `TEST-01`;
  the full run is not described as warning-free.

- **2026-08-09 — `PRIV-03AX` removal phase 2T, MessageBubble presentation and URL-source ownership:** Removed only
  `MessageBubble`'s Redacted store dependency and mode-specific content/child/action masking. Ordinary exact body,
  attributed URL, subject, tombstone sender, reply, payload card, attachment/gallery, sticker, reaction, big emoji,
  accessibility, and actions remain. Exact cached-URL adoption prevents retained URL-A metadata from rendering for URL B;
  deferred old-query success/rejection cannot replace or blank fresh B output. Text-only/no-network preview containment,
  `safeOpenUrl`, hidden plugin-attachment filtering, child-owned attachment native/cache behavior, and exact nested Reply/
  Reaction, configured long-press, Retry, and link/card callbacks remain covered. Direct arithmetic is **55 - 14 obsolete
  mode cases + 3 stronger URL-source cases = 44**. Four obsolete shared MessageBubble/ReplyQuote masking cases were removed
  while the eight ordinary ConversationTile/MessageBubble/ReplyQuote/Find My controls and intentional single NUL delimiter
  remain, yielding **8 suites / 88 tests** warning-free and moving the measured full gate from the phase-2S **4,244-test**
  checkpoint to **396 suites / 4,229 tests**. Targeted ESLint exits with zero errors and seven established mock-factory
  warnings. No DB-write finding was added or shifted; totals remain **1,053 entries / 492 proved / 561 unproven / 0
  structural errors / 0 nested coordinators**. Arbitrary retained Pressability/inline callbacks after same-account
  recycling or unmount remain unfenced; attachment children own their native/cache/download lifecycles; URL-preview reads
  remain account-neutral exact-key cache reads; exact device long-press/FlashList behavior and the remaining mode runtime
  stay open. The established Server Health `act(...)` warning appeared in the measured full run and remains open under
  `TEST-01`; the full run is not described as warning-free.

- **2026-08-09 — `PRIV-03AY` removal phase 2U, Server Health presentation and account ownership:** Removed only
  `ServerHealthScreen`'s Redacted store dependency, privacy-revocation epoch/subscription, and hidden diagnostics/action
  branch. Ordinary exact diagnostics, alerts, RCS state, accessibility, Back, Refresh, Clear Alerts, and RCS reconnect
  remain. A captured original-account lease now drives monotonic exact-generation retirement; the stale route mounts only
  Back plus fixed generic account-changed copy. All ten reads keep exact generation-scoped keys and guarded success/error
  adoption. Refresh retains its lease, while Clear and RCS retain tracked Disconnect drain, stale success/rejection/cache/
  toast/refetch suppression, fixed current errors, current retry/finally release, retained-A rejection, and fresh-B exact
  actions. Direct arithmetic is **19 - 7 obsolete mode cases + 6 stronger ordinary/account cases = 18**; the unchanged
  20-case RCS-health suite yields **2 suites / 38 tests**, moving the measured full gate from the phase-2T **4,229-test**
  checkpoint to **396 suites / 4,228 tests**. The measured full run was quiet, but an independent post-freeze focused run
  reproduced the established intermittent TanStack Query React `act(...)` warning; `TEST-01` therefore remains open and
  the output is not described as categorically warning-free. No DB-write finding was added or shifted; totals remain
  **1,053 entries / 492 proved / 561 unproven / 0 structural errors / 0 nested coordinators**. Raw values may remain in
  generation-scoped query caches outside the host tree; arbitrary same-account unmount/retained callbacks have no generic
  mount lifetime; admitted Clear/RCS work drains rather than cancels; and the remaining mode runtime stays open.

- **2026-08-09 — `PRIV-03AZ` removal phase 2V, New Chat presentation and account/recipient ownership:** Removed only
  `NewChatScreen`'s Redacted store dependency, privacy epoch/subscription, and mode-specific form masking/completion.
  Ordinary exact drafts, recipients, contacts, staged URIs, transport, existing-chat shortcut, accessibility, and form
  actions remain. A captured original-account lease drives monotonic exact-generation retirement and a Back-only fixed
  stale tree; observable retained Open/Start actions plus every form setter recheck the live lease. Existing-chat results retain exact
  `recipientKey` adoption plus effect cleanup, with immediate key-change shielding and same-key stale success/rejection
  coverage. Availability remains address-keyed and original-lease-published. Share/forward adoption remains current-account
  admitted, protected handoff pins release only at full success or unmount, and Start retains the original lease through
  create/send/navigation/error/`finally` handling with fixed current failure copy and retry. Direct arithmetic is **45 -
  15 obsolete mode cases + 11 stronger ordinary/account/source cases = 41**; five unchanged companion suites add 35 tests,
  yielding **6 suites / 76 tests** warning-free and moving the measured full gate from the phase-2U **4,228-test** checkpoint
  to **396 suites / 4,224 tests**. Cross-instance availability/result publication and local-only setters remain integration/
  source-audited rather than mutation-isolated. The two existing New Chat inventory records retain stable IDs and metadata
  with line-only remaps **410→346** and **458→389**; totals remain **1,053 entries / 492 proved / 561 unproven / 0 structural
  errors / 0 nested coordinators**. Arbitrary same-account unmount/pre-rerender callbacks lack a generic lifetime; contact
  search, late local state, and admitted create/send work may continue off-host; incomplete retired sends may hold pins
  until unmount; create-success/attachment-send-failure retry ambiguity and the remaining mode graph stay open. `TEST-01`
  remains open, so the measured full run is not described as warning-free.

- **2026-08-10 — `PRIV-03BA` removal phase 2W, Chat Settings presentation and source/account ownership:** Removed only
  Chat Settings' and `MediaSections`' Redacted store dependencies and mode-specific masking. Ordinary exact conversation
  identity, media/link rows, customization, group actions, notification settings, and picker flows remain. An outer
  captured account lease provides monotonic exact-generation retirement plus a fixed Back-only stale tree; a GUID-keyed
  inner screen owns an opaque mount lifetime so prior reactive data, editor state, and retained A callbacks cannot cross
  A→B→A replacement. Every callback/result/dialog/`finally` path rechecks the exact GUID, lifetime, account lease, and
  mounted owner. One non-reentrant outer token serializes all three pickers, current failures keep fixed copy/retry, and
  stale picker/write/group/notification outcomes cannot publish late UI. `MediaSections` retains `safeOpenUrl` by default
  while Chat Settings supplies its guarded link callback; notification settings receive exact source-account context.
  Direct arithmetic is **11 - 3 + 24 = 32** for Chat Settings and **12 + 1 = 13** for `MediaSections`; five unchanged
  suites add 44 tests, yielding **7 suites / 89 tests** warning-free. The owned-test arithmetic is a net **+22**, moving
  the measured full gate from the phase-2V **4,224-test** checkpoint to **396 suites / 4,246 tests**, zero snapshots,
  passing under `--silent`; it is not described as warning-free, and `TEST-01` remains open. Full TypeScript, configured
  formatting, and diff checks pass. Targeted ESLint has zero errors plus three established `MediaSections` test warnings.
  Thirteen exact Chat Settings inventory
  records were reconciled—eight line-only and five stable-ID/symbol/line replacements—with evidence/dispositions intact.
  The scanner suite passes **35/35**; live totals are **1,053 entries / 492 proved (400 coordinated + 92 temporal) / 561
  unproven / 0 structural errors / 0 nested coordinators**. Exact-chat writes drain with late UI fenced; already-admitted
  native/external/system-settings work cannot be recalled. A keyed-source picker in flight drops later picker taps until
  settlement and requires a fresh tap; a hung picker blocks those actions until settlement or owner unmount. Token-specific
  release ownership has source-audit evidence only because serialization makes a concurrent newer token unreachable.
  Sequential self-transacting background, theme, and reset writes remain non-atomic.
  Local preference writes remain best-effort; exact native timing plus the remaining setting/store/coordinator/mode graph
  stay open.

- **2026-08-10 — `PRIV-03BB` removal phase 2X, Settings mode control and account-owned About presentation:** Removed only
  `SettingsScreen`'s Redacted selector, toggle/persistence wiring, search keywords, and About masking. Ordinary settings,
  search, exact installed app identity, current-account server origin/version/macOS/Private API details, and the iMessage
  Account route remain. A captured lease plus monotonic exact-generation retirement removes old server identity and route
  on the same mounted screen, covers initial-stale state, and permits exact fresh-account values. App Lock's biometric
  gate, truthful limitations, and generic locked-delivery copy; explicit error-report consent and sanitized-report copy;
  original-account Disconnect, tracked key rotation, lease-bearing Contacts sync, and Storage & File Privacy remain.
  Retained account-A consent confirmation is inert and fresh-account consent remains positive. Direct arithmetic is
  **28-4+2=26**; the focused route suite passes **1 suite / 26 tests** warning-free. The measured full gate moves from the
  phase-2W **4,246-test** checkpoint to **396 suites / 4,244 tests**, zero snapshots, passing under `--silent` in
  **57.637s**; it is not described as warning-free, and `TEST-01` remains open. Full TypeScript, targeted ESLint,
  configured formatting, and diff checks pass. The two existing Settings inventory entries keep stable IDs and metadata
  with line-only remaps **142→150** (`forget`) and **167→175** (`rotateDatabaseKey`); scanner **35/35** and live totals
  remain **1,053 entries / 492 proved (400 coordinated + 92 temporal) / 561 unproven / 0 structural errors / 0 nested
  coordinators**. The unleased process-wide queued feature-store consent tail remains a separate account-ownership gap;
  arbitrary same-account route-unmount callbacks and already-admitted Disconnect/contact/rekey/native work cannot be
  recalled. The remaining store/coordinator/mode graph stays open.

- **2026-08-10 — `PRIV-03BC` removal phase 2Y, root mode-coordinator retirement:** Removed only the root layout's
  Redacted store subscription, notification-privacy coordinator, and obsolete rollback/failure-dialog wiring. The mount
  effect admits foreground boot without repeating it on ordinary rerender; fail-closed loading/App Lock, cold/warm unlock,
  exact-run retry, degraded issue toasts, and
  connected notification maintenance remain. Maintenance is admitted only for connected-ready state and once per exact
  run; loading/locked/setup/failed states do nothing, a rejection is securely logged without UI failure or same-run retry,
  and a fresh run retries. Fresh same-run snapshots mutation-pin that guard. The direct suite stays at **12/12 tests**—the
  removed wiring had no behavioral rows—and four boot/lock/notification companions yield **5 suites / 106 tests**
  warning-free. The measured full gate remains **396 suites / 4,244 tests**, zero snapshots, passing under `--silent` in
  **58.004s**; it is not described as warning-free, and `TEST-01` remains open. Full TypeScript, targeted ESLint,
  configured formatting, and diff checks pass. The `startForegroundBoot` inventory record adopts its exact current
  callback stable ID/symbol/line **74**, while `completeUnlock` retains its stable ID with line **156→120**; metadata and
  unproven dispositions remain. Scanner **35/35** and live totals remain **1,053 entries / 492 proved (400 coordinated +
  92 temporal) / 561 unproven / 0 structural errors / 0 nested coordinators**. Admitted notification maintenance and exact
  process/StrictMode/native timing cannot be recalled or device-proved here; bootstrap/realtime-control/store/notification-
  preview/coordinator and the remaining mode graph stay open.

- **2026-08-10 — `PRIV-03BD` removal phase 2Z, dead notification-privacy coordinator deletion:** Deleted the uncalled
  `privacyModeCoordinator` module and its four-case direct suite after a complete production/test/config scan proved zero
  remaining caller or symbol residue. Root foreground boot, connected per-run notification maintenance, App Lock/generic
  locked delivery, `notifeeService`, and the headless `notificationPrivacyGate` remain unchanged. The preserved gate passes
  **6 suites / 111 tests** warning-free. Removing exactly one obsolete suite/four tests moves the measured full gate from
  phase 2Y's **396 suites / 4,244 tests** to **395 suites / 4,240 tests**, zero snapshots, passing under `--silent` in
  **57.506s**; it is not described as warning-free, and `TEST-01` remains open. Full TypeScript, targeted ESLint,
  configured formatting, and diff checks pass. Both deleted files were pre-existing untracked worktree files, so Git
  records no deletion and cannot restore their contents from HEAD. No DB-write finding or inventory entry changed; scanner
  **35/35** and live totals remain **1,053 entries / 492 proved (400 coordinated + 92 temporal) / 561 unproven / 0
  structural errors / 0 nested coordinators**. The deleted coordinator has zero residue; bootstrap/realtime-control/store/
  notification-preview/headless-gate/Notifee branches and the remaining mode graph stay open.

- **2026-08-10 — `PRIV-03BE` removal phase 2AA, bootstrap preview-seed removal:** Removed only bootstrap's
  `notificationPreviewState` import/helper and the three mode-preview seed calls from foreground activation,
  `hydrateSession`, and Connect. The guarded hydration registry still finishes critical Feature/Sync settings before
  delivery admission; exact durable-session/vault/DB checks, original-account lease, cache recovery, session publication,
  sync/realtime startup, and forget ordering remain. The legacy Redacted store remains in the hydration registry and the
  realtime-control/notification-preview/headless-gate/Notifee graph remained live at that checkpoint. Deleting one pure
  mode-seed test moves the direct suite from **84 to 83 tests**; unchanged foreground-boot and hydration-registry
  companions yield **3 suites /
  97 tests** warning-free. The measured full gate remains **395 suites** and moves from phase 2Z's **4,240 tests** to
  **4,239 tests**, zero snapshots, passing under `--silent` in **59.867s**; it is not described as warning-free, and
  `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting, and diff checks pass. Exactly 21
  existing bootstrap inventory records retain their stable IDs and metadata with line-only remaps; scanner **35/35** and
  live totals remain **1,053 entries / 492 proved (400 coordinated + 92 temporal) / 561 unproven / 0 structural errors /
  0 nested coordinators**.

- **2026-08-10 — `PRIV-03BF` removal phase 2AB, realtime notifier mode decoupling:** Removed only realtime-control's
  Redacted store hydration, notification-preview seeding, and mode-specific presentation gate. Durable message delivery
  still hydrates fail-closed feature consent after admission and retries when settings remain unavailable; FaceTime,
  message-notification enablement, unknown-sender filtering/fail-open lookup rejection, and stale delivery-context checks
  remain. The real notifier companion remains DB-first, and App Lock still rejects private intake before DB access while
  Notifee preserves generic locked delivery. Skeptical review also fixed a broad catch that could immediately make a
  second durable native-notification attempt after a known-sender post rejected: the exact error now propagates after one
  attempt to the queue retry owner. Ten mutation-sensitive notifier cases move the startup suite from **13 to 23 tests**;
  with the 30-case server-URL/App-Lock and 26-case real notification-intent companions, the focused gate passes **3 suites
  / 79 tests** warning-free. The measured full gate keeps **395 suites** and moves from phase 2AA's **4,239 tests** to
  **4,249 tests**, zero snapshots, passing under `--silent` in **80.693s**; it is not described as warning-free, and
  `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting, and diff checks pass. Sixteen existing
  realtime-control inventory records retain stable IDs and all review metadata with line-only remaps; scanner **35/35**
  and live totals remain **1,053 entries / 492 proved (400 coordinated + 92 temporal) / 561 unproven / 0 structural errors
  / 0 nested coordinators**. At that checkpoint, the Redacted store/hydration registry, notification-preview state,
  headless privacy gate, Notifee mode branches/tests, and other runtime consumers remained open.

- **2026-08-10 — `PRIV-03BG` removal phase 2AC, uncalled headless mode-gate deletion:** Permanently deleted the
  uncalled `notificationPrivacyGate` production module and its five-case direct suite after phase 2AB removed the final
  production purpose. Current production/test/config scans find zero filename or symbol residue. The preserved root boot
  and connected maintenance, App Lock pre-DB/generic locked delivery, Notifee, realtime feature-consent/durable-retry/
  FaceTime/unknown-sender/stale-context behavior, and real DB-first notification derivation pass **8 suites / 185 tests**
  warning-free. Removing exactly one obsolete suite/five tests moves the measured full gate from phase 2AB's **395 suites /
  4,249 tests** to **394 suites / 4,244 tests**, zero snapshots, passing under `--silent` in **56.361s**; it is not
  described as warning-free, and `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting, and diff
  checks pass. Both deleted files were untracked and absent from HEAD, so Git records no deletion and cannot reconstruct or
  restore them; file absence, zero references, and preserved behavior are the recoverable evidence. No inventory entry
  changed: scanner **35/35** and live totals remain **1,053 entries / 492 proved (400 coordinated + 92 temporal) / 561
  unproven / 0 structural errors / 0 nested coordinators**. The Redacted store/hydration registry, notification-preview
  state, Notifee mode branches/tests, and other runtime consumers remain open.

- **2026-08-10 — `PRIV-03BH` removal phase 2AD, notification presentation-mode removal:** Removed Notifee's
  mode-specific preview branches and permanently deleted the untracked `notificationPreviewState` module. Ordinary
  message, alias, FaceTime, test, and reminder notifications now retain detailed presentation by owner decision while
  Android controls lock-screen visibility. App Lock still posts a fixed generic new-delivery notice and does not
  retroactively scrub already-posted Android notifications or reminders. Legacy raw payload/channel and route-ID
  migration, missing-reminder repair, unsafe reminder-ID refusal, the serialized native-operation queue,
  original-account/DB commit guards, exact FaceTime route deletion, and failure-tolerant teardown remain mutation-pinned.
  Removing 15 obsolete mode cases and adding 10 boundary cases moves the direct Notifee suite from **69 to 64 tests**;
  the focused gate passes **7 suites / 148 tests** warning-free. The measured full gate moves from phase 2AC's **394
  suites / 4,244 tests** to **394 suites / 4,239 tests**, zero snapshots, passing under `--silent` in **83.435s**; this
  is not warning-free full-run evidence, and `TEST-01` remains open. Full TypeScript, targeted ESLint, configured
  formatting, and diff checks pass. Four obsolete mode-only inventory edges were removed; four retained entries were
  rekeyed and sixteen received line-only remaps with their evidence and dispositions unchanged. Scanner **35/35** and
  live totals are **1,049 entries / 492 proved (400 coordinated + 92 temporal) / 557 unproven / 0 structural errors / 0
  nested coordinators**. The deleted preview-state file was untracked and absent from HEAD, so Git cannot reconstruct it.
  The Redacted store/hydration registry and other runtime consumers remain open; stale mode-preview wording remains in
  `src/services/notifications/intents.ts` and `test/realtime/notificationIntent.test.ts` for a later cleanup slice.

- **2026-08-10 — `PRIV-03BI` removal phase 2AE, Redacted hydration-registration removal:** Removed the Redacted
  store from the shared hydration registry and critical-readiness admission. The exact registry is now Theme, Feature,
  and Sync; Feature and Sync remain critical before account activation, while Theme's real DB-unavailable path opens
  first paint on the safe default and is retried at Home. One shared ownership guard reaches all three stores, an
  already-retired run starts no read, unexpected registered-store rejection propagates to the existing fail-closed boot
  boundary, and Home invokes each store once inside its original-account teardown barrier. The captured Home guard stays
  false across an A→paused→B cycle. Adding one rejection-propagation case moves the focused gate to **5 suites / 128
  tests** warning-free; the measured full gate moves from phase 2AD's **394 suites / 4,239 tests** to **394 suites / 4,240
  tests**, zero snapshots, passing under `--silent` in **56.506s**. This is not warning-free full-run evidence, and
  `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting, and diff checks pass. Scanner **35/35**
  and live totals remain **1,049 entries / 492 proved (400 coordinated + 92 temporal) / 557 unproven / 0 structural errors
  / 0 nested coordinators** with no inventory change. The unused `redactedModeStore`, its focused/reset/commit-guard test
  graph, the persisted `privacy.redactedMode` backup allowlist/fixtures, and stale intent wording remain for later removal.

- **2026-08-10 — `PRIV-03BJ` removal phases 2AF/2AG, obsolete test-leg and tracked-store deletion:** Phase 2AF
  removed only obsolete Redacted setup/durable-preference assertions from MessageList and session-scoped-state tests;
  ordinary list behavior, account-leased retry/discard, every account-owned reset, async disowning, and durable
  Feature/Sync/Theme/App Lock/share survival remain. Its direct **2-suite / 20-test** and broader **9-suite / 131-test**
  gates pass warning-free; targeted ESLint reports zero errors and six established MessageList mock warnings. Phase 2AG
  deleted the tracked, runtime-uncalled `redactedModeStore`; its owned suites move from **9−3=6** and **4−2=2** tests,
  while the preserved Sync/Feature/Theme/registry/Home/boot gate passes **7 suites / 89 tests** warning-free. Removing the
  five obsolete cases moves the measured full gate from phase 2AE's **394 suites / 4,240 tests** to **394 suites / 4,235
  tests**, zero snapshots, passing under `--silent` in **59.467s**; this is not warning-free full-run evidence, and
  `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting, architecture, and diff checks pass.
  The tracked source deletion is recoverable from HEAD. Its one unproven `kvSet` inventory edge was removed; scanner
  **35/35** and live totals are **1,048 entries / 492 proved (400 coordinated + 92 temporal) / 556 unproven / 0 structural
  errors / 0 nested coordinators**. The ignored persisted `privacy.redactedMode` row, backup allowlist/compatibility and
  migration fixtures, dead `FindMyMapHidden`, and stale Redacted comments remain explicitly open.

- **2026-08-10 — `PRIV-03BK` removal phases 2AH/2AI, backup compatibility and persisted-key purge:** Phase 2AH
  removes `privacy.redactedMode` from the backup allowlist, so new exports omit the legacy row and older encrypted
  backups cannot restore it while supported settings and existing restore ownership remain intact. Its focused gate
  passes **3 suites / 61 tests** warning-free. Phase 2AI appends exact-key migration
  `0037_purge_legacy_redacted_mode_setting`. The initial source/test-only candidate correctly failed the migration guard;
  the scope expanded to record the required `0037` allocation with schema/cache N/A evidence. The upgrade test proves
  migration-record failure rolls the already-executed delete back, preserves unrelated and same-prefix KV rows, and
  permits a successful, idempotent retry. Its focused gate passes **5 suites / 9 tests** warning-free, and the guard
  passes **37 sequential migrations / 5 tests**. The measured full gate moves from phase 2AG's historical **394 suites /
  4,235 tests** to **395 suites / 4,236 tests**, zero snapshots, passing under `--silent` in **82.117s**; this is not
  warning-free full-run evidence, and `TEST-01` remains open. Full TypeScript, targeted ESLint, configured formatting,
  migration, architecture, and diff checks pass. The exact startup delete adds one reviewed temporal inventory edge;
  scanner **35/35** and live totals are **1,049 entries / 493 proved (400 coordinated + 93 temporal) / 556 unproven / 0
  structural errors / 0 nested coordinators**. Dead mode-only helpers/test artifacts, `FindMyMapHidden`, and stale
  notification/state/Find My comments remain open.

- **2026-08-10 — `PRIV-03BL` removal phases 2AJ–2AT and final `DEC-10` closure:** The former privacy utility was
  reduced to finite-coordinate validation and then renamed, with its test, to `src/utils/location.ts` and
  `test/utils/locationPoint.test.ts` without a compatibility shim;
  obsolete masking APIs/tests, the uncalled `FindMyMapHidden`, and Avatar/GroupAvatar seed APIs/tests were removed while
  ordinary location, map, avatar, accessibility, URI, and layout behavior stayed covered. Stale source/test/`AGENTS.md`
  contracts were corrected, including bootstrap's settings-store wording. The NUL-bearing
  `test/components/redaction.test.tsx` filename remains deliberately untouched and documented; its eight tests exercise
  ordinary behavior only. Removing 13 obsolete coordinate/masking/seed cases moves the historical `PRIV-03BK` checkpoint
  from **395 suites / 4,236 tests** to **395 suites / 4,223 tests**, with the suite count unchanged. No configurable
  Redacted Mode state, UI, runtime API, import/export, or branch remains, and no
  future support is planned. Only exact legacy-key migration/backup negatives and independent secure log/error redaction
  remain. Normal notifications are detailed, while App Lock's fixed generic delivery, Pairing QR's explicit reveal and
  lifecycle revocation, and account/source guards remain intact. The focused final security/retirement gate passes
  **11 suites / 211 tests** warning-free. Two pinned `--silent` full runs pass **395 suites / 4,223 tests / 0 snapshots**
  in **206.655s** and **189.899s**; these are not warning-free full-run claims, and `TEST-01` remains open. Architecture
  passes **30/30 tests** across **65** platform-free core files, migration allocation passes **37 sequential migrations /
  5 guard tests**, and scanner **35/35** reports **1,049 entries / 493 proved (400 coordinated + 93 temporal) / 556
  unproven / 0 structural errors / 0 nested coordinators**.

- **2026-08-10 — `DB-02A-DEVSEED` DEV fixture read-marker containment:** Replaced the reachable DEV seed's raw
  `chats` read-marker update with an awaited call to the public `setLastReadMessageGuid` transaction owner; the helper
  also clears `markedUnreadAt`, matching the fixture's canonical `read: true` state. The mutation-sensitive real-DB
  rolling-neighbour test partial-mocks the earlier handle/chat/message upserts and proves that, while a neighbour holds
  the queue, exactly five message upserts have run, the seed remains pending, and the marker is still exact
  `phantom` / `777`; after that neighbour rolls back, all ten message upserts complete and the marker is exact
  `c-work-m` / `null`. The focused gate passes **4 suites / 52 tests** warning-free. The pinned full gate passes
  **396 suites / 4,224 tests / 0 snapshots** under `--silent` in **63.784s**; this is a functional pass, not a
  warning-free full-run claim, and `TEST-01` remains open. Full TypeScript, targeted ESLint, configured Prettier,
  architecture (**30 tests / 65 core files**), scanner **35/35**, and diff checks pass. Inventory reconciliation
  replaces the old raw Drizzle stable ID with the new unresolved `setLastReadMessageGuid` call and applies 20 exact
  line remaps. Totals remain **1,049 entries / 493 proved (400 coordinated + 93 temporal) / 556 unproven / 0 structural
  errors / 0 nested coordinators**: the runtime bystander defect is fixed and exercised, but the scanner does not yet
  infer the public helper's transitive ownership at this caller, so its disposition remains honestly `unproven` and
  parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-11 — `DB-02A-CONSENT` error-report consent ownership:** Settings now captures the exact database and
  original account lease before the serialized consent tail. The store owns one explicit `withDbTransaction` using
  `kvSetWithinTransaction`, with choice-generation and lease checks at admission, `BEGIN`, `COMMIT`, and publication;
  stale/superseded work resolves quietly, while a current failure restores the prior choice, rejects to fixed UI copy,
  and permits retry. Device-global carryover and legacy `1` migration policy remain `PRIV-02` work. The mutation-sensitive
  related gate passes **5 suites / 92 tests** warning-free. A first full attempt caught a stale service-test caller as
  **TS2554** after **395 suites passed / 1 compile failure / 4,206 tests**; supplying the required lease/database context
  fixed it. The final pinned full gate passes **396 suites / 4,229 tests / 0 snapshots** under `--silent` in **69.125s**;
  this is not a warning-free claim, and `TEST-01` remains open. Full TypeScript, ESLint with zero allowed warnings,
  configured formatting, architecture (**30 tests / 65 core files**), scanner **35/35**, and diff checks pass. The old
  unresolved consent inventory ID was replaced by three coordinated findings; three unrelated Feature-store entries
  were rekeyed and Settings lines **150→151** and **175→176** were remapped. Live totals are **1,051 entries / 496
  proved (403 coordinated + 93 temporal) / 555 unproven / 0 structural errors / 0 nested coordinators**. Parent
  `DB-02A` remains **IN_PROGRESS**.

- **2026-08-11 — `DB-02A-DUPMARK` all-duplicate incremental marker proof:** No production code changed. Two
  mutation-sensitive sync tests prove that the duplicate-only cursor-marker update claims its own queue slot, waits
  behind a rolling-back neighbour, durably advances only afterward, and rejects an original-account retirement that
  occurs after the post-fetch check and queue claim but before `BEGIN`. The direct sync suite moves **21→23 tests**;
  focused **3 suites / 38 tests** and broader **5 suites / 58 tests** pass warning-free. The first pinned full attempt
  reported **395 passing / 1 failing suite** and **4,229 passing / 2 failing tests of 4,231** because cross-Jest-realm
  native `SqliteError` objects failed `.toThrow` identity checks even though both consent triggers rejected and rolled
  back. Exactly those two matchers now compare the structural `CONSENT_WRITE_RAW_CANARY` message; a forced Sync-first
  `--no-cache` gate passes **2 suites / 55 tests**. The final full gate passes **396 suites / 4,231 tests / 0 snapshots**
  under `--silent` in **60.129s**; it is not a warning-free claim, and `TEST-01` remains open. Scanner **35/35**
  classifies only the line-746 transaction opener, callback edge, and inner marker call; the raw transaction-neutral
  `setSyncMarker` definition remains unproven. Live totals are **1,051 entries / 499 proved (406 coordinated + 93
  temporal) / 552 unproven / 0 structural errors / 0 nested coordinators**. Parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-11 — `DB-02A-INCOMING-ENQUEUE` public intake ownership proof:** No production code changed; frozen
  `incomingEvents.ts` is SHA-256 `175793b29d4d1b27e838e0174e630935cd82ace4a694ae714b503aa4e20c6f62`, and its
  direct test is `4514750c6e3383b2a894d69ed4c8d0d1ebec7c27d4fb4640a566eded1059a728`. Three
  mutation-sensitive real-DB cases prove that public intake waits behind a rolling-back neighbour, maintenance and
  insertion share one rollback boundary, and delayed driver maintenance is awaited before insertion or publication.
  The exact gate passes **2 suites / 35 tests** warning-free, and the broader gate passes **4 suites / 70 tests** twice
  in isolation. A first concurrently launched broader run exited **139**; it is retained as a failed resource-contended
  attempt, not behavior evidence. The pinned full gate passes **396 suites / 4,234 tests / 0 snapshots** under `--silent`
  in **59.003s**; it is not a warning-free full-run claim, and `TEST-01` remains open. Scanner **35/35** classifies only
  `src/db/repositories/incomingEvents.ts#enqueueIncomingEvent:mutator-call:c0d9b9793987`,
  `src/db/repositories/incomingEvents.ts#enqueueIncomingEvent:mutator-call:c42331949358`,
  `src/db/repositories/incomingEvents.ts#enqueueIncomingEvent.<callback:0dc6976e8d>:mutator-call:6ac9cadde422`, and
  `src/db/repositories/incomingEvents.ts#enqueueIncomingEvent.<callback:0dc6976e8d>:mutator-call:b1927935b4b6` as
  coordinated. Live totals are **1,051 entries / 503 proved (410 coordinated + 93 temporal) / 548 unproven / 0
  structural errors / 0 nested coordinators**. Parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-11 — `DB-02A-SYNC-SETTING` device-global sync-cap ownership:** Only `syncSettingsStore` changed.
  Its optimistic, best-effort device-global preference now captures one database synchronously and owns an awaited
  `withDbTransaction`/`kvSetWithinTransaction` boundary; no account guard or Settings-route change was introduced.
  Frozen source/test SHA-256 values are `bab140d9771e58683b1dbe67f71fbd6c542d2c72cc130259e4cfbb5532a93ffe` and
  `c34a985e63034b5e8d72cf5a8c178b27a7f8ef75bf2e25110df7d370bab2b53c`. Real-DB tests pin rolling-neighbour
  isolation, invocation-time A-database capture across a mocked B pointer, optimistic pending state, forced rollback,
  retained session value, and retry. Exact **3-suite / 18-test** and broader **7-suite / 132-test** gates pass
  warning-free. The pinned full gate passes **396 suites / 4,236 tests / 0 snapshots** under `--silent` in **64.451s**;
  this is not a warning-free claim, and `TEST-01` remains open. Scanner **35/35** replaces `1506af5c53f5` with
  `b22e0563db36`, `c7fd9d1633dc`, and `8b9c82a51e41`; live totals are **1,053 entries / 506 proved (413
  coordinated + 93 temporal) / 547 unproven / 0 structural errors / 0 nested coordinators**. Parent `DB-02A` remains
  **IN_PROGRESS**.

- **2026-08-11 — `DB-02A-DELETION-CURSOR` post-tombstone cursor ownership proof:** No production code changed;
  frozen source/test SHA-256 values are `fde2ade26d5f0c85c9d7722913de5d13785b8127123c6205f7643c73cef91a01` and
  `0eb4e1cbf99089ed1fade2750343188a3ad1129cc007178bbf1ddfdf37278097`. Mutation-sensitive rows prove
  rolling-neighbour/current commit, queued account-revocation rejection, cursor-KV failure rollback/retry, and the
  delayed exact inner-KV lifetime; the spy wait is bounded to 20 event-loop turns with unconditional release/restore.
  The direct **1-suite / 23-test** and related **4-suite / 61-test** gates pass warning-free, with the latter repeated.
  The pinned full gate passes **396 suites / 4,240 tests / 0 snapshots** under `--silent` in **62.792s**; this is not a
  warning-free claim, and `TEST-01` remains open. TypeScript, lint, Prettier, diff, and scanner **35/35** checks pass.
  Exactly `src/services/sync/engine.ts#syncDeletedMessages:mutator-call:268dc408452b`,
  `src/services/sync/engine.ts#syncDeletedMessages:mutator-call:55b8cf67e19e`, and
  `src/services/sync/engine.ts#syncDeletedMessages.<callback:a3920be9f6>:mutator-call:2849306a1437` are coordinated;
  the line-612 `markMessageDeleted` call remains unproven. Live totals are **1,053 entries / 509 proved (416
  coordinated + 93 temporal) / 544 unproven / 0 structural errors / 0 nested coordinators**. Parent `DB-02A` remains
  **IN_PROGRESS**.

- **2026-08-11 — `DB-02A-INCOMING-TERMINAL` terminal settlement ownership proof:** No production code changed;
  source/test SHA-256 values are `175793b29d4d1b27e838e0174e630935cd82ace4a694ae714b503aa4e20c6f62` and
  `a2ecad7ec41c5f8d50b1c410eda254ee717b80830b7600c32da6894d76270af0`. Twelve real-DB cases cover
  current/revoked rolling neighbours for all three helpers, terminal trim rollback plus same-claim retry, and delayed
  async trim lifetime with bounded cleanup; transient and terminal `failIncomingEvent` branches remain distinct. The
  first direct run passed **35/38** until the harness matched Drizzle's native canary at exact `cause.message`; final
  direct **1/38** and corrected broad **4/75** gates pass warning-free. The first broad command's nonexistent realtime
  path honestly ran only **3/58**. Scanner **35/35** classifies exactly the three opener/callback/trim edges under each
  of `completeIncomingEvent`, `poisonIncomingEvent`, and `failIncomingEvent`. A context-generic inventory patch briefly
  touched an unrelated attachment opener; the exact-ID audit restored it before validation. Totals are **1,053 entries
  / 518 proved (425 coordinated + 93 temporal) / 535 unproven / 0 structural errors / 0 nested coordinators**. The first
  full attempt passed this terminal suite but reported **395 passing / 1 failing suite** and **4,251 passing / 1 failing
  test of 4,252** due the unrelated inbox RAF harness recorded below. Parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-11 — `TEST-01-INBOX-RAF` deterministic inbox return-scroll harness:** No production code changed;
  `ConversationListScreen` remains SHA-256 `a01842b00b983d692c7f14c455d99ec176465a45510c9f5a7864270b65f27629`,
  while `test/components/conversations/conversationListScreen.test.tsx` is
  `9c2210bb49dd740f1f8415b6452e9a0d69b259f7f6e8d4a3f0fa2e558e78d1fc`. The first full run failed line 792
  (**expected 1 scroll, received 2**) after **61.571s**; filtered stress reproduced **3 failures in 8 runs**. The RN
  Jest RAF shim is a zero-delay timer that could fire during awaited `act()`, so the test now captures frames, checks
  the immediate scroll, explicitly flushes the corrective frame, and proves drag suppression. Post-fix evidence is
  **8/8** filtered repetitions, direct **32/32**, and companion **2 suites / 36 tests**; TypeScript, Prettier, and diff
  checks pass, while targeted lint reports **0 errors and 11 established Jest-mock warnings**. The final full gate
  passes **396 suites / 4,252 tests / 0 snapshots** under `--silent` in **61.716s**. This is not a warning-free claim:
  child `TEST-01-INBOX-RAF` is **DONE**, while primary `TEST-01` remains open for Account/Server Health TanStack Query
  `act(...)` warnings and the UI coverage threshold.

- **2026-08-11 — `DB-02A-INCOMING-CLAIM` public incoming claim ownership proof:** No production code changed;
  source/test SHA-256 values are `175793b29d4d1b27e838e0174e630935cd82ace4a694ae714b503aa4e20c6f62` and
  `2994dd6e03aae9253694705d81062eb8dfe313b5c586715f3b8fe607f0790600`. Current/revoked
  rolling-neighbour rows prove queued ownership and fresh retry; an exact claim-UPDATE trigger proves atomic
  maintenance, trim, claim rollback, and retry; and a sequential delayed-driver row proves both the semantic
  terminalization write and exact claim update remain awaited with bounded cleanup. The first direct run passed
  **41/42** warning-free because it expected stale `terminalAt` **0** rather than the seeded **499999**; the sole
  correction names and asserts the exact `staleTerminalAt`. Final direct **1/42** and broad **4/79** gates pass
  warning-free. TypeScript, lint, Prettier, and diff checks pass. The pinned full gate passes **396 suites / 4,256
  tests / 0 snapshots** under `--silent` in **61.501s**; this is not a warning-free claim, and `TEST-01` remains open.
  Scanner **35/35** coordinates exactly `be1a887c88a0`, `4b006e047c1e`, and `563137048706` under
  `claimIncomingEvents`; raw `2b18a1aa5bcb` and the caller/private/maintenance/DEV exclusions remain unchanged. Live
  totals are **1,053 entries / 521 proved (428 coordinated + 93 temporal) / 532 unproven / 0 structural errors / 0
  nested coordinators**. Child `DB-02A-INCOMING-CLAIM` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-11 — `DB-02A-MANUAL-RETRY` post-lock manual-send lease:** A concrete duplicate-send defect captured a
  numeric `Date.now()` before the global mutex; waiting at least 120 seconds could commit an expired manual lease and
  let the automatic drain overlap. `claimFailedOutgoingForRetry` now accepts a clock callback, reads it once as the
  owned callback begins, and production passes `Date.now` with the existing account guard. Frozen outgoing/send/test
  SHA-256 values are `3badf27232663ff67975102609cb107335d11483774e0e3cf284790be9c6c6e5`,
  `13adf7fa10c550d026ecbe26afda8bcc2d88713ab82dbf5e70f612cd7f2984d5`, and
  `7b4de47eda3894c864dac2038eef2bfe0306e3e6957d04638da18c94bdb6c8f0`. The unchanged-test gate first had **3
  passing suites / 1 TS2345 compile-failing suite** with **46 runnable tests passing** at the two numeric test callers.
  The first saved direct gate passed **21/21** without behavioral correction; final direct **1/21** and broad **4/67**
  pass warning-free after mechanical Prettier. The matrix proves post-lock T0→T1 lease timing and the real automatic
  claimant boundary, queued revocation/fresh retry, exact rearm rollback/retry, and delayed final-run lifetime with
  bounded cleanup. Statics pass. The full `--silent` gate passes **396 suites / 4,260 tests / 0 snapshots** in
  **246.999s**; it remained active without timeout and is not a warning-free claim. Scanner **35/35** rekeys the two
  coordinated owner entries to `325097db272e` and `a706d4ac651f`; service caller `7d5ba2e65922` remains unproven,
  47 line fields move by one, and SQL IDs `581ca0d744d7` / `cdb4aa217454` remain coordinated. Live totals are **1,053
  entries / 523 proved (430 coordinated + 93 temporal) / 530 unproven / 0 structural errors / 0 nested coordinators**.
  Child `DB-02A-MANUAL-RETRY` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-NO-GUID` no-GUID outcome ownership proof:** No production code changed; frozen
  outgoing/test SHA-256 values are `3badf27232663ff67975102609cb107335d11483774e0e3cf284790be9c6c6e5` and
  `b14f8c8617ab0404c6863fde0378f06432a908bb5e83e91f8fde1f5353721d54`. The first saved direct matrix passed
  **36/36** without behavioral correction; final direct **1/36** and exact related **6/92** pass warning-free after
  mechanical Prettier, with TypeScript/lint/Prettier/diff green. The matrix covers current NULL-state queue isolation,
  queued revocation/fresh retry, promoted UPDATE+exact DELETE rollback/retry, and the orphan branch's second delete via
  a typed exact-table `.where(...).then` gate with bounded cleanup; sticky-error, orphan, and tombstone branches remain.
  The full `--silent` gate passes **396 suites / 4,264 tests / 0 snapshots** in **62.247s**, not a warning-free claim.
  Scanner **35/35** coordinates only `21d3f3a56e51` and `56ce496904c4`; raw `bd931e16d6fe`, `4cd4d05885ce`, and
  `4cd4d05885ce:2` stay coordinated, while callers `9593aa17c736` / `7d4ffb0ff6ea` remain unproven. Live totals are
  **1,053 entries / 525 proved (432 coordinated + 93 temporal) / 528 unproven / 0 structural errors / 0 nested
  coordinators**. Non-unique/unindexed `outgoing_queue.temp_guid` remains a schema residual, so no absolute row bound is
  claimed. Child `DB-02A-NO-GUID` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-ATTACHMENT-INSERT` atomic insert and monotonic inbox date:** A source audit found that
  `insertOutgoingAttachment` unconditionally replaced `latest_message_date` with `args.now`, allowing an older queued
  send to move a newer chat backward. The one-file fix changes source prefix `b19867e2` to SHA-256
  `70908bf68d68c3e61b3e53b227caac652a119c3f5c046f6ed28cde6c82a8c1bb`, takes the NULL-safe maximum in the
  existing transaction, and leaves the message's own `dateCreated` unchanged. Frozen test SHA-256 is
  `1ade99575ffe746b6a2fcb8852a3ee29aa42e9e514b3f937ff684e6f9dc447c5`. The first saved direct matrix passed
  **18/18**; skeptical review found a surviving no-`COALESCE` mutation because all dates were non-NULL, and one
  in-place NULL-baseline correction closed it. Final direct **1/18** and related **5/54** pass warning-free. The three
  cases cover a committing newer-date neighbour with exact four-table state, final chat-update rollback/retry, and
  sequential exact-table message→attachment→queue→chat driver lifetimes with bounded unconditional cleanup. Statics
  pass. The full `--silent` gate passes **396 suites / 4,267 tests / 0 snapshots** in **238.705s**, not a warning-free
  claim. Scanner **35/35** rekeys opener `d3ae4f593073`→`4dd6251e013d`, callback `5dce26a2d13d`→`dd5c38e6102a`,
  and chat update `d76c724fb6cf`→`b3bfd51dc502`; three insert IDs stay stable and four downstream records receive
  line-only remaps. Live totals are **1,053 entries / 527 proved (434 coordinated + 93 temporal) / 526 unproven / 0
  structural errors / 0 nested coordinators / 0 membership errors**. Foreground/DEV exact-A capture plus admitted-work
  drain-before-wipe means no narrow A→B defect; long-transfer drain latency, logical string/payload byte lengths that
  lack schema caps, adjacent text/contact timestamp updates, and unresolved caller edges remain. Child
  `DB-02A-ATTACHMENT-INSERT` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-OUTGOING-DATES` monotonic text/contact chat dates:** A source audit confirmed that the
  optimistic text and contact writers shared the attachment path's inbox-order regression: after waiting behind newer
  committed work, each could overwrite `latest_message_date` with an older captured `args.now`. The one-file fix
  changes `outgoing.ts` SHA-256 `3badf27232663ff67975102609cb107335d11483774e0e3cf284790be9c6c6e5`→
  `209a17db65df75a0719e3af713d4c69a53acdd96ce763ca84d80ad2fc8f9096e`, applies the NULL-safe maximum at both
  projections, and leaves message dates/APIs/callers/transaction ownership unchanged. Frozen `outgoingBranches`
  SHA-256 is `f63f6a81bef6267c72dc989c518dfadf0b7a412895794db53e5b15ed16a72e65`. Its first saved expansion passed
  **41/41** without behavioral correction; final direct **1/41** and related **6/92** pass warning-free after
  mechanical Prettier. The five cases cover text/contact NULL, forward, and committing-newer-neighbour behavior;
  exact final-chat failure rollback/retry; and a contact-only queue→message→chat delayed-driver lifetime with bounded
  cleanup. The full `--silent` gate passes **396 suites / 4,272 tests / 0 snapshots** in **232.787s**, not a
  warning-free claim. Scanner **35/35** replaces text update `299c124b87a4`→`7d8ea8995411` as still unproven,
  coordinates contact opener `73e7d6d7db86`→`9007b0c2c63b` and callback `c70f215977f1`→`92c88f78cf3d`, preserves
  coordinated update `b288290fa098`→`531c582192c5`, and applies **63** line-only remaps. The first combined inventory
  patch rejected atomically with no partial change; split exact-ID batches succeeded. Live totals are **1,053 entries /
  529 proved (436 coordinated + 93 temporal) / 524 unproven / 0 structural errors / 0 nested coordinators / 0
  membership errors**. Caller edges, the exported transaction-only text primitive, long drain latency, and uncapped
  payload strings/contact arrays remain explicit residuals. Child `DB-02A-OUTGOING-DATES` is **DONE**; parent
  `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-INCOMING-CLAIM-CLOCK` post-lock normal incoming lease:** The normal production claim path
  sampled `now` before waiting for the process-wide mutex, so a wait of at least 120 seconds could commit an expired
  lease and permit duplicate durable-event processing or side effects. `incomingEvents.ts` SHA-256 changes
  `175793b29d4d1b27e838e0174e630935cd82ace4a694ae714b503aa4e20c6f62`→
  `da3a8a3ccefd390f220427dede1acb2785ea7fc6bbc01d821b4db86f18a3a208`; `incomingEventDrain.ts` prefix changes
  `0db9e3c`→`7631bd53`. The claim now invokes a supplied clock once as its transaction callback begins and the drain
  passes `this.now`; token/limit prevalidation remains, while the DEV atomic helper is untouched follow-up work. The
  unchanged first gate reported `TS2353` at `incomingEvents.test.ts:125` while the other three suites passed **37
  tests**. All **31** old normal test callers were migrated. Frozen test SHA-256 is
  `da082366e9e572bb31bb3b01f30862cccb66a7d6cc42576643576abf084aa6e4`; its first saved direct **43/43**
  passed without behavioral correction, followed only by targeted Prettier. Final direct **1/43**, exact **2/54**,
  and broad **3/71** pass warning-free with green statics. The matrix pins queued T0→T1 sampling, full lease and exact
  reclaim boundary, unconditional cleanup, and invalid-limit clock non-invocation. Scanner **35/35** rekeys
  `4b006e047c1e`→`86f06ad89cf5`, `be1a887c88a0`→`cdfba391a5f5`, `563137048706`→`1d2e16d25d67`, and
  `2b18a1aa5bcb`→`2238677decf4` as coordinated; drain `eb422d5557eb`→`45ee0a84041c` remains unproven, and
  **16** line-only remaps leave totals unchanged at **1,053 / 529 proved (436 coordinated + 93 temporal) / 524
  unproven / 0 structural / 0 nested / 0 membership** under the applicable live `--report` gate. `--check`
  intentionally rejects unproven entries. The full `--silent` gate passes **396 suites / 4,273 tests / 0 snapshots**
  in **246.149s**, not a warning-free claim. Child `DB-02A-INCOMING-CLAIM-CLOCK` is **DONE**; parent `DB-02A` remains
  **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-DEV-CLAIM-CLOCK` post-lock DEV atomic lease:** The DEV-only process-death proof helper had
  the same pre-mutex stale-clock risk as normal claiming. Frozen `incomingEvents.ts` and dispatcher SHA-256 values are
  `be0de7f569e2622c918e309120907552a9c489e2c754ab208f07bc870757755e` and
  `ad310194f5a612b9c890a5578206a5c3a8ef512e4c95417744f85fc153e93e15`. Validation still uses the caller's
  pre-queue sample, but prepared data is time-neutral; `clock()` is sampled once as the transaction begins, and fresh
  time controls maintenance, expiry, terminalization, and the exact claim lease. Normal paths are unchanged. With old
  tests, only four `TS2345` missing-clock callers compile-failed while dispatcher/drain passed **28 tests**. The first
  saved test then failed only `TS2304` for a missing existing result-type import; after that import, behavioral direct
  **44/44** passed. Frozen test SHA-256 is
  `df1aac610f1508f5e88102dbf66e9fd37388e6f1bed0e876f3a7b12e4a508f78`; final direct **1/44**, exact **2/61**,
  and broad **3/72** pass warning-free with green statics. Its queued expired-first/live-second T0→T1 row proves fresh
  expiry poison and pruning, full live lease, exclusion through boundary-minus-one, exact-boundary version-2 reclaim,
  and unconditional cleanup. Scanner **35/35** coordinates `652d7f3eeb1f`, `cb87d6e06595`, `f3ff85da8756`, and
  `d2a399dbd4a6`; raw UPDATE `5f3d3d7c5a4e` stays coordinated, dispatcher `098d325c57da` stays unproven, and **28**
  line-only remaps leave live totals at **1,053 / 533 proved (440 coordinated + 93 temporal) / 520 unproven / 0
  structural / 0 nested / 0 membership**. The full `--silent` gate passes **396 suites / 4,274 tests / 0 snapshots**
  in **256.953s**, not a warning-free claim. Child `DB-02A-DEV-CLAIM-CLOCK` is **DONE**; parent `DB-02A` remains
  **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-OUTGOING-SUCCESS` normal acknowledgement owner proof:** Production remains unchanged at
  `outgoing.ts` SHA-256 `209a17db65df75a0719e3af713d4c69a53acdd96ce763ca84d80ad2fc8f9096e`. The pre-edit
  baseline stopped on the actual exact-related count (**6/97**, not stale **6/92**) and corrected the intended
  post-change target to **6/100**. Frozen `outgoingBranches.test.ts` SHA-256 is
  `c00bdf013f7e98a1970e58bccc89a897705796f753201aad1de9deb309b40eb6`; its first saved direct **44/44** passed
  without behavioral correction, followed only by mechanical Prettier. Final direct **1/44** and exact related
  **6/100** pass warning-free with green statics. Current and revoked rolling-neighbour rows pin independent commit,
  guard rejection, unchanged state, slot release, and fresh retry. A combined table-identity delayed final-delete
  gate plus exact trigger proves the helper adopts that lifetime and rolls message/alias/ledger/queue state back
  atomically before the same acknowledgement retries. Scanner **35/35** coordinates only `4093050f0f88` and
  `4184edf8f1d4`; delegation `9593aa17c736` and callers `e5846ec828a7` / `c4f357471236` remain unproven. A corrected
  exact-ID audit passed after an initial read-only parser used the wrong top-level key and failed before evaluation or
  file mutation. Live totals are **1,053 / 535 proved (442 coordinated + 93 temporal) / 518 unproven / 0 structural /
  0 nested / 0 membership**. The full `--silent` gate passes **396 suites / 4,277 tests / 0 snapshots** in **62.578s**
  (Jest printed `estimated 246 s`), not a warning-free claim. Child `DB-02A-OUTGOING-SUCCESS` is **DONE**; parent
  `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-TEMP-TARGET-ACTIONS` temp-target reaction/reply containment:** ChatScreen exposed reaction
  and long-press/swipe reply actions for local-only `temp-*` identities even though the reaction endpoint requires a
  server GUID, replies forward `selectedMessageGuid`, and later promotion/retry does not rewrite dependent target
  references. The central hook now rejects temp live/DEV reactions plus menu/swipe replies; the overlay hides its
  fallback and anchored picker, arbitrary-emoji input, and Reply while retaining Cancel/Remove and local actions;
  and MessageRow omits the right-swipe reply binding/glyph even when a temp row reads `sent`. Frozen source/test
  SHA-256 pairs are `0655b88c4c13ecc5c474d6196a46e82ca178eaff23f6f7f781c70c5d9e58c1ae` /
  `44167d2ec72657ec1d3517a847ffc1fda710217a795b8b2faaf90cf5bc797f7d`,
  `b46def0ac6a015ff60a9fb1d2f4ce6db19976b1d4c8db2c5d0e0501e29ff00cb` /
  `a7d8fef939482b470b21932ef5203fd28ab1fbbc9876774d49de14996b9a473a`, and
  `9ec3aea8217b5b7c82f51dcd453da49309db1f71b540a3665b0f1b48fd282017` /
  `a3e5824935d43d1d4e58a084170cc369ffffdeb109d096a7b36db3442cf6f9db`. Focused gates pass warning-free at
  direct/exact **1/5 + 2/46**, direct/related **1/40 + 4/93**, and direct/related **1/5 + 5/94**. The only first-check
  failures were overlay source/test Prettier layout; both behavioral gates were already green, and formatter-only
  corrections changed no behavior. Full TypeScript, lint, Prettier, and diff checks pass. Scanner **35/35** stays at
  **1,053 / 535 proved (442 coordinated + 93 temporal) / 518 unproven / 0 structural / 0 nested / 0 membership** with
  no inventory edit; reaction IDs `53cbac0fda45` / `93316102c235` remain unproven. The full `--silent` gate passes
  **396 suites / 4,282 tests / 0 snapshots** in **65.276s**, not a warning-free claim. Already-queued stale targets,
  dead/unbounded `selectedMessageText`, arbitrary-emoji bounds, and DB reaction-owner proof remain open. Child
  `DB-02A-TEMP-TARGET-ACTIONS` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-DISCARD-OUTGOING` discard owner proof:** Production remains unchanged at `outgoing.ts`
  SHA-256 `209a17db65df75a0719e3af713d4c69a53acdd96ce763ca84d80ad2fc8f9096e`. Baselines were direct **44/44** and
  focused **3/71**. Frozen `outgoingBranches.test.ts` SHA-256 is
  `0b1dc5d5034be3ca40d4f370d7ca4a862f6d07e82c884262306d37f613bb8967`; its first saved direct **46/46** passed
  without behavioral correction, followed only by mechanical Prettier. Final direct **1/46**, focused **3/73**,
  and related **6/102** pass warning-free with green statics. A rolling-back neighbour proves an exact `true`
  discard commits its tombstone, deletion ledger, dequeue, and chat-date recompute independently. A two-stage exact
  queue-delete→final-chat-run gate plus final-chat trigger proves every write rolls back together before the same
  discard retries `true`; bounded unconditional cleanup drains and restores the harness. Scanner **35/35** coordinates
  only `45492546ab25` and `a6b1e3d1ccfc` under `discardOutgoingMessage`; inner `52e8602e5ddd`, `bd46b5b29f79`, and
  `218041275c8c` remain coordinated, while caller `3f8f69a2103c` and reaction IDs `53cbac0fda45` / `93316102c235`
  stay unproven. Live totals are **1,053 / 537 proved (444 coordinated + 93 temporal) / 516 unproven / 0 structural /
  0 nested / 0 membership**. The full `--silent` gate passes **396 suites / 4,284 tests / 0 snapshots** in **62.93s**
  (Jest printed `estimated 66 s`), not a warning-free claim. Child `DB-02A-DISCARD-OUTGOING` is **DONE**; parent
  `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-ERROR-CLAIM-CLOCK` post-lock error-report lease:** A numeric time sampled before the
  global DB mutex could become at least **120 seconds** stale, commit an already-expired claim, and let foreground
  and background queue runners POST the same privacy-sensitive report. The repository now accepts a clock and
  samples it once after mutex/BEGIN admission; the service passes live `Date.now`. Frozen source SHA-256 values are
  `46d6b1960ba6dc8c115977233772e54847a0a925e146da41437ce07cd2c38bd6` and
  `9600e31a026401d4b0f7de369133aead8ce5d9d251229f194a407f15efeb9296`; frozen repo/service test values are
  `90bfcac0e6b39dd696a6d5be777a4ff24194fc9b774cb679bea50dc7adb583b7` and
  `cc77656e48154202bafd554035e743479fcf179e4e1b6f93828de0ea8f145bbf`. The initial source candidate stopped on
  exact `TS1109` at `errorReports.ts:254:5` from one trailing comma; after that punctuation correction, skeptical
  audit prompted the user-approved four-file expansion for unconditional repo cleanup and an end-to-end service
  mutation check. Its first saved expanded **2/48** gate passed; only mechanical Prettier followed. Final focused
  **2/48** and related **4/65** pass warning-free with green statics; ordinary lint has only the **14** established
  service-test `import/first` warnings. Scanner **35/35** applies two coordinated claim rekeys, one still-unproven
  service-caller rekey, and eight line remaps without changing **1,053 / 537 proved (444 coordinated + 93 temporal) /
  516 unproven / 0 structural / 0 nested / 0 membership**. The full functional `--silent` gate run alone passes **396 suites /
  4,285 tests / 0 snapshots** in **288.348s**, not a warning-free claim. Numeric list/maintenance time, slow-failure
  backoff, reaction temp-target identity, and payload bounds remain open. Child `DB-02A-ERROR-CLAIM-CLOCK` is
  **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-ERROR-LIST-FAILURE-CLOCKS` post-lock list snapshot and failure backoff:** The list owner
  previously cleaned and selected with stale invocation time after a mutex wait, while slow HTTP plus another queue
  wait could commit an already-elapsed failure backoff. `listRetryableErrorReports` and `markErrorReportsFailed` now
  accept clocks sampled and validated once after mutex/BEGIN admission; list cleanup+SELECT and failure UPDATE+DELETE
  each share their sampled time and owning transaction. The queue service passes live `Date.now`; claim behavior and
  upload-envelope fallback time are unchanged. Frozen source hashes are
  `a26471cc587d8be8d1e7043d2ad15e473c865fa9a9d934ba6d3cb59042ec8a2b` /
  `0b760061fb706cb6689ef30aefb26d575a47e999658fcf9b8f2bdcd909e87aaf`; test hashes are
  `9fc0c96ed3d9f3bbae9713cc0fc6bfbaa24e28122ebbc2fb9573df61057acb8f` /
  `e402d5432f82f2453ecb029712370222b0b76df4798beee40cd2b8cd69bccf2a`. The first saved run passed the repository
  but failed one service fixture (**49/50**): legacy rows timestamped `1`/`2` were now correctly older than seven
  days, so only those fixtures moved relative to `uploadNow`. Final focused **2/50** and related **4/67** pass
  warning-free; statics pass and ordinary lint retains **14** established `import/first` warnings. The matrix proves
  queued T0→T1 list pruning/eligibility and failure backoff, guard/clock validation, exact trim→SELECT lifetime, live
  service composition, a **30,001ms** failed request, exact retry boundaries, and bounded unconditional cleanup.
  Scanner **35/35** coordinates list IDs `e417cfc06d79`, `8866f799b02f`, and `4d1cf884e6f6`; failure rekeys preserve
  coordination, service rekeys stay unproven, and **21** line-only remaps are exact. Live validation caught a generic
  line edit that moved contacts `42255f8c4337`; an ID-bound correction restored it and moved only error-report
  `d00f2ee94ed5`. Final totals are **1,053 / 540 proved (447 coordinated + 93 temporal) / 513 unproven / 0 structural
  / 0 nested / 0 membership**. The full functional `--silent` gate run alone passes **396 suites / 4,287 tests / 0
  snapshots** in **253.246s**, not a warning-free claim. At this checkpoint, reaction identity, payload/device evidence,
  remaining `DB-02A`, and `DB-02B`/`DB-02C` stayed open; parent `DB-02A` remained **IN_PROGRESS** and `TEST-01`
  remained open.

- **2026-08-11 — `DB-02A-DELETE-CHAT-IDENTITY` serialized chat identity and chunk-owner proof:** A pre-owner
  GUID→numeric-id read could observe a neighbouring transaction's uncommitted AUTOINCREMENT chat. Its rollback and
  id reuse then let the queued delete tombstone/purge an innocent replacement. `deleteChatLocal` now resolves and
  fences identity inside its outer owner, returns the exact committed id/boundary, and starts the separate 500-row
  purge only after that commit. Frozen source/test SHA-256 values are
  `6a0d85413a0c9d2dedb9cf72e522c7811310e822892377f1d58a51f5447110df` and
  `3fb64b950fdebbc2a8c0f4b841526077223a4878958b5ee6f3d0f4850ee483a9`. Unchanged tests passed **2/48**; the
  first saved matrix passed direct **1/33** without behavioral correction; final direct **1/33** and related **3/61**
  pass warning-free with green statics. Four cases prove exact rollback/id reuse, rolling-neighbour independence,
  final-draft failure rollback/retry with no purge, and awaited outer stages→COMMIT→first independent purge chunk.
  Scanner **35/35** coordinates outer IDs `84e70be46f0e` / `a09c26040866` and purge IDs `63396864b914` /
  `3813b67ad498`; the coordinated UPDATE rekeys to `7f340a4cad48`, unresolved delete→purge rekeys to
  `4b0c893b8080`, service/resume callers remain unproven, and **39** exact line remaps yield **1,053 / 544 proved
  (451 coordinated + 93 temporal) / 509 unproven / 0 structural / 0 nested / 0 membership**.

  The first full run passed **395/396 suites and 4,290/4,291 tests**; only a cross-Jest-realm `instanceof Error`
  helper hid the wrapped SQLite canary. Bounded structural cause traversal then passed the rollback row **8/8**, the
  realm pair **2/39** cached and `--no-cache`, direct **1/33**, and related **3/61**. The next full run passed the
  corrected chat suite and printed **284 passing suites** before a native-GC exit **139** with no totals. Report
  `node-2026-08-11-205421.ips` shows the recurring pinned-Node/V8 mark-compact
  `ClearStaleLeftTrimmedPointerVisitor::VisitRootPointers` `EXC_BAD_ACCESS`/`SIGSEGV`; the same frame and binary UUID
  predate this slice. Boundary cluster **8/158** passed three times, then the final functional `--silent` gate passed
  **396/4,291/0** in **61.31s**, not a warning-free claim. Native-GC harness/upgrade investigation remains open under
  `TEST-01`; total purge duration, unresolved caller edges, device evidence, remaining `DB-02A`, and primary
  `DB-02B`/`DB-02C` also remain open. Child `DB-02A-DELETE-CHAT-IDENTITY` is **DONE**; parent `DB-02A` remains
  **IN_PROGRESS**.

- **2026-08-11 — `DB-02A-DELETE-MESSAGE-OWNER` delete-message transaction-owner proof:** No production code
  changed; `messages.ts` remains SHA-256 `e5e7df49686f8253836974004fe5754017635b864fb347c5ddfd38524feff0d7`,
  and frozen `messagesRepo.test.ts` is
  `5abca799969aceb41146a817eff2434cec942cd64399aea9ff914d6ab2d73e65`. Baselines were direct **32/32** and
  related **5/71**. The first saved three-case matrix passed direct **35/35**; skeptical review then replaced its
  real-GUID neighbour fixture with the required exact current-temp message plus queue row and hardened unconditional
  drainage. Post-correction direct **35/35** stayed green. Final related **5/74** passed twice; an independent rerun
  passed direct **1/35** and related **5/74**, warning-free with green statics.

  The matrix pins current-temp rolling-neighbour isolation, post-queue temp→real promotion before identity lookup,
  and the awaited queue DELETE→ledger insert→message tombstone→chat-sort lifetime. An exact final-chat trigger proves
  full rollback before the same-GUID retry succeeds, with bounded unconditional cleanup. Scanner **35/35** coordinates
  only opener `b23bdb02d771` and callback `adc6c67cceea` under `deleteMessageLocal`; existing `fa382907379e`,
  `7daafcdeffcd`, and inner writes are preserved, while service caller `65ef55b84361` remains unproven. Inventory
  SHA-256 is `048f14159087d5ef0364879ad4b216c86019622ec79f0ecae7a5510743cb74e7`; live totals are **1,053 / 546 proved
  (453 coordinated + 93 temporal) / 507 unproven / 0 structural / 0 nested / 0 membership**. The full functional
  `--silent` gate passes **396/4,294/0** in **61.588s**, not a warning-free claim. Child
  `DB-02A-DELETE-MESSAGE-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-CACHE-LEDGER-WIPE` ledger-wipe and dirty-read ownership proof:** Production remains
  unchanged at `maintenance.ts` SHA-256 `a1665345807df9bd4912d7e8124a62c356b4ce3d4c2c7282426c9929ce6e8c19`;
  frozen `clearLocalCache.test.ts` is
  `12657f4f840d031239806421dccc29071c7cb960662bbafac6626de37b5e7936`. Baselines were direct **26/26** and
  related **3/118**. The first save compile-failed only at line 622 with TS1135 from `});` instead of `);`; the
  punctuation correction produced direct **27/27**, followed only by mechanical Prettier formatting. Skeptical review
  then found that a single ledger gate did not kill removal/enlargement of `LIMIT 500`; the in-place second gate now
  proves **501 → 1 → 0** across two batches. Final direct **1/27** and related **3/119** pass warning-free in both owner
  and independent runs, with green statics.

  The semantic alias→rolling-neighbour→two-ledger-batch→attachment-cache sequence proves queue order, rollback
  isolation, exact per-statement bound, adopted async lifetimes, and successor ordering; the existing dirty-read row
  now has unconditional cleanup and proves it rejects a neighbour's temporary empty view. Scanner **35/35** coordinates
  only ledger IDs `25b8d31b80df`, `e79ade7c65e1`, `e04a760b714e` and dirty-check ID `3117ce193e0b`; bootstrap caller
  edges `80814999e829`/`972629a8899e` stay unproven. Inventory
  `04f6c084423df718f80611d136d9667fd6bc4eaebef6d038153d58698044df51` is exact at **1,053 / 550 proved (457
  coordinated + 93 temporal) / 503 unproven / 0 structural / 0 nested / 0 membership**. A broad inventory patch briefly
  mis-targeted `rotateDbKey` `743c04944fee`; exact review restored it before final validation. The full functional
  `--silent` gate passes **396/4,295/0** in **62.259s**, not a warning-free claim. Child
  `DB-02A-CACHE-LEDGER-WIPE` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-NOTIFICATION-ROUTE-CLEANUP` bounded notification-route teardown:**
  `clearNotificationRoutes` previously held the global DB mutex for one prefix-wide, schema-uncapped DELETE. Source
  SHA-256 changed from `88dc763e824fafbe1de2c0cc17c852f32b56ce4af9718c421f241d1cdc74d0e5` to
  `61f0561d6a409d4a66aaacbd08fe73b00dadfc678fbfe880772d45637addc292`; each route batch now deletes at most
  500 rows in its own `withDbTransaction` and yields before the next. Public APIs/callers and the exact-delete source
  are unchanged. Frozen test SHA-256 is `73ec0dee5284b9ff86b89fdb60c78d693eb003cbf07119666dbeb453dbc473f1`.
  Baselines were direct **10/10** and related **4/89**; the first saved candidate passed direct **12/12**. Skeptical
  review added the load-bearing second-batch trigger because two gates alone did not disprove one long transaction.
  Post-strengthening direct **12/12** remained green. Final direct **1/12** and related **4/91** pass warning-free in
  owner and independent runs with green statics; the
  matrix proves exact queued delete lifetime plus clear **501 → 1 → 0**, second-batch rollback, and retry with bounded
  unconditional cleanup.

  Scanner **35/35** coordinates stable delete wrapper IDs `c3d03cde0a0e`/`ec4625bd7241` and rekeyed clear wrapper
  IDs `33710a48b511`/`8e582f820418`; raw clear DELETE `487cbd0a4e5e` rekeys to `f27d9c134c56` with prior
  metadata, while caller edges `4cd9c37810a4`/`5e1eda48b4c7` stay unproven. Inventory
  `962cd88113f76b597696fb0070ffabab5047b72e4fb5f966b3c955877833601a` is exact at **1,053 / 554 proved
  (461 coordinated + 93 temporal) / 499 unproven / 0 structural / 0 nested / 0 membership**. A generic inventory
  patch briefly mis-targeted `maintainIncomingEvents` `3ec3e30efd66`; exact-ID audit restored it before validation.
  The full functional `--silent` gate passes **396/4,297/0** in **71.163s**, not a warning-free claim. Per-slot route
  deletion is bounded, but total batches/duration, unresolved callers, device proof, remaining `DB-02A`, and primary
  `DB-02B`/`DB-02C` remain open. Child `DB-02A-NOTIFICATION-ROUTE-CLEANUP` is **DONE**; parent `DB-02A` remains
  **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-DB-KEY-ROTATION-OWNER` live rekey ownership proof:** Production did not change:
  `src/db/key.ts` remains SHA-256
  `9d04cbc6bd67512c95dcfb2c21e1a6b125d0995de22f2ef1f65525ac922b445e`; frozen
  `test/db/dbKeyRotation.test.ts` is
  `a9ea8ee6a759c313e79eb14dd2bc49dd6d8915657dd754299918f6fd9ca20223`. Baselines were direct **1/6** and
  related **4/45**. The first saved strengthening passed direct **1/6**, followed only by mechanical Prettier
  formatting. Final direct **1/6** and related **4/45** pass warning-free with green statics. Independent verification
  first supplied nonexistent `test/db/ensureDatabaseSingleFlight.test.ts`, producing only `ENOENT` while three suites
  passed **42/42**; the corrected `test/services/ensureDatabaseSingleFlight.test.ts` path passed the intended
  **4/45**.

  The load-bearing row proves predecessor queue ownership, exact delayed 64-hex-key PRAGMA lifetime, successor
  exclusion, and pending-old-primary→promotion→pending-clear ordering with bounded unconditional cleanup. Scanner
  **35/35** coordinates only `743c04944fee` and `b495209d9e52` under `rotateDbKey`; raw PRAGMA `3a94b1e1c97e`
  stays coordinated, while service/Settings callers `dc60d96f0ec1` and `ac9fcd609606` remain unproven. Inventory
  `397cafbfdb88ecdbe4752b94ecab21a9cdf1d3678a4572128c13b19e39929a35` is exact at **1,053 / 556 proved
  (463 coordinated + 93 temporal) / 497 unproven / 0 structural / 0 nested / 0 membership**. The unchanged-count full
  functional `--silent` gate passes **396/4,297/0** in **71.79s**, not a warning-free claim. The sole tracked Settings
  route remains the only production caller; add single-flight before any second/re-entrant caller because staging has
  one pending-key slot. Child `DB-02A-DB-KEY-ROTATION-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**,
  and `TEST-01` remains open.

- **2026-08-11 — `DB-02A-REMINDER-ID-MIGRATION-OWNER` durable native-id handoff proof:** Production did not
  change. Frozen source/test SHA-256 values are
  `61f0561d6a409d4a66aaacbd08fe73b00dadfc678fbfe880772d45637addc292` and
  `f87e5307b9eb7909fe1705769e55f2fcf10f67899c53959726d1b096cb417c20`. The pre-existing source/test paths are
  untracked, so exact hashes, tests, and statics replace an unavailable Git diff. Baselines were direct **12/12** and
  related **4/91**; the first saved row passed direct **13/13**, followed only by mechanical Prettier. Final direct
  **1/13** and related **4/92** pass warning-free in owner and independent runs with green statics.

  The matrix proves rolling-neighbour isolation, exact delayed UPDATE lifetime, successor exclusion, durable `true`
  handoff, fallback-SELECT idempotent `true`, missing-row `false`, and queued account-guard rejection with bounded
  unconditional cleanup. Scanner **35/35** coordinates only `44918d382fdf`/`7ac9ad737605` under
  `migrateReminderNotificationId`; raw `d6c50c44f83d` stays coordinated, while callers `fc0ca0b8b11a` /
  `f8804eee4845` and separate DbEventSink `89d7a5f4910f` stay unproven. Inventory
  `130b6ea30d5d71a4ed76aeeeae014f25f2a91e374812d3e1df5d79883fdfaa72` is exact at **1,053 / 558 proved
  (465 coordinated + 93 temporal) / 495 unproven / 0 structural / 0 nested / 0 membership**. The full functional
  `--silent` gate passes **396/4,298/0** in **63.402s**, not a warning-free claim. The fixed statement has no hard
  one-row guarantee because `notification_id` is not unique or schema-capped. Child
  `DB-02A-REMINDER-ID-MIGRATION-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains
  open.

- **2026-08-11 — `DB-02A-DB-EVENT-SINK-OWNER` durable realtime transaction-owner recognition:** Production and
  tests did not change. Frozen source/direct-test SHA-256 values are
  `9fedccb993886538bf81122ffe296a8068f140bd5fba2a94c15a0b960402ea25` and
  `74cc77cd43ccb0c9b9baf1d0f11e4b16d517e233399171e7eaebcb23d26f6124`. Direct **1/24** and exact related
  sink + phase-6 + incoming-drain + transaction **4/47** pass warning-free with zero snapshots under pinned Node
  24.19.0.

  Existing evidence mutation-pins the public owner: rolling-neighbour rollback isolates its writes; all five writable
  branches reject pre-task retirement; a separate post-task commit-handoff row rolls back executed writes; and durable
  checkpoint failures roll back the domain mutation and receipt together. Scanner/transaction tests reject detached,
  escaped, and nested callback variants. Scanner **35/35** newly coordinates only `89d7a5f4910f` under
  `withCurrentDeliveryTransaction`; the other 19 sink records remain coordinated and upstream/dynamic callers remain
  excluded. A generic patch initially matched `maintainIncomingEvents` `3ec3e30efd66`; exact-ID audit restored it,
  and reversing only the authorized target fields reproduces the prior inventory SHA exactly. Final inventory
  `267d259ae85013e595f10b04549eb0c3fac34ad7ad15982199ff35a50fffaf48` is **1,053 / 559 proved
  (466 coordinated + 93 temporal) / 494 unproven / 0 structural / 0 nested / 0 membership**.

  The preceding full functional `--silent` gate remains current at **396/4,298/0** in **63.402s**; it was not rerun
  for this inventory/docs-only checkpoint and is not warning-free evidence. Attachment and group participant arrays
  remain without schema caps, so absolute callback boundedness is not claimed. Child `DB-02A-DB-EVENT-SINK-OWNER`
  is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-12 — `DB-02A-REACTION-PAYLOAD-PRIVACY` durable reaction-body scrub and owner proof:**
  `insertOutgoingReaction` no longer copies the selected message body into retry JSON, while its compatibility input
  remains accepted and ignored. Migration `0038_scrub_reaction_selected_message_text` scrubs canonical legacy
  reaction payloads atomically and preserves absent-key, non-reaction, and malformed rows. Frozen production,
  registry, test, and inventory SHA-256 values are `71201e10470e9b56802ee99220b4eb77b7f4454f13fcbf786c45cb0a108cf0e9`,
  `92db1a9a5df155f2636650211d8bdcaa74bd362642b5dee9db8e6800a1658831`,
  `c51544f1adcb18f9c1966335f25047172ecfd917e8a6b03dcb928f41145734e7`,
  `c4803e01763db8db033293a1f78103c6edc027805e6b7c826a20226a41f20896`,
  `ba911e787e1b5ffd9453902036630d7de419fba1b1d43a0dca7e48b6428a3e9b`, and
  `96ae3da4574565588ce2bb7332e82a429c045b35956454a40520466ce445158b`.

  The first saved **2/49** passed without behavioral correction; only Prettier followed. Final focused **2/49** and
  related **6/62** pass warning-free, statics are green, and the migration guard is **38/head 0038 + 5/5**. The owner
  matrix proves rolling-neighbour isolation, ordered queue/message awaits, exact second-insert rollback/retry, and
  omission of a private 4 KiB sentinel. The upgrade test proves in-transaction scrub visibility, migration-record
  failure rollback, retry, byte preservation, and idempotency with bounded cleanup. The original narrow scope omitted
  cleanup; a later four-file scope omitted the mandatory registry allocation, so work stopped until the user approved
  all five files.

  The first full attempt exited 139 without totals after both new suites passed; its new report was the outer Node 26/
  npx `node::Kill` signal-forwarding stack, not the older pinned Node 24 GC signature. One bounded direct-binary retry
  passes **397/4,301/0** under `--silent` in **181.985s**, not a warning-free claim. Scanner **35/35** records **1,054 /
  562 proved (468 coordinated + 94 temporal) / 492 unproven / 0 structural / 0 nested / 0 membership**, with only the
  two reaction owner rekeys and migration `a6a11f9eb292` newly proved. Unbounded startup work, noncanonical duplicate
  JSON keys, stale temp-target identity, uncapped reaction/emoji bytes, unresolved callers, and device proof remain
  open. Child `DB-02A-REACTION-PAYLOAD-PRIVACY` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`
  remains open.

- **2026-08-12 — `DB-02A-SEARCH-TEXT-BACKFILL-OWNER` guarded page revalidation:** A preliminary search-text page
  could observe another transaction's uncommitted eligibility on the shared SQLite connection, then skip a restored
  row permanently after that neighbour rolled back. `runSearchTextBackfillPass` now re-reads the exact ordered
  **LIMIT 50** page inside its tracked/account-guarded owner and advances only when identity, source body, and
  eligibility still match. Mismatch writes nothing and retries the same cursor, including zero-decode pages.

  Frozen source/test/inventory SHA-256 values are
  `82da12422f64349fb6638577329f42c601209252733f0959942cc0e034e75186`,
  `aa8aa18d080a17b11fe6dfec1dc17904163be318407aec60a363dc33981b5b20`, and
  `b8abfe1d85d1142f326ba728eb21774225ba8fe79dfeb639e19ad85fe8942d6f`. First saved real-DB **1/3** passed; only
  expected-log suppression, unused helper/import removal, and Prettier were mechanical. Skeptical strengthening proves
  an all-undecodable dirty page cannot bypass revalidation, a real one-of-two CASE update and in-owner body mutation
  both roll back on row-count mismatch, the successor queue releases, and stale-account work rejects before BEGIN.
  Final direct **1/3** and exact related **4/30** pass warning-free; TypeScript, lint, formatting, and diff checks pass.

  The complete functional gate passes **398/4,304/0** under `--silent` in **101.4s**, not a warning-free claim.
  Scanner **35/35** records **1,054 / 565 proved (471 coordinated + 94 temporal) / 489 unproven / 0 structural / 0
  nested / 0 membership**, with only the three owner entries newly coordinated. The raw helper and production callers
  remain unproven. Exact-device op-sqlite/SQLCipher execution, uncapped attributed-body bytes and total pass count, and
  the separate optimistic-edit failure path that can restore stale empty text remain open. Child
  `DB-02A-SEARCH-TEXT-BACKFILL-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-12 — `DB-02A-OPTIMISTIC-EDIT-SAFETY` atomic restore and lifecycle queue:** Edit snapshot and optimistic
  apply now share one short transaction, rich-body decoding occurs after the mutex is released, and failure restores
  effective searchable text plus the exact prior body/marker only while the optimistic row still owns all CAS fields.
  Full edit lifecycles serialize per captured `(AppDatabase, messageGuid)` outside the DB mutex, so dirty neighbour
  reads, overlapping-failure stranding, rejected-tail poisoning, mutable-key cleanup, and cross-account GUID blocking
  are covered without holding SQLite open over HTTP. Missing rows do not POST; unsend is unchanged.

  Frozen source/service/test/inventory SHA-256 values are `ee03a76da17479d2bb7bea5e8ef88d9b2808257a3da246e5a725debe891f0120`,
  `ac5b15cc7ce755433a87b317dad993de4096698fddae4e43223d34d86623a510`,
  `f0dd369e4611ea51ccb24d745e40335f3344c883fd2e8b3d29505cc27bb61b2a`, and
  `d155fd213bfd8f44619d952432519321417dcc9011ca95088d881341aebb3f46`. Final direct **1/13**, independent **7/60**,
  and root related **8/65** pass; TypeScript, lint, formatting, diff checks, and scanner **35/35** pass. The full
  functional gate passes **398/4,308/0** under `--silent` in **180.443s**, not a warning-free claim. Inventory is
  **1,055 / 565 proved (471 coordinated + 94 temporal) / 490 unproven / 0 structural / 0 nested / 0 membership**.
  Byte-identical server echoes still need a durable revision token; rich-body refresh, crash recovery, device proof,
  remaining inventory, `DB-02B`, and `DB-02C` remain open. Child `DB-02A-OPTIMISTIC-EDIT-SAFETY` is **DONE**; parent
  `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-12 — `DB-02A-OPTIMISTIC-UNSEND-SAFETY` committed snapshot and shared lifecycle queue:** Unsend now
  snapshots committed message/chat identity and the exact prior retraction marker in the same short owner that applies
  the optimistic marker. Failure restores the exact predecessor only by compare-and-set; missing rows never POST.
  Edits and unsends serialize per captured database/message outside the DB mutex, while unrelated DB writes and the
  same GUID on another database remain independent. Frozen source/service/repository-test/service-test/inventory
  SHA-256 values are `ac74c658c8b155908a83b8ebeb1f1a5f619670c2ab8f9d0b320ef1cca781ecf1`,
  `268e3e95bcb0d69729fda8b4a2eded035077cd2250265eaddccc944454f54a96`,
  `887373e1fdd473aa3eb40f77652dc0702c6b913558b435afffa6166fc15c470e`,
  `c2cb1a31b53aff6df595c8c3bf0536d772ef31fab64fd1ed31b16d732244fbea`, and
  `0b5d7ae2f0956711d85eccaf3af49e4dca94e0b927b54e37f975a159dae0b6bb`. Final direct **2/29** and related **9/103**
  pass; TypeScript, lint, formatting, diff, and scanner **35/35** pass. The complete functional gate passes
  **398/4,311/0** under `--silent` in **241.992s**, not a warning-free claim. Inventory is **1,056 / 565 proved (471
  coordinated + 94 temporal) / 491 unproven / 0 structural / 0 nested / 0 membership**. Same-marker echo identity,
  aggregate queue bounds, the 30-second HTTP tail, crash/device proof, remaining inventory, `DB-02B`, and `DB-02C`
  remain open. Child `DB-02A-OPTIMISTIC-UNSEND-SAFETY` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and
  `TEST-01` remains open.

- **2026-08-12 — `DB-02A-MESSAGE-RICH-BODY-REFRESH` authoritative rich/plain refresh:** Message conflict ingestion
  now replaces a present non-null rich body, clears an old rich body only for a strictly newer dated nonempty plain
  edit, and preserves it for null/omitted receipt projections and equal-marker lean duplicates. This keeps rendered
  wording, decoded `text`, and FTS coherent while tolerating the real lean FCM representation.

  Frozen source/repository-test/sink-test/inventory SHA-256 values are
  `5e4d42adcc58ae7f40536675e6207c68998dd7eef309d1e8911b3a6b6f62fc8d`,
  `098fb0d95a73349babe2b012194ef526f50761604f481bff0b88acee3248a7ae`,
  `3109197587ec0787f9e97a2a4e2f8ede212cbfff855a4c08ef4907fca219a3ec`, and
  `2e30de6a3e7bbacbaacefcbde1d4c779ea9cd770183d64a0146d5fbcfcef9188`; the adjacent comment-only send-edit test is
  `e8e28c76f2961d1fa369bd91d628f9942652e25d46d3c2d59f9b7d956f0f9aa5`. Focused **2/60**, related **9/135**, and
  the complete functional **398/4,312/0** gate pass, the latter under `--silent` in **246.733s** and therefore not a
  warning-free claim. TypeScript, lint, formatting, diff, and inventory checks pass; inventory remains **1,056 / 565
  proved (471 coordinated + 94 temporal) / 491 unproven / 0 structural / 0 nested / 0 membership**.

  Forced post-message attachment failure proves rich-body/text/marker/FTS rollback and retry. Newer plain clear,
  marker-only/explicit-null/omitted preservation, same-marker rich restoration, and the production chats-less
  `updated-message` path are mutation-pinned. Same-millisecond authority, stale present-body ordering, device proof, and
  remaining inventory stay open. Child
  `DB-02A-MESSAGE-RICH-BODY-REFRESH` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-12 — `DB-02A-OUTGOING-CHAT-IDENTITY` committed chat resolution for optimistic sends:** Text, contact,
  reaction, and attachment sends now resolve GUID to local chat id inside their existing optimistic-insert owner. This
  closes the shared-connection race where a pre-owner read could retain an uncommitted numeric id whose SQLite
  AUTOINCREMENT allocation was rolled back and then reused by an unrelated chat. Scheduled text reuses the same
  transaction-only resolver inside its one atomic handoff; no owner nests and HTTP/upload begins only after release.

  Frozen chats/outgoing/attachments/text/contact/reaction/attachment-service/regression/corrected-handover/guard/inventory
  SHA-256 values are `a2b58a5012e98ee3e058cd9c1e025630fd6399a914642c2ae1bf8f30764d2f52`,
  `ecbe23d61f0ead7e2c5eecea6e0321543d78a6c531b45a47b289ce1374254289`,
  `14b0d58eed83120de1585ded19cbe0947b7d4f18cd79cb713e0c6b25f1e05062`,
  `74448675b4a6ce56e9a9b5a5f6e3d6ff469219c5d496f0b62219a7a3d08072d7`,
  `690f0a18760b2985d5604351ef82f4e21b89e7c6f45977c03b0b3ff58845f5d3`,
  `8cabc2cf7dff8cca5da5507360d410ab8fb5084122a50a45419b1e6609b38b40`,
  `5ae53670dc19c21e72124d56a1b45c75844d65798e71caccceb7abf144f9626d`,
  `9b2f10311af7d48b21fe7200ddc4a7eaf29216a723f44d52aa5899f1dbcc02a1`,
  `a6bcbce7f6de7e4cd1dd7ce9d3248d45ed0cf6ace53ca3e60057ffb3a0321974`,
  `9339101802de2ae06f1d4e5efa32f26cc377a5682c50ae1c62f63d44e474948a`, and
  `b13e9f2f4fc9cacf2fba0af2bbc2c9707098c115920f7c2ad0829970497257ea`. Direct **6/48**, related **8/117**,
  correction **3/45**, and complete functional **399/4,322/0** pass; the full run used `--silent` and took **239.62s**,
  so it is not a warning-free claim. TypeScript, earlier targeted zero-error ESLint, formatting, diff, architecture
  **30/30**, and scanner **35/35** pass. A final standalone ESLint invocation could not load the existing
  `@typescript-eslint` configuration and therefore supplied no additional code result. Inventory remains **1,056 / 565
  proved (471 coordinated + 94 temporal) / 491 unproven / 0 structural / 0 nested / 0 membership**.

  Four-kind rollback, committed-miss, in-transaction lookup, exact message/queue/wire identity, post-lock network, and
  scheduled one-owner cases are mutation-pinned. An initial compile mismatch, a scanner-obscuring overload, and one
  stale scheduled fixture were corrected before freeze. The architecture guard then rejected its stale `f283…`
  reviewed body fingerprint; one expected-value line was refreshed to current `381fed…`, with no checker logic/test
  change, and live core/scheduled guards pass. The ignored legacy id field, construction-time transaction typing, exact
  native-driver/device/process-death proof, and remaining inventory stay open. Child
  `DB-02A-OUTGOING-CHAT-IDENTITY` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-12 — `DB-02A-QUERY-MESSAGE-PROJECTION` shared incremental rich projection:** Incremental
  `POST /message/query` now sends `SYNC_WITH_QUERY.join(',')`, matching chat history's ordered `chats`,
  `chats.participants`, `handle`, `attachments`, `attributedBody`, `messageSummaryInfo`, and `payloadData` projection.
  Current bbd loads the latter two only when their tokens are present. It accepts both attachment spellings today, so
  adopting the shared plural token is compatibility/future parity rather than a claim of a current attachment outage.
  Limits, cursors, ascending order, parsing, persistence, and transaction ownership do not change.

  Frozen endpoint/test/constant/byte-unchanged-inventory SHA-256 values are
  `7df15017f22569df1a710b3b1b515a14bc13f7b4f8adeb1e0d6a8e43ea40fcfc`,
  `116521da7c98c661d0260f52cb15b0346b38b134138316cca3671f93b3aeae05`,
  `5f27965b0b3237a2c95f44a7f0fef6e6ab0c65e7772eb79e4d37c0b4f74a1bc0`, and
  `b13e9f2f4fc9cacf2fba0af2bbc2c9707098c115920f7c2ad0829970497257ea`. A literal seven-token assertion plus an exact
  shared-`join` spy rejects both self-referential and hardcoded projection survivors; response assertions cover edited
  parts, retractions, and rich-link metadata. Final direct **2/29** passes in **2.773s**, related **6/78** in **4.13s**,
  and complete functional **399/4,322/0** under `--silent` in **62.661s**, exit zero; the full run is functional evidence,
  not a warning-free claim. TypeScript, targeted zero-error ESLint, formatting, diff, architecture **30/30**, scanner
  **35/35**, and migrations **5/5** pass. Inventory stays **1,056 / 565 proved (471 coordinated + 94 temporal) / 491
  unproven / 0 structural / 0 nested / 0 membership**.

  This client contract does not prove deployed-server or device delivery. The 250-message page and 16 MiB JSON limits do
  not separately cap each nested metadata array, and equal-millisecond/stale-present-body ordering still lacks a durable
  revision fence. Crash/device proof, remaining inventory, `DB-02B`, and `DB-02C` stay open. Child
  `DB-02A-QUERY-MESSAGE-PROJECTION` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-12 — `DB-02A-ATTACHMENT-CACHE-RESERVATION-OWNER` explicit production reservation owner:** The
  production attachment-cache scope now exposes transaction-neutral `runTracked` account-lifetime adoption, while the
  coordinator itself opens the guarded transaction around the durable reservation INSERT. A successful reservation is
  committed before native download starts; queued account revocation returns `stale` without a ledger row or native
  effect, and native work remains outside the database mutex.

  Frozen coordinator/index/account-test/coordinator-test/inventory SHA-256 values are
  `1a1e12e93cbcf19a3a015b06beb1eff4fc04cc8675d2d6d5c946ed8f6ffa2433`,
  `845ea46e25385d93c4bd45f6b7f9a372a195d53ef794a1a8b84a35154f09fb05`,
  `61cc7313bc8d5166fa278c043cbc0f176c0037bc26d4704ed169df9952fb9530`,
  `f25102103f1a06b4f398f7a86869e98bac14a6ca7f9b86c2e2014d98f065bfad`, and
  `c1ef0d24c6b064038ab45257f055169eba36d59883f52b36f2c68300ef214aa7`. Final direct **1/16**, focused **5/128**,
  and complete functional **399/4,324/0** pass; the full run used `--silent` and took **99.924s**, so it is functional
  evidence rather than a warning-free claim. TypeScript, targeted lint, formatting, diff, architecture **30/30** plus
  its live boundaries, migrations **5/5**, and scanner **35/35** pass. Inventory is **1,059 / 568 proved (474
  coordinated + 94 temporal) / 491 unproven / 0 structural / 0 nested / 0 membership**.

  The first saved direct fixtures inherited a zero-free-space native default; a safe-space result corrected them. The
  first broader compile then exposed the old synthetic account scope missing required `runTracked` (`TS2322`), and the
  combined fresh-generation retry needed a third explicit safe-space result. Both were mechanical fixture corrections.
  Initial npm-wrapper guard commands could not find `node_modules/npm/bin/npm-cli.js`; direct pinned-Node guard commands
  passed, making that a tool-invocation failure only. Cache reuse, retirement, recovery, unscoped fallback, exact-device,
  process-kill, and remaining-inventory proof stay open. Child `DB-02A-ATTACHMENT-CACHE-RESERVATION-OWNER` is **DONE**;
  parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-12 — `DB-02A-ATTACHMENT-CACHE-REUSE-OWNER` explicit tracked reuse/repair owner:** Production
  existing-path reuse now performs native stat outside the database mutex, then uses transaction-neutral `runTracked`
  adoption around a source-local guarded transaction. That one owner either records the file's exact bytes/access or
  atomically clears matching attachment paths and deletes a missing active ledger row. A queued account revocation
  returns `stale` without an old-account write.

  Frozen coordinator/index/account-test/coordinator-test/inventory SHA-256 values are
  `f44d2c3ffcc6105c39d4a54134c1ff1c4c020790fce8029d050bc3aff5740668`,
  `845ea46e25385d93c4bd45f6b7f9a372a195d53ef794a1a8b84a35154f09fb05`,
  `cf201c46b825700781f0fb1b1d73f0dd46c38b7d088fe35a4b4ef1991954f580`,
  `a1b31bdd513cc0aa95fb9949b593a1fc5a3aab3818b8307f32ff380ce2bc47e2`, and
  `d51dbb9e0e71a2c122a0a6f5f9175aa1dd7df972c1b39043781836a77697d5a2`. Final direct **2/47**, focused **5/129**,
  and complete functional **399/4,325/0** pass; the full `--silent` run took **121.843s**, so it is functional evidence
  rather than a warning-free claim. TypeScript, architecture **30/30** plus its live boundaries, migrations **5/5** at
  head `0038`, and scanner **35/35** pass. Inventory is **1,063 / 572 proved (478 coordinated + 94 temporal) / 491
  unproven / 0 structural / 0 nested / 0 membership**.

  The first saved direct run was **46 passed / 1 failed** because recovery consumed a one-shot stat fixture; a first
  manifest-only correction still left mocked free space at zero and correctly allowed quota eviction. Safe free space
  plus an explicit post-recovery state assertion corrected the fixture. Only four tracked production `reuseProtected`
  findings close here; repository definitions, caller edges, recovery, unscoped fallback, retirement, exact-device,
  process-kill, and remaining-inventory proof stay open. Child `DB-02A-ATTACHMENT-CACHE-REUSE-OWNER` is **DONE**;
  parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-12 — `DB-02A-ATTACHMENT-CACHE-RETIREMENT-SETTLEMENT-OWNER` explicit tracked settlement owner:** Native
  deletion remains outside the database mutex. The tracked production branch adopts only the short settlement task with
  transaction-neutral `runTracked`, then opens one guarded transaction to confirm the exact retiring row after native
  absence or atomically persist its bounded retry attempt/backoff after native failure. Token-checked `finally` cleanup
  releases exact-path ownership on every outcome.

  Frozen coordinator/coordinator-test/account-test/inventory SHA-256 values are
  `794a11a5de4ad8e9c4ba027710d18e678023361b5f9d01c80611b7393f3047bd`,
  `6af607b470fbeade6b78675c84e93c41d95e1d821438883b30d541b7f7b05886`,
  `91b3335575e509fd6cbed40bf9d47df60464d33ad6e3fe4b7bd3620c7a674afe`, and
  `0431455733482265027505b331fbd8123827256f6bebf49009b6b71bc1472ddb`. Final direct **2/52**, focused **5/134**,
  and complete functional **399/4,330/0** pass; the full `--silent` run took **116.248s**, so it is functional evidence
  rather than a warning-free claim. TypeScript, targeted lint, formatting, diff, architecture **30/30** plus its live
  65-file boundary and three scheduled guards, migrations **5/5** at head `0038`, and scanner **35/35** pass. Inventory
  is **1,069 / 578 proved (484 coordinated + 94 temporal) / 491 unproven / 0 structural / 0 nested / 0 membership**.

  The first new-test run passed **2/50** without correction; the first production-confirm expansion passed **2/51**.
  Mutation review then exposed a retry-guard proof gap, so the symmetric retry-revocation case was added and first passed
  **2/52**; the only later correction was Prettier's assertion wrapping. Exactly six tracked production
  `settleRetirement` findings close here. Repository definitions, claim/planning and outer-caller edges, recovery and
  unscoped fallback settlement, exact-device/process-kill, and remaining-inventory proof stay open. Child
  `DB-02A-ATTACHMENT-CACHE-RETIREMENT-SETTLEMENT-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and
  `TEST-01` remains open.

- **2026-08-12 — `DB-02A-ATTACHMENT-CACHE-ADMISSION-CLAIM-OWNER` explicit tracked eviction claim:** An initial
  inactive-retirement preflight stopped without edits after finding startup recovery scoped but ordinary chat, send,
  sync, and realtime callers unscoped. The narrower admission path already had production account tracking, so its
  candidate claim plus all-reference clear now run in one source-local guarded transaction adopted by `runTracked`.
  Native deletion begins only after that commit and remains outside the mutex; revocation rolls the whole claim back,
  and `finally` clears pending path ownership for a fresh retry.

  Frozen coordinator/coordinator-test/account-test/inventory SHA-256 values are
  `93532cbc6bab3d43e4684820d2b0d41b30133c999fc11908d681675b01e1ead6`,
  `c4c902eba7344ab407dc21f2957d23ab4f55c572f164d13bad48909182be43ad`,
  `0945f46728b52d5bffc53f2baa7627a82a692f4bc7c957f64ee4743edd9db36b`, and
  `847883f630b30273288feab48393feb0b123b7795d7d1b2cfac052b72ff47653`. The first saved tests passed **2/55**; the
  sole correction was Prettier wrapping. Final direct **2/55**, focused **7/130**, and complete functional
  **399/4,333/0** pass; the full `--silent` run took **103.083s**, so it is functional evidence rather than a
  warning-free claim. TypeScript, targeted lint, formatting, diff, architecture **30/30** plus its live 65-file boundary
  and three scheduled guards, migrations **5/5** at head `0038`, and scanner **35/35** pass. Inventory is **1,072 / 581
  proved (487 coordinated + 94 temporal) / 491 unproven / 0 structural / 0 nested / 0 membership**.

  Exactly three tracked admission-claim findings close. Initial snapshot, inactive/conformance claims, recovery,
  unscoped fallback, caller and raw-definition, exact-device/process-kill, and remaining-inventory proof stay open.
  Child `DB-02A-ATTACHMENT-CACHE-ADMISSION-CLAIM-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and
  `TEST-01` remains open.

- **2026-08-13 — `DB-02A-ATTACHMENT-CACHE-CHAT-SEND-SCOPE` shared caller-scope prerequisite:** The inactive-retirement
  preflight had found that ordinary cleanup callers lacked an account scope. A shared
  `createAttachmentCacheAccountScope` now binds the caller's exact database and realtime account lease, adopts short
  work through `runTracked`, and gives transaction work the same lease as its last-moment commit guard. Message discard
  passes one non-null scope to retirement and retry drain; chat deletion reuses one scope for both calls before and both
  calls after resumed purge cleanup.

  Real-SQLite tests prove the factory uses the supplied database, preserves a generic task result, does not invoke stale
  work, rejects queued old-generation work while Disconnect drains it, observes the blocking neighbour's rollback, and
  releases the queue for a fresh generation. Composition tests prove exact scope identity across send's two calls and
  chat deletion's four calls.
  Frozen factory/send/chat/send-test/chat-test/inventory SHA-256 values are
  `8aba08631acb2e064f6fbd8f45ed8149eb1d7b082f4791d3c4d583cbae3fc059`,
  `42e0bddaf10f6de1aed8fd5e77774630745bccc1cd9327582fa201a37a62fb53`,
  `799e8d9f8a48e82f61c4b1fa94b3f3fc9fc633a95789ff39163723f00ce9b27f`,
  `50b8cea5f2ce491d1eb577ec60d0cf32abd2e150ce2fcdfdedb473782f505c84`,
  `8e5a9c416e89a89c7ee98e274c7b2c9cda8ebff1bb5f76e57a02cd5aaaa1fa9a`, and
  `6e0bb8c87e41072c09b6cecfd9cbf263679a4c60a910ad3829b922d265da327a`.

  The first saved direct gate passed **2/28**. Two later full-order harness corrections changed no production behavior:
  a better-sqlite3 `SqliteError` created in the preceding Jest realm had genuinely rejected admission claim with
  `SQLITE_CONSTRAINT_TRIGGER`, but the old realm-sensitive `toThrow` matcher reported that the rejection did not throw;
  the corrected assertion structurally pins its name, code, and message. Then two fixed 2026-08-06 error-report fixtures
  crossed the intended seven-day retention boundary, yielding zero eligible rows and no upload payload; their live clock
  is now pinned and restored in `finally`. The corrected
  coordinator-test and error-report-test SHA-256 values are
  `341905386b264a462ab1eba0dc63cd72c220190510b935a67399e7302b83d680` and
  `9f9f1071750f46e31f466e36ce5e7344f5ec059d76d1d6dad5b2d591faa595a2`. Final direct **2/28** and complete functional
  **399/4,337/0** pass under pinned Node 24.19.0; the full `--silent` run took **63.276s**, so it is functional evidence,
  not a warning-free claim. TypeScript, Prettier, diff, architecture **30/30** plus its live 65-file boundary and three
  scheduled guards (**1/1 each**), migrations **5/5** at 38/head `0038`, and scanner **35/35** pass. Focused ESLint exits zero
  with 14 pre-existing `import/first` warnings in the error-report queue test.

  Inventory is **1,074 / 581 proved (487 coordinated + 94 temporal) / 493 unproven / 0 structural / 0 nested / 0
  membership**. The two new shared-factory findings remain deliberately unproven; this prerequisite does not claim the
  caller's inactive-retirement selection/claim writes. Sync/realtime propagation, initial snapshot, inactive and
  conformance claims, recovery, unscoped fallback, raw definitions, exact-device/process-kill, and remaining-inventory
  proof stay open. Child `DB-02A-ATTACHMENT-CACHE-CHAT-SEND-SCOPE` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**,
  and `TEST-01` remains open.

- **2026-08-13 — `DB-02A-ATTACHMENT-CACHE-INACTIVE-RETIREMENT-CLAIM-OWNER` explicit tracked inactive claim:**
  Ordinary chat/send cleanup now carries its exact account scope into a source-local tracked branch of
  `retireInactiveEntries`. One guarded transaction reads the bounded inactive list, excludes current in-memory owners,
  claims exact eligible ledger rows, and clears every matching attachment reference atomically. An outgoing-protected
  first claim keeps the same transaction and retries only safe siblings once. Guard rejection returns `stale`, pending
  path ownership clears in `finally`, and native deletion starts only after commit and outside the database mutex.

  Real-SQLite tests distinguish `runTracked` from the recovery/unscoped transaction fallback, observe the semantic
  inactive-list query inside the transaction, and prove all-reference clear plus ledger claim rollback together when
  the final clear fails. They retain outgoing and synchronous-pin refusal, release pending ownership for same-path
  retry, and prove bounded **100 + 1** claims. Production chat deletion queues the tracked claim behind a rolling-back
  neighbour; Disconnect waits for admitted work, revocation leaves the active row and both references unchanged with
  no native delete, and a fresh generation completes the claim and retirement outside the mutex.

  The first source draft was discarded before test edits because a shared `claimInactivePaths` helper hid both claim
  writes from the scanner as unresolved; coordinated inventory would therefore have overstated mechanically visible
  ownership. The final branch keeps the tracked writes inline. The first saved tests passed **2/57**. Skeptical and
  inventory review then found two mutation survivors: moving the inactive list outside its owner and removing the
  tracked path's 100-row bound. A semantic query observation plus a **101 → 100 + 1** case close both gaps. Final direct
  **2/58/0** in **6.108s** and focused **7/137/0** in **15.218s** pass under pinned Node 24.19.0.

  Frozen coordinator/coordinator-test/chat-test/inventory SHA-256 values are
  `4e4cea77fe4e9fe2275f1bea71b084720fe848177576ad0cbeda304559ef16c0`,
  `0bc86051b73ad9a2a6aa081da58ab66c7068176ee7f80b83399e2b188fdccd6e`,
  `a94ff47f7fa9e64b2597720936abc9d791e6b36df5c282870c055ec987267fab`, and
  `41043f39b5519aed6fbf9bc80ee6f250fe7af286378d3f6a6eb54d6029219e2c`. The complete functional gate passes **399
  suites / 4,340 tests / 0 snapshots** under `--silent` in **105.641s**; this is functional evidence, not a warning-free
  claim. TypeScript, targeted lint, Prettier, diff, architecture **30/30** plus its live 65-file boundary and three
  scheduled guards (**1/1 each**), migrations **5/5** at 38/head `0038`, and scanner **35/35** pass. Inventory is
  **1,078 / 585 proved (491 coordinated + 94 temporal) / 493 unproven / 0 structural / 0 nested / 0 membership**. The
  stricter approval check still intentionally exits at the first known unproven layout record; that expected backlog
  signal ran once outside the required structural gate and was not retried.

  Exactly four inline tracked-production findings close. Recovery and unscoped inactive claims, conformance and initial
  quota-snapshot ownership, sync/realtime propagation, outer caller and transaction-neutral raw-definition edges,
  aggregate cache lifecycle, exact op-sqlite/SQLCipher, process-kill, physical-device, remaining-inventory, `DB-02B`,
  and `DB-02C` proof stay open. Child `DB-02A-ATTACHMENT-CACHE-INACTIVE-RETIREMENT-CLAIM-OWNER` is **DONE**; parent
  `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-13 — `DB-02A` reusable proof/reconciliation tooling:** Added a small reusable ownership-test harness and
  a fail-closed reconciliation mode to the existing DB-write scanner. The harness owns rolling-neighbour release,
  deliberate rollback, early setup/BEGIN rejection, observable pending state, and idempotent cleanup. The reconciler
  automates only line movement, uniquely proved callback rekeys with an unchanged mutator snippet, and new `unproven`
  skeletons; it refuses stale, semantic, context, duplicate, and ambiguous changes. The package command defaults to a
  dry run, while `-- --write` is an explicit reviewed atomic replacement.

  Frozen scanner/scanner-test/harness/harness-test/package/inventory SHA-256 values are
  `25413c87ed936c2394493218aa8a35d7d3946cc93762eaf3fdbdec9ce41f5268`,
  `8974bb864dcd65a1068c21915837e4ba5d3f7e3cbd923d788855d7c245305dce`,
  `5f602e2c32cc8759d25ec39cf9047ac0cedb8b0c2dd097e725c75e2f2c110bd4`,
  `7a2bcb61f6f067cc39b0ae037a2a7e41bbd12d56a65dc42dbd53dd500da7e72f`,
  `7d5609b50953e459e04e6928734e304e74aa6ce1c7ced7402b43fe6f3ebc4210`, and
  `41043f39b5519aed6fbf9bc80ee6f250fe7af286378d3f6a6eb54d6029219e2c`. Scanner/reconciler tests pass **48/48**;
  harness tests pass **5/5**; Node syntax, TypeScript, focused TypeScript lint, Prettier, and diff checks pass. Both the
  direct and npm live previews report **0 line shifts / 0 rekeys / 0 additions**, leave the inventory byte-identical,
  and the live scanner remains **1,078 findings / 0 structural or membership errors**. This tooling-only slice changes
  no production behavior, proves or promotes no inventory record, and intentionally does not consume another full-app
  gate. `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-14 — `DB-02A-ATTACHMENT-CACHE-TRACKED-RECOVERY-PLANNING-OWNER` tracked recovery and quota planning:**
  Startup recovery now validates the complete native manifest before its first mutation-capable scope, then adopts each
  at-most-100-file page through the account scope's transaction-neutral `runTracked` lifetime around one source-local,
  commit-guarded `withDbTransaction`. Admission and current-quota conformance likewise take their fresh quota snapshots
  through explicit tracked guarded owners; conformance claims at most 100 exact retirement paths in a separate guarded
  commit. Native scan, free-space inspection, and file deletion remain outside the database mutex. The explicit
  transaction-scope compatibility branches remain unchanged.

  Real-SQLite recovery tests place each adoption owner behind a rolling-back neighbour, prove queued account-generation
  revocation leaves both ledger and attachment reference untouched before a fresh generation succeeds, reject a late
  duplicate before any page is adopted, and pin **101 files as 100 + 1 transactions**. Coordinator tests observe each
  tracked admission/conformance snapshot inside its transaction, pin conformance retirement at **100 + 1 claims** with
  native deletion outside the mutex, force final-reference-clear failure and whole-claim rollback, prove pending-path
  cleanup permits retry, reject a generation revoked before commit, and retain the explicit transaction-scope fallback.

  The ordinary reconciler correctly stopped on an ambiguous many-to-many `planAdmissionStep` group. Exact semantic-ID
  review preserved four coordinated and three unproven inactive-retirement callback rekeys, replaced only the three
  former unproven recovery-adoption records, and added five tracked planning/claim records. The eight newly coordinated
  suffixes are `71f05d67903d`, `75078a0a985e`, `d607bbd5b418`, `9ac0064005fa`, `cb1bfc109f34`,
  `807b4b5d0e88`, `8e297c53e5e4`, and `911c88673979`. Frozen recovery/coordinator/recovery-test/coordinator-test/inventory
  SHA-256 values are `35da99952ef17bb9f84945d856f2ba07593766dcd31015d26ffd5a8a595af3f8`,
  `9bb94656e84b0e80775eea6dcacc417b24ccff580623a9128149718c83ee8502`,
  `c7b971c552d8204dca27368a8ea75d904c1c2d689c6ae8f1e81f325b86480ae6`,
  `88730ba2279e3616ed5a1765d89b24995d7b9d641c38f0fc59dcc8544edc1d14`, and
  `85614e28a8604cdafdf4aa1cc1a4a77faec8ee3611212b80d467dfd5ca70f9ab`.

  Final direct **2 suites / 57 tests / 0 snapshots** pass in **5.791s** and focused **7 / 143 / 0** in **17.268s**.
  The complete noninteractive CI-mode functional gate passes **400 suites / 4,351 tests / 0 snapshots** in **60.121s**;
  this supersedes an unrelated interactive wrapper timeout and remains functional evidence, not a warning-free claim.
  TypeScript, targeted lint, configured formatting, diff, architecture **30/30**, migrations **5/5** at 38/head `0038`,
  and scanner **48/48** pass. Live inventory is **1,083 / 593 proved (499 coordinated + 94 temporal) / 490 unproven /
  0 structural / 0 nested / 0 membership**.

  The transaction-scope/unscoped compatibility branches, outer recovery/planner callers, and transaction-neutral
  repository definitions remain deliberately unproven. Sync/realtime account-scope propagation, aggregate cache
  lifecycle, exact op-sqlite/SQLCipher behavior, process-kill/physical-device evidence, remaining inventory, `DB-02B`,
  and `DB-02C` stay open; returned snapshot/claim pages are capped, but this child does not claim an absolute transaction-
  duration bound. Child `DB-02A-ATTACHMENT-CACHE-TRACKED-RECOVERY-PLANNING-OWNER` is **DONE**; parent `DB-02A` remains
  **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-14 — `DB-02A-ATTACHMENT-CACHE-SYNC-REALTIME-SCOPE` sync/realtime account-scope propagation:** Foreground
  sync now captures its account lease before database open, folds lease currentness into the existing session-ended
  guard, creates one attachment-cache account scope only after current-account database admission, and reuses that exact
  scope for startup retire → drain and post-deletion retire → drain. Durable realtime deletion cleanup now fails closed
  when its delivery context is missing or stale, derives one scope from the exact current context, and uses it for
  retire → drain.

  Mutation-sensitive sync coverage pins pre-open lease capture, one exact `{db, lease}` scope construction, the ordered
  retire → drain → retire → drain sequence, and lease-only revocation without an epoch change suppressing trailing
  cleanup plus old-account banner/contact effects. Realtime coverage pins exact context propagation, one same-scope
  retire → drain sequence, and zero cleanup for missing or stale contexts. The first saved direct run passed **2 suites /
  40 tests / 0 snapshots** in **7.422s**; skeptical mutation review found that removing the lease half of `sessionEnded`
  still survived, so the lease-only case was added. The strengthened direct run passes **2 / 41 / 0** in **7.071s**, and
  the focused cache matrix passes **8 / 171 / 0** in **7.2s**.

  Frozen sync-source/realtime-source/sync-test/realtime-test/inventory SHA-256 values are
  `fbb240f099e798b6fca74d41310ef08786025e60664fd7ee688588c8fbbbdf65`,
  `85b5f1372332dbac33165447259f8c471004e54893e3c234b4425b0719fee8a5`,
  `c06353f3ac5e7a93edb264b79d442318d0c08193976894b77b71cac960d4f9e3`,
  `21307cf3c57195fc4a1f7e77953f5e22e3a38680882ee904b16aa741faa1d2b0`, and
  `dbe8d2d3696cc8c3334050f50e0e50013500632229117158b4086e4cf4f01c29`.

  The complete noninteractive CI-mode functional gate passes **400 suites / 4,355 tests / 0 snapshots** in **89.289s**.
  TypeScript, configured formatting, diff, architecture **30/30** with its live **65-core-file** boundary and three
  scheduled guards (**1/1 each**), migrations **5/5** at 38/head `0038`, and scanner **48/48** pass. ESLint reports
  **0 errors** and four pre-existing `import/first` warnings, so this remains functional evidence, not a warning-free
  claim. The live inventory and reconciliation preview report **1,083 / 593 proved (499 coordinated + 94 temporal) /
  490 unproven / 0 structural / 0 nested / 0 membership** and **0 line shifts / 0 rekeys / 0 additions**.

  This behavioral prerequisite promotes no DB-write record and changes no inventory classification. It closes only the
  prior sync/realtime account-scope propagation residual. Transaction-scope/unscoped compatibility branches, outer
  recovery/planner callers, transaction-neutral repository definitions, aggregate cache lifecycle, exact op-sqlite/
  SQLCipher behavior, process-kill/physical-device evidence, remaining inventory, `DB-02B`, and `DB-02C` stay open.
  Child `DB-02A-ATTACHMENT-CACHE-SYNC-REALTIME-SCOPE` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and
  `TEST-01` remains open.

- **2026-08-15 — `DB-02A-ATTACHMENT-CACHE-TRACKED-DRAIN-LIST-RECHECK-OWNER` tracked due-list and recheck owners:**
  Account-scoped `drainDueRetirements` now takes its bounded due-list snapshot and its post-gate exact-path recheck
  through two separate transaction-neutral `runTracked` lifetimes. Each lifetime surrounds one source-local,
  account-guarded `withDbTransaction`; a path promoted from `reserved` to `active` after the snapshot is re-read before
  native-delete ownership is granted. Native deletion remains outside the database mutex. The explicit transaction-scope
  and unscoped compatibility branches retain their existing `runTransaction` fallback.

  The first saved exact coordinator/account-scope/recovery run passed **3 suites / 80 tests / 0 snapshots** in **10.485s**
  (real **10.99s**). Skeptical mutation review then found that deleting the due-list commit guard could still reach the
  later stale recheck and survive; the strengthened production-composition proof now requires queued revocation to reject
  before the due-list SQL runs. An independent audit then blocked the freeze because the 100-row limit was only statically
  visible. One 101-row case now proves an oversized first drain attempts and confirms exactly **100**, retains exactly
  **1**, then a second drain attempts and confirms that final row; all **101** native deletes observe
  `raw.inTransaction === false`. The first post-strengthening run passed **3/81/0** in **6.224s** (real **6.77s**), and
  the formatted final run passes **3/81/0** in **5.817s** (real **6.23s**). No source correction or rollback followed
  either review.

  Scanner reconciliation adds exactly two coordinated source-local openers: due-list `b3591dcd08ea` and recheck
  `5be4ec4c94d8`. The fallback rekeys `c7fd9cae2f23` → `e876c83ad518` without changing its unproven disposition, while
  `a777bbd94487` remains preserved and unproven. Frozen coordinator/account-scope/coordinator-test/account-test/
  recovery-test/ownership-harness/inventory SHA-256 values are
  `652e2cc4a9198b5bb897605c5115d8dccebe4f57726849b3be238e31644029d0`,
  `8aba08631acb2e064f6fbd8f45ed8149eb1d7b082f4791d3c4d583cbae3fc059`,
  `0e693d63747e8b58d8e7407e6700ecefb04f4dda815371916f58bd91686afb0a`,
  `8998e6e97df9e24cb22528c67bea1bd4ac280762d4a5f49ccbfc4421cc421a59`,
  `c7b971c552d8204dca27368a8ea75d904c1c2d689c6ae8f1e81f325b86480ae6`,
  `5f602e2c32cc8759d25ec39cf9047ac0cedb8b0c2dd097e725c75e2f2c110bd4`, and
  `6d57ec244203dcc13efbd2e2fcc5c25a03b267b64ac20bebb8a30feff41eccfb`.

  The focused cache matrix passes **8 suites / 175 tests / 0 snapshots** in **12.886s**. The complete single-run
  noninteractive CI-mode functional gate passes **400 suites / 4,359 tests / 0 snapshots** in **141.095s**. TypeScript,
  zero-error ESLint,
  configured formatting, diff, architecture **30/30** with its live **65-core-file** boundary and three scheduled guards
  (**1/1 each**), migrations **5/5** across 38 migrations at head `0038`, and scanner **48/48** pass. The live scanner
  reports **1,085 findings / 0 structural or membership errors**, with **0 nested coordinators**; reconciliation reports
  **0 line shifts / 0 rekeys / 0 additions**. Inventory is **1,085 / 595 proved (501 coordinated + 94 temporal) / 490
  unproven**.

  This child closes exactly the two tracked source-local opener records. Transaction-scope/unscoped fallback edges and
  outer callers remain unproven. The 100-row database list cap does not bound native-delete latency or total drain
  duration. Aggregate cache lifecycle, exact op-sqlite/SQLCipher behavior,
  process-kill/physical-device evidence, remaining inventory, `DB-02B`, and `DB-02C` stay open. Child
  `DB-02A-ATTACHMENT-CACHE-TRACKED-DRAIN-LIST-RECHECK-OWNER` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and
  `TEST-01` remains open.

- **2026-08-15 — `DB-02A-ATTACHMENT-CACHE-COMPATIBILITY-RETIREMENT` direct unscoped owners:** The attachment-cache
  coordinator's standalone/unscoped paths no longer dispatch through the polymorphic `runTransaction` compatibility
  helper. Source-local `withDbTransaction` owners now cover inactive list/claim, due list/recheck, admission snapshot/
  reservation/claim, conformance snapshot/claim, reuse access/missing-file repair, and settlement confirmation/retry.
  Account-scoped production branches retain `runTracked` around those local guarded transactions. Recovery's separate
  ledger-list `scope.runTransaction` owner and the `AttachmentCacheTransactionScope` interface remain outside this child.

  Mutation-sensitive coverage proves the relevant unscoped SQL executes with `raw.inTransaction === true` while native
  stat, free-space, and delete work stays outside the database transaction; it also preserves the due-list A → queued
  promotion B → exact recheck C race, tracked sentinels, revocation, rollback, and **100 + 1** bounds. The first saved
  harness incorrectly awaited a queued promotion from a COMMIT spy while the outer queue slot was still owned, reproducing
  a test-only nested-queue wedge; it was stopped with SIGINT (**exit 130**) after **54.78s** and was never accepted as a
  gate. The corrected post-owner seam exposed one invalid concurrent assertion: the exact pinned run passed **80/81**
  because the test assumed the process-global `raw.inTransaction` flag must be false while another operation could
  legitimately own the shared transaction. After a stop-and-rethink removed only that ambiguous instrumentation, the
  final direct run passed **3 suites / 81 tests / 0 snapshots** in **6.242s** (real **6.81s**).

  Exact scanner review promotes **27** records: inactive **4**, due-list/recheck **2**, admission **7**, conformance **4**,
  reuse **4**, and settlement **6**. Ten explicit outer/handoff edges remain unproven: reserve → drain/plan/settle (**3**),
  conform → drain/plan/settle (**3**), reuse-existing → reuse-protected (**1**), retire-inactive → settle (**1**),
  drain-due → settle (**1**), and reservation-release → drain (**1**). Frozen coordinator/recovery/coordinator-test/
  account-test/recovery-test/inventory SHA-256 values are
  `bf378631f0cd929f999ba562ca4b523c11b582b405f352dc056cae70ab871dbd`,
  `7d5804fb60d3347029f26d99dcd05b3ea3e6d6d5b5c5833e33dce831c25cdfe3`,
  `30cbd7abac5216bb2281c174b0ff76a80f335b689121f9be14a04e953ce89969`,
  `8998e6e97df9e24cb22528c67bea1bd4ac280762d4a5f49ccbfc4421cc421a59`,
  `c7b971c552d8204dca27368a8ea75d904c1c2d689c6ae8f1e81f325b86480ae6`, and
  `586a2838a708c70acb3eae6e4611b7cd1c2f277fcb44ad480369189e0fc2b003`.

  The focused cache matrix passes **8 suites / 175 tests / 0 snapshots** in **13.362s**. The authoritative managed full
  gate exits **0** with **400 suites / 4,359 tests / 0 snapshots** in **799.937s**. One unchanged
  `chatScreenReadMarker` suite took **735.137s** during a host stall but passed; an earlier detached process lost its
  aggregate output and is inconclusive, so it is not counted. TypeScript, zero-error ESLint, configured formatting, diff,
  architecture **30/30** with its live **65-core-file** boundary and three scheduled guards (**1/1 each**), migrations
  **5/5** across 38 migrations at head `0038`, and scanner **48/48** pass. No Jest process remains active. The live scanner
  reports **1,089 findings / 0 structural or membership errors**, with **0 nested coordinators**; reconciliation reports
  **0 line shifts / 0 rekeys / 0 additions**. Inventory is **1,089 / 622 proved (528 coordinated + 94 temporal) / 467
  unproven**.

  This host-green child closes only the 27 direct unscoped coordinator records. The ten outer/handoff edges, recovery
  ledger-list compatibility owner, transaction-neutral repository definitions, aggregate cache lifecycle and duration,
  exact op-sqlite/SQLCipher behavior, process-kill/physical-device evidence, remaining inventory, `DB-02B`, and `DB-02C`
  stay open. A **100-row database cap does not bound total native-delete latency**. Child
  `DB-02A-ATTACHMENT-CACHE-COMPATIBILITY-RETIREMENT` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`
  remains open.

- **2026-08-15 — `DB-02A-DB-REKEY-SELFTEST-THROWAWAY-EXCLUSION` fixed throwaway isolation:** The DEV-only database
  rekey self-test still opens only the fixed `rekey-selftest.db`, never the production `gator.db`. Preflight found that
  its primary-key, reopened-new-key, and stale-old-key handles could remain open when their reads or writes rejected, and
  that the broad stale-handle catch could misclassify a close failure as proof that the old key was rejected. Each keyed
  handle now closes from its own `finally`, while only the stale `SELECT` rejection sets `oldRejected`; best-effort
  prewipe and final-wipe deletion remain scoped to the fixed throwaway name.

  The first source save passed its static checks, but scanner reconciliation correctly rejected a local `db` identifier
  rename because it would needlessly disturb stable record identity. Restoring that name was a mechanical-only correction:
  all six scanner IDs remain stable, with **4 line shifts / 0 rekeys / 0 additions**. A local op-sqlite mock pins the exact
  five-handle success sequence—prewipe, key A, key B, stale key A, final wipe—plus exact open options, key relationships,
  CREATE → INSERT → PRAGMA → new-key SELECT → stale-key SELECT order, close attempts, and cleanup. Separate PRAGMA and
  new-key read failures prove every opened keyed handle closes before the final wipe; a compact close-failure case proves
  close failure is not old-key rejection. The first saved and final direct gate passes **1 suite / 10 tests / 0 snapshots**
  in **4.715s**, with no test correction. One attempted standalone `tsc -p tsconfig.test.json` was an invalid repository
  invocation because that config's legacy module resolution conflicts with inherited custom conditions; repo TypeScript
  and the exact ts-jest suite are green.

  The fixed-name delete, prewipe call, schema create, insert, rekey PRAGMA, and final-wipe call are now exactly six
  `proven-temporal-exclusion` records. Frozen source/test/inventory SHA-256 values are
  `f6a0aa7d4d25745c0158c4dd845a0727215b1266714fcc65185b96dad82a9465`,
  `fdde8433555890c70ffd0cfdebcd131238e3852c095a08d286cffe67cc1f9f3e`, and
  `cedf1ffd92d2054380c9d1b0d39daa4c610a1e9789a70d87fa668b6c3a48d84d`. Inventory remains **1,089** total and is now
  **628 proved (528 coordinated + 100 temporal) / 461 unproven**.

  The focused ownership matrix passes **4 suites / 103 tests / 0 snapshots** in **5.143s**. The complete functional gate
  exits **0** with **400 suites / 4,363 tests / 0 snapshots** in **80.454s**. Scanner tests pass **48/48** in **8.562s**;
  the live report is **1,089 / 0 structural or membership errors**, with **0 nested coordinators**, and reconciliation is
  **0 line shifts / 0 rekeys / 0 additions**. TypeScript, zero-error ESLint, configured formatting, diff, architecture
  **30/30** in **6.945s** with its live **65-core-file** boundary and three scheduled guards (**1/1 each**), and migrations
  **5/5** across 38 migrations at head `0038` pass. No Jest process remains active.

  This host proof establishes JavaScript filename/options/order and cleanup behavior only. It does **not** prove native
  SQLCipher re-encryption, native filesystem deletion or path resolution, concurrent native handles, process-kill,
  exact-candidate, or physical-device behavior. The DEV foreground `startProcessWork → runDbRekeySelfTest` caller remains
  unproven, and the device checklist stays open. Child `DB-02A-DB-REKEY-SELFTEST-THROWAWAY-EXCLUSION` is **DONE**; parent
  `DB-02A` remains **IN_PROGRESS**, and `TEST-01` remains open.

- **2026-08-15 — `DB-02A-RUNTIME-TRANSACTION-CONTEXT-JOIN` authenticated transaction-only joins:** The first
  prototype used only a branded TypeScript database type. Skeptical review showed that a cast, `any`, or an escaped
  handle could forge or outlive that compile-time brand, so the prototype was abandoned and reverted byte-for-byte
  before the production design proceeded. The retained design gives every `withDbTransaction` owner a frozen, opaque
  `DbTransactionContext` backed by a private `WeakMap`; transaction-only helpers must enter through
  `runInTransactionContext` rather than accepting a raw database handle as proof of ownership.

  Registration is synchronous. The owner stops accepting joins as soon as its callback settles, then all-settles every
  task that registered in time before deciding whether to commit or roll back. An attempted late join latches a context
  violation and forces rollback even if its returned rejection is ignored. The private token is removed before the
  final guard and `COMMIT`, so stale, forged, cross-owner, and post-owner contexts reject. This authenticates a helper's
  membership in the current transaction; callers must still keep the token inside the owner callback, must not pass it
  to unrelated code, and must never capture the raw callback database for later use.

  The scanner recognizes only the exact imported `runInTransactionContext` called with an inline callback when the
  guard call itself is awaited or returned. Named callbacks, dynamic or namespace dispatch, lookalikes, unadopted
  promises, and returns that an enclosing `finally` can replace all fail closed. The guard does not invent a separate
  write finding; it supplies mechanically checked ownership context for the writes in its callback, while existing
  transitive nested-coordinator detection remains active. One explicit limitation remains: a generic finding ID does
  not encode whether a future edit removes the outer `await`. The exact promoted surface therefore also received a
  manual TypeScript-AST audit, and all 52 paths are currently awaited or returned.

  The batch migrated **25 transaction-only owner bodies** and promoted exactly **52** formerly unproven findings. An
  independent AST audit counted **112 calls** on the reviewed paths, with **0 database/context escapes** and **0 nested
  coordinator paths**. The two durable incoming-event records remain deliberately open:
  `e5c8469dbfa3` (`markIncomingEventDbAppliedWithinTransaction`) and `1939ccb043fe`
  (`durableContext.markDbAppliedWithinTransaction`). The exact inventory is now **1,089 entries / 680 proved (580
  coordinated + 100 temporal) / 409 unproven / 0 structural errors / 0 nested coordinators / 0 membership errors**;
  reconciliation is **0 line shifts / 0 rekeys / 0 additions**. Frozen SHA-256 values are inventory
  `1eedb2712217d6b3cf2617d54367ad1af8921ce19a1a151de2212f9353c9ac3a`, transaction runtime
  `9d590bd3ceb2fc535a72613b253a6ae6a7322fd75b1d984942dffd27e2c67411`, scanner
  `09a7f2de341918925aa9a2875bb87248808566a4a298f842f803422534e490ea`, and scanner tests
  `971dc58f1ea83adc150d11e9048413bf5814f678fde325a773e8e25df6e49719`.

  Scanner tests pass **52/52** in **6.38s**. The combined focused matrix passes **27 Node suites / 487 tests** in
  **61.505s** plus **2 component suites / 36 tests** in **2.091s**, for **29 suites / 523 tests** total. The first full
  run reached **399/400 suites and 4,367/4,369 tests** in **253.701s**, exposing a cascade in two `markUnread` tests
  whose test-only wait stopped after 20 microtasks; an isolated run reproduced it. The harness was changed to a bounded
  event-loop wait with an explicit fail-safe (test SHA-256
  `bb9c6f821a5455d1c80f9fc5ca675388acc9503f89d028d2e89ab15729ce19ac`), and its isolated suite passes **1/11** in
  **5.289s**. The final full functional gate exits **0** with **400 suites / 4,369 tests / 0 snapshots** in **62.069s**.

  TypeScript, zero-error ESLint, configured Prettier, architecture **30/30** over **65 core files**, all three scheduled
  guards (**1/1 each**), and migrations **5/5** across 38 migrations at head `0038` pass. This is host proof of the
  JavaScript runtime/context and exact reviewed ownership paths. It does **not** prove op-sqlite/SQLCipher device or
  process-kill behavior, exact-candidate behavior, or an absolute row/byte/duration bound for every callback. The two
  durable records above, the remaining **409** findings, primary `DB-02B`/`DB-02C`, and device evidence remain open.
  Child `DB-02A-RUNTIME-TRANSACTION-CONTEXT-JOIN` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**, and `TEST-01`
  remains open.

- **2026-08-16 — `DB-02A-INCOMING-EVENT-LIFECYCLE` durable intake through settlement:** This lean milestone resolved
  the exact **35-row** source-local backlog in `incomingEvents.ts`, `incomingEventDrain.ts`, and
  `incomingEventDispatcher.ts`: **34 live findings became coordinated**, while one compile-time-only `ReturnType`
  reference was removed from runtime inventory. The durable DB-applied checkpoint now requires the exact active opaque
  transaction context and joins that owner inline, so the domain write and queue checkpoint commit or roll back
  together. Receipt, claim, retry, completion, poison, and maintenance clocks are read at their ownership boundary;
  dispatcher receipt time is captured before FIFO waiting.

  Attempt authority is revoked after every settlement path. Detached attachment downloads and wallpaper refreshes do
  not receive the attempt context or durable checkpoint capability; each captures a fresh account-generation lease.
  Deferred recovery uses the exact dynamic delivery guard, and the intentionally soft lease remains fenced by claim
  token plus version takeover. The scanner's new `coordinated-delegation` proof is eligible only in the drain and
  dispatcher files, is never inherited as transaction membership, and uses backward unsafe-taint checks for raw writes,
  scheduled callbacks, dynamic dispatch, references, and ordinary call edges. Outer transport/composition callers stay
  unproven for a later milestone.

  The exact inventory is **1,088 entries / 714 proved (614 coordinated + 100 temporal) / 374 unproven**, with **0
  structural or membership errors**, **0 nested coordinators**, and reconciliation at **0 line shifts / 0 rekeys / 0
  additions**. Scanner mutation tests pass **55/55**; the focused lifecycle matrix passes **11 suites / 219 tests / 0
  snapshots**. TypeScript, zero-error ESLint, configured formatting, diff checks, architecture **30/30** plus the live
  **65-core-file** boundary and scheduled-owner guards, and migrations **5/5** across 38 migrations at head `0038` pass.
  The first full run reached **399/400 suites and 4,375/4,376 tests** before an unrelated conversation-list test exceeded
  its 5-second timeout under full-run load; that suite passed unchanged **32/32** in isolation, and the unchanged full
  rerun exits **0** with **400 suites / 4,376 tests / 0 snapshots** in **230.996s**.

  Remaining work is explicit: maintenance-triggered terminalization does not yet directly emit recovery, lease expiry is
  soft until a fenced takeover, and host tests do not prove native cancellation, op-sqlite/SQLCipher, process-death,
  killed-connected-FCM, exact-candidate, or server `attemptGuid` behavior. `PUSH-RETRY-01`, outer ingress ownership, the
  remaining **374** findings, and device evidence stay open. Child `DB-02A-INCOMING-EVENT-LIFECYCLE` is **DONE**; parent
  `DB-02A` remains **IN_PROGRESS**.

- **2026-08-16 — `DB-02A-DB-OPEN-LIFECYCLE` exact first-open temporal exclusion:** The encrypted database's first
  process-local open is now one mechanically proved single-flight lifecycle. `ensureDatabase` publishes the shared
  promise synchronously before its first suspension and clears only that exact attempt on either outcome. `initDatabase`
  keeps the native handle private through the awaited foreign-key PRAGMA, migrations, and Drizzle construction, then
  publishes the raw/wrapped pair without another suspension; any failure closes the unpublished handle and rethrows the
  original error. Crash-recovery probing closes both readable and wrong-key handles, promotes a pending key only after a
  positive read, and preserves both vault candidates when neither key can be proved. Notification routing retains its
  lazy native boundary through `notificationDatabase.ts`, but that helper makes the formerly hidden database-open caller
  explicit to the inventory.

  The scanner's `startup-single-flight-delegation` certificate requires the exact TypeScript symbols and source shape:
  one named native-open and Drizzle import/reference, one initializer and migration entry, synchronous `??=` admission,
  identity-fenced two-sided cleanup, awaited initialization, delayed publication, and close-plus-original-rethrow on
  failure. Mutation fixtures revoke the entire proof for reordered or detached work, default parameters, state
  replacement (including destructuring/loop targets), additional or dynamic entry points, namespace/local aliases,
  CommonJS/import-equals loads, JavaScript-extension substitutions, and dotted barrel paths. Driver-adapter findings
  remain explicitly unproven rather than inheriting this temporal context.

  The exact milestone promotes **26 findings**: **25 `startup-single-flight-delegation`** records plus the direct
  `initDatabase` → `runMigrations` **`startup-initialization`** edge. Inventory is **1,089 entries / 740 proved (614
  coordinated + 126 temporal) / 349 unproven**, with **0 structural or membership errors**, **0 nested coordinators**,
  and reconciliation at **0 line shifts / 0 rekeys / 0 additions**. Scanner tests pass **59/59**; the focused open,
  migration, key-recovery, notification, and foreground-boot matrix passes **6 suites / 50 tests / 0 snapshots**.
  TypeScript, zero-error ESLint, configured formatting, diff checks, architecture **30/30** plus the live
  **65-core-file** boundary and scheduled-owner guards, and migrations **5/5** across 38 migrations at head `0038` pass.
  The full gate exits **0** with **400 suites / 4,385 tests / 0 snapshots** in **101.627s**.

  This host proof does not establish native op-sqlite/SQLCipher wrong-key, close, file-lock, or migration behavior;
  process death during open/migration; same-ReactContext killed-FCM races; or an exact release candidate on a physical
  device. Outer realtime/FCM/DEV composition ownership and the remaining **349** findings stay open. Child
  `DB-02A-DB-OPEN-LIFECYCLE` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-17 — `DB-02A-INCOMING-INGRESS-LIFECYCLE` direct transport admission and revocation:** The exact direct
  socket, eligible unlocked-FCM, and DEV paths now enter the durable incoming-event queue through one tracked,
  generation-fenced admission boundary. Raw callback data, occurrence identity, and receipt time are captured
  synchronously before database-open or FIFO waits. FCM callbacks reserve one process-local FIFO slot at receipt,
  socket replacement retires the previous lifecycle before reopening, and pause/account invalidation waits for admitted
  work while disposing the old dispatcher and drain. Locked legacy/V2 FCM retains the deliberate
  generic-notice/no-database exception; authenticated, active-bound V3 first persists only its canonical durable
  admission and still produces no content effect until unlock. DEV entry points retain both release-mode and
  account-lease gates.

  The scanner's **`incoming-ingress-delegation`** context is an exact edge-level coordination proof, never inherited
  transaction membership. Its certificate binds the reviewed socket, FCM, dispatcher, delivery-coordinator, runtime,
  codec, and DEV source shapes by TypeScript symbol and fails closed on aliases or shadowed globals; detached or
  reordered FIFO work; missing lease, lock, session, generation, persistence, or disposal guards; mutable snapshot
  reuse; alternate native registration; and untracked admission. Exactly **22 findings** are coordinated. Seven newly
  visible transport handoffs make the inventory **1,096 entries / 762 proved (636 coordinated + 126 temporal) / 334
  unproven**, with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0 line
  shifts / 0 rekeys / 0 additions**. The six broader edges targeting mixed `startRealtime`/`resumeRealtime` composition
  owners deliberately remain unresolved.

  Scanner mutation tests pass **61/61** and the focused ingress matrix passes **16 suites / 224 tests / 0 snapshots**.
  TypeScript, zero-error ESLint, configured formatting, diff checks, architecture **30/30** plus the live
  **65-core-file** boundary and scheduled-owner guards, and migrations **5/5** across 38 migrations at head `0038` pass.
  The first full run exposed one stale five-argument mock expectation after the new captured-receipt parameter; the
  corrected exact suite passes **30/30**, and the full rerun exits **0** with **401 suites / 4,399 tests / 0 snapshots**
  in **65.105s**.

  This host proof does not authenticate a plaintext FCM envelope to a server/account, prove native Socket.IO/RNFB
  callback ordering or cancellation, killed/background same-ReactContext behavior, process death, op-sqlite/SQLCipher,
  a physical release candidate, or server `attemptGuid` behavior. Those items, the mixed start/resume owners, and the
  remaining **334** findings stay open. Child `DB-02A-INCOMING-INGRESS-LIFECYCLE` is **DONE**; parent `DB-02A` and
  `PUSH-RETRY-01` remain **IN_PROGRESS**.

- **2026-08-17 — `DB-02A-FOREGROUND-UNLOCK-REVOCATION` active-only biometric and cold-boot authority:** Foreground
  unlock now requires an explicit active AppState. A biometric attempt has separate result authority and native
  in-flight ownership: backgrounding or unmounting revokes the result immediately, but the stale Android prompt keeps
  the one prompt slot until its promise settles. Returning active never overlaps it, and a later explicit tap is
  required before a fresh prompt may unlock. Initial null/unknown AppState remains inert until React Native reports an
  explicit active transition.

  The root layout now owns the exact cold-unlock boot run before its first await. A non-active transition or root
  unmount invalidates that exact pending run even if it just reached ready, or invalidates an ordinary loading run; a
  later active transition starts exactly one successor. A normal already-ready run with no pending cold unlock remains
  owned by the connected layout and is not spuriously restarted. `invalidateForegroundBootRun` is a narrow exact-run
  facade over the existing coordinator fence, so a stale run id is a no-op and late stage settlement cannot clear the
  lock or publish connected UI.

  This is a behavioral prerequisite, not a DB-proof promotion. The former single root-start finding was replaced by
  three explicit unresolved lifecycle edges and one existing line shift. All **12** live findings across the root and
  foreground-boot source remain unproven, while `LockScreen` has no DB finding. Inventory is therefore **1,098 entries /
  762 proved (636 coordinated + 126 temporal) / 336 unproven**, with **0 structural or membership errors**, **0 nested
  coordinators**, and reconciliation at **0 line shifts / 0 rekeys / 0 additions**.

  The focused lifecycle matrix passes **7 suites / 122 tests / 0 snapshots**. TypeScript, zero-error ESLint,
  repository-wide formatting, diff checks, architecture **30/30** plus the live **65-core-file** boundary and
  scheduled-owner guards, and migrations **5/5** across 38 migrations at head `0038` pass. The full gate exits **0**
  with **401 suites / 4,414 tests / 0 snapshots** in **87.488s**.

  JavaScript revocation cannot cancel an already-admitted native biometric prompt or the process-global SQLCipher open;
  it only prevents their retired result from publishing settings, connected UI, realtime admission, or an unlock.
  Native AppState ordering, biometric cancellation, SQLCipher handle behavior, process-kill, and physical-candidate
  evidence remain open. Child `DB-02A-FOREGROUND-UNLOCK-REVOCATION` is **DONE**; parent `DB-02A` and `REL-007B2..C`
  remain **IN_PROGRESS**.

- **2026-08-17 — `DB-02A-ERROR-REPORT-REVOCATION-LIFECYCLE` exact consent and account authority:** Error-report
  flushing now publishes one process-wide flight and captures its exact account lease and database before the first
  await. Overlapping callers join that flight; account invalidation aborts its one upload controller; and hydration,
  sink drain, network work, and every queue outcome recheck the captured authority. Consent revocation always retires
  the in-memory sink, serializes a purge against the captured database, and keeps a failed or stale purge as a hard
  barrier rather than letting a later Allow upload old rows. Errors emitted after account admission closes are rejected
  synchronously, so teardown diagnostics cannot enter the next account's ring.

  Both explicit consent choices now write the versioned choice and clear `error_reports` in one guarded transaction.
  This makes rapid Off → Allow ordering and process-restart/headless behavior durable: Allow cannot authorize rows whose
  preceding denial was skipped or whose purge failed, while a failing delete rolls back the choice. Unknown consent
  after a contained hydration failure remains fail-closed without destructively erasing a saved queue.

  The scanner promotes exactly **28** formerly unproven records: **21** source-local
  `coordinated-delegation` edges and **7** exact mixed-composition `error-report-lifecycle-delegation` handoffs. The
  outer certificate distinguishes background, active, and mount AppState branches and fails closed if any reviewed
  handoff is removed, redirected, duplicated into the wrong branch, or replaced. Two newly visible transaction-only
  purge calls grow inventory to **1,100 entries / 792 proved (666 coordinated + 126 temporal) / 308 unproven**, with
  **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0 line shifts / 0 rekeys /
  0 additions**.

  The focused lifecycle matrix passes **13 suites / 264 tests / 0 snapshots**. Scanner mutation tests pass **64/64**;
  TypeScript, zero-error ESLint, repository formatting, diff checks, architecture **30/30** plus the live
  **65-core-file** boundary and scheduled-owner guards, and migrations **5/5** across 38 migrations at head `0038`
  pass. The first full run exposed three stale settings assertions that still expected BEGIN/COMMIT without the new
  in-transaction queue delete (**400/401 suites; 4,423/4,426 tests**). The corrected suite pins
  BEGIN → DELETE → COMMIT and revoked BEGIN → DELETE → ROLLBACK (**27/27**), and the clean full rerun exits **0** with
  **401 suites / 4,426 tests / 0 snapshots** in **65.417s**.

  Abort can stop or contain a client request but cannot recall a POST already accepted by the server. Native
  ErrorUtils/Hermes/fetch ordering, process death, op-sqlite/SQLCipher behavior, physical-candidate/proxy evidence,
  server-side duplicate aggregation, legacy stored consent policy, and pre-runtime native logging remain open. Child
  `DB-02A-ERROR-REPORT-REVOCATION-LIFECYCLE` is **DONE**; parent `DB-02A`, `PRIV-02`, and `LOG-01` remain
  **IN_PROGRESS**.

- **2026-08-17 — `DB-02A-NOTIFICATION-EFFECT-LIFECYCLE` guarded reminder and private-notification effects:** Reminder
  create, update, cancel, notification-press cleanup, and FaceTime-route deletion now pass the captured account lease
  into the final database commit guard. Reminder updates and deletes compare the native notification id they originally
  observed, so a slow stale action cannot overwrite or delete a newer schedule. Native schedule uncertainty is
  compensated with a strict candidate cancel, while a failed cleanup is surfaced instead of being reported as safe.
  Detailed message, alias, and FaceTime presentation also rechecks App Lock after deferred channel/route work and falls
  back to the fixed generic locked notice before any remaining private native write.

  The scanner coordinates exactly **26** formerly unproven findings: **20** in `notifeeService`, **4** in
  `remindersService`, and **2** exact reminder-press handoffs in `actions`. The five reply/reaction/send action edges stay
  unresolved for the separate send lifecycle. Inventory remains **1,100 entries** and advances to **818 proved (692
  coordinated + 126 temporal) / 282 unproven**, with **0 structural or membership errors**, **0 nested coordinators**,
  and reconciliation at **0 line shifts / 0 rekeys / 0 additions**.

  Focused verification passes **4 suites / 146 tests / 0 snapshots**; the complete scanner passes **65/65**. TypeScript,
  zero-error scoped ESLint, scoped formatting, architecture **30/30** plus the live **65-core-file** and scheduled-owner
  guards, and migrations **5/5** across 38 migrations at head `0038` pass. The full Jest gate exits **0** with **401
  suites / 4,439 tests / 0 snapshots**. A bounded independent review found no remaining blocker.

  Host tests do not prove Android notify-kit ordering/cancellation, process-kill behavior, or native op-sqlite/SQLCipher
  behavior. Native notification state and SQLite are coordinated through guarded writes and compensation, not one
  cross-system atomic transaction. The five action-send edges, broader send ordering/cancellation, physical-candidate
  evidence, and `NOTIF-01..03` remain open. Child `DB-02A-NOTIFICATION-EFFECT-LIFECYCLE` is **DONE**; parent `DB-02A`
  remains **IN_PROGRESS**.

- **2026-08-18 — `DB-02A-INTERACTIVE-LEAF-DELEGATION` exact UI/store persistence delegation:** The scanner now
  recognizes exactly **25** leaf call edges that delegate to already coordinated public repository writers: **13** chat
  appearance/customization edges, **6** conversation and scheduled-history controls, and **6** feature/theme preference
  setters. The proof is deliberately narrow: it establishes database-owner delegation only, not account revocation,
  native-effect ordering, or optimistic UI semantics. Exact-ID coverage prevents unrelated calls in the reviewed paths
  from silently joining the milestone; unsafe and dynamic targets continue to fail closed.

  Inventory remains **1,100 entries** and advances to **843 proved (717 coordinated + 126 temporal) / 257 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0 line shifts / 0 rekeys
  / 0 additions**. Focused verification passes **8 suites / 202 tests / 0 snapshots**; the fast scanner passes **65/65
  relevant tests** with one slow mutation sweep intentionally skipped, while the required full scanner passes **66/66**.
  TypeScript, lint, formatting, architecture **30/30** plus live guards, migrations **5/5**, and the full Jest gate pass
  with **401 suites / 4,439 tests / 0 snapshots**.

  Lean milestone operation is now explicit: format precedes scanner/inventory work; homogeneous proof-only batches may
  span 40–60 records; high-risk runtime/native/concurrency batches stay smaller; and the four-minute incoming-ingress
  mutation sweep runs only when scanner/certificate logic changes or parent `DB-02A` closes. The short current handoff is
  `docs/DB_02A_CURRENT.md`. Child `DB-02A-INTERACTIVE-LEAF-DELEGATION` is **DONE**; parent `DB-02A` remains
  **IN_PROGRESS**.

- **2026-08-18 — `DB-02A-ORDINARY-SEND-DELEGATION` exact ordinary-send ownership:** The scanner now coordinates
  exactly **26** formerly unresolved call edges across notification reply/reaction handoff, optimistic
  text/contact/reaction/attachment services, shared send outcome settlement, and outgoing recovery. Every edge delegates
  to a public writer with an already proved short transaction owner; none of these reviewed services opens or nests a
  second coordinator. This is database-owner delegation only: network cancellation, immediate account-revocation
  rollback, scheduled sends, edit/unsend, discard/cache cleanup, and outer UI send wrappers remain outside this child.

  Inventory remains **1,100 entries** and advances to **869 proved (743 coordinated + 126 temporal) / 231 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused
  verification passes **11 suites / 144 tests / 0 snapshots**; the fast scanner passes **66 relevant tests** with one
  intentional skip and the required full scanner passes **67/67**. TypeScript passes, and a bounded independent review
  is GO. No application source changed after the immediately preceding green lint/format, architecture **30/30**,
  migrations **5/5**, and full **401-suite / 4,439-test** gate, so those identical runtime gates were not repeated.

  Child `DB-02A-ORDINARY-SEND-DELEGATION` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-18 — `DB-02A-DEFERRED-SEND-SERVICE-DELEGATION` scheduled and edit/unsend ownership:** Exactly **23**
  formerly unresolved internal service edges now delegate to already proved short transaction owners: one scheduled
  reconciliation snapshot handoff, **12** scheduled-message service edges, and **10** edit/unsend service edges. The
  proof is limited to DB ownership; outer timer/UI callers, network behavior, native scheduling, and account cancellation
  remain separate lifecycle work.

  Inventory remains **1,100 entries** and advances to **892 proved (766 coordinated + 126 temporal) / 208 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused tests
  pass **9 suites / 135 tests / 0 snapshots**; TypeScript and the fast scanner pass (**67 relevant tests**, one intentional
  slow skip), and bounded independent review is GO. This was a reviewed path/ID data-only proof addition, so the unrelated
  incoming-ingress mutation sweep was not repeated; the unchanged scanner algorithm's immediately preceding full run
  passed **67/67**. Application source also remained unchanged from the green lint/format, architecture **30/30**,
  migrations **5/5**, and full **401-suite / 4,439-test** gate.

  Child `DB-02A-DEFERRED-SEND-SERVICE-DELEGATION` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-18 — `DB-02A-SEND-FRONT-DOOR-DELEGATION` public send-facade ownership:** Exactly **21** formerly
  unresolved edges in `src/services/send/index.ts` now delegate to already proved short transaction owners. They cover
  text, contact, reaction, attachment, scheduled-message, retry, discard, and the two post-discard cache-cleanup
  handoffs. The cache calls are safe at this boundary because they open their own short DB owners and perform native
  deletion outside those owners; this child does not certify the cache coordinator's remaining internal lifecycle.

  Inventory remains **1,100 entries** and advances to **913 proved (787 coordinated + 126 temporal) / 187 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused tests
  pass **9 suites / 119 tests / 0 snapshots**; TypeScript and the fast scanner pass (**68 relevant tests**, one intentional
  slow skip), and bounded independent review is GO. This was a reviewed path/ID data-only proof addition, so the
  unchanged scanner algorithm's slow incoming-ingress mutation sweep was not repeated. Application source remained
  unchanged from the immediately preceding green lint/format, architecture **30/30**, migrations **5/5**, and full
  **401-suite / 4,439-test** gate.

  The proof is DB-owner delegation only. Network/native cancellation, outer UI/timer ownership, full attachment-cache
  lifecycle, and device evidence remain open. Child `DB-02A-SEND-FRONT-DOOR-DELEGATION` is **DONE**; parent `DB-02A`
  remains **IN_PROGRESS**.

- **2026-08-18 — `DB-02A-CONVERSATION-ACTION-DELEGATION` chat and DEV operation ownership:** Exactly **32** formerly
  unresolved edges now delegate to already proved short transaction owners: **13** production chat read/unread/delete,
  reminder, scheduled-message, purge, and post-delete cache handoffs plus **19** DEV fixture/send/edit/unsend/reconcile
  handoffs. The scanner pins the exact ID set; existing startup and incoming-ingress contexts in those files retain their
  stronger classifications.

  Inventory remains **1,100 entries** and advances to **945 proved (819 coordinated + 126 temporal) / 155 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused tests
  pass **7 suites / 130 tests / 0 snapshots**; TypeScript and the fast scanner pass (**67 relevant tests**, three
  intentional full-only mutation sweeps), and the two newly deferred error-lifecycle mutation tests pass **2/2** when
  explicitly enabled. The fast scanner now memoizes its immutable whole-project scan across exact-boundary assertions,
  reducing this run from roughly 56 seconds to roughly 15 seconds without removing any assertion.

  This is DB-owner delegation only; production feature gating, account/native lifecycle behavior, and the remaining
  attachment-cache internal graph stay separate. Application source remained unchanged from the prior green lint/format,
  architecture **30/30**, migrations **5/5**, and full **401-suite / 4,439-test** gate. Child
  `DB-02A-CONVERSATION-ACTION-DELEGATION` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-18 — `DB-02A-SYNC-DELEGATION` foreground/background sync ownership:** Exactly **21** formerly unresolved
  edges now delegate to already proved short transaction owners: **10** foreground sync-control handoffs, **5** sync
  engine handoffs, **4** synced-background persistence handoffs, and **2** background-task handoffs. Exact-ID coverage
  preserves the stronger startup, transaction, and error-lifecycle contexts already present in these mixed files.

  Inventory remains **1,100 entries** and advances to **966 proved (840 coordinated + 126 temporal) / 134 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused tests
  pass **7 suites / 108 tests / 0 snapshots**; TypeScript and the memoized fast scanner pass (**68 relevant tests**, three
  intentional full-only mutation sweeps) in about 16 seconds. This reviewed path/ID addition changes no application code,
  so the immediately prior green lint/format, architecture **30/30**, migrations **5/5**, and full **401-suite /
  4,439-test** gate remain the applicable runtime baseline.

  This proof covers DB-owner delegation only; network request semantics, task scheduling, account cancellation, and
  device/process behavior remain separate. Child `DB-02A-SYNC-DELEGATION` is **DONE**; parent `DB-02A` remains
  **IN_PROGRESS**.

- **2026-08-18 — `DB-02A-ATTACHMENT-CACHE-TRANSACTION-CONTEXT` authenticated cache joins:** Ten exported
  attachment-cache mutators, representing **13** write findings, now accept an opaque `DbTransactionContext` and join
  exactly one active owner through the runtime-checked inline helper. Their **10** coordinator and **7** recovery
  handoffs now have DB-owner delegation proof. Native scan, stat, download, free-space, and delete work remains outside
  the short transaction callbacks. Regression coverage rejects stale and forged contexts and proves joined writes roll
  back with their owner.

  Inventory remains **1,100 entries** and advances to **996 proved (870 coordinated + 126 temporal) / 104 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused tests
  pass **8 suites / 231 tests / 0 snapshots**; TypeScript, lint, the full scanner **72/72**, architecture **30/30** with
  **65** core files checked, migrations **5/5** with **38** migrations, and full Jest **401 suites / 4,440 tests** pass.
  Bounded independent review is GO.

  The dynamic account-scope callback remains deliberately unproven, and host evidence does not establish native
  filesystem, op-sqlite/SQLCipher, process-kill, or device behavior. Child
  `DB-02A-ATTACHMENT-CACHE-TRANSACTION-CONTEXT` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-18 — `DB-02A-ATTACHMENT-DOWNLOAD-DELEGATION` UI-to-download ownership:** Exactly **26** formerly
  unresolved edges now delegate to already proved short DB owners: **19** attachment UI call/reference edges, **5**
  download-front-door edges, and **2** download-service edges. The scanner pins the exact set and deliberately leaves
  the generic `runTrackedDownloadTransaction` callback unproven rather than treating arbitrary callback work as safe.

  Inventory remains **1,100 entries** and advances to **1,022 proved (896 coordinated + 126 temporal) / 78 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused tests
  pass **10 suites / 218 tests / 0 snapshots**; TypeScript and the fast scanner pass (**70 tests**, three intentional
  full-only skips), and the exact boundary test passes **1/1**. This data-only proof reuses the immediately preceding
  green lint/format, scanner **72/72**, architecture **30/30**, migrations **5/5**, and full **401-suite / 4,440-test**
  gates because application code did not change.

  This is DB-owner delegation only. Five attachment components still capture the current account lease at invocation
  rather than binding it to the mounted account; native download/filesystem behavior, that account-authority residual,
  and the dynamic cache account-scope callback remain open. Child `DB-02A-ATTACHMENT-DOWNLOAD-DELEGATION` is **DONE**;
  parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-18 — `DB-02A-REPOSITORY-CONTEXT-AND-THIN-DELEGATION` authenticated leaves and bounded callers:** Six
  repository/service write leaves now either own one short transaction or accept the opaque runtime-checked
  `DbTransactionContext` and immediately join the active owner. This covers read-marker reconciliation, handle and KV
  upserts, outgoing-error and sync-marker updates, and bounded search-text batches. The search updater uses only the
  callback-supplied Drizzle database and `UPDATE ... RETURNING`; cache clearing no longer opens a nested writer around
  the public sync-marker owner. The scanner additionally rejects joined callbacks that write through a captured or
  mismatched database handle.

  Exactly **21** formerly unresolved repository and thin caller edges now have DB-owner delegation proof. The public
  wrapper changes add two net scanner records, so inventory is **1,102 entries / 1,045 proved (919 coordinated + 126
  temporal) / 57 unproven**, with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at
  **0/0/0**. Focused tests pass **17 suites / 305 tests / 0 snapshots**; TypeScript, scoped formatting/lint (zero errors),
  and the full scanner pass **71 tests** with three intentional skips. Architecture passes **30/30** with **65** core
  files checked, and migrations pass **5/5** with **38** sequential migrations.

  The milestone-wide Jest run passed **400/401 suites and 4,440/4,441 tests**; its sole failure was an unrelated
  account-screen test exceeding the five-second timeout under the long run, and that exact suite immediately passed
  **13/13** in isolation. Bounded independent review is GO. Contacts' dynamic transaction callback, driver-adapter,
  database-rekey/native crypto, and remaining account/device lifecycle findings stay unproven. Child
  `DB-02A-REPOSITORY-CONTEXT-AND-THIN-DELEGATION` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-19 — `DB-02A-ACCOUNT-TRANSITION-AUTHORITY` mount-bound download and teardown authority:** The download
  front door now requires an explicit account lease. Audio, File, Image, Sticker, and Video attachment components
  capture that lease once at mount and retain it across rerenders, automatic attempts, taps, and retries, preventing a
  retained account-A UI callback from silently adopting account B. Rerender regressions prove each component still
  forwards the original mounted lease.

  The scanner now proves exactly **five** Home, Settings, and realtime transition edges as
  `account-transition-delegation`; same-file scheduled work, key rotation, and mixed realtime resume composition remain
  unresolved, and a target-substitution mutation revokes the entire five-edge certificate. Inventory remains **1,102
  entries** and advances to **1,050 proved (924 coordinated + 126 temporal) / 52 unproven**, with **0 structural or
  membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**.

  Focused tests pass **10 suites / 182 tests**, including the strengthened five-component rerender subset at **5 suites
  / 71 tests**. TypeScript, scoped lint/format, and the full scanner pass (**76/76**). Architecture passes **30/30**
  across **65** core files, migrations pass **5/5** across **38** migrations, and the full Jest set passes in four
  non-overlapping shards: **402 suites / 4,442 tests / 0 snapshots**. Bounded independent review is GO.

  This host proof does not establish native filesystem/download behavior, process death, or device behavior. Bootstrap
  teardown composition, generic/dynamic transaction callbacks, and the remaining inventory stay open. Child
  `DB-02A-ACCOUNT-TRANSITION-AUTHORITY` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-19 — `DB-02A-OUTER-LIFECYCLE-DELEGATION` reviewed outer calls to proved DB owners:** Nine reviewed
  lifecycle/orchestration files now participate in the existing whole-program delegation proof. Exactly **31** formerly
  unresolved records—connected-layout resume, Home scheduled recovery, manual/scan connect, Welcome DEV seed, three
  foreground-boot adapter references, the bootstrap connect/forget chain, unlock resume, and realtime start
  delegation—now resolve as `coordinated-delegation` because their targets already have safe DB ownership.

  This is deliberately a DB-owner-only claim. The exact-set test keeps the four root-layout and four foreground
  process/self-test execution edges unresolved, including `runDbRekeySelfTest`; driver adapters, contacts and cache
  dynamic callbacks, and live database rekey also remain outside the proof. Inventory remains **1,102 entries** and
  advances to **1,081 proved (955 coordinated + 126 temporal) / 21 unproven**, with **0 structural or membership
  errors**, **0 nested coordinators**, and reconciliation at **0/0/0**.

  The exact boundary test passes **1/1**, and the fast scanner passes **73 tests** with four intentional full-only skips.
  Because this child changes only scanner eligibility, inventory, and documentation—not application code—it reuses the
  immediately preceding same-day TypeScript, lint/format, scanner **76/76**, architecture **30/30**, migrations **5/5**,
  and four-shard full Jest **402 suites / 4,442 tests** gates. Independent review is GO. This does not prove account,
  timer, network, native, process-death, or device correctness. Child `DB-02A-OUTER-LIFECYCLE-DELEGATION` is **DONE**;
  parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-19 — `DB-02A-DYNAMIC-TRANSACTION-CALLBACK-ELIMINATION` replaced generic transaction callbacks with
  explicit owners:** The attachment-cache account scope no longer exposes an arbitrary `runTransaction(task)` API,
  the dead parallel download wrapper is gone, and cache recovery now performs its ledger read in one tracked, guarded,
  short transaction. Contact matching now opens each owner locally and routes its write through an opaque,
  runtime-checked transaction context instead of passing a raw writer callback.

  Queued-neighbour regressions prove that a retired contact match and a verified download awaiting its final commit both
  reject before publishing stale state. The scanner pins the exact eight replacement records and proves the old dynamic
  coordinator shapes are absent. Six previously unresolved findings were eliminated or replaced, leaving inventory at
  **1,100 entries / 1,085 proved (959 coordinated + 126 temporal) / 15 unproven**, with **0 structural or membership
  errors**, **0 nested coordinators**, and reconciliation at **0/0/0**.

  Focused verification passes **6 suites / 120 tests**; TypeScript, scoped lint/format, full scanner **78/78**,
  architecture **30/30**, and migrations **5/5** pass. Four non-overlapping full-Jest shards pass **402 suites / 4,445
  tests / 0 snapshots**. Native contact, filesystem/download, process-death, and device behavior remain outside this host proof. The remaining ledger
  is the mixed root/foreground boot group (8), driver adapters (5), and live database rekey (2). Child
  `DB-02A-DYNAMIC-TRANSACTION-CALLBACK-ELIMINATION` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-19 — `DB-02A-LIVE-REKEY-DELEGATION` proved the two live key-rotation handoffs:** The existing whole-program
  delegation proof now covers exactly the Settings confirmation callback and `rotateDatabaseKey` wrapper. Settings
  admits the mount-bound account lease before rotation, the wrapper captures the current shared raw handle, and
  `rotateDbKey` awaits its `PRAGMA rekey` inside the global writer lock before promoting the staged key.

  No production code changed. The target-based exact-set test pins the sole Settings caller and sole wrapper edge.
  Inventory remains **1,100 entries** and advances to **1,087 proved (961 coordinated + 126 temporal) / 13 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused
  Settings and key-rotation tests pass **2 suites / 42 tests**, TypeScript passes, and the fast scanner passes **75 tests
  with four intentional full-only skips**. The immediately preceding same-day full scanner **78/78**, architecture
  **30/30**, migrations **5/5**, and four-shard full Jest **402 suites / 4,445 tests** remain applicable because this
  child changes reviewed-path data, inventory, tests, and documentation only.

  This host proof does not establish real SQLCipher re-encryption, old-key rejection, Keystore/CSPRNG durability,
  concurrent native handles, or crash/power-loss recovery; those remain device-only. A second or re-entrant production
  rotation caller would require a single-flight design. Child `DB-02A-LIVE-REKEY-DELEGATION` is **DONE**; parent
  `DB-02A` remains **IN_PROGRESS**.

- **2026-08-19 — `DB-02A-FOREGROUND-BOOT-LIFECYCLE-DELEGATION` exact boot and root authority:** The scanner now
  proves the final eight mixed foreground-boot records without broadly approving `app/_layout.tsx` or treating the
  DEV database rekey self-test as a live coordinated write. Seven exact root/start/restart/warm-unlock edges use
  `foreground-boot-lifecycle-delegation`; the one `startProcessWork` call into `runDbRekeySelfTest` uses the separate
  temporal context `throwaway-database-delegation`.

  The all-or-nothing certificate pins the process-wide one-shot claim before any effect, the exact DEV guard and
  contained promise chain, the coordinator start/replay order, mounted-and-active root restarts, and the
  `completeUnlock` callback on the imported `ForegroundLockGate`. The throwaway premise is also structural: the sole
  dynamic op-sqlite binding cannot escape, every open uses the fixed `rekey-selftest.db` symbol, and the primary,
  reopened, and stale handles are immutable and used only by their exact SQL/read/close calls. Mutations that redirect
  the filename, replace a handle with the live shared database, weaken the one-shot/DEV gates, or move the warm-unlock
  callback revoke all eight approvals.

  No production code changed. Inventory remains **1,100 entries** and advances to **1,095 proved (968 coordinated +
  127 temporal) / 5 unproven**, with **0 structural or membership errors**, **0 nested coordinators**, and
  reconciliation at **0/0/0**. Focused boot/root/lock/key tests pass **4 suites / 53 tests**; TypeScript, scoped
  lint/format/diff checks, full scanner **81/81**, architecture **30/30** across **65** core files, and migrations
  **5/5** across **38** migrations pass. Four non-overlapping full-Jest shards pass **402 suites / 4,447 tests / 0
  snapshots**. Bounded independent review is GO.

  The remaining five inventory findings are the op-sqlite/Drizzle driver adapters. Host proof here does not establish
  native SQLCipher, file deletion, bridge behavior, process death, or device behavior. Child
  `DB-02A-FOREGROUND-BOOT-LIFECYCLE-DELEGATION` is **DONE**; parent `DB-02A` remains **IN_PROGRESS**.

- **2026-08-19 — `DB-02A-DRIVER-ADAPTER-PROOF` closes the exact DB-write inventory:** The scanner now certifies
  exactly the five dynamic op-sqlite/Drizzle adapter calls in `src/db/database.ts`. `opRunner.exec` and
  `opRunner.query` are two `startup-migration-adapter` temporal exclusions: the private runner exists only inside the
  awaited migration stage, before either shared database handle is published. `drizzleAdapter.execute`,
  `executeAsync`, and `executeRawAsync` are three `runtime-drizzle-adapter` coordinated calls: the exact private Proxy
  feeds the sole Drizzle client on the sole shared raw handle, and every other inventoried write already has a proved
  owner or temporal exclusion.

  The all-or-nothing certificate pins the runner, adapter, row conversion, dependency versions, sole consumers, and
  closed-world references. It fails closed on detached migration work, runner/adapter/client/reflection escape, raw
  method extraction, extra overrides, dependency drift, or a new unresolved write. Exposed `$client`, `session.client`,
  and extracted raw-method capabilities are always inventoried as unresolved even when they appear lexically inside a
  transaction owner.

  No production code changed. Inventory is **1,100 / 1,100 proved (971 coordinated + 129 temporal) / 0 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused
  adapter/startup/migration tests pass **3 suites / 15 tests**; TypeScript, lint, format, and diff checks pass; the full
  scanner passes **85/85**, architecture **30/30** across **65** core files, migrations **5/5** across **38**
  migrations, and four full-Jest shards pass **402 suites / 4,448 tests / 0 snapshots**. Bounded independent review is
  GO. Child `DB-02A-DRIVER-ADAPTER-PROOF` and parent `DB-02A` are **DONE**.

  This closes host proof of DB-write ownership, not the native database contract. `DB-01` remains open for real
  Drizzle/op-sqlite result shapes, builders/`RETURNING`, rollback, upgrades, and reactive delivery; specifically, the
  synchronous `execute` override still lacks the reactive-query flush used by the two async overrides. Android
  SQLCipher/op-sqlite behavior, encrypted open/migration/rekey, process reopen, and crash/power-loss behavior remain
  device-only evidence.

- **2026-08-19 — `DB-01A-SYNC-EXECUTE-REACTIVE-FLUSH` closes the host-side sync notification gap:** Drizzle's
  synchronous `execute` override now calls op-sqlite's `executeSync`, requests one reactive-query flush after success,
  and only then wraps and returns the result. A thrown synchronous execution does not request a flush, and the wrapper
  preserves row and mutation metadata.

  A contract test using the installed Drizzle 0.45.2 verifies the three actual routes: raw `db.all` with an `UPDATE ...
RETURNING` statement uses the synchronous override, `db.run` uses `executeAsync`, and a builder with `.returning()`
  uses `executeRawAsync`; all three request a flush. The exact adapter certificate now requires the synchronous flush,
  and its adversarial test proves that removing only that line revokes all five adapter approvals.

  The DB-write inventory remains **1,100 / 1,100 proved (971 coordinated + 129 temporal) / 0 unproven**, with **0
  structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Focused verification
  passes **4 suites / 16 tests**; TypeScript, lint, format, and diff checks pass; the full scanner passes **85/85**,
  architecture **30/30**, migrations **5/5**, and four full-Jest shards **403 suites / 4,449 tests / 0 snapshots**.
  Bounded independent review is GO. Child `DB-01A-SYNC-EXECUTE-REACTIVE-FLUSH` is **DONE**; parent `DB-01` remains
  **IN_PROGRESS**.

  This host proof shows that the application requests a reactive flush on every installed Drizzle write route. It does
  not prove Android JSI result shapes, eventual callback delivery or ordering, commit/rollback behavior, SQLCipher,
  upgrades, or process reopen; those remain `DB-01`/`DB-03` device evidence.

- **2026-08-19 — `DB-01B-ANDROID-DRIVER-CONTRACT` proves the disposable native driver path on API 35:** A DEV-only,
  zero-argument `runDbDriverSelfTest` now uses the private production Drizzle adapter against the fixed
  `driver-selftest.db`; it never accepts, returns, or publishes a database handle and never touches `gator.db`.
  Each run generates two throwaway keys, removes any old test file, verifies encrypted open and forced wrong-key
  rejection, creates/searches a tiny FTS5 table, exercises commit and rollback through `database.run`, tests all
  three installed adapter routes with bounded reactive subscribers, rekeys, reopens with the new key, rejects the old
  key, closes every handle, and deletes the test file in `finally`.

  The review exposed and fixed a real adapter defect: reactive flushes used to run after statements inside an open
  transaction, so UI subscribers could observe an uncommitted value and never converge after rollback. The adapter
  now defers notification until successful COMMIT/ROLLBACK, and a failed ROLLBACK retires its in-memory transaction
  flag so later autocommit writes can notify normally. Focused host verification passes **6 suites / 116 tests / 0
  snapshots**. The privacy-safe ADB harness passes **12/12** host tests and the exact API-35 arm64 emulator run records
  **PASS** with all **11/11** finite checks true at
  `android/app/build/reports/db-contract/android-db-contract-2026-08-19T20-21-45-109Z.json`; `/android` remains ignored.

  The exact scanner certificate now covers the richer throwaway contract without weakening production ownership.
  Its focused hostile-driver matrix passes **1/1** and the required full adversarial scanner passes **86/86** in
  **529.594s**. Inventory is **1,113 / 1,113 proved (971 coordinated + 142 temporal) / 0 unproven**, with **0
  structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**. Bounded independent
  review is GO. The complete Jest gate passes **404 suites / 4,450 tests / 0 snapshots**. Child
  `DB-01B-ANDROID-DRIVER-CONTRACT` is **DONE**; parent `DB-01` and `DB-03` remain **IN_PROGRESS**.

  At this DB-01B checkpoint, the result was same-process close/reopen evidence for a tiny disposable schema on a
  debuggable emulator. It did not run the 38 production migrations, kill/relaunch the process, exercise the production
  database file, simulate a crash/power loss, or substitute for an exact release-candidate/physical-device run. The
  DB-03A entry below supersedes only that migration-path gap.

- **2026-08-19 — `DB-03A-ANDROID-MIGRATION-CONTRACT` proves the current production migration path on API 35:** The
  finite DEV-only contract is now schema V2 and still uses only fixed disposable `driver-selftest.db`. It invokes the
  exact production `runMigrations(opRunner(handle))` path. A deliberately conflicting
  `attachment_cache_entries_state_lru_idx` lets migrations `0001`–`0029` commit and makes the second statement of
  `0030` fail; the contract proves `0030` leaves neither its created table nor a ledger row without claiming the whole
  chain is one transaction. After a same-process close/reopen, it removes the conflict, seeds reviewed head-`0029`
  rows, applies exact `0030`–`0038`, verifies the deletion ledger, error-report purge, scheduled-send retirement,
  legacy setting purge, reaction-payload scrub and preserved controls, then proves a third migration run is empty.

  The V2 path also exercises the production `messages_fts` insert/update/delete triggers and `MATCH`, requires
  `foreign_key_check` to be empty and `integrity_check` to be `ok`, and retains the DB-01B rollback/reactive, all-three
  Drizzle-route, rekey, key-specific reopen, and cleanup checks. The privacy-safe API-35 arm64 artifact is
  `android/app/build/reports/db-contract/android-db-contract-2026-08-19T21-44-08-558Z.json`, with schema **2**,
  migration count **38**, head `0038_scrub_reaction_selected_message_text`, and all **17/17** finite checks true.

  Focused runtime tests pass **3 suites / 100 tests**; the ADB harness passes **13/13**; the pinned migration guard
  passes **1 suite / 5 tests**; and TypeScript passes. The fast scanner passes **80 tests + 6 intentional full-only
  skips**; the focused hostile V2 mutation passes **1/1** in **233.425s**; and the required full adversarial scanner
  passes **86/86** in **623.426s**. The reviewed inventory retires three obsolete ad-hoc-schema writes, carries the
  replacement production-schema `handles` fixture seed once, and adds 27 V2 writes: net **+24**, for **1,137 / 1,137
  proved (971 coordinated + 166 temporal) / 0 unproven**, with **0 structural or membership errors**, **0 nested
  coordinators**, and reconciliation at **0/0/0**. Architecture passes **30/30**, the full migration guard passes
  **5/5**, and the complete Jest gate passes **404 suites / 4,452 tests / 0 snapshots** in **111.749s**. Child
  `DB-03A-ANDROID-MIGRATION-CONTRACT` is **DONE**; parent `DB-01` and `DB-03` remain **IN_PROGRESS**.

  This is same-process evidence for the current migration registry and a deliberately audited head-`0029` fixture on
  a debuggable emulator. It does not prove a true two-process death/relaunch protocol, every historical pre-`0029` or
  shipped database state, abrupt crash/power-loss behavior, the production database file, scheduled CI, or exact
  release-candidate/physical-device behavior. Those remain DB-03B/release evidence.

- **2026-08-19 — `DB-03B1-ANDROID-PROCESS-RELAUNCH` proves one controlled API-35 process boundary:** A separate
  DEV-only lane uses fixed disposable `driver-relaunch-selftest.db` and zero-byte durable request/phase markers. It
  claims foreground boot before production work can start, so neither `gator.db` nor the same-process V2 contract can
  run in either test process. Process A opens the encrypted throwaway database, commits exact migrations `0001`–`0029`,
  deliberately rolls back conflicted `0030`, verifies the exact partial ledger and a continuity sentinel, then emits
  READY from a callback that retains its native handle until the host terminates the process.

  The ADB harness ties READY to process A, force-stops the package, requires an observed no-process gap, and launches a
  numerically different process B. B's first encrypted open is `readOnly: true`; before any write-capable reopen it
  verifies the preserved head-`0029` ledger, sentinel, and rolled-back `0030` table state. Only then does B persist its
  resuming fence, reopen read-write, remove the deliberate conflict/sentinel, apply exact `0030`–`0038`, verify the
  full ledger, foreign keys, integrity and idempotency, and delete only the fixed database and four phase files.
  Interrupted prepare/resume and malformed/orphaned marker states fail with finite codes and deterministic cleanup.

  The privacy-safe API-35 arm64 artifact is
  `android/app/build/reports/db-relaunch/android-db-relaunch-2026-08-20T02-09-52-914Z.json`, with schema **1**, migration
  count **38**, head `0038_scrub_reaction_selected_message_text`, and all **7/7 prepare**, **12/12 resume**, and **3/3
  host** checks true. Focused Jest passes **3 suites / 37 tests**; the standalone harness passes **22/22**; TypeScript
  and focused formatting pass; and independent review is GO.

  The exact scanner certificate covers the fixed filename/key, private handle lifetime, read-only-before-write order,
  durable state machine, sole callers, and exclusive foreground interception. The fast scanner passes **81 tests + 7
  intentional full-only skips**. The first full run exposed one stale older-test assertion: it expected every
  throwaway delegation to disappear after a V2-only mutation, including 11 independent DB-03B1 service handoffs.
  Scoping that assertion to its exact V2 target passes its focused hostile regression **1/1**; the required full rerun
  passes **88/88** in **840.708s**. Manual inventory review adds **17** fixed-database writes plus **12** exclusive
  DEV handoffs, all exact temporal exclusions. Inventory is now **1,166 / 1,166 proved (971 coordinated + 195
  temporal) / 0 unproven**, with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation
  at **0/0/0**.

  Architecture passes **30/30** including both live guards; migrations pass **5/5** across 38 migrations at head
  `0038`; and pinned Node 24 full Jest passes **406 suites / 4,479 tests / 0 snapshots** in **61.736s**. Child
  `DB-03B1-ANDROID-PROCESS-RELAUNCH` is **DONE**. This controlled force-stop/relaunch proves two distinct PIDs and
  preserved encrypted database state, not inode identity or spontaneous OS death. Parent DB-03B remains **OPEN**;
  DB-03B2 still owns the reviewed repository heads `0024`/`0027`/`0029`, abrupt death during an active
  write/migration, power loss, the production database, scheduled CI, and exact release-candidate/physical-device
  evidence. Parent `DB-01` and `DB-03` remain **IN_PROGRESS**.

- **2026-08-20 — `DB-03B2A-REPOSITORY-HEAD-MATRIX` proves three reviewed repository logical heads on API 35:** A
  host provenance test pins the complete migration prefixes at `0024`, `0027`, and `0029` to three full reviewed Git
  commit objects and verifies byte-for-data equality with the current canonical prefixes. The repository has no
  release tags or retained historical APK/AAB/database samples, so this is repository provenance—not Play/store
  distribution provenance.

  Schema V3 keeps the existing fixed `driver-selftest.db` path for the audited `0029` fixture and adds fixed
  `driver-history-selftest.db` for `0024` and `0027`. For each earlier head, the exact production migration runner is
  stopped at the reviewed boundary, the next migration is proved rolled back, fixture state is closed, rejected under
  the wrong key, verified through `readOnly: true`, reopened read-write, and upgraded through exact head `0038`.
  Ledger/data transforms, production FTS5 insert/update/delete triggers, foreign keys, integrity, idempotence, and
  cleanup all pass. The V3 aggregate `historicalReadOnly` and wrong-key checks cover `0024` and `0027`; `0029`
  read-only/process continuity remains the separate DB-03B1 artifact.

  The privacy-safe API-35 arm64 artifact is
  `android/app/build/reports/db-contract/android-db-contract-2026-08-20T05-04-33-795Z.json`, with schema **3**, 38
  migrations at head `0038_scrub_reaction_selected_message_text`, and all **28/28** exact checks true. Focused Node 24
  Jest passes **4 suites / 110 tests**, the standalone host harness passes **35/35**, and independent artifact/privacy
  review is GO.

  The fail-closed V3 scanner certificate covers the fixed file/key authority, exact provenance records and helper
  membership, boundary trigger, read-only-before-write order, production runner adoption, data/FTS/integrity checks,
  cleanup, and sole caller. Its whole-project private-helper search was narrowed to the defining file with byte-identical
  findings; the pinned Node 24 full adversarial scanner passes **90/90** in **996.036s**. Manual inventory review adds
  **39** exact throwaway temporal exclusions: **1,205 / 1,205 proved (971 coordinated + 234 temporal) / 0 unproven**,
  with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**.

  TypeScript and repository lint pass; architecture passes **30/30** over 65 core files; migrations pass **5/5** over
  38 migrations at head `0038`; Prettier/diff passes all 13 touched source/test files; and pinned Node 24 full Jest
  passes **407 suites / 4,487 tests / 0 snapshots** in **129.711s**. Child
  `DB-03B2A-REPOSITORY-HEAD-MATRIX` is **DONE**. This is same-process logical-fixture evidence, not an old signed-app
  install-over or retained historical database. Parent DB-03B and `DB-03` remain **IN_PROGRESS** for abrupt
  write/migration death, WAL/power-loss recovery, production `gator.db`, scheduled CI, actual historical/release
  artifacts, and exact release-candidate/physical-device evidence.

- **2026-08-20 — `DB-03B2B1-ACTIVE-WAL-WRITE-DEATH` proves one controlled ordinary active-WAL crash on API 35:** The
  existing single DEV relaunch dispatcher now recognizes distinct zero-byte request/preparing/ready/resuming markers
  for fixed disposable `driver-wal-write-death-selftest.db`, never `gator.db`. Process A commits an exact baseline in WAL
  mode, requires a successful `wal_checkpoint(TRUNCATE)`, begins `BEGIN IMMEDIATE`, writes and verifies a bounded
  multi-page uncommitted canary, and emits READY while the transaction and encrypted handle remain open. The host ties
  READY to A, observes the physical WAL grow beyond its header, invokes exact `adb shell am crash <PID A>`, proves the
  no-process gap, and launches a distinct process B.

  B's first database open is `readOnly: true` and must prove the exact committed baseline row set with every uncommitted
  canary absent; there is no recovery-required read-write fallback. Only then does B reopen read-write, pass integrity
  and foreign-key checks, commit one recovery row, close, and reopen read-only to prove the exact two-row state. After
  that proof, the app requires an exact zero-work WAL checkpoint, confirms `journal_mode=DELETE`, closes, deletes the
  fixed main file, and the unchanged host pre-fallback gate proves the database, journal, WAL, SHM, and four scenario
  markers are all absent.

  The privacy-safe API-35 arm64 artifact is
  `android/app/build/reports/db-wal-write-death/android-db-wal-write-death-2026-08-20T16-46-24-970Z.json`, with schema
  **1** and all **9/9 READY**, **12/12 final**, and **5/5 host** checks true. It postdates all seven runtime, service,
  harness, test, and package sources by **44.362s**. Pinned Node 24 focused Jest passes **3 suites / 53 tests**, the
  standalone host harness passes **31/31**, TypeScript reports no diagnostics, and independent runtime/harness/artifact
  review is GO. Final repository gates pass lint, architecture **30/30**, migrations **5/5** over 38 migrations at head
  `0038`, and full Jest **407 suites / 4,503 tests / 0 snapshots** in **142.18s**.

  The fail-closed scanner pins the fixed file/key, ordinary non-migration SQL shape and ordering, exact row sets,
  read-only-before-write recovery, cleanup retirement, scenario-specific durable state, single dispatcher, sole
  callers, and no capability escape. Its pinned full matrix passes **92/92**. Manual inventory review adds **33** direct
  throwaway writes plus **13** exclusive DEV delegations: **1,251 / 1,251 proved (971 coordinated + 280 temporal) / 0
  unproven**, with **0 structural or membership errors**, **0 nested coordinators**, and reconciliation at **0/0/0**.

  Child `DB-03B2B1-ACTIVE-WAL-WRITE-DEATH` is **DONE** only for this controlled shell-induced crash of an ordinary
  active WAL write on a local debuggable emulator. Parent DB-03B2B, DB-03B, `DB-03`, and `DB-01` remain open or
  **IN_PROGRESS** for `DB-03B2B2` active-migration crash, power-loss/torn-write recovery, production `gator.db`, actual
  historical signed/store provenance, spontaneous or uncontrolled process death, scheduled CI, and exact
  release-candidate/physical-device evidence.

- **2026-08-21 — `DB-03B2B2-ACTIVE-MIGRATION-DEATH` proves one controlled post-statement active-migration crash on
  API 35:** A fourth mode in the existing single DEV relaunch dispatcher uses only fixed disposable
  `driver-active-migration-death-selftest.db`, never `gator.db`, plus distinct zero-byte
  request/preparing/ready/resuming markers. Process A constructs the exact production migration ledger through head
  `0037`, commits an exact 133-row fixture containing 128 bounded spill targets and five controls, enables WAL, and
  requires a successful truncate checkpoint. A private exact-SQL wrapper then observes the production runner begin
  migration `0038`, awaits its real `UPDATE`, and proves the exact migrated in-transaction row set while the ledger is
  still exactly at `0037`. It enters the non-settling READY callback before returning to the runner, so the ledger
  insert and transaction commit cannot start.

  The host binds READY to process A, requires the physical WAL to exceed its header, invokes exact
  `adb shell am crash <PID A>`, proves the no-process gap and that the WAL still exceeds its header, then launches a
  distinct process B. B's first database open is `readOnly: true` and must prove the exact head-`0037` ledger and
  original 133-row fixture, demonstrating rollback of the uncommitted `0038` result. Only then does B reopen
  read-write, pass integrity and foreign-key checks, apply exact `[0038]`, prove the exact head-`0038` ledger and
  migrated data, prove idempotency, and reopen read-only for persistence. The retirement path checkpoints, confirms
  `journal_mode=DELETE`, closes, deletes the fixed main file, and the host proves all eight scenario database,
  sidecar, and marker paths absent before fallback cleanup.

  The privacy-safe API-35 arm64 artifact is
  `android/app/build/reports/db-active-migration-death/android-db-active-migration-death-2026-08-21T09-05-01-344Z.json`,
  with schema **1**, 38 migrations at head `0038_scrub_reaction_selected_message_text`, and all **11/11 READY**,
  **15/15 final**, and **6/6 host** checks true. Pinned Node 24 focused Jest passes **3 suites / 70 tests**, and the
  standalone host harness passes **36/36**. TypeScript and repository lint pass; architecture passes **30/30** over 65
  core files with the single reset/claim/handoff owner; migrations pass **5/5** over 38 migrations at head `0038`.
  The authoritative pinned Node 24.19.0 full Jest run under `caffeinate` with `--runInBand --no-cache` passes **407/407
  suites / 4,520/4,520 tests / 0 snapshots**. Its raw reported **2,519.353s** duration is host-clock contaminated and is
  not performance evidence.

  The fail-closed scanner pins the fourth file/key, exact `0038` SQL and post-return/pre-ledger callback boundary,
  exact 37/38-entry ledgers and 133-row states, read-only-before-write recovery, pre/post-crash WAL checks, retirement,
  scenario-specific state, sole callers, and no capability escape. Its exact certificate passes **4/4**, the hostile
  matrix passes **17 cases**, the fast matrix reports **84 pass / 10 skip**, and the pinned full matrix passes **94/94**
  in **1,179,132.309ms**. Manual inventory review adds **34** direct throwaway writes plus **15** exclusive DEV
  delegations: **1,300 / 1,300 proved (971 coordinated + 329 temporal) / 0 unproven**, with **0 structural or membership
  errors**, **0 nested coordinators**, and reconciliation at **0/0/0**.

  Child `DB-03B2B2-ACTIVE-MIGRATION-DEATH` is **DONE** only for this controlled shell-induced crash after migration
  `0038`'s `UPDATE` resolved inside its open transaction and before its ledger insert/commit on a local debuggable
  emulator. It does not prove a statement-in-flight crash. Parent DB-03B2B, DB-03B, `DB-03`, and `DB-01` remain open or
  **IN_PROGRESS** for power-loss/torn-write recovery, production `gator.db`, actual historical signed/store provenance,
  spontaneous or uncontrolled process death, scheduled CI, and exact release-candidate/physical-device evidence.

- **2026-08-21 — `STORE-00` closes the repository-side truthful Google Play draft:** The store pack now replaces the
  old “no third-party cloud,” light-theme, row-encryption, vague map/provider, and incomplete App Lock/diagnostic
  language with source-backed boundaries. It states that Gator is dark-only; distinguishes the SQLCipher database from
  ordinary unencrypted app-private and shared-media files; identifies FCM's Google transport and server-dependent
  payload encryption; limits maps/links to explicit external-app handoff; names outbound-only sharing; and describes
  consent-controlled error reports sent only to the connected server.

  The pack includes a five-shot exact-candidate plan with staged-data and alt-text rules, a draft answer/evidence-gap
  matrix, and a candidate checklist. App name, short description, and full description measure **5/30**, **63/80**,
  and **2,284/4,000** characters. The icon passes the current **512×512 8-bit RGBA** requirement. The feature graphic
  was mechanically normalized from invalid 16-bit RGBA to **1024×500 8-bit RGB with no alpha**, then visually
  rechecked. No EAS build, submission, Play edit, credential use, or paid service was invoked.

  The audit also found a new release blocker: Google's user-generated-content policy covers direct-messaging clients,
  while the current product has no owner-approved terms acceptance, in-app block/report path, or documented moderation
  operation. Non-primary child `STORE-01A-UGC-SAFETY` and parent `STORE-01` are therefore **IN_PROGRESS**; metadata
  alone does not satisfy that gate. `PRIV-01` remains **TODO**. `LEGAL-01` is **IN_PROGRESS** after the later
  private-scope decision, while `DEVICE-01` remains **BLOCKED**; the exact-candidate store-listing box in
  `RELEASE_CHECKLIST.md` remains unchecked, and no screenshots, Data safety answers, privacy URL, legal approval,
  exact-AAB/device evidence, or Play Console state is claimed.

- **2026-08-21 — `DEC-11` narrows the current Play target to exclusive Internal Testing:** The owner confirmed that
  Gator is intended only for private testers through Google Play testing. Repository inspection proves that the sole
  configured Android submission track is `internal`; read-only EAS history later confirmed all 45 recorded Android
  submissions targeted that track. No conflicting Closed/Open/Production track configuration was found. A live Play
  Console session was unavailable, so the current Console tracks and any manual promotion remain unverified.

  `STORE-01A-UGC-SAFETY` moves from an active P0 child to a P2 pre-promotion TODO. Its audited terms, blocking,
  reporting, server-enforcement, and moderation gaps remain recorded and are not waived or declared compliant. It
  becomes P0 again before any Closed, Open, or Production track, or earlier if Play flags the internal app. Current
  `STORE-01` instead requires proof of the exact Internal Testing artifact, intended tester restriction, staged access,
  feedback path, and artifact-specific Console prompts. No EAS build/submission, Play Console change, runtime code
  edit, credential use, or paid service was performed for this decision.

- **2026-08-21 — `STORE-01` candidate-freeze preflight reconciles the draft and stops before a paid build:** The owner
  approved treating the existing dirty worktree as the draft candidate while preserving it. The exact boundary is all
  **607** Git-visible entries: **418 modified / 12 deleted / 177 untracked** across **249 runtime**, **18 native**,
  **37 build/config/proof**, **283 test**, and **20 documentation/store** entries. Existing tracked entry points import
  43 of the untracked runtime modules, and the authoritative plan, guards, inventories, and their tests are also
  untracked, so selective cherry-picking would not preserve the app or its evidence. No file was staged, committed,
  reverted, or deleted.

  Local EAS archive inspection copied **972 files / 20 MiB**. The candidate change excludes `.claude/` local
  settings and scheduler state; Play credentials, key extensions, generated native trees, and old AABs are absent.
  `google-services.json` is the sole remaining sensitive-name match because read-only EAS metadata proves that
  `GOOGLE_SERVICES_JSON` is absent at both account and project scope in development, preview, and production. The
  machine-local fallback remains uploadable rather than breaking the build silently; creating the owner-approved EAS
  File/Secret variable and then excluding the local file is still open. EAS reports remote Android version code **53**,
  **21** Android cloud builds, and **45** Android submissions: **42 finished / 3 canceled**, all `internal` with
  `COMPLETED` release status. This history cannot exclude a manual Play Console promotion.

  Two release-safety edits are candidate-local: `.claude/` is now ignored by EAS, and both Android release scripts stop
  after building so the exact artifact can be inspected and hashed before a separate submission. Both commands invoke
  exact `eas-cli@21.5.0` through pinned npm. Downloaded lifecycle scripts are disabled only while acquiring that
  transient CLI, then `npm_config_ignore_scripts` is removed before EAS executes so a local project build retains its
  approved lifecycle policy. Version and environment probes resolve `eas-cli/21.5.0` with the flag absent downstream.
  The toolchain guard requires the exact reviewed commands and rejects missing, indirect, wrong-target, submitting, or
  unpinned variants; its focused gate passes **5/5** under isolated Node **24.19.0**, npm **11.17.0**, and EAS CLI
  **21.5.0**. The global tools remain unchanged.

  A clean disposable install succeeds, and the inspected snapshot passes workflow security **20/20**, architecture
  **30/30** over 65 core files, migrations **5/5** over 38 migrations at head `0038`, secret hygiene **4/4**, error
  diagnostics **30/30**, TypeScript, zero-warning lint, configured format, dependency-tree integrity, DB inventory
  **1,300 findings / 0 errors / 0 reconciliation drift**, and the full DB hostile matrix **94/94**. The DB test process
  reported zero failures; the polling wrapper emitted a post-completion session-serialization error, so that wrapper
  message is not represented as a repository failure. Both full Jest runs pass **407 suites / 4,520 tests / 0
  snapshots**. UI coverage passes **91.28% statements / 85.00% branches / 90.35% functions / 93.33% lines**, and the
  production Android JavaScript export succeeds over 2,248 modules with the safe Firebase fixture.

  The draft remains **NO-GO** for a build. Both full and production-only npm audits report seven high-severity
  transitive findings, so the production dependency audit is not clean. Expo dependency validation fails on 19 SDK 57
  patch mismatches, and Doctor is **19/20** for the same set. The second Jest run also prints one real unwrapped React
  update from `mediaViewer.test.tsx`; both runs print
  finite secure-logger events, so the release checklist's no-unexpected-console-noise box is open. No EAS build,
  submission, Play edit, environment-variable mutation, global install, staging, commit, native build, or device claim
  occurred.

- **2026-08-21 — `STORE-01B-SDK57-DEPS` closes the SDK-patch and dependency-audit blockers:** The approved package and
  lockfile milestone aligns all 19 SDK 57 packages without changing the Expo SDK or React Native minor version. The
  manifest changed only the 16 ranges that did not already admit the reviewed patch; `expo-asset`, `expo-constants`,
  and `expo-file-system` retained their compatible ranges and moved only in the lock. `jest-expo` is now `57.0.4`,
  `expo` and `expo-router` are `57.0.15`, and every other reviewed Expo package resolves to Doctor's exact target.

  The first `expo install --fix` pass installed the patches but exited nonzero because it could not add `expo-image` to
  dynamic `app.config.ts`. Inspection proved that plugin changes only an iOS Podfile property, so the Android-only app
  did not add the unrelated config entry. A disposable reproduction then proved the narrow lock resolution before it
  was applied: final `package.json` has no direct or overridden Metro, `image-size`, `nanoid`, or `js-yaml` entry;
  `@expo/metro` is **56.0.2**; the complete Metro family is **0.84.5**; `image-size` is absent; `nanoid` is **3.3.18**;
  and the two `js-yaml` branches are **3.15.1** and **4.3.1**.

  Under isolated Node **24.19.0** and npm **11.17.0**, clean `npm ci` installs 1,295 packages and reports zero
  vulnerabilities. Full and production-only high-severity audits both report zero; `expo install --check` reports
  dependencies up to date; Doctor passes **20/20**; and both the targeted and depth-zero dependency trees are clean.
  Toolchain **5/5**, workflow security **20/20**, architecture **30/30** over 65 core files, migrations **5/5** over
  38 migrations at head `0038`, the fast DB scanner **84 pass / 10 intentional skip** with **1,300 findings / 0
  errors**, secret hygiene **4/4**, error diagnostics **30/30**, TypeScript, zero-warning lint, and configured format
  all pass. Android artifact-guard tests pass **10/10** against the pre-existing local artifacts only; no fresh AAB is
  claimed. Full Jest passes **407 suites / 4,520 tests / 0 snapshots**, and a cache-cleared production Android
  JavaScript export succeeds over **2,252 modules** with the safe Firebase fixture.

  The earlier one-off React `act(...)` warning did not reproduce, but finite expected secure-logger output remains, so
  the release-noise gate is not closed here. The Expo patches include native modules, so the eventual device proof must
  use a freshly generated native build; this JavaScript export is not native evidence. The remote Firebase file
  variable, clean-source freeze, signed AAB, intended tester access, staged server/feedback journey, live Play tracks,
  artifact prompts, and exact-candidate device proof remain open. No EAS build/submission, Play edit, environment
  mutation, global install, commit, native generation, or release occurred.

- **2026-08-21 — `STORE-01C-FIREBASE-EAS` closes the Firebase-file and local-fallback upload blockers:** The approved
  EAS change stores `GOOGLE_SERVICES_JSON` as a project-scoped `FILE_BASE64` variable with `SECRET` visibility in the
  development (`640edfce-3215-48e7-b901-d125836f67ae`), preview
  (`b1a20ce9-2ea5-478e-8318-c6f53d8e02fd`), and production
  (`0101e9e9-6d07-4c0f-8cf6-53133655d05f`) environments. Sanitized read-back proves the name and protected file
  metadata at project scope without printing contents; the corresponding account-scoped variable is absent. Dynamic
  config resolves a safe supplied fixture path exactly. Every selectable build profile now chooses an environment:
  base and production use production, while development and preview retain their same-named environments.

  The root-only `/google-services.json` EAS ignore rule prevents the machine-local fallback from entering the upload
  while retaining `test/fixtures/google-services.ci.json`. Initial archive inspection also exposed that `.git/`
  matched Git contents but not the directory name as checked by pinned EAS CLI **21.5.0**; the corrected `.git` rule
  removes the metadata. The final inspected production archive contains **943 files / 16 MiB**: the root Firebase
  file, `.git`, private environment files, service-account/signing artifacts, and symlinks are absent; `.env.example`
  and the byte-identical safe fixture remain; `.claude` contains zero files; and archived `.easignore`, `eas.json`,
  and `app.config.ts` hashes match the working tree. An independent read-only review approves the final profile map
  and archive.

  Under isolated Node **24.19.0**, npm **11.17.0**, and EAS CLI **21.5.0**, toolchain **5/5**, workflow security
  **20/20**, secret hygiene **4/4**, the focused EAS config test **1/1**, TypeScript, zero-warning lint, configured
  format, architecture **30/30**, migrations **5/5**, Expo Doctor **20/20**, and both zero-vulnerability npm audits
  pass. The first full Jest attempt emitted no assertion failure but exited **139** while unrelated server test workers
  were running and swap was nearly exhausted. After those workers finished and memory pressure normalized, the one
  clean retry passed **407 suites / 4,520 tests / 0 snapshots** in **63.834s**.

  This milestone did not build, submit, increment a version, change Play state, stage, commit, generate native code, or
  claim device evidence. Finite secure-logger output, the owner-approved clean-source freeze, signed exact AAB,
  intended tester access, staged server/feedback journey, live Play tracks, artifact prompts, and exact-candidate
  device proof remain open. `STORE-01A-UGC-SAFETY` remains deferred only for exclusive Internal Testing and is not
  waived for later tracks or a policy finding.

- **2026-08-22 — `STORE-01D-RELEASE-NOISE` closes the deterministic host release-noise gate:** Three finite expected
  secure-logger events that reached Jest's owned console sink are now intercepted only in their behavior-owning tests:
  two search backfill completions (`fixed: 121` and `fixed: 2`) and one socket failure retired during an account
  transition (`event: new-message`). Each test still proves the corresponding secure-log sink event and now requires
  exactly one matching console call; production logger behavior, global console handling, and error/warn output are
  unchanged.

  The first post-logger full run passed all **407 suites / 4,520 tests** but exposed ten intermittent
  `ServerHealthScreen` React `act(...)` warnings. Two attempted global Query notification wrappers were rejected and
  fully reverted: React Native Testing Library's exported `act` is always asynchronous, while direct React `act`
  conflicted with the library-owned environment lifecycle. Isolation then found the exact race: manual Refresh and
  successful RCS actions started all ten health-query refetches, but their tests asserted endpoint call counts before
  query/observer settlement. Every current-account invalidation now awaits the existing exact health-query drain
  before synchronous call-count assertions. The Health suite also awaits its asynchronous unmount directly.

  Repeated order testing then exposed a separate `ServerManagementScreen` lifecycle defect: two manually unmounted
  account-transition trees discarded React Native Testing Library's `Promise<void>` unmount result inside a nested
  async `act`. Both sites now await `view.unmount()` directly. The management suite passes **23/23**, the combined
  release-noise focus passes **4 suites / 58 tests**, and the formerly failing Management→Health order passes
  **20/20 runs**, each **41/41 tests** with zero Jest `Console` sections or React act warnings. TypeScript,
  zero-warning lint, configured format, architecture **30/30** over 65 core files, migrations **5/5** over 38
  migrations at head `0038`, DB inventory **1,300 findings / 0 errors**, and error diagnostics **30/30** all pass.

  The first frozen-candidate full attempt ended before Jest totals with exit **139**. The generated macOS diagnostic
  proves `EXC_BAD_ACCESS` / `SIGSEGV` inside V8's `ClearStaleLeftTrimmedPointerVisitor` during mark-compact garbage
  collection; the partial Jest log contained zero console/noise matches, and system memory remained healthy. No code
  or toolchain setting changed for the controlled retry. The next two consecutive complete runs each pass
  **407/407 suites / 4,520/4,520 tests / 0 snapshots** under pinned Node **24.19.0** and npm **11.17.0**, in
  **70.088s** and **62.443s**. Both saved logs contain zero Jest `Console` sections, console method lines, React act
  warnings, or formerly leaked logger messages.

  The 607-entry dirty working draft remains **418 modified/added / 12 deleted / 177 untracked** when Git expands all
  untracked files; no user path was lost, staged, committed, reverted, or deleted. This test-only milestone did not
  build, submit, increment a version, change EAS/Play state, generate native code, or claim device evidence. The
  owner-approved clean-source freeze, signed exact AAB, intended tester access, staged server/feedback journey, live
  Play tracks, artifact prompts, and exact-candidate device proof remain open. `STORE-01A-UGC-SAFETY` remains deferred
  only for exclusive Internal Testing and is not waived for later tracks or a policy finding.

- **2026-08-22 — `STORE-01E-SOURCE-FREEZE` captures the coupled draft in one local commit:** The owner approved the
  recommended repository pre-build gate. Because `bb2-batch1-defects` had no upstream and no longer described the
  broad August snapshot, the exact unchanged worktree moved to local branch
  `release/store-01-source-freeze-2026-08-22` at pre-freeze head `2fad42d215df`. The commit containing this statement
  is the source-freeze identity; its literal hash is reported at handoff because a commit cannot contain its own hash.

  Three independent read-only audits confirmed that the documented boundary is exactly **607 Git-visible paths**:
  **418 modified / 12 deleted / 177 formerly untracked**. Selective staging would not preserve the coupled app and
  its evidence. The staged set matches those exact counts with no unstaged or untracked candidate path and contains
  **169,013 insertions / 12,962 deletions**. It has no rename, mode change, symlink, submodule, diff-check error,
  suspicious credential path, or generated build artifact.

  The index-aware secret-hygiene gate passes **4/4** and scans the resulting **944 tracked files** plus **814
  historical paths**. A supplemental scan of every formerly untracked file finds no forbidden filename or
  high-confidence credential. Real local Firebase/Play files, signing/build artifacts, generated Android content,
  Expo logs, coverage, and machine-local AI state remain ignored. The repository now explicitly ignores only
  `.claude/settings.local.json` and `.claude/scheduled_tasks.lock`; shared `.claude/settings.json` stays tracked.

  Configured source format, work-plan format, TypeScript, zero-warning lint, architecture **30/30** over 65 core
  files, migrations **5/5** over 38 migrations at head `0038`, DB inventory **1,300 findings / 0 errors**, and the
  fast DB-write suite **84 passed / 10 intentionally skipped / 0 failed** all pass. The first full Jest invocation
  exposed an operator toolchain error: Homebrew Node **26.7.0** required native-module ABI **147**, while the installed
  `better-sqlite3` correctly targeted the repository's Node ABI **137**. It therefore ended **289 suites passed / 118
  failed** and **3,223 tests passed / 1,297 failed**, with every reported failure carrying the same ABI mismatch rather
  than a test assertion diagnosis. No source or dependency changed. Under pinned Node **24.19.0** and npm **11.17.0**,
  the native smoke and toolchain guard **5/5** pass, then the full gate passes **407/407 suites / 4,520/4,520 tests / 0
  snapshots**.

  Independent staged review approves the exact set. This milestone does not fetch, push, tag, change a version, build
  or sign an AAB, submit, alter Play state, or claim device evidence. `STORE-01` remains open for the intended tester
  list, staged server and feedback journey, signed exact AAB/hash, live Play tracks, artifact-specific prompts, and
  exact-candidate device proof. `STORE-01A-UGC-SAFETY` remains deferred only for exclusive Internal Testing.

- **2026-08-23 — `STORE-01F-LOCAL-AAB` closes the fresh signed-bundle and static identity gate:** The exact candidate
  source is clean commit `5d367eb58e38126258423f1cd9ce0da42b179f7f` on local branch
  `release/store-01-source-freeze-2026-08-22`. It contains source freeze `66869d3`, the local-only release guard
  `374b0e7`, and the narrow local helper launch correction in `5d367eb`. The guarded command used isolated Node
  **24.19.0**, npm **11.17.0**, EAS CLI/helper **21.5.0**, OpenJDK **17.0.20.1**, and the local Android SDK. Expo Doctor
  passed **20/20**, all three owned modules were discovered, SQLCipher plus FTS5 were enabled, the Firebase release
  task succeeded without exposing the ignored local file, and Gradle executed **1,227 tasks** with `BUILD SUCCESSFUL`
  in **4m 20s**.

  The first local attempt incremented remote version code **54 → 55** and fetched the managed credential, then stopped
  before Android compilation when EAS's nested npm helper invocation exited `EUSAGE`. Diagnosis proved that the outer
  transient CLI leaked npm invocation state into the nested helper; the project `strict-allow-scripts` policy also
  correctly rejected the helper's optional native install hook. The committed correction resolves the exact
  `eas-cli-local-build-plugin@21.5.0` with install scripts disabled, passes its executable path to EAS, and clears only
  the inherited transient npm invocation variables before the build. The one controlled retry incremented **55 → 56**
  and completed. Read-only EAS history still shows hosted build version **54** as the newest hosted build, so neither
  local attempt created a hosted build; no submission or Play mutation occurred.

  The retained ignored artifact is `gator-release-0.1.40-v56-5d367eb.aab`: **55,729,707 bytes**, SHA-256
  `926ce40c8ada2b69b093aaafb7a5f3a2a08bd7f5ae061c526c8a33b5462b9eac`. Independent `shasum` and OpenSSL digests
  match; ZIP integrity passes over **1,754 unique entries**; official Bundletool validation passes; and the packaged
  guard reports zero errors. The decoded manifest is package `com.bluegreengatorapps.messages`, version `0.1.40`,
  version code `56`, minimum SDK `24`, target SDK `36`, and `android:allowBackup="false"`. Its native-library ABI set is
  exactly `arm64-v8a`; all required product permissions/components are present; all seven project-forbidden
  permissions are absent; and no inbound `ACTION_SEND`/`ACTION_SEND_MULTIPLE`, Direct Share resource, or removed
  `expo-share-intent` DEX marker is present.

  Ordinary `jarsigner -verify` exits **0** with `jar verified`. OpenSSL and independent certificate inspection agree on
  managed upload-certificate SHA-256
  `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`.
  Java's `-strict` mode exits **4** because the upload certificate is self-signed and untimestamped, not because the
  signature failed; it also reports its known sequential ZIP-reader warning. Unique-entry inspection, ordinary
  cryptographic verification, and Bundletool validation all pass. Google Play acceptance remains unproven until a
  separately approved upload.

  The post-artifact repository freeze passes the pinned toolchain guard **7/7**, combined release-script and Android
  artifact-guard tests **17/17**, TypeScript, zero-warning lint, configured source and evidence-document format,
  architecture **30/30** over 65 core files, migrations **5/5** over 38 migrations at head `0038`, DB inventory
  **1,300 findings / 0 errors**, secret hygiene **4/4**, and full Jest **407/407 suites / 4,520/4,520 tests / 0
  snapshots**. Independent read-only artifact review agrees with the digest, signature/certificate, manifest, ABI,
  permission/component, unique-entry, and inbound-share results.

  `RELEASE_CHECKLIST.md` now binds the candidate version, commit, digest, and local-build provenance while leaving
  tester/device identity and test date blank. `STORE-01` remains **IN_PROGRESS** for intended tester access, stable
  staged server/setup, feedback-path proof, known-limitations disclosure, exact-AAB install/update/runtime testing,
  live Play Console track state, Play's artifact-specific prompts and acceptance, and the owner-approved submission.
  `STORE-01A-UGC-SAFETY` remains a recorded pre-promotion gate and is not waived.

- **2026-08-23 — `STORE-01G-TESTER-READINESS` opens the private test operation without inventing owner facts:** The
  repository and sibling-server audit found no tester list/group label, opt-in link, feedback destination/response
  owner, staged server, approved tester notice, or exact candidate journey. That absence is retained rather than
  filling Git with tester identities or secrets. The production app supports QR and manual connection, but its fixture
  shortcut is DEV-only. The server's tracked public README describes startup against the real macOS Messages database
  and AppleScript message actions; it has no isolated synthetic-data staging recipe. The stale device checklist still
  identifies app `0.1.28`, so it cannot serve as version-code-56 evidence.

  Pinned read-only EAS history reports remote Android version code **56**, **22** hosted Android builds (**19 finished /
  3 errored**), and zero hosted builds for version codes **55** or **56**; hosted version **54** remains newest. It also
  reports exactly **45** Android submission records (**42 finished / 3 canceled**), all requesting track `internal`
  and release status `COMPLETED`, with the newest dated 2026-07-30. EAS CLI explicitly does not provide live Google
  Play app status, tester membership, opt-in links, or current track inventory, so those records cannot prove manual
  Play state or version-code-56 acceptance. An authenticated browser session was unavailable; no Play page was read or
  changed.

  Google's current Internal Testing instructions allow up to **100** testers, select testers through an email list,
  require a feedback email or URL, and provide a shareable opt-in link. The new
  [`STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](../STORE_01G_INTERNAL_TESTING_RUNBOOK.md) records those mechanics, the exact
  candidate identity, a private-feedback recommendation, the absence of supported synthetic staging, owner-only input
  fields, a versioned limitations-notice draft, staged test/cleanup steps, and fail-closed stop conditions. Public
  GitHub Issues remain enabled but are not treated as an approved private feedback destination.

  The local-only EAS candidate-build requirement is reconciled into the current `SUPPLY-01`/`ENV-01`/`BUILD-01`
  evidence and external-dependency text while retaining the existing disposable GitHub Actions verification lane. The
  current tracker no longer suggests a hosted EAS release candidate as a closure path. No app/server code, AAB,
  EAS/Play state, tester access, server process, network endpoint, credential, or device state changed.
  `STORE-01G` remains **IN_PROGRESS** until its owner fields, versioned fixture/update baselines, staged-server and
  feedback dry runs, approved notice, read-only live Play preflight, and independent review are real. Parent `STORE-01`
  separately remains **IN_PROGRESS** through submission approval, Play acceptance, opt-in/install, exact-candidate
  device journeys, prompted declarations, cleanup, and tester-access evidence.

- **2026-08-23 — `STORE-01H-INTERNAL-TRACK-CONFIG-GUARD` freezes the declared destination without touching Play:**
  The pre-change toolchain validator did not inspect `eas.submit`; deleting the block, changing its track to
  `production`, or adding another profile or iOS destination produced no error. The guard now compares the raw submit
  object against one deeply frozen reviewed value: `production.android`, explicit track `internal`, and
  `./play-service-account.json`. Exact comparison intentionally requires review for inheritance, application-id,
  rollout, release-status, credential-path, platform, profile, or unknown-option changes instead of relying on EAS
  defaults.

  The focused pinned-toolchain run passes **8/8** and its new table rejects **24** adversarial configurations plus
  explicit hosted/auto-submit/direct-submit package-script variants; harmless property reordering still passes. The
  existing local candidate build command is unchanged. The complete host freeze passes the static gates and **407/407
  Jest suites / 4,520/4,520 tests** recorded in the child evidence above. This is an offline repository-config proof:
  it neither scans a future workflow publisher nor prevents a manual terminal/Play Console action, and it does not
  prove the current live track, artifact, tester list, opt-in link, or Play acceptance. No AAB, EAS/Play state, version
  counter, credential, tester access, server, network endpoint, or device state changed. `STORE-01`, `STORE-01G`, and
  `STORE-01A-UGC-SAFETY` retain their existing open boundaries.

- **2026-08-23 — `DEVICE-01A-CANDIDATE-PREFLIGHT` makes the stale device record safe to prepare offline:** Two
  independent read-only audits found that the prior checklist mixed Play version code `39`, development-emulator
  harnesses, a destructive dev rebuild, removed Redacted Mode behavior, real-account prompts, raw private evidence,
  and stale full-screen-intent assumptions. Adding only a version-code-56 heading would therefore have left unsafe
  tester instructions active.

  The checklist now freezes the exact local version-code-56 candidate and separates its AAB/upload signature from the
  still-open Play-delivery signature. A secret-free ledger requires candidate/source/install provenance, the approved
  update baseline, device/permission/accessibility context, Play/tester evidence, isolated server/fixture/Firebase
  labels, cleanup ownership, and private evidence references. The candidate lane no longer directs a rebuild, all old
  checkmarks are visibly historical, and the remaining behavior matrix is quarantined as non-executable until
  `DEVICE-01B-CURRENT-FLOW-MATRIX` reconciles each flow. The device preflight also requires the open `STORE-01G`
  notice, access, halt-owner, test-window/credential-expiry, staged-server, and feedback approvals rather than treating
  generic device-session approval as a substitute. No AAB was rebuilt, uploaded, or installed; no EAS, Play, tester,
  server, network, credential, Firebase, or device state changed. Parent `DEVICE-01` remains **BLOCKED**, and
  `STORE-01` remains **IN_PROGRESS** for separately approved live distribution and exact-candidate proof.

- **2026-08-23 — `DEVICE-01B1-NOTIFICATION-LIFECYCLE-MATRIX` replaces stale tester expectations without running
  them:** Parallel read-only audits split `DEVICE-01B` into notifications/lifecycle, data/native, and
  UI/accessibility/account-transition slices. The first slice now gives every current step an explicit
  `STATIC/HOST`, supporting-only `LOCAL-DEV`, `STAGED-SERVER`, or `EXACT PLAY CANDIDATE` evidence class and keeps all
  **40** result fields open. It uses the fixed app-authored push self-test, separate messages for destructive tray
  actions, exact package-only ordinary kill, synthetic plaintext/encrypted fixtures, and privacy-safe cleanup. It
  records active-chat and per-chat-history limitations instead of passing them, distinguishes App Lock's live grace
  from the always-generic persisted-lock fresh-process path, treats reminders/background scheduling as inexact, makes
  full-screen FaceTime conditional with an actionable heads-up fallback, and distinguishes foreground versus
  notification Decline behavior.

  Independent review found and corrected four precision problems before freeze: normal message taps open a chat at
  its newest message rather than anchoring to the triggering message; a fresh killed/background-worker process cannot
  inherit warm App Lock grace; internal route/token teardown requires host/static proof rather than a tester-visible
  claim; and the foreground FaceTime overlay appears but is not itself the sound source. Final document/source
  assertions pass **67/67**, the focused notification/lifecycle gate passes **16/16 suites / 254/254 tests**, and the
  complete host freeze passes TypeScript, zero-warning lint, configured Markdown formatting, architecture **30/30**,
  migrations **5/5**, DB inventory **1,300 / 0 errors**, fast DB-write tests **84 passed / 10 intentionally skipped /
  0 failed**, secret hygiene **4/4**, and full pinned-Node Jest **407/407 suites / 4,520/4,520 tests / 0 snapshots**.
  Historical sections (b)–(e)/(i) remain visibly non-executable evidence, and `DEVICE-01B2`/`DEVICE-01B3` remain TODO.
  No code, AAB, build, upload, submission, tester access, server/network/Firebase/credential, Play Console, or device
  state changed. Parent `DEVICE-01` remains **BLOCKED**; `STORE-01`/`STORE-01G` remain **IN_PROGRESS**; `PLAY-02` remains
  **BLOCKED**; and `NOTIF-01..03` remain open.

- **2026-08-23 — `DEVICE-01B2-DATA-NATIVE-MATRIX` replaces unsafe data/native tester instructions without running
  them:** Parallel read-only audits traced the production DB/search/rekey, attachment download/cache, multipart upload,
  FileProvider/open/share/save, inbound-share containment, sticker, storage-disclosure, and Disconnect paths. The
  current B2 slice assigns all **40** result fields to `STATIC/HOST`, supporting-only `LOCAL-DEV`, `STAGED-SERVER`, or
  `EXACT PLAY CANDIDATE` evidence and leaves all **40** open. It separates clean install from an approved natural Play
  update, keeps API 24/25 conditional, uses bounded synthetic fixtures, requires server aggregate evidence for upload
  concurrency/cancellation, and prevents visible persistence/retry results from claiming hidden SQLCipher, WAL, cache
  ledger, quota, or native-delete internals.

  Independent review initially returned **NO-GO** and corrected seven precision/safety issues before its final **GO**:
  audio has a tap-to-load retry without an explicit error label; generic uploads show spinner/byte text rather than a
  media ring; active cancellation needs bounded byte-stop/connection-close proof; the image counter requires two
  same-chat images and fullscreen video uses Shared Media; cleanup covers only copies actually created; the prohibition
  list must unambiguously forbid `run-as`; and cleanup restores only settings this slice changed. The stale historical
  matrix is now permanently non-executable rather than executable “until” a future event.

  Final document/source assertions pass **90/90**, the focused data/native gate passes **29/29 suites / 507/507 tests**,
  and the complete host freeze passes TypeScript, zero-warning lint, configured Markdown formatting/diff checks,
  architecture **30/30** over **65** core files, migrations **5/5** over **38** migrations at head `0038`, DB inventory
  **1,300 / 0 errors**, fast DB-write tests **84 passed / 10 intentionally skipped / 0 failed**, secret hygiene **4/4**,
  and full pinned-Node Jest **407/407 suites / 4,520/4,520 tests / 0 snapshots**. No code, AAB, build, upload,
  submission, tester access, server/network/credential, Play Console, or device state changed. Parent `DEVICE-01`
  remains **BLOCKED**; `STORE-01`/`STORE-01G`, `DL-01`, `SHARE-01`, `FILE-01A`, and parent `DB-03` remain
  **IN_PROGRESS**; `PLAY-02` remains **BLOCKED**; `STICKER-4` remains decision-pending; and `DEVICE-01B3` remains TODO.

- **2026-08-23 — `DEVICE-01B3-UI-ACCESSIBILITY-MATRIX` finishes the executable-matrix reconciliation without running
  it:** Parallel read-only audits traced Android permissions and API branches, external browser/Maps/settings handoffs,
  preview and embedded-WebView containment, keyboard/inset/navigation behavior, effects and reactions, enabled themes,
  accessibility semantics, and Disconnect/account cleanup. The current B3 slice assigns all **40** result fields to
  `STATIC/HOST`, supporting-only `LOCAL-DEV`, `STAGED-SERVER`, or `EXACT PLAY CANDIDATE` evidence and leaves all
  **40** open. It requires controlled synthetic inputs, exact platform/session applicability, both enabled dark presets,
  and a real A→explicit Disconnect→B journey; Welcome or a sender-alias change cannot substitute for isolation.

  Independent review initially returned **NO-GO** and corrected four issues before final **GO**: QR guidance now
  distinguishes forbidden raw evidence retention from expected secure-vault credential persistence; manual Android
  keyboard behavior is a cannot-pass finding; screen-effect one-shot behavior is not falsely applied to bubble-effect
  mount/remount behavior; and external cleanup deletes only artifacts created by this slice. The matrix records the
  known manual-keyboard, Theme Studio contrast, Reduce Motion, unlabeled-control/message-action, TalkBack/media,
  API-32, and silent no-handler gaps instead of passing them. Historical sections remain permanently non-executable.

  Final document/source assertions pass **116/116** and the focused host gate passes **44/44 suites / 577/577 tests /
  0 snapshots**. The complete host freeze passes TypeScript, zero-warning lint, configured Markdown formatting and
  diff checks, architecture **30/30** over **65** core files, migrations **5/5** over **38** migrations at head `0038`,
  DB inventory **1,300 findings / 0 errors** and reconciliation with no drift, fast DB-write tests **84 passed / 10
  intentionally skipped / 0 failed**, secret hygiene **4/4**, and full pinned-Node Jest **407/407 suites / 4,520/4,520
  tests / 0 snapshots**. No code, AAB,
  build, upload, submission, tester access, server/network/credential, Play Console, Android setting, or device state
  changed. Documentation parent `DEVICE-01B` is **DONE**, but parent `DEVICE-01` remains **BLOCKED**;
  `STORE-01`/`STORE-01G` remain **IN_PROGRESS**; and every named permission, UI, accessibility, theme, browser,
  FaceTime, Play, alias, share, IPC, and release-evidence blocker remains open or conditional.

- **2026-08-23 — `A11Y-01A-TEXTFIELD-LABELS` gives shared fields a real accessible name:** The shared `TextField`
  primitive now assigns each visual label a unique React-generated native identifier and links its `TextInput` with
  `accessibilityLabelledBy`. Caller-provided React Native or ARIA names remain authoritative, so the primitive does not
  overwrite a deliberate accessible name. Independent review initially returned **NO-GO** because the first two tests
  did not prove cross-instance uniqueness or all four naming-prop precedence branches; the expanded suite now covers
  those claims explicitly, and final re-review returned **GO**.

  The focused behavior suite passes **5/5**, focused `TextField.tsx` coverage is **100% statements / 83.33% branches /
  100% functions / 100% lines**, the complete component project passes **119/119 suites / 1,223/1,223 tests**, and the
  full pinned-Node gate passes **408/408 suites / 4,525/4,525 tests**. TypeScript, zero-warning lint, configured format/
  diff checks, architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and secret hygiene also pass.
  This host proof does not claim device TalkBack behavior. Parent `A11Y-01` remains **IN_PROGRESS** for the insecure-
  HTTP switch and message actions/hints, while `A11Y-03` retains the exact-device accessibility matrix.

- **2026-08-23 — `A11Y-01B-MANUAL-SWITCH-LABEL` makes the HTTP acknowledgement independently operable:** The manual
  setup route now gives its existing `Switch` the same accessible name as the visible “Allow insecure connection”
  copy. A mounted-route test finds the control by `switch` role and exact name, verifies its off state, operates its
  value-change path, and verifies its on state without using the adjacent text node as the query target. The scanner
  inventory reconciliation changes only the unchanged `Manual.submit` callback record's stored line from 89 to 87;
  identity, target, context, ownership, and disposition stay unchanged.

  The focused suite passes **1/1**, focused `manual.tsx` coverage is **89.47% statements / 58.33% branches / 80%
  functions / 100% lines**, the complete component project passes **120/120 suites / 1,224/1,224 tests**, and the full
  pinned-Node gate passes **409/409 suites / 4,526/4,526 tests**. TypeScript, zero-warning lint, configured format/diff
  checks, architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and secret hygiene also pass.
  This host proof does not claim device TalkBack or Android keyboard/inset behavior. Parent `A11Y-01` remains
  **IN_PROGRESS** for message actions/hints, and `A11Y-03` retains the exact-device accessibility matrix. No build,
  upload, submission, tester invitation, server deployment, Play Console mutation, or device action occurred.

- **2026-08-23 — `A11Y-01C-MESSAGE-BUBBLE-ACTIONS` exposes one menu path to touch and TalkBack:** Actionable message
  bubbles now advertise React Native's standard `longpress` action with static, non-private copy and a double-tap-and-
  hold hint. The accessibility handler filters the exact action name and reuses the physical long-press handler's
  `measureInWindow` callback, so it preserves the existing reaction/action overlay anchor instead of opening a second
  menu path. Bubbles without a long-press callback expose no action, hint, or handler; the container does not claim a
  misleading button role or derive a new label from message bodies, senders, URLs, attachments, or file paths.

  The focused suite passes **29/29**, focused `MessageBubble.tsx` coverage is **93.13% statements / 81.81% branches /
  95.23% functions / 98.86% lines**, the complete component project passes **120/120 suites / 1,226/1,226 tests**, and
  the full pinned-Node gate passes **409/409 suites / 4,528/4,528 tests**. TypeScript, zero-warning lint, configured
  format/diff checks, architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and secret hygiene
  also pass. This host proof does not claim native Android action delivery, TalkBack announcement/focus behavior, or
  exact-device overlay anchoring. Parent `A11Y-01` remains **IN_PROGRESS** only for device TalkBack proof, and
  `A11Y-03` retains the broader exact-device accessibility matrix. No build, upload, submission, tester invitation,
  server deployment, Play Console mutation, or device action occurred.

- **2026-08-23 — `A11Y-02A-SCREEN-EFFECTS` prevents a decorative motion flash and live-setting overrun:** The
  full-screen overlay now waits for the native Reduce Motion preference before it creates particles or starts its one
  animation. An initially enabled preference skips the overlay and clears its transient state; a live false-to-true
  event stops the running animation, clears once, and makes a late native completion harmless. Subscription-before-
  query ordering plus an event-wins guard prevents a slower initial query from overwriting a newer preference event.
  Query failure deliberately retains the prior animation instead of trapping the effect in an unresolved state, and
  listener/unmount cleanup remains bounded. Normal mode keeps the existing six effect/count branches and non-blocking
  overlay contract. Independent review initially rejected independent completion paths, an effect-name reuse latch, and
  a post-commit/pre-passive-cleanup stale-callback window. The final layout-phase per-transition generation guard and
  exact regressions closed those findings; final re-review returned **GO**.

  The focused suite passes **21/21**, focused `ScreenEffectOverlay.tsx` coverage is **100% statements / 95% branches /
  100% functions / 100% lines**, the complete component project passes **120/120 suites / 1,237/1,237 tests**, and
  full pinned-Node Jest passes **409/409 suites / 4,539/4,539 tests**. TypeScript, zero-warning lint,
  configured format/diff checks, architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and
  secret hygiene also pass. This host proof does not claim Android preference/event delivery or visible no-flash/live-
  cancellation behavior. Parent `A11Y-02` remains **IN_PROGRESS** for bubble/invisible-ink effects, typing, overlay/
  toast/modal transitions, functional-motion decisions, and exact-device proof; `A11Y-03` retains its wider matrix.
  No build, upload, submission, tester invitation, server deployment, Play Console mutation, Android-setting change,
  or device action occurred.

- **2026-08-23 — `A11Y-02B-BUBBLE-EFFECTS` makes bubble and invisible-ink motion preference-aware:** One mounted
  preference owner now keeps entrance content static while unresolved, runs the existing `slam`/`loud`/`gentle`
  entrance only for the first authoritative false result, suppresses it for true, and stops/snaps an active composite
  to final values on live true. Consumed mounts do not replay after setting-off or an in-place effect change, but a
  FlashList unmount/remount remains a fresh run. Invisible ink remains covered and tappable; unresolved/true tap is an
  instant reveal, false retains the prior fade, and live true stops/snaps without re-hiding. Event-before-query and
  late-query-after-unmount paths fail safe; a rejected native query preserves the prior animation.

  Independent review found no source defect but initially returned **NO-GO** because effect-prop dependency evidence
  was missing. The exact `slam`→`gentle` mounted rerender now proves one stop, final **1/1**, no second composite, and
  no duplicate unmount stop; final re-review returned **GO**. The focused suite passes **16/16**, focused source
  coverage is **100% statements / 93.75% branches / 100% functions / 100% lines**, the complete component project
  passes **120/120 suites / 1,251/1,251 tests**, and full pinned-Node Jest passes **409/409 suites / 4,553/4,553 tests**.
  TypeScript, zero-warning lint, configured format/diff checks, architecture, migrations, DB inventory/reconciliation,
  fast DB-write tests, and secret hygiene also pass.

  This host proof does not claim Android preference/native-driver/FlashList or TalkBack behavior. The existing risk that
  concealed invisible-ink descendant text may be announced by the default-accessible `Pressable` remains open under
  `A11Y-03`. Parent `A11Y-02` remains **IN_PROGRESS** for typing, overlay/toast/modal transitions, functional-motion
  decisions, and exact-device proof. No build, upload, submission, tester invitation, server deployment, Play Console
  mutation, Android-setting change, or device action occurred.

- **2026-08-23 — `A11Y-02C-TYPING-PULSE` keeps the continuous typing status meaningful without forced motion:** The
  three dots now stay fully visible and static while the preference is unresolved or enabled. One listener is installed
  before the initial query; a newer event wins, query failure preserves the existing pulse, and fulfilled/rejected late
  results cannot publish after unmount. An authoritative false starts the existing three staggered loops, live true
  stops that exact trio before snapping all dots to full opacity, and a later false starts one fresh non-overlapping
  trio. The labeled plain `View` is now explicitly `accessible`, so suppressed animation does not remove the grouped
  `Typing` meaning.

  Focused verification passes **10/10** with **100% statements / 100% branches / 100% functions / 100% lines** for
  `TypingBubble.tsx`; filtered chat-screen integration passes **2/2 suites / 15/15 relevant tests**. The complete
  component project passes **120/120 suites / 1,259/1,259 tests**, and full pinned-Node Jest passes **409/409 suites /
  4,561/4,561 tests**. TypeScript, zero-warning lint, configured format/diff checks, architecture, migrations, DB
  inventory/reconciliation, fast DB-write tests, and secret hygiene also pass. Independent review returned **GO**; a
  final branch-coverage regression also proves the removed-listener and late-rejected-query guards.

  This host proof does not claim Android preference/background-resume or native-driver behavior, real typing-state
  mounting, TalkBack announcements, or measured composer layout. Parent `A11Y-02` remains **IN_PROGRESS** for the
  action-overlay pop, slide-modal policy, functional-motion decisions, and exact-device proof. App-toast live-region
  semantics and the invisible-ink label risk remain open under `A11Y-03`. No build, upload, submission, tester
  invitation, server deployment, Play Console mutation, Android-setting change, network mutation, or device action
  occurred.

- **2026-08-23 — `A11Y-02D-ACTION-POP` makes each message-actions opening preference-aware and leak-free:** The
  chat-lifetime overlay now owns one ordered Reduce Motion query/listener and begins at fully visible final values.
  Unresolved, enabled, and fallback openings are static and consumed, so a later false result or same-guid anchor object
  cannot make an already-visible menu jump backward. A new anchored generation under known false retains the former
  spring exactly once. Its retained handle is nulled before stop and snapped to final **1** on live true, close,
  replacement, fallback, or unmount; later false does not replay that generation. Different-guid selection and
  close/reopen are fresh generations. Motion changes and same-guid anchor updates preserve the open emoji draft.

  The direct suite passes **53/53**, retaining **40** prior action cases and adding **13** lifecycle cases; direct plus
  arbitrary-emoji integration passes **2/2 suites / 60/60 tests**. Focused source coverage is **94.11% statements /
  92.30% branches / 85.71% functions / 95.16% lines**. The complete component project passes **120/120 suites /
  1,272/1,272 tests**, and full pinned-Node Jest passes **409/409 suites / 4,574/4,574 tests**. TypeScript, zero-warning
  lint, configured format/diff checks, architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and
  secret hygiene also pass. Independent review returned **GO** with no host defect.

  This host proof does not claim Android preference/background-resume, real native-driver interruption/first-frame
  behavior, anchored placement, or Modal/TalkBack focus order and restoration. Parent `A11Y-02` remains **IN_PROGRESS**
  for slide-modal and functional-motion decisions plus exact-device proof. App-toast and invisible-ink semantics remain
  open under `A11Y-03`. No build, upload, submission, tester invitation, server deployment, Play Console mutation,
  Android-setting change, network mutation, or device action occurred.

- **2026-08-23 — `A11Y-02E-SERVER-MODALS` latches each native modal's motion decision at its opening boundary:** The
  server-management route now owns one ordered Reduce Motion query/listener. Unknown and enabled preferences suppress
  a new slide; explicit false or query failure preserves the former slide for future openings. Pairing QR captures at
  tap time, while logs capture when their response is published. The QR open/type value and the logs text/type value
  are atomic, and duplicate publishers keep the existing opening, so a live preference event cannot change a visible
  native `Modal`'s `animationType`, recreate its Android dialog, or clear revealed QR/log content. Close/reopen adopts
  the latest preference; QR close and account retirement still unmount the sensitive subtree.

  The direct suite passes **33/33**, direct plus Pairing QR/server endpoints passes **3/3 suites / 58/58 tests**, and
  focused source coverage is **94.54% statements / 93.86% branches / 93.10% functions / 96.94% lines**. The complete
  component project passes **120/120 suites / 1,282/1,282 tests**, and full pinned-Node Jest passes **409/409 suites /
  4,584/4,584 tests**. TypeScript, zero-warning lint, configured format/diff checks, architecture, migrations, DB
  inventory/reconciliation, fast DB-write tests, and secret hygiene also pass. Independent review found and closed the
  separate-state and deferred-ref-capture risks before returning **GO**.

  This host proof does not claim Android setting/background-resume delivery, native modal pixels/recreation/focus,
  hardware Back, TalkBack behavior, or physical-device QR/log privacy. Parent `A11Y-02` remains **IN_PROGRESS** for
  the Theme Studio slide modals, functional swipe/zoom motion decisions, and exact-device proof. No build, upload,
  submission, tester invitation, server deployment, Play Console mutation, Android-setting change, network mutation,
  or device action occurred.

- **2026-08-23 — `A11Y-02F-ZOOM-RESET` preserves direct photo control while suppressing automatic spring-back:** Each
  mounted `ZoomableImage` now owns an ordered Reduce Motion query/listener and one generation-checked reset composite.
  Pinch and pan remain direct under every setting. Unknown/enabled resets write final **1/0/0** values; false or query
  failure retains the former three springs. Live true stops/snap-settles only an active reset, while committed or held
  zoom remains untouched. Fresh pinch, offscreen transition, completion, and unmount each retire exact ownership, so
  stale native completions cannot clear a replacement or revive motion.

  The focused suite passes **21/21**, retaining **12** prior cases and adding **9** lifecycle/race cases; focused plus
  media-viewer integration passes **2/2 suites / 55/55 tests**. Focused source coverage is **100% statements / 93.61%
  branches / 100% functions / 100% lines**. The complete component project passes **120/120 suites / 1,291/1,291
  tests**, and full pinned-Node Jest passes **409/409 suites / 4,593/4,593 tests**. TypeScript, zero-warning lint,
  configured format/diff checks, architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and
  secret hygiene also pass. Independent review caught the temporary typed-mock failure and required fresh-pinch plus
  offscreen-reset races before returning **GO**.

  This host proof does not claim Android preference/background-resume delivery, native-driver pixels/cancellation,
  real pinch/pan/pager arbitration, FlatList recycle, rotation, or TalkBack. Parent `A11Y-02` remains **IN_PROGRESS**
  for Theme Studio slides, message/conversation-row spring decisions, and device proof. No build, upload, submission,
  tester invitation, server deployment, Play Console mutation, Android-setting change, network mutation, or device
  action occurred.

- **2026-08-23 — `A11Y-02G-MESSAGE-LIST-SCROLL` closes four list-motion paths, including FlashList's hidden default:**
  The audit corrected the earlier three-path inventory: FlashList 2.0.2 also defaults near-bottom auto-follow to
  animated. One `MessageList`-lifetime preference owner now writes a stable ref before state. The ref controls the reply
  jump, own-send frame, and newest-button scroll at issue time; state explicitly controls FlashList auto-follow.
  Unknown/enabled uses immediate scrolls, while false/query failure retains existing animation. Events beat stale
  queries, preference rerenders keep memoized row callbacks stable, and unmount removes the listener and cancels delayed
  work. Already-static landing/convergence/resize paths and direct finger scrolling remain unchanged.

  Focused verification passes **21/21**, retaining **13** prior cases and adding **8** motion/lifecycle cases; all four
  related list suites pass **41/41** with source coverage at **93.75% statements / 84.51% branches / 87.75% functions /
  97.85% lines**. The complete component project passes **120/120 suites / 1,299/1,299 tests**, and full pinned-Node
  Jest passes **409/409 suites / 4,601/4,601 tests**. TypeScript, zero-warning lint, configured format/diff checks,
  architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and secret hygiene also pass. Independent
  review returned **GO** with no blocking defect.

  This host proof chooses motion policy when each scroll starts; it cannot prove or cancel FlashList work already queued
  or in native flight. Android preference/background delivery, physical landing/pinning, OEM variance, and TalkBack
  remain device-only. Parent `A11Y-02` remains **IN_PROGRESS** for Theme Studio slides, message/conversation-row springs,
  and device proof. The existing in-place chat-replacement pending-frame race remains separate lifecycle debt. No build,
  upload, submission, tester invitation, server deployment, Play Console mutation, Android-setting change, network
  mutation, or device action occurred.

- **2026-08-23 — `A11Y-02H-SHARED-MOTION-PREFERENCE` gives high-count rows one fenced native owner:** One
  UI-layer singleton now serves both rendering snapshots and stable non-rendering refs. The first state-only or ref-only
  consumer registers the native listener before one query; later consumers share it. Events beat stale query success or
  failure, duplicate booleans are silent, and the last unmount advances the generation before removing the subscription
  and resetting future mounts to unknown. Old events and queries cannot publish into a replacement owner.

  The ref projection updates its stable object before calling the latest optional boolean-change handler. Callback-prop
  rerenders cause no native owner churn, cleanup-to-null is silent, and retained responders receive no post-unmount
  work. This small addition was required so the next message/conversation-row milestones can stop an already-running
  spring without rerendering every mounted row or installing one native listener per row.

  Focused verification passes **8/8** with source coverage at **94.44% statements / 82.60% branches / 100% functions /
  95.55% lines**. The complete component project passes **121/121 suites / 1,307/1,307 tests**, and full pinned-Node
  Jest passes **410/410 suites / 4,609/4,609 tests**. TypeScript, zero-warning lint, configured format/diff checks,
  architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and secret hygiene also pass. Review
  holds exposed missing listener-before-query proof, the absent in-flight notification API, and missing no-churn proof;
  each was closed before two independent final **GO** verdicts.

  This infrastructure child changes no user-facing motion. Parent `A11Y-02` remains **IN_PROGRESS** for adopting it in
  `MessageSwipeWrapper` and `SwipeableRow`, both Theme Studio slide modals, and exact-device proof. Android preference
  delivery/background resume, many recycled rows, native-driver interruption, gesture arbitration, OEM variance, and
  TalkBack remain device-only. No build, upload, submission, tester invitation, server deployment, Play Console
  mutation, Android-setting change, network mutation, or device action occurred.

- **2026-08-23 — `A11Y-02H1-MESSAGE-LIST-SHARED-OWNER` removes duplicate native ownership before row adoption:**
  `MessageList` now gets render-time policy and its stable delayed-callback ref from the shared `A11Y-02H` store. Its
  private `AccessibilityInfo` query/listener and duplicate stale-query/fallback lifecycle are removed. FlashList
  auto-follow still reads state, while reply jump, own-send frame, and newest-button callbacks still read a stable ref at
  use time; the four policies and existing fallback remain unchanged.

  The first broad run with the paused message-row candidate passed **120/121 component suites** but produced **13**
  owner-count failures: the old list owner plus the new row owner caused two native queries/removals. No behavioral
  assertion failed. The swipe changes were isolated in a named local stash, and the fix kept the exact one-owner
  assertions instead of accepting duplication. A ref-only owner can now resolve before the list mounts; list state/ref
  join immediately with no second add/query, list-first cleanup keeps the owner, and final cleanup removes once. A
  synchronous true registration event also reaches FlashList and the exact retained jump callback before a stale false
  query resolves.

  Focused verification passes **23/23**; all four related list suites pass **43/43** with source coverage at **93.58%
  statements / 84.82% branches / 85.71% functions / 97.56% lines**. The complete component project passes **121/121
  suites / 1,309/1,309 tests**, and full pinned-Node Jest passes **410/410 suites / 4,611/4,611 tests**. TypeScript,
  zero-warning lint, formatting/diff checks, architecture, migrations, DB inventory/reconciliation, fast DB-write
  tests, and secret hygiene also pass. Independent review's ordering-proof **HOLD** was closed before final **GO**.

  Parent `A11Y-02` remains **IN_PROGRESS** for `MessageSwipeWrapper`, `SwipeableRow`, both Theme Studio slide modals,
  and exact-device proof. Android preference/background delivery, native FlashList work already in flight, physical
  landing/pinning, OEM variance, and TalkBack remain open. No build, upload, submission, tester invitation, server
  deployment, Play Console mutation, Android-setting change, network mutation, or device action occurred.

- **2026-08-23 — `A11Y-02I-MESSAGE-SWIPE-RESET` keeps finger control direct and removes automatic motion:** Each
  `MessageSwipeWrapper` now reads the shared non-rendering preference projection. Left timestamp reveal and right reply
  pull still track the finger for every setting. Only release/termination return is gated: unknown/true snaps to zero,
  while false/query failure retains the exact prior spring. Live true stops/snaps only an owned automatic return, so a
  held swipe does not move until release; live false changes only future policy.

  One exact animation handle is cleared before stop, installed before start, and cleared only by its own completion. A
  fresh grant stops an older return without snapping, stale/synchronous completions cannot clear a replacement, and
  unmount stops without a later write. Reply reads the latest callback and fires before settle only past the translated
  threshold; termination never replies. The Samsung claim/capture/refusal/native-block guards remain unchanged. A
  focused rerender check also found and fixed the pre-existing `useRef(PanResponder.create(...))` evaluation that built
  and discarded a responder on every render; the committed row now initializes it once explicitly.

  Focused verification passes **13/13** with **100% statements / branches / functions / lines**. Swipe math, row
  memo/binding, and focused suites pass **4/4 suites / 27/27 tests**; wrapper plus shared-list-owner integration passes
  **2/2 suites / 36/36 tests**. The complete component project passes **121/121 suites / 1,319/1,319 tests**, and full
  pinned-Node Jest passes **410/410 suites / 4,621/4,621 tests**. TypeScript, zero-warning lint, formatting/diff checks,
  architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and secret hygiene also pass. Two
  independent lifecycle reviews returned **GO**; the earlier duplicate-list-owner failure was closed by separately
  freezing `A11Y-02H1`, not by weakening integration assertions.

  Parent `A11Y-02` remains **IN_PROGRESS** for `SwipeableRow`, both Theme Studio slide modals, and exact-device proof.
  Native-driver interruption/pixels, rapid re-grab, live setting changes during held/return motion, real left/right
  gesture feel, keyboard-open behavior, FlashList/Samsung arbitration, recycle/unmount, OEM variance, and TalkBack remain
  device-only. No build, upload, submission, tester invitation, server deployment, Play Console mutation,
  Android-setting change, network mutation, or device action occurred.

- **2026-08-23 — `A11Y-02J-CONVERSATION-ROW-SNAP` preserves direct row control and removes automatic snap motion:**
  Every `SwipeableRow` now reads the shared non-rendering Reduce Motion preference. Left/right movement and width clamps
  still track the finger. Only automatic release/termination destinations and action-button close are gated:
  unknown/true writes the chosen open/closed target directly, while false/query failure retains the exact prior spring.
  Live true stops and finishes an owned snap at its target but does not move a held swipe; live false affects only future
  work.

  One exact animation handle is cleared before stop, installed before start, and cleared only by its own completion. A
  fresh grant stops without writing, stale/synchronous completions cannot clear a replacement, recycle stops and centers
  immediately, and unmount stops without later writes. Current widths and action callbacks remain live, close settlement
  starts before the selected callback, and all Samsung/FlashList responder guards remain. The row now also constructs
  its PanResponder exactly once rather than evaluating a discarded instance on each rerender. Multiple conversation
  rows, message rows, and `MessageList` share the one native preference owner from `A11Y-02H`/`H1`.

  Focused verification passes **15/15** with **100% statements / branches / functions / lines**. Row plus
  `ConversationTile` passes **2/2 suites / 37/37 tests**; row plus shared-owner infrastructure passes **2/2 suites /
  23/23 tests**. The complete component project passes **121/121 suites / 1,328/1,328 tests**, and full pinned-Node Jest
  passes **410/410 suites / 4,630/4,630 tests**. TypeScript, zero-warning lint, configured format/diff checks,
  architecture, migrations, DB inventory/reconciliation, fast DB-write tests, and secret hygiene also pass. The first
  focused run's sole failure was the pre-existing clamp's JavaScript negative zero versus an expected positive zero;
  that exact behavior is now pinned. Independent review's action-start ordering **HOLD** was closed with an actual Jest
  invocation-order assertion before final **GO**.

  Parent `A11Y-02` remains **IN_PROGRESS** for both Theme Studio slide modals and exact-device proof. Native-driver
  interruption/landing, rapid re-grab, live setting changes, real left/right and vertical-list gesture arbitration,
  keyboard-open behavior, recycling, OEM/Samsung variance, and TalkBack remain device-only. No build, upload,
  submission, tester invitation, server deployment, Play Console mutation, Android-setting change, network mutation,
  or device action occurred.

- **2026-08-23 — `A11Y-02K-GLOBAL-THEME-STUDIO-MODAL` latches native dialog motion and editor identity together:**
  The global custom-themes route now uses the shared Reduce Motion preference owner. Every New/Edit opening captures
  one complete editor payload: unknown/true selects `animationType="none"`, while exact false or query failure retains
  `"slide"`. Live setting changes affect only the next opening. A retained or double opener cannot replace the motion
  decision, row identity, name, or tokens of a visible editor; Back, Cancel, and successful Apply clear the latch.

  Focused verification passes **14/14** with **85.23% statements / 73.03% branches / 95.65% functions / 87.78% lines**.
  Route plus the real `ThemeStudio` passes **15/15**; route plus the shared preference owner passes **22/22**. The
  complete component project passes **121/121 suites / 1,333/1,333 tests**, and full pinned-Node Jest passes **410/410
  suites / 4,635/4,635 tests**. TypeScript, zero-warning lint, configured format/diff checks, architecture, migrations,
  DB inventory/reconciliation, fast DB-write tests, and secret hygiene also pass. The initial DB report exposed **17**
  line shifts caused by declaration placement; moving the declarations below the final inventoried writer restored exact
  **0/0/0** reconciliation. Independent review's retained-opener/identity/close-path **HOLD** was closed before final
  **GO**.

  Parent `A11Y-02` remains **IN_PROGRESS** for the per-chat Theme Studio modal and exact-device proof. Android setting
  and background delivery, real native Modal presentation/dismissal without draft or focus loss, Back/Cancel/Apply,
  keyboard/insets/font scaling, TalkBack focus, account replacement, and OEM variance remain device-only, along with
  the earlier `A11Y-02A..J` device matrix. No build, upload, submission, tester invitation, server deployment, Play
  Console mutation, Android-setting change, network mutation, or device action occurred.

- **2026-08-23 — `A11Y-02L-CHAT-THEME-STUDIO-MODAL` closes the final host implementation gap:** The outer
  conversation-details route now retains one shared Reduce Motion preference owner across GUID-keyed children. Each
  child stores a private opening-latched `none`/`slide` value, so unknown/true suppresses the transition, exact
  false/query failure keeps it, and a live setting change affects only the next Back/Cancel/Apply-delimited opening.
  Retained A/account open or Apply callbacks are inert; fresh B immediately reads the current outer snapshot and writes
  only B's GUID.

  Focused verification passes **37/37** with **84.53% statements / 78.57% branches / 85.39% functions / 91.77% lines**.
  Route plus the real `ThemeStudio` passes **38/38**; route plus the shared owner passes **45/45**. The complete component
  project passes **121/121 suites / 1,338/1,338 tests**, and full pinned-Node Jest passes **410/410 suites / 4,640/4,640
  tests**. TypeScript, zero-warning lint, configured format/diff checks, architecture, migrations, DB inventory
  **1,300/0** with exact **0/0/0** reconciliation, fast DB-write tests, and secret hygiene also pass. Independent audit
  caught and corrected the first candidate's keyed-child owner before freeze; the strengthened A→B live-value seam and
  final tree received **GO**.

  `A11Y-02` host implementation is complete but the parent remains **IN_PROGRESS** for exact-device proof across
  `A11Y-02A..L`: Android setting/background delivery, real native effects and driver interruption/landing, scroll and
  gesture feel, modal presentation/dismissal without recreation or draft/focus loss, Back/Cancel/Apply, keyboard/insets/
  font scaling, TalkBack focus/announcements, recycling, and OEM/Samsung variance. No build, upload, submission, tester
  invitation, server deployment, Play Console mutation, Android-setting change, network mutation, or device action
  occurred.

- **2026-08-23 — `DEVICE-01B4-A11Y-02-MOTION-MATRIX` prevents old-candidate evidence from closing new motion work:**
  Read-only ancestry proves frozen version-code-56 source `5d367eb58e38126258423f1cd9ce0da42b179f7f` is 24 commits
  behind `8c5e7836b52df4207e315a7a445893f7b36b4a41`, which contains the completed `A11Y-02A..L` host
  implementation. The unchanged v56 ledger and no-rebuild boundary remain valid for their original purposes, but v56 is
  explicitly ineligible for A11Y-02 device credit. A future candidate must be separately approved, built locally from a
  descendant containing that exact implementation commit, and assigned a fresh artifact/source/Play-install ledger
  before any motion row can run.

  The one stale pre-remediation finding is replaced by **12 open / 0 checked** source-gated rows covering A–L/H1 and
  their common off/on, cold-open, foreground-live, background/resume, restore-off, Android/OEM/navigation/keyboard/font/
  TalkBack context. B4 owns those 12 rows inside B3's current **51**, so the B1+B2+B3 parent count is **131 open / 0
  checked**, not 132. Internal query failure, listener ownership, and generation fencing remain host-only claims.

  Exact document/source assertions pass **62/62**, the frozen candidate table is byte-for-byte unchanged, and configured
  Markdown formatting/diff checks pass. Pinned Node **24.19.0** verification passes TypeScript, zero-warning lint,
  architecture **30/30** over **65** core files, migrations **5/5** over **38** migrations at head `0038`, DB inventory
  **1,300 findings / 0 errors** with **0/0/0** reconciliation, fast DB-write tests **84 passed / 10 intentionally skipped /
  0 failed**, secret hygiene **4/4**, and full Jest **410/410 suites / 4,640/4,640 tests / 0 snapshots**. Independent
  review initially returned **HOLD** for four wording/audit precision issues; the exact-source gate, reduced-versus-normal
  invisible-ink reveal, live overlay settlement, and this audit record now correct them. Final re-review returned **GO**.

  This docs-only milestone created no code or app build and performed no upload, install, submission, tester invitation,
  Play Console, server, network, credential, Firebase, Android-setting, or device action. `A11Y-02` remains
  **IN_PROGRESS**, `DEVICE-01` remains **BLOCKED**, and `STORE-01` remains **IN_PROGRESS** pending a separately approved
  current-source local candidate and all existing external evidence.

- **2026-08-23 — `STORE-01A0-UGC-CONTRACT-DECOMPOSITION` turns the deferred L-sized safety gap into reviewable work:**
  The required first action for an undecomposed L parent is complete in [`UGC_SAFETY_CONTRACT.md`](../UGC_SAFETY_CONTRACT.md).
  Official Google Play guidance was rechecked without changing Play state: direct-messaging clients remain within the
  UGC policy's terms/moderation/blocking boundary, while exclusive Internal Testing might skip standard policy/security
  review and is Data safety-exempt—not declared policy-exempt. `DEC-11` and parent `STORE-01A` therefore remain unchanged:
  behavior is deferred for the current exclusive Internal Testing target and becomes P0 before later tracks or an earlier
  Play finding.

  Read-only app/server inventory found no terms model/acceptance gate, block/report model or UI/API, advertised UGC
  capability, authoritative enforcement, moderation case store, owned response operation, or reviewer journey. The
  technical `/error-reports` path has different privacy projection, consent, schema, storage, and purpose and cannot be
  counted as abuse intake. Canonical server send/new-chat handlers require shared-password authentication but ignore a
  human/device safety principal and apply no acceptance/block check. The server tree was preserved with its pre-existing
  **659** default short-status records (**680** with untracked files expanded); its exact NUL-delimited status digest
  remained `4c123e8ca35de77e3f58281c3915812e4522afe819275896eba876c0e86fa145`.

  A0 now defines eight explicit owner/cross-repository decision stop gates and A1–A6 children for terms acceptance,
  blocking, report intake, server enforcement, moderation operations, and exact reviewer evidence. Every behavior child
  must first receive its listed decisions and be split into focused two- or three-file batches; approving one milestone
  does not waive another blocker. Parent `STORE-01A` stays **TODO**, `STORE-01` stays **IN_PROGRESS**, and no UGC safety or
  Google Play compliance is claimed.

  Exact document/source assertions pass **127/127**; configured Markdown formatting and diff checks pass. Pinned local
  host verification passes TypeScript, zero-warning lint, architecture **30/30** over **65** core files, migrations
  **5/5** over **38** migrations at head `0038`, DB inventory **1,300 findings / 0 errors** with exact **0/0/0**
  reconciliation, fast DB-write tests **84 passed / 10 intentionally skipped / 0 failed**, secret hygiene **4/4**, and
  full Jest **410/410 suites / 4,640/4,640 tests / 0 snapshots**. The first independent review returned **HOLD** for six
  contract/evidence precision defects; all were corrected before final read-only re-review returned **GO**.

  This two-doc milestone changes no app/server behavior and performs no build, EAS/cloud action, upload, submission,
  tester invitation, Play Console mutation, server edit/deployment, network mutation, credential use, Android-setting,
  or device action.

- **2026-08-24 — `REL-005A` closes the bounded-teardown host inventory and confirmed code gaps:**
  `docs/REL_005A_TEARDOWN_INVENTORY.md` counts 12 work families. Attachment teardown now double-sweeps active and
  cancelled-but-unsettled handles, reissues native cancellation on a later cleanup, and joins the exact terminal promise
  before B admission. Direct image sends cannot open a new old-account upload after their optimistic insert. Automatic
  outgoing recovery is tracked across its whole HTTP/native attempt. All 14 remote TanStack queries now abort active
  transport and retry backoff through their endpoint wrappers; local SQLite search remains deliberately publication-
  fenced rather than falsely advertised as cancelable.

  Independent review found the first registry candidate retained only the terminal promise, not the cancel handle; the
  identity-keyed pending registry and a repeated-sweep regression closed that blocker. Final focused verification passes
  **9/9 Node suites / 207/207 tests** and **3/3 component suites / 66/66 tests**, strict TypeScript, targeted ESLint with
  **0 errors** (10 unchanged test-harness import-order warnings), touched-file format/diff checks, DB inventory
  **1,301 findings / 0 errors**, and exact **0/0/0** reconciliation. Two reviewed callback rekeys and 43 mechanical line
  shifts were recorded; there were no new DB-write findings.

  Parent `REL-005A` remains **IN_PROGRESS** only for synchronous-JSI/Expo/OkHttp and exact Android
  A→Disconnect→B device proof on a future candidate containing this post-v56 work. Frozen version-code-56 source and AAB
  were not rebuilt or modified. No full Jest/component, architecture, migration, adversarial DB-write, build, upload,
  Play, EAS, server, network, credential, Android-setting, or device action occurred.

- **2026-08-25 — replacement `STORE-01` source freeze and local candidate v57:** The owner-approved replacement source
  is clean commit `8564b348d02c4e218e8a75a6a36e265ec5740772` on branch `release/store-01-0.1.41`. The ignored retained artifact
  is `gator-release-0.1.41-v57-8564b34.aab`: **55,768,266 bytes**, SHA-256
  `3ad096fe474fb35b8f0619ca9b9ac337dc3613d16a1df1f98d638176ef25be2b`. The approved local EAS production build
  incremented the remote Android counter **56 → 57**, fetched the existing managed keystore, and stopped after writing
  the local AAB. Gradle reported **BUILD SUCCESSFUL**, **1,227 tasks**, in **4m40s**; it created no hosted build or
  submission.

  Independent `shasum` and OpenSSL digests agree. ZIP integrity passes across **1,754 unique entries**; the native ABI
  set is exactly `arm64-v8a`; ordinary Java signature verification passes; Keytool and OpenSSL report upload-certificate
  SHA-256 `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`.
  Official Bundletool **1.18.3**, whose downloaded JAR hash was independently checked as
  `a099cfa1543f55593bc2ed16a70a7c67fe54b1747bb7301f37fdfd6d91028e29`, validates the bundle. The decoded manifest is
  package `com.bluegreengatorapps.messages`, version `0.1.41`, version code `57`, minimum SDK `24`, target SDK `36`, and
  `android:allowBackup="false"`; the packaged Android guard reports **0 errors** across **6 DEX entries**.

  The candidate freeze gates pass strict TypeScript, zero-warning lint, configured formatting, architecture **30/30**,
  migration guard **5/5** at head `0039_message_error_message`, error-diagnostic guard **30/30**, release/toolchain
  guard **8/8**, workflow security **20/20**, secret hygiene **4/4**, Expo Doctor **20/20**, dependency alignment, both
  npm audits with **0 vulnerabilities**, and an Android export of **2,264 modules**. The full DB-write gate passes
  **94/94** with **0 failed / 0 skipped**, inventory **1,304 findings / 0 errors**, and exact **0/0/0** reconciliation.
  The one full Jest run initially produced **419 passed / 4 failed suites** and **4,728 passed / 28 failed tests** because
  Expo Babel rejected `declare public readonly serverDetail?: string` before the four suites reached assertions. The
  shown one-line correction removed only `declare`; focused recovery then passed TypeScript, API **4/4 suites / 41/41
  tests**, and affected component **5/5 suites / 114/114 tests**. Per the no-repeat candidate policy, full Jest was not
  rerun after that focused recovery.

  Retired v56 and its original digest remain historical static proof only. In a read-only Chrome preflight on
  2026-08-25, the only available signed-in Google account opened Play Console's developer-account creation page rather
  than an existing developer account, so no live app or track state was visible. No AAB upload, Play submission/track
  change, tester invitation, server/EAS deployment, credential mutation, install, Firebase delivery, Android-setting
  change, or device action occurred. `STORE-01` and `STORE-01G` remain **IN_PROGRESS**; `DEVICE-01` remains **BLOCKED**
  on Play delivery, a refreshed v57 checklist, representative devices, isolated staged server/fixtures, Firebase,
  release credentials, and exact-candidate execution.

- **2026-08-25 — `DB-02B1` reconciles and pins the existing transaction API:** Read-only source and history review
  found that later DB-02A work had already supplied B1's production foundation: one process-wide writer queue, an
  opaque branded transaction token authenticated by a private runtime `WeakMap`, prompt rejection of forged/stale joins,
  rollback-latched late joins, and scanner rejection of direct or transitive nested coordinator entry. Replacing that design
  with another transaction layer or a type-only database brand would have weakened the existing runtime boundary, so no
  production source changed.

  `test/types/dbTransactionApi.typecheck.ts` is now part of the normal repository typecheck. Its positive assertions
  accept the owner token at transaction-only entry points; its negative assertions fail the build if the token becomes
  usable as a raw database or nested transaction argument, or if a raw database/plain object becomes usable as the
  token. This proves the capability supplied by the owner callback. The scanner remains necessary for captured raw
  databases and explicit type bypasses, which TypeScript cannot structurally prevent.

  Under pinned Node **24.19.0**, strict TypeScript passes with the contract visibly included, the focused transaction
  suite passes **1 suite / 15 tests / 0 snapshots**, the fast scanner passes **84 / 94** with **10 intentional skips /
  0 failed**, and the live report remains **1,304 findings / 0 structural or membership errors**. An earlier test start
  under the host's unpinned Node 26 failed before SQLite assertions because `better-sqlite3` had the wrong native ABI;
  rebuilding that local dependency under the repository's pinned Node restored the green focused run without source or
  lockfile changes. Independent review is **GO** for the proof-only B1 closure.

  Parent `DB-02B` is **IN_PROGRESS** and `DB-02B2` remains open. This post-v57 milestone does not rebuild, modify, or
  supply evidence for the frozen v57 AAB, and performs no build, upload, submission, Play/EAS/server mutation, credential
  use, Android-setting change, or device action.

- **2026-08-25 — `DB-02B2A` hardens outgoing chat-ID lookup construction:** The focused audit found one named
  transaction-only helper still accepted a raw `AppDatabase`: `requireChatIdByGuidWithinTransaction`, used only by the
  existing text, contact, reaction, and attachment optimistic-insert owners. All four paths were already inside
  `withDbTransaction`, so this closes a construction-time API gap rather than reclassifying an unowned write.

  The helper now accepts `DbTransactionContext` and immediately returns one inline, authenticated
  `runInTransactionContext` join. Each owner passes its callback token, and the compile-only API contract proves both
  valid token use and rejection of the old raw-database call shape. No new coordinator, write, network operation, or
  device dependency was introduced.

  The scanner correctly refused automatic metadata transfer after the callback snippets changed. Six exact
  contact/reaction/attachment callback and coordinator records were manually mapped with their reviewed evidence and
  disposition preserved; ten later `chats.ts` records received scanner-proven four-line shifts. The final dry-run is
  exactly **0 line shifts / 0 rekeys / 0 additions**, and the live report remains **1,304 findings / 0 structural or
  membership errors**.

  Under Node **24.19.0**, strict TypeScript passes; the outgoing identity, scheduled handoff, and transaction-runtime
  suites pass **3/3 suites / 31/31 tests / 0 snapshots**; and the fast scanner passes **84/94** with **10 intentional
  skips / 0 failed**. One attempted Jest launch used the host's Node 26 child process and failed before assertions on a
  `better-sqlite3` ABI mismatch; invoking Jest directly with pinned Node 24 produced the green result without rebuilding
  dependencies or changing source. Independent final review is **GO**.

  Parent `DB-02B` remains **IN_PROGRESS** because the rest of `DB-02B2` owner/path enumeration and conversion is open.
  This is post-v57 work: it does not rebuild, modify, or supply evidence for the frozen v57 AAB, and it performs no
  build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-25 — `DB-02B2B` makes deletion-sync tombstones explicit transaction-context work:** The only production
  caller in this slice, `syncDeletedMessages`, previously delegated each row to the standalone `markMessageDeleted`
  owner. That path was already scanner-approved and safe; this slice hardens its construction so the sync service now
  opens the guarded owner itself and can invoke only `markMessageDeletedWithinTransaction` with the callback token.

  The row loop deliberately retains one short transaction per deletion. It does not hold the global mutex across a
  server page of up to 500 rows, network work, or the later cursor write, and it preserves the tested guarantee that an
  earlier tombstone remains committed if a later row fails. The null-date clock fallback is evaluated before queue
  admission, the account commit guard still gates admission and commit, and `applied` increments only after commit.

  The exact sync-delegation certificate drops the retired public-helper edge. The scanner then failed closed first on
  the stale old inventory record and again on ambiguous coordinator cardinality because this function already had two
  other transaction owners. Manual live-ID review replaced that one record with the new coordinator, callback, and
  token-only-helper records; their evidence is the scanner, deletion-sync behavior suite, and transaction-runtime
  suite. Twelve downstream `engine.ts` lines shifted mechanically. The final inventory is **1,306 findings / 0
  structural or membership errors**, and reconciliation is exactly **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/services/deletionSync.test.ts` passes **1 suite / 23
  tests / 0 snapshots**; and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Independent
  final review is **GO**.

  Parent `DB-02B` remains **IN_PROGRESS** because the rest of `DB-02B2` owner/path enumeration and conversion is open.
  This is post-v57 work: it does not rebuild, modify, or supply evidence for the frozen v57 AAB, and it performs no
  build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-25 — `DB-02B2C` makes error-report revocation an explicit context owner:** `revokeErrorReporting`
  previously delegated the durable queue purge to standalone `clearErrorReports`. That path was already guarded and
  scanner-approved; this slice changes its construction so the service opens the owner and calls only
  `clearErrorReportsWithinTransaction` with the callback token.

  Upload abort remains synchronous. The exact database and account lease are still captured before any await; an older
  purge and the in-memory sink drain both settle before DB admission; and the live lease function—not a captured
  boolean—guards admission, `BEGIN`, and `COMMIT`. Only one bounded `DELETE` runs under the mutex. A rejected or failed
  purge still leaves `purgeRequiredGeneration` set for retry, while a successful current-account commit clears only its
  matching generation. No upload, network request, sink wait, or second purge generation enters the transaction.

  The error-report scanner certificate now expects **20** local delegated edges, retains the rekeyed outer purge-IIFE
  edge, removes the retired public-helper edge, and pins the three explicit coordinator/callback/token-helper records.
  Automatic reconciliation correctly refused to transfer proof across the changed callback snippet. Manual exact-ID
  review applied that outer rekey, replaced the inner edge with the three reviewed records, and accepted seven later
  `index.ts` line shifts. Inventory is **1,308 findings / 0 structural or membership errors**, and reconciliation is
  exactly **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/services/errorReportQueueService.test.ts` passes **1
  suite / 32 tests / 0 snapshots**; the fast scanner passes **84/94** with **10 intentional skips / 0 failed**; and the
  exact-set check proves both old IDs absent plus the rekeyed outer and three explicit-owner IDs present. Independent
  final review is **GO**.

  Parent `DB-02B` remains **IN_PROGRESS** because the rest of `DB-02B2` owner/path enumeration and conversion is open.
  This is post-v57 work: it does not rebuild, modify, or supply evidence for the frozen v57 AAB, and it performs no
  build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-25 — `DB-02B2D` makes outgoing failure reconciliation an explicit context owner:** `handleSendFailure`
  previously delegated its message/queue update to standalone `reconcileOutgoingError`. That edge was already guarded
  and scanner-approved; the service now opens the owner itself and calls only
  `reconcileOutgoingErrorWithinTransaction` with the authenticated callback token.

  The fallback clock is sampled before writer-queue admission, preserving the previous retry-backoff timestamp if the
  mutex is busy. Sanitized server detail is also captured before admission, and the live `commitGuard` function—not a
  sampled boolean—still guards admission, `BEGIN`, and `COMMIT`. Diagnostic logging remains before the owner, and
  `notifyFailedSend` remains after a successful commit. The transaction callback performs only the existing bounded
  outgoing-row/queue reconciliation; no network, native, notification, UI, or timer work enters it.

  The ordinary-send exact-set certificate removes the retired delegated ID and pins the three explicit coordinator,
  callback, and token-helper IDs. Automatic reconciliation correctly stopped on the stale delegated record because a
  one-to-three ownership change cannot safely inherit metadata. Manual live-ID review replaced that record with the
  three reviewed entries. Inventory is **1,310 findings / 0 structural or membership errors**, and reconciliation is
  exactly **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/services/sendOutcome.test.ts` passes **1 suite / 9
  tests / 0 snapshots**; the exact queued-disconnect test in `test/services/outgoingQueueService.test.ts` passes **1/1**;
  the ordinary-send exact-set test passes **1/1**; and the fast scanner passes **84/94** with **10 intentional skips / 0
  failed**. Prettier and `git diff --check` pass. Independent final review is **GO** with no findings.

  Parent `DB-02B` remains **IN_PROGRESS** because the rest of `DB-02B2` owner/path enumeration and conversion is open.
  This is post-v57 work: it does not rebuild, modify, or supply evidence for the frozen v57 AAB, and it performs no
  build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-25 — `DB-02B2E` makes backup customization restore an explicit context owner:** `restoreBackup`
  previously delegated the customization list to standalone `restoreChatCustomizations`, which owned one guarded
  transaction per row. The service now preserves that exact per-row loop itself and calls only
  `restoreChatCustomizationWithinTransaction` with each authenticated callback token.

  The loop remains outside the transaction, so a validated but untrusted backup cannot hold the global mutex across up
  to 2,000 customization rows. The same live `ownershipGuard` function—not a sampled boolean—guards admission, `BEGIN`,
  and `COMMIT` for every row. A successful prefix remains committed if a later row fails, and the applied count advances
  only after each row commits. Missing chats still contribute zero. KV and theme restore phases remain unchanged, as does
  the public wrapper for genuine standalone callers and tests.

  The repository-context exact-set certificate removes the retired delegated ID and pins the three explicit coordinator,
  callback, and token-helper IDs. A one-to-three ownership change requires manual live-ID review rather than unsafe proof
  inheritance; that review replaced the one old record with the three exact entries. Inventory is **1,312 findings / 0
  structural or membership errors**, and reconciliation is exactly **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/services/backup.test.ts` and
  `test/services/backupService.test.ts` pass **2 suites / 61 tests / 0 snapshots**; the repository-context exact-set test
  passes **1/1**; and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Prettier and
  `git diff --check` pass. Independent final review is **GO** with no findings.

  Parent `DB-02B` remains **IN_PROGRESS** because the rest of `DB-02B2` owner/path enumeration and conversion is open.
  This is post-v57 work: it does not rebuild, modify, or supply evidence for the frozen v57 AAB, and it performs no
  build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-25 — `DB-02B2F` makes global custom-theme persistence explicit context work:** `setCustomTheme` and
  `clearCustomTheme` previously delegated their single KV upserts to standalone `kvSet`. Each setter now opens one
  bounded owner and calls only `kvSetWithinTransaction` with its authenticated callback token. The selected ID is still
  converted to the same string value, clearing still stores the same empty string, and validation, optimistic state,
  and best-effort persistence behavior are unchanged. Because these keys are app-wide preferences, no account guard is
  required.

  The interactive-leaf exact-set certificate removes the two retired delegated IDs and pins the six explicit
  coordinator/callback/token-helper IDs. The enclosing store callback change mechanically rekeys and shifts the four
  unchanged `setPreset` records. Manual live-ID review records all ten exact findings; inventory is **1,316 findings / 0
  structural or membership errors**, and reconciliation is exactly **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/state/themeStore.test.ts` passes **1 suite / 20 tests / 0
  snapshots**; the exact interactive-leaf certificate passes **1/1**; and the fast scanner passes **84/94** with **10
  intentional skips / 0 failed**. Prettier and `git diff --check` pass. Independent final review is **GO** with no
  findings.

  Parent `DB-02B` remains **IN_PROGRESS** because the rest of `DB-02B2` owner/path enumeration and conversion is open.
  This is post-v57 work: it does not rebuild, modify, or supply evidence for the frozen v57 AAB, and it performs no
  build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-25 — `DB-02B2G` gives mark-read one guarded read/write owner:** `markRead` previously resolved the local
  chat ID and newest received message on the shared connection before delegating the marker update to a later standalone
  transaction. Those reads could observe a neighboring transaction's uncommitted replacement chat and phantom message;
  after that neighbor rolled back, the delayed setter could commit the nonexistent GUID into the restored chat.

  A private transaction-context-only resolver now immediately adopts the authenticated token for both reads. `markRead`
  opens one bounded owner, passes the same token to that resolver and `setLastReadMessageGuidWithinTransaction`, and uses
  the live account lease as its commit guard. Lease assertions bracket the DB steps. `ensureDatabase` remains before the
  owner for killed-app notification actions; feature-setting hydration and the best-effort HTTP receipt remain after
  commit. Unknown chats still stop before hydration/HTTP, while known empty chats still perform the server receipt.

  The conversation-action exact-set certificate removes the retired setter-delegation ID and pins the coordinator,
  callback, and scoped-helper IDs. Manual live-ID review replaces that one finding with the three explicit records;
  reconciliation then applies one scanner-proven startup-edge rekey and twenty line shifts. Inventory is **1,318 findings
  / 0 structural or membership errors**, and final reconciliation is exactly **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/services/markUnread.test.ts` passes **1 suite / 14 tests /
  0 snapshots**; the exact conversation-action certificate passes **1/1**; and the fast scanner passes **84/94** with
  **10 intentional skips / 0 failed**. Prettier and `git diff --check` pass. Independent concurrency review is **GO**
  with no findings.

  Parent `DB-02B` remains **IN_PROGRESS** because the rest of `DB-02B2` owner/path enumeration and conversion is open.
  This is post-v57 work: it does not rebuild, modify, or supply evidence for the frozen v57 AAB, and it performs no
  build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2H` makes global feature-setting persistence explicit context work:** `setFlag`,
  `setMaxConcurrentDownloads`, and `setAutoDownloadDestination` previously delegated their one-row KV upserts to the
  standalone `kvSet` owner. Each setter now opens one bounded transaction and calls only `kvSetWithinTransaction` with
  its authenticated callback token. These keys are device-global preferences that intentionally persist across account
  disconnects, so they do not receive an account lease guard.

  Setter behavior is otherwise unchanged. Boolean flags still publish optimistically and serialize the same key plus
  `1`/`0`; the download cap is still clamped, applied to the runtime semaphore, and published before persistence; and the
  destination still publishes the same `app`/`gallery`/`album` value first. Persistence failures remain best-effort and
  do not roll back the in-memory session choice. No state, semaphore, network, native, or timer work enters an owner.

  The interactive-leaf exact-set certificate removes the three retired delegated IDs and pins nine explicit
  coordinator/callback/token-helper IDs. Manual live-ID review replaces each one-to-three conversion. Removing the unused
  `kvSet` import shifts the four unchanged consent-owner records up one line; final inventory is **1,324 findings / 0
  structural or membership errors**, with exact **0 line shifts / 0 rekeys / 0 additions** reconciliation.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/state/featureSettingsStore.test.ts` passes **1 suite / 34
  tests / 0 snapshots**; the exact interactive-leaf certificate passes **1/1**; and the fast scanner passes **84/94**
  with **10 intentional skips / 0 failed**. Prettier and `git diff --check` pass. Independent final review is **GO** with
  no findings.

  Parent `DB-02B` remains **IN_PROGRESS** because the rest of `DB-02B2` owner/path enumeration and conversion is open.
  This is post-v57 work: it does not rebuild, modify, or supply evidence for the frozen v57 AAB, and it performs no
  build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2I` makes the cache-reset marker an explicit context owner:** `clearLocalCache` previously
  delegated its mandatory first sync-marker reset to the standalone `setSyncMarker` transaction owner. It now opens
  one short marker transaction and calls only `setSyncMarkerWithinTransaction` with the authenticated callback token.
  That transaction commits before the first deletion stage begins. The independently committed, at-most-500-row
  deletion batches remain unchanged; the entire wipe is deliberately not wrapped in one transaction. Cleanup remains
  unguarded by an account lease because it must complete after disconnect revokes the old account authority.

  The repository-context exact-set certificate removes the retired delegated ID and pins the three explicit
  coordinator, callback, and token-helper IDs. Manual live-ID review replaces the old one-to-three boundary, while
  reconciliation applies fifty-two scanner-proven line shifts to the unchanged later maintenance findings. Inventory
  is **1,326 findings / 0 structural or membership errors**, and final reconciliation is exactly **0 line shifts / 0
  rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/db/clearLocalCache.test.ts` passes **1 suite / 27 tests /
  0 snapshots**; the exact repository-context certificate passes **1/1**; and the fast scanner passes **84/94** with
  **10 intentional skips / 0 failed**. The rollback-neighbor test now directly proves the marker itself stays queued
  until the neighboring rollback completes. Parent `DB-02B` remains **IN_PROGRESS** because the rest of `DB-02B2`
  owner/path enumeration and conversion is open. This is post-v57 work and performs no build, upload, submission,
  Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2J` gives mark-unread a guarded explicit context owner:** the service previously delegated
  its local chat update to standalone `setChatUnreadLocal`. The repository now exposes
  `setChatUnreadLocalWithinTransaction`, which requires both an authenticated context and an already sampled timestamp;
  the existing public wrapper retains its `Date.now()` default and standalone owner for other callers.

  After `ensureDatabase` and a current-account assertion, `markUnread` samples the tap time before it enters the writer
  queue. It opens one bounded transaction, asserts the live account lease around the single scoped update, and supplies
  the same live lease as the admission/commit guard. A revocation while queued therefore prevents `BEGIN`; a revocation
  during the update rolls both marker columns back. The outer tracked action and post-commit assertion remain in place,
  and RCS handling, settings hydration, the Private API gate, logging, and HTTP all remain outside the owner.

  The conversation-action certificate replaces one delegated service ID with the exact coordinator, callback, and
  token-helper set. The repository-context certificate pins the scoped helper SQL. Manual review replaces the
  repository's old three-record direct owner with its four-record helper/wrapper shape. Reconciliation applies one
  unchanged startup-edge rekey and fifteen line shifts; inventory is **1,329 findings / 0 structural or membership
  errors**, with final **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/services/markUnread.test.ts`,
  `test/db/chatsContactsBranches.test.ts`, and `test/db/readReconcile.test.ts` pass **3 suites / 46 tests / 0
  snapshots**; both exact scanner certificates pass **2/2**; and the fast scanner passes **84/94** with **10
  intentional skips / 0 failed**. Parent `DB-02B` remains **IN_PROGRESS** because the remaining B2 owner conversions
  are open. This is post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation, credential
  use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2K` gives per-chat draft persistence a guarded explicit owner:** the chat route previously
  handed each debounced or unmount-flushed `draft.<guid>` value to standalone `kvSet`. It now admits the write through
  the existing account-tracking barrier, captures the database, key, and immutable text before the first await, and
  opens one short transaction whose only work is `kvSetWithinTransaction`. The admitted mount lease remains a live
  guard through queue admission, `BEGIN`, and `COMMIT`.

  The synchronous stale-lease check and optimistic `setDraft(text)` still run first. This preserves multi-select
  unmount/remount behavior even while persistence is queued or fails. Composer remains the sole 500 ms debounce owner;
  its immediate empty-string write after send and intentional latest-value unmount flush are unchanged. A callback that
  fires only after account retirement still returns before either the owner or scoped helper begins. No UI state,
  timer, network, native, or logging work enters the transaction.

  The repository-context exact-set certificate removes the retired delegated draft ID and pins the route's exact
  coordinator, callback, and scoped-KV-helper IDs. Manual review replaces one record with three. Reconciliation applies
  two scanner-proven line shifts to the unchanged scheduled ticker and DEV typing records; inventory is **1,331
  findings / 0 structural or membership errors**, with final **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/components/routes/chatScreen.test.tsx` passes **1 suite /
  47 tests / 0 snapshots**; the two selected Composer draft debounce/send-clear tests pass **2/2**; the exact
  repository-context certificate passes **1/1**; and the fast scanner passes **84/94** with **10 intentional skips / 0
  failed**. The real transaction coordinator test observes `BEGIN IMMEDIATE` followed by `ROLLBACK`, no `COMMIT`, and
  no account-B database access after mid-owner retirement. Parent `DB-02B` remains **IN_PROGRESS** because remaining B2
  owner conversions are open. This is post-v57 host proof and performs no build, upload, submission, Play/EAS/server
  mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2L` gives completed scheduled-history Clear a guarded explicit owner:** the scheduled screen
  previously delegated each completed-row deletion to standalone `deleteScheduledHistory`. The repository now exposes
  `deleteScheduledHistoryWithinTransaction`, which immediately adopts an authenticated transaction context and retains
  the exact numeric-id plus `sent`/`error`/`uncertain` predicate. Its public wrapper remains a thin standalone owner, so
  pending/sending rows and missing ids remain no-ops.

  The existing tracked Clear callback captures the mounted account's database and immutable row id before its first
  await. It opens one short transaction whose only work is the scoped helper and supplies the admitted account lease as
  the live admission/commit guard. Pending cancellation, scheduled-server behavior, reactive reads, UI work, and the
  fixed error dialog remain outside. A retained stale callback starts neither the owner nor helper; an admitted write
  that loses its account during the delete rolls back before teardown finishes and cannot cross into a successor
  database whose numeric ids may repeat.

  The interactive-leaf certificate replaces the retired route delegate with its exact coordinator, callback, and
  scoped-helper IDs. The repository-context certificate pins the scoped DELETE. Manual review replaces the route's old
  one-record boundary with three records and the repository's old three-record direct owner with its four-record
  helper/wrapper shape. Reconciliation applies forty-one line shifts to unchanged scheduled-repository findings;
  inventory is **1,334 findings / 0 structural or membership errors**, with final **0 line shifts / 0 rekeys / 0
  additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/db/scheduledRepo.test.ts` and
  `test/components/routes/scheduledScreen.test.tsx` pass **2 suites / 55 tests / 0 snapshots**; both exact certificates
  pass **2/2**; and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. The real SQLite trigger
  proof restores the deleted row after mid-statement guard revocation. The route proof observes account A
  `BEGIN IMMEDIATE` then `ROLLBACK`, no `COMMIT`, no account-B SQL, complete teardown drain, and no stale dialog.
  Prettier and `git diff --check` pass; independent concurrency review is **GO** with no findings.

  Parent `DB-02B` remains **IN_PROGRESS** because remaining B2 owner conversions are open. This is post-v57 host proof
  and performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or
  device action.

- **2026-08-26 — `DB-02B2M` gives account-wide Mark All Read a guarded explicit owner:** the conversation-list screen
  previously delegated its confirmed bulk update to standalone `markAllChatsReadLocal`. The repository now exposes
  `markAllChatsReadLocalWithinTransaction`, which immediately adopts an authenticated transaction context and preserves
  the exact single-statement semantics: newest received/nondeleted message by date then id, outgoing-only chats
  untouched, and any deliberate unread stamp cleared. Its public wrapper remains a thin standalone owner.

  The existing tracked confirmation captures the mounted account's database before its first await. It opens one short
  transaction whose only work is the scoped helper and supplies the admitted account lease as the live admission/commit
  guard. A stale retained confirmation starts neither the owner nor helper; an admitted account-A update that loses its
  lease rolls back before teardown finishes and cannot touch account B.

  The interactive-leaf certificate replaces the retired route delegate with its exact coordinator, callback, and
  scoped-helper IDs. The repository-context certificate pins the scoped SQL update. Manual review replaces the route's
  old one-record boundary with three records and the repository's old three-record direct owner with its four-record
  helper/wrapper shape. Inventory is **1,337 findings / 0 structural or membership errors**, with final **0 line shifts /
  0 rekeys / 0 additions** reconciliation.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/db/chatsContactsBranches.test.ts` and
  `test/components/conversations/conversationListScreen.test.tsx` pass **2 suites / 48 tests / 0 snapshots**; both exact
  certificates pass **2/2**; and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. The real
  SQLite trigger proof restores every Mark All Read column after mid-statement guard revocation. The screen proof observes
  account A `BEGIN IMMEDIATE` then `ROLLBACK`, no `COMMIT`, no account-B SQL, complete teardown drain, and no SQL from a
  retained stale confirmation. Prettier and `git diff --check` pass; independent concurrency review is **GO** with no
  findings.

  Parent `DB-02B` remains **IN_PROGRESS** because remaining B2 owner conversions are open. This is post-v57 host proof
  and performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device
  action.

- **2026-08-26 — `DB-02B2N` gives scheduled-message cancellation a guarded explicit local owner:** the send front door
  previously delegated its final local deletion to standalone `deleteScheduled`. The service now snapshots the account
  database, numeric row id, and nullable server UUID before its first await. For a server-backed row, the HTTP DELETE
  remains strictly first and outside the writer lock. Only after that succeeds does one short transaction pass its
  authenticated token to `deleteScheduledWithinTransaction`, with the admitted account lease as the live
  admission/commit guard. Local-only cancellation uses that same guarded owner without a server request, while the public
  repository wrapper remains a thin standalone owner for separate callers.

  A server refusal preserves the local retry handle and original error. Account retirement after server success but
  during the local delete restores the local row by rollback before teardown completes, so the old numeric id cannot be
  deleted from a successor account database. No HTTP, tracking, UI, native, timer, or logging work enters the transaction.

  The send-front-door certificate replaces the retired service delegate with its exact coordinator, callback, and
  scoped-helper IDs. The repository-context certificate pins the scoped DELETE. Manual review replaces the service's old
  one-record boundary with three records and the repository's old three-record direct owner with its four-record
  helper/wrapper shape. Reconciliation applies twenty line shifts to unchanged later send-front-door findings; inventory
  is **1,340 findings / 0 structural or membership errors**, with final **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/db/scheduledRepo.test.ts` and
  `test/services/scheduledAccountScope.test.ts` pass **2 suites / 53 tests / 0 snapshots**; both exact certificates pass
  **2/2**; and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. The repository trigger restores
  the deleted row on guard revocation. The production-composition trigger observes completed server deletion before the
  local DELETE, retires account A from inside that DELETE, restores the row, and fully drains teardown; a separate server
  refusal case preserves the row and original error. Prettier and `git diff --check` pass; independent concurrency review
  is **GO** with no findings.

  Parent `DB-02B` remains **IN_PROGRESS** because remaining B2 owner conversions are open. This is post-v57 host proof
  and performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device
  action.

- **2026-08-26 — `DB-02B2O` gives inbox Pin and Archive guarded explicit owners:** the action sheet previously
  delegated Pin and Archive to standalone repository owners, and the conversation tile separately delegated Archive.
  The repository now exposes `setChatPinWithinTransaction` and `setChatArchiveWithinTransaction`; each immediately
  adopts an authenticated transaction context, while both public wrappers remain thin standalone owners with unchanged
  one-row update semantics.

  Each of the three already-tracked UI callbacks admits work against its mounted account before capturing the database,
  guid, and toggled value. It then opens a separate short transaction whose only work is the matching context-only
  helper and uses that same admitted lease as the live admission/commit guard. Retained account-A callbacks start no
  database work after B connects; already-admitted A writes roll back and fully drain before teardown, without touching
  B. Mute, customization, Reset All, and chat-settings behavior remain unchanged and outside this slice.

  The interactive-leaf certificate removes the three retired delegates and pins the nine exact coordinator, callback,
  and helper-call records. The repository-context certificate pins both scoped updates. Manual review converts each
  repository's old three-record direct owner to a four-record helper/wrapper shape and each UI delegate to three explicit
  records, a net increase of eight. Reconciliation applies forty-eight line shifts to unchanged findings; inventory is
  **1,348 findings / 0 structural or membership errors**, with final **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/db/chatActionsRepo.test.ts`,
  `test/components/conversations/chatActionsSheet.test.tsx`, and
  `test/components/conversations/conversationTile.test.tsx` pass **3 suites / 74 tests / 0 snapshots**; both exact
  certificates pass **2/2**; and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Real SQLite
  triggers restore both Pin and Archive after mid-update guard revocation. UI coordinator proofs observe account A
  `BEGIN IMMEDIATE` then `ROLLBACK`, no `COMMIT`, no account-B SQL, complete teardown drain, and no database access from
  retained stale callbacks. Prettier and `git diff --check` pass; independent concurrency review is **GO** with no
  findings.

  Parent `DB-02B` remains **IN_PROGRESS** because remaining B2 owner conversions are open. This is post-v57 host proof
  and performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device
  action.

- **2026-08-26 — `DB-02B2P` gives inbox Mute guarded explicit owners:** the action sheet and conversation tile
  previously delegated their Mute/Unmute writes to standalone `setChatMute`. The repository now exposes
  `setChatMuteWithinTransaction`, which immediately adopts an authenticated transaction context and preserves the exact
  one-row `'mute'`/`null` update. Its public wrapper remains a thin standalone owner for the unmodified Chat Settings,
  Reset All, notification fixtures, and other non-inbox callers.

  Both already-tracked inbox callbacks capture the mounted account's database, exact guid, and toggled value only after
  admission. Each opens one short transaction containing only the scoped helper and supplies that same account lease as
  the live admission/commit guard. Retained account-A callbacks start no database work after B connects; already-admitted
  A writes roll back and fully drain before teardown without touching B. The action sheet still closes in `finally`, and
  the tile remains fire-and-forget. Reset All deliberately retains its sequential customization-then-mute transactions
  and partial-progress behavior for a later settings-specific review.

  The interactive-leaf certificate removes the two retired inbox delegates and expands the exact inbox preference owner
  set from nine to fifteen records. The repository-context certificate pins the scoped update. Manual review replaces
  each one-record UI delegate with three explicit owner/context records and the repository's old three-record owner with
  its four-record helper/wrapper shape, a net increase of five. Reconciliation applies sixty line shifts to unchanged
  findings; inventory is **1,353 findings / 0 structural or membership errors**, with final **0 line shifts / 0 rekeys /
  0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/db/chatCustomization.test.ts`,
  `test/components/conversations/chatActionsSheet.test.tsx`, and
  `test/components/conversations/conversationTile.test.tsx` pass **3 suites / 52 tests / 0 snapshots**. The unchanged
  public-wrapper notification contracts pass `test/realtime/notificationIntent.test.ts` and
  `test/services/notificationTombstone.test.ts` **2 suites / 34 tests**, for **5 suites / 86 tests** overall. Both exact
  certificates pass **2/2**, and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. The real
  SQLite trigger restores the mute value after mid-update guard revocation. Both UI coordinator proofs observe account A
  `BEGIN IMMEDIATE` then `ROLLBACK`, no `COMMIT`, no account-B SQL, complete teardown drain, and no database access from
  retained stale callbacks. Prettier and `git diff --check` pass; independent concurrency review is **GO** with no
  findings.

  Parent `DB-02B` remains **IN_PROGRESS** because Chat Settings/Reset All and other B2 owner conversions remain open.
  This is post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation, credential use,
  Android-setting change, or device action.

- **2026-08-26 — `DB-02B2Q` gives Chat Settings Mute and Reset's mute step guarded explicit owners:** the remaining
  route callbacks previously delegated Mute/Unmute to standalone `setChatMute`. `runScreenAccountTask` now passes its
  admitted account lease to the task. Each mute callback captures that account's database, exact route guid, and
  immutable value before its first await, then opens one short transaction whose only work is the existing
  `setChatMuteWithinTransaction` helper and whose live commit guard reads that admitted lease.

  Reset All preserves its existing partial-progress contract. Its standalone customization owner is awaited first
  against the captured database; only after that commit does the separate guarded mute owner begin. Customization
  rejection prevents mute entirely, while a later lease retirement rolls back only mute and leaves the completed
  customization committed. Retained account-A controls perform no database lookup or work, and admitted A mute work
  holds teardown through rollback without touching account B. No customization helper, theme/background path,
  notification setting, global preference, native behavior, or release candidate changed.

  The interactive-leaf certificate replaces the two retired delegates with six exact transaction records and carries
  the surviving Reset customization edge through one manually reviewed callback rekey. Ten unrelated route records
  receive scanner-proven line shifts. Inventory is **1,357 findings / 0 structural or membership errors**, with final
  **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/components/routes/chatSettingsScreen.test.tsx` passes
  **1 suite / 43 tests / 0 snapshots**. The route suite proves active Mute/Unmute values, active Reset's two committed
  transactions, stale-callback exclusion, real teardown drain, account-A mute rollback, Reset's intentional
  customization-commit/mute-rollback partial progress, no account-B SQL, and silent customization-failure
  short-circuiting. Both exact certificates pass **2/2**, and the fast scanner passes **84/94** with **10 intentional
  skips / 0 failed**. Prettier and `git diff --check` pass. Independent concurrency review is **GO** with no blocking
  findings; its only residual risk is that host mocks do not prove op-sqlite or native device behavior.

  Parent `DB-02B` remains **IN_PROGRESS** because other B2 owner conversions remain open. This is post-v57 host proof
  and performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or
  device action.

- **2026-08-26 — `DB-02B2R` gives automatic server-avatar finalization a guarded explicit owner:** the repository's
  public `setHandleServerAvatar` remains available for standalone callers and delegates through the new transaction-only
  `setHandleServerAvatarWithinTransaction` helper. That helper immediately joins its authenticated context and preserves
  the existing `avatar IS NULL` compare-and-swap. The backfill service now opens one short guarded transaction only
  after its server query, directory work, cache inspection, and optional download have completed, and passes the
  admitted account lease as the live admission/commit guard.

  Mid-commit account retirement rolls the avatar update back and keeps teardown waiting until stale-attempt cleanup has
  removed a file downloaded by that attempt. A reused cached file is not removed, and an initially stale lease performs
  no server or filesystem work. The pre-existing device-photo race still leaves the device avatar authoritative. No
  network, native filesystem, UI, timer, or unbounded work moved under the database mutex.

  The repository-context certificate replaces the retired service delegate with the scoped SQL helper and adds an exact
  three-record certificate for the service transaction. The former four relevant findings become seven explicit
  wrapper, helper, and owner/context findings, taking inventory from **1,357** to **1,360 findings / 0 structural or
  membership errors**; exact reconciliation is **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/services/serverAvatars.test.ts` and
  `test/db/chatsContactsBranches.test.ts` pass **2 suites / 35 tests / 0 snapshots**. The exact certificate passes
  **1/1**, and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Real SQLite trigger proofs
  cover scoped-helper rollback and the full service's guarded rollback, teardown drain, and newly downloaded stale-file
  cleanup; active CAS behavior and the device-photo race remain covered. Prettier and `git diff --check` pass.
  Independent concurrency review is recorded as **GO** with no blocking findings. Exact op-sqlite/SQLCipher and Expo
  filesystem timing remain device-only evidence and are not claimed by these host tests.

  Parent `DB-02B` remains **IN_PROGRESS** because Chat Settings customization and other B2 owner conversions remain
  open. This is post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation, credential use,
  Android-setting change, or device action.

- **2026-08-26 — `DB-02B2S` gives Chat Settings Name, Color, and Reset customization guarded explicit owners:** the
  repository's public `setChatCustomization` keeps its exact trim, empty-name-to-null, six-digit hex validation,
  invalid-color rejection, null-clear, undefined-preserve, and empty-patch-before-admission behavior. It now delegates
  through `setChatCustomizationWithinTransaction`, whose one immediate authenticated join independently repeats
  normalization and validation so scoped callers cannot bypass the contract.

  `saveName`, `pickColor`, and Reset's first step now capture the admitted account database, route guid, and immutable
  patch before their first await, then open one short transaction containing only the scoped helper and use that same
  lease as the live admission/commit guard. Name remains immediately optimistic and rapid edits queue in input order;
  Color remains reactive rather than optimistic. Reset deliberately retains separate customization-then-mute owners.
  Retirement during customization produces `BEGIN/ROLLBACK` and no mute attempt, while retirement after customization
  produces `BEGIN/COMMIT` customization followed by `BEGIN/ROLLBACK` mute. Retained account-A controls perform no
  database lookup or work, and neither admitted A path consults account B.

  The interactive-leaf certificate replaces three customization delegates with nine exact transaction records and
  expands the exact Chat Settings preference set to fifteen records covering Name, Color, Mute, and both Reset owners.
  The repository-context certificate pins the scoped update. The repository's three-record owner becomes four and each
  route delegate becomes three, taking inventory from **1,360** to **1,367 findings / 0 structural or membership
  errors**. Three enclosing Reset-mute findings receive manually reviewed callback rekeys; thirty unchanged findings
  receive scanner-proven line shifts; exact reconciliation is **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes; `test/components/routes/chatSettingsScreen.test.tsx` and
  `test/db/chatCustomization.test.ts` pass **2 suites / 56 tests / 0 snapshots**. Both exact certificates pass **2/2**,
  and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. The proof includes real SQLite
  mid-update rollback of both customization fields, mounted rapid-write queue order, active Name/Color commits, stale-
  account exclusion, teardown drain, both Reset retirement points, and silent rejection/retry behavior. Prettier and
  `git diff --check` pass. Independent concurrency review is **GO** with no blocking findings. Host SQLite and React
  Native mocks do not prove op-sqlite/SQLCipher scheduling, reactive refresh timing, or physical-device input behavior.

  Parent `DB-02B` remains **IN_PROGRESS** because theme/background and other B2 owner conversions remain open. This is
  post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-
  setting change, or device action.

- **2026-08-26 — `DB-02B2T` gives both no-real-GUID successful-send finalizations guarded explicit owners:** the
  repository's public `markOutgoingSentNoGuid` remains a thin standalone owner and now delegates through
  `markOutgoingSentNoGuidWithinTransaction`. The scoped helper immediately joins its authenticated transaction context
  and preserves the exact sticky-error predicate, promotion, retry-queue deletion, and missing-message orphan cleanup.
  The RCS self-GUID branch in `reconcileOutgoingSuccess` and the absent-GUID branch in `reconcileSendOutcome` now each
  open one short guarded transaction and pass its callback token to that helper. The normal real-server-GUID path is
  unchanged, and `clearFailedSendNotice` remains outside and after the successful database commit.

  Real SQLite triggers revoke the guard from inside each promotion and prove the message update plus queue deletion
  roll back together. The service case additionally proves notification cleanup does not run after a rejected commit;
  both paths commit normally on a fresh retry. No network, notification, native, UI, timer, or unbounded work moved
  under the database mutex.

  The ordinary-send and repository-context certificates replace seven retired delegation/direct-owner records with
  twelve exact owner, callback, scoped-helper, and write records, taking inventory from **1,367** to **1,372 findings /
  0 structural or membership errors**. Forty-six unchanged findings receive scanner-proven line shifts; exact
  reconciliation is **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. The outgoing-branch and send-outcome suites pass **2 suites /
  61 tests / 0 snapshots**; the outgoing-queue, echo, emoji-echo, and attachment-send compatibility suites pass **4
  suites / 54 tests / 0 snapshots**, for **6 suites / 115 tests / 0 snapshots** overall. Both exact certificates pass
  **2/2**, and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Prettier and
  `git diff --check` pass. Independent concurrency review is **GO** with no blocking findings. Host SQLite proves the
  JavaScript rollback contract, but not op-sqlite/SQLCipher scheduling, process death, physical-device behavior, or
  native notification cancellation.

  Parent `DB-02B` remains **IN_PROGRESS** because theme/background and other B2 owner conversions remain open. This is
  post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-
  setting change, or device action.

- **2026-08-26 — `DB-02B2U` makes all four Chat Settings appearance actions atomic guarded owners:** the new
  `setChatAppearanceWithinTransaction` helper immediately adopts its authenticated context, repeats undefined-preserve/
  null-clear normalization, and writes theme tokens, the device-local background URI, and background luminance in any
  combination through one bounded row update. The public `setChatTheme` and `setBackgroundIsLight` wrappers remain
  available as thin standalone owners; `setChatTheme({})` still returns before transaction admission.

  Apply commits only tokens. Set Background commits the copied URI and computed luminance together. Generate commits
  generated tokens when available plus URI and luminance, while an unavailable extractor deliberately preserves the
  prior tokens. Clear commits all three local fields as null without touching synced-background state. Every handler
  captures the admitted account database and exact chat GUID before native awaits. Image persistence, adaptive-color
  extraction, and luminance extraction finish before `BEGIN`; the admitted lease is rechecked after each await and is
  also the live commit guard. Same-account keyed replacement may finish already-admitted work for its captured chat but
  publishes no stale UI. Account retirement either prevents the owner or rolls it back before teardown, with no
  successor-database lookup or SQL.

  The interactive certificate's final eight delegated appearance edges become twelve explicit route owner/callback/
  helper records, leaving that reviewed delegation set empty. The two repository three-record direct owners become two
  three-record thin wrappers plus one shared scoped update. Fourteen retired records therefore become nineteen, taking
  inventory from **1,372** to **1,377 findings / 0 structural or membership errors**. Thirty-six unchanged records
  receive scanner-proven line shifts; exact reconciliation is **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. The Chat Settings route and chat-theme repository suites pass
  **2 suites / 64 tests / 0 snapshots**; the chat-actions repository and Chat Theme provider compatibility suites pass
  **2 suites / 44 tests / 0 snapshots**, for **4 suites / 108 tests / 0 snapshots** overall. A real SQLite trigger proves
  tokens, URI, and luminance roll back together and a fresh retry commits. Mounted route proofs cover every exact patch,
  native work before SQLite, retirement before admission, teardown-drained in-owner rollback, and no account-B access.
  Both exact certificates pass **2/2**, and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**.
  Prettier and `git diff --check` pass. Independent concurrency review is **GO** with no blocking findings.

  Host SQLite and component mocks do not prove op-sqlite/SQLCipher scheduling or physical-device filesystem/color-
  extraction behavior. A file copied before account retirement can remain unreferenced when the guarded commit is
  skipped; that is existing file-retention behavior and safe ownership-aware deletion remains separate work. Parent
  `DB-02B` remains **IN_PROGRESS** because other B2 owner conversions remain open. This is post-v57 host proof and
  performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device
  action.

- **2026-08-26 — `DB-02B2V` gives delete-chat scheduled-row finalization a guarded explicit owner:**
  `cancelServerScheduledForChat` was the final production caller of the public standalone `deleteScheduled` wrapper.
  It now retains its per-row server-first order, rechecks the admitted account lease after the Mac confirms the
  cancellation, then opens one short transaction guarded by that same lease and passes the authenticated callback
  context to the existing `deleteScheduledWithinTransaction` helper. The scheduled-row read, HTTP DELETE, logging,
  reminder cleanup, notification cleanup, attachment cleanup, and purge recovery all remain outside this owner.

  A server refusal still logs and preserves the local row as the user's retry handle. Local-only scheduled rows remain
  owned by `deleteChatLocal`, and successful earlier rows retain their intentional per-row partial progress. If account
  retirement occurs after server success but during the local delete, the commit guard restores the row before the
  tracked chat action drains; a fresh current-account attempt can retry and commit. The public repository wrapper
  remains available for standalone tests and callers outside this production seam.

  The exact conversation-action certificate replaces one delegated record with three explicit coordinator, callback,
  and scoped-helper records. This reviewed one-to-many replacement takes inventory from **1,377** to **1,379 findings /
  0 structural or membership errors**; no unrelated record moves or rekeys, and exact reconciliation is **0 line shifts
  / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/deleteChat.test.ts` passes **1 suite / 22 tests
  / 0 snapshots**; its new real-SQLite trigger proves server completion outside SQLite, mid-delete lease revocation,
  rollback with the row restored, teardown drain, and fresh retry/commit. The exact certificate passes **1/1**, and the
  fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Prettier and `git diff --check` pass.
  Independent concurrency review is **GO** with no blocking findings.

  Host better-sqlite3 and mocked HTTP do not prove op-sqlite/SQLCipher scheduling, real-server cancellation retry or
  idempotency, or physical-device/native teardown timing. Parent `DB-02B` remains **IN_PROGRESS** because ordinary send,
  edit/unsend, synced-background, discard/tombstone, and other residual owner conversions still require conversion or
  exact justification. This is post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation,
  credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2W` gives delete-chat reminder cleanup guarded explicit owners:** the repository's public
  `deleteReminderByNotificationId` keeps its exact signature and optional commit guard, but now delegates through
  `deleteReminderByNotificationIdWithinTransaction`. That scoped helper immediately joins its authenticated context
  and performs the existing notification-id DELETE. Notification ids are not schema-unique, so each owner is accurately
  a bounded one-statement owner rather than a guaranteed one-row owner; deleting every matching row remains the
  preserved behavior.

  `cancelRemindersForChat` still reads the chat's reminder snapshots, dynamically loads the native notification module,
  and runs every alarm-cancellation attempt through `Promise.allSettled` before any database delete. Failed native
  cancellations keep their rows. Each fulfilled notification id now opens its own short transaction containing only
  the scoped helper and uses the admitted chat-action lease as its live admission/commit guard. Earlier successful
  owners keep their intentional partial progress. Retirement during one owner restores that DELETE, stops later
  finalization, and leaves the already-cancelled alarm's durable row as a safe retry residue before the tracked outer
  action lets teardown continue. The notification-body-press caller remains on the unchanged public wrapper with its
  existing live guard.

  The repository-context certificate adds the scoped DELETE, and the conversation-action certificate replaces the one
  service delegate with three explicit owner/callback records. Three retired repository records plus the retired
  service record become seven explicit helper, wrapper, owner, and callback records, taking inventory from **1,379** to
  **1,382 findings / 0 structural or membership errors**. Twelve unchanged records receive scanner-proven line shifts;
  exact reconciliation is **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/deleteChat.test.ts` and
  `test/services/remindersService.test.ts` pass **2 suites / 52 tests / 0 snapshots**; the unchanged notification-press
  wrapper path in `test/services/notificationActions.test.ts` passes **1 suite / 41 tests / 0 snapshots**, for **3 suites
  / 93 tests / 0 snapshots** overall. Real SQLite triggers prove authenticated-helper rollback/retry and the full
  service's native-first/outside-SQLite ordering, mid-DELETE retirement, rollback, teardown drain, and fresh retry.
  Both exact certificates pass **2/2**; the fast scanner passes **84/94** with **10 intentional skips / 0 failed**;
  Prettier and `git diff --check` pass. Independent concurrency review is **GO** with no blocking findings.

  Host better-sqlite3 and native mocks do not prove notify-kit cancellation truth/timing, op-sqlite/SQLCipher scheduling,
  or physical-device teardown. Parent `DB-02B` remains **IN_PROGRESS** because direct reminder cancellation,
  synced-background settlement, ordinary send, edit/unsend, discard/tombstone, and other residual owner conversions
  still require conversion or exact justification. This is post-v57 host proof and performs no build, upload,
  submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2X` gives direct reminder cancellation one guarded explicit owner:** the repository's public
  `deleteReminder` retains its existing `(db, id, commitGuard?, expectedNotificationId?)` signature and standalone
  behavior, but now delegates through `deleteReminderWithinTransaction`. The scoped helper immediately joins its
  authenticated context and preserves the exact id-only or id-plus-notification-id compare-and-delete, `RETURNING`
  ownership check, and boolean mismatch result.

  `cancelReminder` still checks its admitted account lease, cancels the exact native alarm first, and checks the lease
  again before touching SQLite. It now opens one short transaction with that same lease as the live admission/commit
  guard and passes the authenticated callback context to the exact-row helper. A stale reminder snapshot still throws
  `reminder no longer matches`. Retirement during the DELETE restores the durable row before the tracked reminder
  operation lets teardown continue; a fresh current-account attempt deliberately retries the idempotent native cancel
  and can then commit. Notification-body press and delete-chat's notification-id cleanup remain unchanged.

  The repository-context certificate adds the scoped DELETE, while the notification/reminder certificate replaces one
  service delegation with three explicit coordinator, callback, and helper records. Three retired repository records
  plus the retired service record become seven explicit records, taking inventory from **1,382** to **1,385 findings /
  0 structural or membership errors**. Nine unchanged records receive scanner-proven line shifts; exact reconciliation
  is **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/remindersService.test.ts` passes **1 suite /
  31 tests / 0 snapshots**. Real SQLite triggers prove authenticated-helper rollback/retry and the full service's
  native-first/outside-SQLite ordering, mid-DELETE retirement, rollback, teardown drain, and fresh retry. Both exact
  certificates pass **2/2**, and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Prettier
  and `git diff --check` pass. Independent concurrency review is **GO** with no blocking findings.

  Host better-sqlite3 and native mocks do not prove notify-kit cancellation truth/timing, op-sqlite/SQLCipher
  scheduling, or physical-device teardown. If native cancellation succeeds and the guarded database owner rolls back,
  the retained row is an intentional retry handle; retry correctness depends on native cancellation being idempotent,
  as it did before this conversion. Parent `DB-02B` remains **IN_PROGRESS** because synced-background settlement,
  ordinary send, edit/unsend, discard/tombstone, and other residual owner conversions still require conversion or exact
  justification. This is post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation,
  credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2Y` gives all three synced-background file settlements guarded explicit owners:**
  `setSyncedBackgroundUriIfCurrentWithinTransaction` and
  `setSyncedBackgroundLuminanceIfCurrentWithinTransaction` each immediately join one authenticated context and retain
  the existing exact channel/URI/local-override predicates plus `RETURNING` boolean. Their public wrappers keep their
  signatures and remain thin standalone transaction owners.

  Server-removal clearing, downloaded-file promotion, and measured-luminance storage now each call the appropriate
  scoped helper through an inline `withDbTransaction` guarded by `ownsRequest`, which combines the captured account
  lease with the same-chat request revision. They remain three separate short owners around the intervening effects.
  Transport snapshot and HTTP, state/theme reads, directory/stat/create work, bounded download and move, luminance
  computation, old-file native deletion, global quota pruning, and delayed repair all stay outside SQLite. A successful
  removal still clears the pointer before deleting the old file. Promotion still downloads first, commits only when
  exact channel and prior URI match, then deletes the prior file and prunes. Luminance still measures first and writes
  only for the exact current synced artifact while no local background has precedence.

  The tracked settlement adapter now maps only `DbCommitGuardRejectedError` to `false`; ordinary database errors keep
  flowing to the existing best-effort handler because their commit outcome must not be guessed. This makes a known
  rollback take the existing false-settlement branch: promotion deletes only its uncommitted destination and retains
  the referenced prior pointer/file, while removal retains both. Do not recheck ownership after a successful commit,
  because a lease flip during the promise handoff must not make the service delete a file the database now references.
  Skeptical review moved known-rollback candidate deletion into the admitted tracking callback, so Disconnect cannot
  finish its drain before that synchronous cleanup; ordinary CAS-miss and pre-admission cleanup retain the existing
  outer branch. Refreshed server-chat metadata and its post-commit contact enrichment remain on the unchanged public
  delegate for a separate multi-owner slice.

  The repository-context certificate adds both scoped update bodies. The sync certificate leaves the metadata delegate
  pinned, replaces the three file-settlement delegates with nine explicit coordinator/callback/helper records, and
  keeps every other sync edge exact. Six retired repository records plus three retired service records become seventeen
  explicit records, taking inventory from **1,385** to **1,393 findings / 0 structural or membership errors**. The
  initial conversion and skeptical cleanup follow-up apply **23 scanner-proven line-only updates across two
  reconciliation passes / 0 rekeys / 0 additions**; exact reconciliation ends at **0 line shifts / 0 rekeys / 0
  additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/db/chatTheme.test.ts` and the new
  `test/services/syncedBackgroundTransaction.test.ts` pass **2 suites / 19 tests / 0 snapshots**; the existing
  `test/services/syncedBackgroundAccountScope.test.ts` passes **1 suite / 24 tests / 0 snapshots**; and the native quota
  contract passes **1 suite / 7 tests / 0 snapshots**, for **4 suites / 50 tests / 0 snapshots** overall. Real SQLite
  triggers prove helper and full-service rollback/retry for URI promotion, URI removal, and luminance. The promotion
  proof also verifies download before SQLite, teardown drain, old-pointer/file retention, candidate-only cleanup, no
  prune/old-file delete/luminance after rollback, candidate cleanup before the drain resolves, and successful fresh
  retry; every modeled native effect is observed outside a transaction. Both exact certificates pass **2/2**, and the
  fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Prettier and `git diff --check` pass.
  Independent concurrency review is **GO** with no blocking findings.

  Host better-sqlite3 and native mocks do not prove Expo/native file truth, fixed-root delete/prune/quota behavior,
  op-sqlite/SQLCipher scheduling, process-kill windows, or physical A→Disconnect→B teardown. Pointer settlement and
  filesystem effects are intentionally ordered recovery steps, not one cross-system atomic transaction. A synthetic
  lease flip in the promise handoff immediately after successful COMMIT is not directly forced by this suite; the
  implementation deliberately has no post-COMMIT ownership recheck, preventing a committed pointer from being treated
  as failure and its referenced file deleted. Parent `DB-02B` remains **IN_PROGRESS** because refreshed-chat metadata/
  contact enrichment, ordinary send, edit/unsend, discard/tombstone, and other residual owner conversions still require
  conversion or exact justification. This is post-v57 host proof and performs no build, upload, submission, Play/EAS/
  server mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2Z` gives refreshed synced-background metadata and contact enrichment explicit owners:** the
  chat metadata refresh still performs its server GET before touching SQLite, but no longer delegates to the public
  self-transacting `persistServerChat`. It now opens one short `withDbTransaction` guarded by `ownsRequest` and passes
  the authenticated callback context to `persistServerChatWithinTransaction`, keeping handle, chat, and participant-link
  persistence atomic under both the captured account lease and latest same-chat revision. The public
  `persistServerChat` wrapper remains unchanged for standalone callers.

  Device-contact names and photos stay presentation-only and outside that authoritative transaction. After metadata
  commits, the service admits `linkHandlesToContacts` as a separate tracked phase and supplies the same live guard to
  each of its short per-row transactions. This keeps the contact-index and handle reads attached to account teardown
  without holding the global DB transaction mutex across the full contact scan. A guard rejection stops stale work; an
  ordinary contact-index or contact-write failure remains best-effort, does not undo authoritative metadata, and still
  lets the committed channel drive the existing background settlement. Tracking the full contact-enrichment phase can
  modestly lengthen Disconnect while its contact index is built; splitting that phase into per-read admission would be
  a broader repository refinement and is not required for this correctness boundary.

  The exact sync certificate retires the last synced-background coordinated metadata delegate and adds three explicit
  metadata coordinator/callback/helper records. Inventory moves from **1,393** to **1,395 findings / 0 structural or
  membership errors**. Nine unchanged settlement records receive scanner-proven line shifts; exact reconciliation ends
  at **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. The existing
  `test/services/syncedBackgroundAccountScope.test.ts`, expanded
  `test/services/syncedBackgroundTransaction.test.ts`, `test/db/chatsContactsBranches.test.ts`, and
  `test/db/contactsRepo.test.ts` pass **4 suites / 68 tests / 0 snapshots**. Real SQLite triggers prove metadata-wide
  rollback with no contact/native continuation when ownership retires during the authoritative transaction, followed
  by a successful fresh retry. A separate trigger proves contact-only rollback after metadata commit, teardown drain,
  and successful linking on retry; an ordinary contact failure still reaches background download/promotion. Both exact
  certificates pass **2/2**, and the fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Prettier
  and `git diff --check` pass. Independent concurrency review is **GO** with no blocking findings; its expanded focused
  rerun passes **5 suites / 74 tests / 0 snapshots**.

  Host better-sqlite3 does not prove op-sqlite/SQLCipher scheduling or physical A→Disconnect→B teardown. Parent
  `DB-02B` remains **IN_PROGRESS** because ordinary send, edit/unsend, discard/tombstone, and other residual owner
  conversions still require conversion or exact justification. This is post-v57 host proof and performs no build,
  upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2AA` gives real-GUID successful-send settlement an explicit guarded owner:** the shared
  `reconcileSendOutcome` tail no longer delegates a distinct real GUID to the public self-transacting
  `reconcileOutgoingSuccess` wrapper. It snapshots the acknowledgement GUID, opens one short `withDbTransaction`
  guarded by the existing `commitGuard`, and passes the authenticated context to the new
  `reconcileOutgoingSuccessWithinTransaction` body. Alias/deletion-ledger handoff, duplicate attachment `local_path`
  carry, temp-message promotion/drop, and outgoing-queue removal remain one DB-only atomic owner after the network
  response. Failed-send-notice cleanup remains strictly after successful COMMIT.

  Absent/empty and RCS self-GUID acknowledgements continue through the existing no-GUID transaction-only helper. The
  public wrapper remains compatible for DEV and standalone callers: an empty GUID is still a quiet no-op before owner
  admission even under a false guard, a self GUID still marks sent and dequeues, and a distinct real GUID delegates
  thinly to the new scoped body with its optional guard.

  The ordinary-send and repository-context certificates retire ten old service/wrapper/body records and add thirteen
  explicit service-owner, public-wrapper, and scoped-body records. Inventory moves from **1,395** to **1,398 findings /
  0 structural or membership errors**. Forty-nine unchanged records receive scanner-proven line shifts; exact
  reconciliation ends at **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/sendOutcome.test.ts`,
  `test/db/outgoingBranches.test.ts`, `test/services/outgoingQueueService.test.ts`,
  `test/services/sendService.test.ts`, `test/services/sendAttachmentService.test.ts`,
  `test/services/sendContactService.test.ts`, and `test/services/sendReactionService.test.ts` pass **7 suites / 128
  tests / 0 snapshots**. A real SQLite trigger revokes ownership during the temp-to-real GUID update and proves the
  message, alias, deletion-ledger transfer, and queue removal all roll back, failure-notice cleanup does not run, and a
  fresh retry commits. Both exact certificates pass **2/2**, and the fast scanner passes **84/94** with **10
  intentional skips / 0 failed**. Prettier and `git diff --check` pass. Two independent read-only boundary reviews are
  **GO** with no blocking findings.

  Host better-sqlite3 does not prove op-sqlite/SQLCipher scheduling or physical A→Disconnect→B teardown. Parent
  `DB-02B` remains **IN_PROGRESS** because manual retry claim, initial ordinary-send persistence, edit/unsend,
  discard/tombstone, and other residual owner conversions still require conversion or exact justification. This is
  post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation, credential use,
  Android-setting change, or device action.

- **2026-08-26 — `DB-02B2AB` gives manual “Try Again” claim an explicit guarded owner:** the send front door no longer
  delegates its failed-message claim to the public self-transacting `claimFailedOutgoingForRetry` wrapper. It opens one
  short `withDbTransaction` guarded by the captured account lease and passes the authenticated context to
  `claimFailedOutgoingForRetryWithinTransaction`. The scoped body preserves the exact queue-payload read, message
  compare-and-set, refusal outcomes, attempts reset, and 120-second retry lease. The injected clock remains inside the
  adopted transaction after mutex/guard admission, preserving fresh lease timing and the existing guarantee that a
  queued owner rejected before BEGIN never samples it.

  The public wrapper retains its exact arguments, optional guard, and standalone behavior. After the service owner
  commits, `retry()` rechecks the account lease before wording a refusal or passing the original queue payload/temp GUID
  to `resendOutgoingRow`; HTTP/upload work and all toast/log continuations remain outside SQLite. A stale guard rejection
  remains quiet, while current-account DB failures retain the existing warning and retry toast.

  The send-front-door and repository-context certificates retire five old delegate/wrapper/body records and add eight
  explicit service-owner, public-wrapper, and scoped-body records. Inventory moves from **1,398** to **1,401 findings /
  0 structural or membership errors**. Fifty-seven unchanged records receive scanner-proven line shifts; exact
  reconciliation ends at **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/sendRetryGuard.test.ts`,
  `test/db/outgoingUserActions.test.ts`, `test/services/outgoingQueueService.test.ts`, and
  `test/services/sendAccountScope.test.ts` pass **4 suites / 72 tests / 0 snapshots**. A real SQLite trigger calls
  account teardown during the message claim and proves the original error/detail and queue attempts/lease roll back,
  the admitted owner drains, and no HTTP/toast/log continuation runs. After the trigger is removed and a fresh account
  lease is captured, one retry sends the retained payload under the same temporary GUID, with HTTP observed outside
  the transaction. Existing focused tests also retain queued-neighbor clock/guard behavior, final queue-update rollback,
  and the manual-versus-automatic retry single-winner race. Both exact certificates pass **2/2**, and the fast scanner
  passes **84/94** with **10 intentional skips / 0 failed**. Prettier and `git diff --check` pass. Independent
  concurrency review is **GO** with no blocking findings.

  `outgoing_queue.temp_guid` remains non-unique and unindexed, so this milestone deliberately preserves its existing
  update shape instead of claiming a hard one-row bound. Host better-sqlite3 does not prove op-sqlite/SQLCipher
  scheduling or physical A→Disconnect→B teardown. Parent `DB-02B` remains **IN_PROGRESS** because automatic queue
  claim, initial ordinary-send persistence, edit/unsend, discard/tombstone, and other residual owner conversions still
  require conversion or exact justification. This is post-v57 host proof and performs no build, upload, submission,
  Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2AC` gives discard plus fallback tombstoning one explicit guarded owner:** the send front door
  no longer commits `discardOutgoingMessage` and then conditionally opens a second `deleteMessageLocal` transaction.
  That split let the first owner delete a stranded retry row, then account retirement or another failure could prevent
  the fallback tombstone and leave the message visible without its ladder. `discardMessage()` now opens one short
  `withDbTransaction` guarded by the captured account lease and passes its authenticated context first to
  `discardOutgoingMessageWithinTransaction`, then—only when the optimistic temp-row compare-and-set declines
  ownership—to `deleteMessageLocalWithinTransaction` before the same COMMIT.

  The scoped discard body preserves the exact `temp-%` plus `sending`/`error` compare-and-set, unconditional deletion
  of every matching queue record, and owned-row chat-sort recompute. The scoped local-delete body preserves the second
  temp-keyed queue cleanup, exact-before-alias target resolution, durable deletion-ledger marker, tombstone, unresolved-
  temp outcome, and chat-sort recompute. Each public wrapper retains its exact signature and standalone transaction;
  `cancelOutgoing` remains the exact discard alias. `uploadRegistry.cancel` remains before the database owner, while
  unresolved copy, failed-send notification cleanup, and attachment-cache retirement/drain remain after confirmed
  COMMIT and a live account check.

  The send-front-door and repository-context certificates retire eleven old repository owner/body and service delegate
  records and add fifteen explicit scoped-body, public-wrapper, coordinator, callback, and helper records. Inventory
  moves from **1,401** to **1,405 findings / 0 structural or membership errors**. Seventy-six unchanged findings receive
  scanner-proven line shifts, while two unchanged cache delegates receive reviewed enclosing-callback rekeys; exact
  reconciliation ends at **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/discardMessage.test.ts`,
  `test/services/sendAccountScope.test.ts`, `test/db/outgoingBranches.test.ts`, `test/db/messagesRepo.test.ts`,
  `test/db/outgoingUserActions.test.ts`, `test/db/cancelOutgoing.test.ts`, and
  `test/services/attachmentCacheCoordinator.test.ts` pass **7 suites / 191 tests / 0 snapshots**. A real SQLite trigger
  starts account teardown during fallback-ledger insertion for an already-sent temporary GUID with a stranded queue
  row. The rejected owner restores that queue row, the untombstoned message, empty ledger, and prior chat date; teardown
  drains it, and no toast, notice cleanup, or cache continuation runs. With the trigger removed and a fresh lease, the
  same action commits queue removal, ledger, tombstone, and chat date, then performs notification/cache cleanup outside
  SQLite. Upload cancellation is also observed before/outside SQLite. Both exact certificates pass **2/2**, and the
  fast scanner passes **84/94** with **10 intentional skips / 0 failed**. Prettier and `git diff --check` pass.
  Independent concurrency review is **GO** with no blocking findings.

  `outgoing_queue.temp_guid` remains non-unique and unindexed, so all-matching cleanup remains deliberate and this
  milestone claims no hard one-row bound. The native upload-cancellation tail remains registry-tracked rather than
  synchronously awaited by the database owner. Host better-sqlite3 and mocks do not prove native cancellation/
  notification truth, op-sqlite/SQLCipher scheduling, process-kill recovery, or physical A→Disconnect→B teardown.
  Parent `DB-02B` remains **IN_PROGRESS** because automatic queue claim, initial ordinary-send persistence,
  edit/unsend, and other residual owner conversions still require conversion or exact justification. This is post-v57
  host proof and performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-setting
  change, or device action.

- **2026-08-26 — `DB-02B2AD` gives the automatic outgoing retry claim an explicit guarded owner:**
  `runOutgoingQueueBody` no longer delegates its claim to the public self-transacting `claimOutgoingForSend` wrapper.
  It opens one short `withDbTransaction` under the existing account-commit barrier and passes its authenticated token
  to `claimOutgoingForSendWithinTransaction`. The scoped body retains the exact queue-ID lease compare-and-set and
  `RETURNING`, the conditional failed-message transition to `sending`, and sticky error/detail cleanup in the same
  commit. Its clock remains sampled only after mutex/guard admission. The public wrapper keeps its exact signature,
  optional guard, and standalone behavior, while HTTP/native resend and outcome work remain outside this owner.

  The ordinary-send and repository-context certificates retire five delegated/wrapper/body records and add eight
  exact scoped-body, wrapper, service-owner, and callback records. Inventory moves from **1,405** to **1,408 findings /
  0 structural or membership errors**, with exact reconciliation at **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/outgoingQueueService.test.ts`,
  `test/db/outgoingUserActions.test.ts`, `test/db/outgoingBranches.test.ts`,
  `test/services/sendQueueHandover.test.ts`, `test/services/sendRetryGuard.test.ts`, and
  `test/services/outgoingQueueEmoji.test.ts` pass **6 suites / 132 tests / 0 snapshots**. A real SQLite trigger retires
  the account during the second claim write and proves both durable writes roll back, the admitted owner drains, and
  no HTTP starts; a fresh account then retries exactly once with HTTP observed outside SQLite. Both exact certificates
  pass **2/2**, the fast scanner passes **84/94** with **10 intentional skips / 0 failed**, Prettier and
  `git diff --check` pass, and independent concurrency review is **GO** with no blocker.

  A retry can still outlive its existing 120-second lease; this ownership slice does not change that policy. Host
  better-sqlite3 does not prove op-sqlite/SQLCipher, long native-upload timing, or physical-device account teardown.
  Parent `DB-02B` remains **IN_PROGRESS** because initial ordinary-send persistence, permanent-retire settlement,
  edit/unsend, scheduled handoff, and other residual owner conversions remain open. This is post-v57 host proof and
  performs no build, upload, submission, Play/EAS/server mutation, credential use, Android-setting change, or device
  action.

- **2026-08-26 — `DB-02B2AE` gives permanent outgoing retirement one shared explicit guarded owner:** Both the
  missing-attachment and unknown-kind retry branches now enter the private `retireUnsendableOutgoing` service owner
  under their existing account-commit barrier. That owner opens one short guarded transaction and passes its
  authenticated context to `retireOutgoingWithinTransaction`, whose inline join caps every matching queue row and
  marks every matching non-sent bubble errored with cleared detail in the same commit. The public `retireOutgoing`
  wrapper preserves its exact signature, default error code, optional guard, standalone behavior, and retained queue-
  row semantics. Attachment lookup/native file inspection, warning logging, HTTP/upload work, and failed-send
  notification remain outside SQLite; notification runs only after confirmed COMMIT.

  The ordinary-send and repository-context certificates retire six old repository body/wrapper and service delegate
  records and add ten exact scoped-body, public-wrapper, service-owner, callback, and delegation records. Inventory
  moves from **1,408** to **1,412 findings / 0 structural or membership errors**, a reviewed net increase of four.
  Twenty-eight unchanged findings receive scanner-proven line shifts; exact reconciliation ends at **0 line shifts / 0
  rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/outgoingQueueService.test.ts`,
  `test/db/outgoingBranches.test.ts`, and `test/services/sendRetryGuard.test.ts` pass **3 suites / 92 tests / 0
  snapshots**. A real SQLite trigger invalidates the account generation during the message update and proves the
  provisional queue cap plus message mutation roll back, the admitted owner drains, and no failed-send notice
  publishes. A fresh lease then retires the retained row once, with notification observed outside SQLite; the missing-
  file proof separately observes native `fileExists` outside the transaction. Both exact certificates pass **2/2**,
  the fast scanner passes **84/94** with **10 intentional skips / 0 failed**, Prettier and `git diff --check` pass, and
  independent concurrency review is **GO** with no blocking finding.

  `outgoing_queue.temp_guid` remains non-unique and unindexed, so the all-matching update is deliberate and this slice
  claims no hard one-row bound. The trigger proves generation turnover and a fresh lease, not a full account wipe/
  reconnect. Host better-sqlite3 and mocks do not prove Android-native filesystem/notification truth,
  op-sqlite/SQLCipher scheduling, process-kill recovery, or physical-device teardown. Parent `DB-02B` remains
  **IN_PROGRESS** because initial ordinary-send persistence, edit/unsend, scheduled handoff, and other residual owner
  conversions remain open. This is post-v57 host proof and performs no build, upload, submission, Play/EAS/server
  mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2AF` gives optimistic reaction persistence one explicit guarded owner:**
  `sendReactionMessage` no longer delegates its queue-plus-message insert to the public self-transacting
  `insertOutgoingReaction` wrapper. It opens one short `withDbTransaction` under an optional live account guard and
  passes the authenticated token to `insertOutgoingReactionWithinTransaction`. That scoped body retains the exact
  queue-first ordering, shared temporary GUID, in-owner chat-identity lookup, associated reaction row, optional custom
  emoji, and no chat-date bump. The public wrapper remains compatible for standalone and DEV callers.

  The UI React front door and notification Love action now supply guards tied to their captured account leases. After
  COMMIT, the service checks the guard again before starting the Private API request and passes it through real-GUID or
  failure settlement. HTTP remains outside SQLite. The durable queue payload and wire request exclude the private
  selected-message text; the wire request also excludes the optimistic temporary GUID.

  The ordinary-send, send-front-door, and repository-context certificates retire five old repository/service records
  and add eight explicit service-owner, public-wrapper, and scoped-body records; the two front-door callback records
  only rekey. Inventory moves from **1,412** to **1,415 findings / 0 structural or membership errors**. Eighty-seven
  unchanged findings receive scanner-proven line shifts; exact reconciliation ends at **0 line shifts / 0 rekeys / 0
  additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/db/outgoingBranches.test.ts`,
  `test/services/sendReactionService.test.ts`, `test/services/sendReactionEmoji.test.ts`,
  `test/services/outgoingQueueEmoji.test.ts`, `test/services/echoReconcileEmoji.test.ts`,
  `test/services/sendAccountScope.test.ts`, `test/services/notificationActions.test.ts`,
  `test/services/sendChatIdentity.test.ts`, and `test/services/logicalSendQueueWiring.test.ts` pass **9 suites / 131
  tests / 0 snapshots**. A real SQLite trigger retires the account during the second insert and proves both provisional
  rows roll back, the admitted owner drains, and no HTTP starts; a fresh lease then commits and settles the exact
  privacy-safe payload with HTTP observed outside SQLite. All three exact certificates pass **3/3**, the fast scanner
  passes **84/94** with **10 intentional skips / 0 failed**, Prettier and `git diff --check` pass, and independent
  concurrency review is **GO** with no blocking finding.

  The trigger proves generation turnover and a fresh lease, not a full account wipe/reconnect. Host better-sqlite3
  does not prove op-sqlite/SQLCipher scheduling, native headless/killed-process execution, or physical-device teardown.
  Parent `DB-02B` remains **IN_PROGRESS** because text/contact/attachment initial persistence, edit/unsend, scheduled
  handoff, and other residual owner conversions remain open. Text and scheduled handoff remain deferred during
  focused-only work because their scheduled-recovery checker coupling requires a broader checker update and full gate.
  This is post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation, credential use,
  Android-setting change, or device action.

- **2026-08-26 — `DB-02B2AG` gives optimistic unsend apply and failure rollback explicit guarded owners:**
  `sendUnsendOnce` no longer delegates either phase to the public self-transacting repository wrappers. The new
  `applyLocalUnsendWithinTransaction` and `revertLocalUnsendWithinTransaction` bodies accept only authenticated
  transaction contexts and immediately adopt one inline join apiece. Public `applyLocalUnsend` and
  `revertLocalUnsend` keep their exact standalone signatures and semantics for DEV/tests, including exact non-null/zero
  predecessor restoration and the legacy omitted-predecessor clear-to-null behavior.

  The service opens one guarded transaction to snapshot row/chat identity and the prior marker while applying the
  optimistic retraction. It checks the same account lease again before HTTP, then uses a separate shared guarded owner
  for the marker compare-and-set rollback on missing chat, transport failure, or a non-true acknowledgement. The
  per-message edit/unsend lifecycle queue and HTTP stay outside SQLite. Narrowing the HTTP catch also prevents a DB or
  guard failure from the revert owner being caught and attempted twice; a differently stamped server echo still wins.
  The UI unsend front door supplies the live guard, while the DEV fake remains on the unchanged public wrapper.

  The deferred-send, send-front-door, and repository-context certificates retire eleven old repository/service records
  and add seventeen exact scoped-body, public-wrapper, service-owner, and delegation records; the DEV wrapper edge is
  unchanged. Inventory moves from **1,415** to **1,421 findings / 0 structural or membership errors**, a reviewed net
  increase of six. Thirty-four unchanged findings receive scanner-proven line shifts; exact reconciliation ends at
  **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/db/editUnsendRepo.test.ts`,
  `test/db/messagesBranches.test.ts`, `test/services/sendEditService.test.ts`,
  `test/services/sendAccountScope.test.ts`, and `test/features/conversations/devSeedAccountScope.test.ts` pass **5
  suites / 66 tests / 0 snapshots**. Real SQLite triggers prove account retirement during apply restores the exact
  predecessor and starts no HTTP, a fresh lease performs HTTP outside SQLite and its guarded failure revert, and an
  aborting revert performs one POST plus exactly one local attempt before rollback. A fresh public-owner retry restores
  the exact prior marker. All three exact certificates pass **3/3**, the fast scanner passes **84/94** with **10
  intentional skips / 0 failed**, Prettier and `git diff --check` pass, and independent concurrency review is **GO**
  with no blocking finding.

  An exact same-millisecond server/client retraction marker remains protocol-indistinguishable without a durable
  revision token. The trigger proves generation turnover and a fresh lease, not a full wipe/reconnect. Host
  better-sqlite3 does not prove op-sqlite/SQLCipher scheduling, native process-kill behavior, or physical-device
  teardown. Parent `DB-02B` remains **IN_PROGRESS** because text/contact/attachment initial persistence, edit
  apply/revert, scheduled handoff, and other residual owner conversions remain open. Text and scheduled handoff remain
  deferred during focused-only work because their scheduled-recovery checker coupling requires a broader checker update
  and full gate. This is post-v57 host proof and performs no build, upload, submission, Play/EAS/server mutation,
  credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2AH` gives optimistic edit apply and failure rollback explicit guarded owners:**
  `sendEditOnce` no longer delegates either persistence phase to the public self-transacting repository wrappers. The
  new `applyLocalEditWithinTransaction` and `revertLocalEditWithinTransaction` bodies accept only authenticated
  transaction contexts and immediately adopt one inline join each. Public `applyLocalEdit` and `revertLocalEdit` keep
  their standalone signatures, including compatibility behavior when the exact optimistic-state arguments are
  omitted.

  The guarded apply owner snapshots committed text, the exact attributed body, prior edit marker, and chat identity
  while applying the optimistic text, cleared body, and marker atomically. The service rechecks its captured UI account
  lease after COMMIT and before rich-body parsing or HTTP. Rich-body decoding remains outside the database mutex. A
  missing chat, transport failure, or acknowledgement without a GUID uses one shared guarded revert owner that retains
  the exact production compare-and-set over marker, optimistic text, and `attributed_body IS NULL`, then restores the
  exact predecessor body/marker. Narrowing the HTTP catch ensures a DB or guard failure from rollback propagates after
  one attempt. The shared edit/unsend lifecycle queue is unchanged, and the DEV fake remains on the public wrapper.

  The deferred-send and repository-context certificates retire eleven old repository/service records and add seventeen
  exact scoped-body, public-wrapper, service-owner, and delegation records. The send-front-door certificate remains
  structurally unchanged. Inventory moves from **1,421** to **1,427 findings / 0 structural or membership errors**, a
  reviewed net increase of six. Forty-three unchanged findings receive scanner-proven line shifts; exact reconciliation
  ends at **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/db/editUnsendRepo.test.ts`,
  `test/db/messagesBranches.test.ts`, `test/services/sendEditService.test.ts`,
  `test/services/sendAccountScope.test.ts`, and `test/features/conversations/devSeedAccountScope.test.ts` pass **5
  suites / 69 tests / 0 snapshots**. Real SQLite triggers prove account retirement during apply rolls back the whole
  edit and starts no HTTP; a fresh lease observes HTTP outside SQLite and restores exact rich-body-derived text, body,
  marker, and FTS state after a negative acknowledgement; and an aborting revert performs one POST plus exactly one
  local attempt before rollback. A fresh public-owner retry then restores the exact predecessor. All three exact
  certificates pass **3/3**, the fast scanner passes **84/94** with **10 intentional skips / 0 failed**, and Prettier
  plus `git diff --check` pass. Independent concurrency and scanner/inventory reviews are both **GO** with no blocking
  finding.

  A server echo with the exact client timestamp, optimistic text, and cleared rich body remains protocol-
  indistinguishable without a durable revision token. A lost response can temporarily restore the predecessor when its
  successful echo has not arrived before rollback; a later echo remains authoritative. Tests do not separately force
  the narrow successful-COMMIT→lease-revoked→pre-HTTP interval or retirement inside the revert owner; the source guard
  wiring covers those constituent checks, while exact device teardown remains open. The trigger proves generation
  turnover and a fresh lease, not a full account wipe/reconnect. Host better-sqlite3 does not prove op-sqlite/SQLCipher
  scheduling, native process-kill behavior, or physical-device teardown. Parent `DB-02B` remains **IN_PROGRESS**
  because text/contact/attachment initial persistence, scheduled handoff, and other residual owner conversions remain
  open. Text and scheduled handoff remain deferred during focused-only work because their scheduled-recovery checker
  coupling requires a broader checker update and full gate. This is post-v57 host proof and performs no build, upload,
  submission, Play/EAS/server mutation, credential use, Android-setting change, or device action.

- **2026-08-26 — `DB-02B2AI` gives initial contact-card persistence one explicit guarded owner:**
  `sendContactMessage` no longer delegates optimistic persistence to the public self-transacting repository wrapper.
  The new `insertOutgoingContactWithinTransaction` accepts only an authenticated transaction context and immediately
  adopts one inline join. The public `insertOutgoingContact` signature remains compatible for standalone callers.
  Committed chat lookup, contact retry-row insertion, optimistic message insertion, and NULL-safe monotonic chat-date
  advancement now share the service's one short guarded transaction.

  Both direct and post-picker UI front doors pass a guard from their captured account lease; native permission/picker
  work remains outside SQLite and the logical-send queue. The service rechecks that lease after COMMIT and before HTTP,
  passes the same guard into successful and failed settlement, and rethrows guard rejection rather than attempting a
  second stale-account failure owner. Existing temp/real GUID, structured contact, retry, and reply semantics remain
  intact. The supported payload excludes top-level native contact IDs, photo paths, unrelated selected text, and empty
  attachment/reaction arrays.

  The ordinary-send, repository-context, and send-front-door certificates replace six old core records with nine
  explicit helper-body, wrapper, and service-owner records, while rekeying four outcome/front-door records one-for-one.
  Inventory moves from **1,427** to **1,430 findings / 0 structural or membership errors**, a reviewed net increase of
  three. Ninety-three unchanged findings receive scanner-proven line shifts, and exact reconciliation ends at **0 line
  shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/db/outgoingBranches.test.ts`,
  `test/db/outgoingUserActions.test.ts`, `test/services/sendContactService.test.ts`,
  `test/services/sendAccountScope.test.ts`, `test/services/sendChatIdentity.test.ts`,
  `test/services/sendRetryGuard.test.ts`, and `test/services/logicalSendQueueWiring.test.ts` pass **7 suites / 119 tests
  / 0 snapshots**. A real SQLite trigger proves lease retirement during the final chat update rolls back all
  provisional state, drains the admitted owner, starts no HTTP, and preserves the predecessor date. A fresh lease then
  commits exact provisional state, observes HTTP with no transaction open, and completes real-GUID promotion. All three
  exact certificates pass **3/3**, the fast scanner passes **84/94** with **10 intentional skips / 0 failed**, and
  Prettier plus `git diff --check` pass. Independent concurrency and scanner/inventory reviews are both **GO**.

  The focused test does not separately retire the lease during post-HTTP settlement or the narrow successful-
  COMMIT→pre-HTTP interval; shared settlement tests and explicit guard wiring cover the constituent behavior. Untyped
  runtime callers could still add nested phone/email keys outside the supported contact shape. Native Expo Contacts,
  real `/message/contact`, op-sqlite/SQLCipher timing, process-kill, and physical teardown remain device/staged evidence.
  Parent `DB-02B` remains **IN_PROGRESS** because text/attachment initial persistence, scheduled handoff, and other
  residual owner conversions remain open. Text and scheduled handoff remain deferred during focused-only work because
  their scheduled-recovery checker coupling requires a broader checker update and full gate. This is post-v57 host proof
  and performs no external write or device action.

- **2026-08-26 — `DB-02B2AJ` gives initial attachment persistence one explicit guarded owner:**
  `sendImageMessage` no longer delegates optimistic construction to the public self-transacting repository wrapper.
  The new `insertOutgoingAttachmentWithinTransaction` accepts only an authenticated transaction context and immediately
  adopts one inline join. Committed chat lookup, message insert, inserted-ID read, attachment insert, attachment retry-
  queue insert, and NULL-safe monotonic chat-date update retain their exact awaited order in one short transaction. The
  public `insertOutgoingAttachment` keeps its standalone signature and DEV/test behavior.

  The existing synchronous source-path protection now surrounds that guarded owner and still releases after COMMIT or
  rollback, before native upload. The service rechecks its captured account lease before upload and after upload, passes
  the same guard through successful and failed settlement, and rethrows ownership loss rather than marking/notifying the
  retired account. Single- and multi-image front doors retain their original lease closures; every sibling remains under
  the batch's tracked `Promise.allSettled` lifetime. File streaming, progress, cancellation, HTTP, and notifications stay
  outside the process-wide DB mutex.

  The ordinary-send and repository-context certificates retire nine old repository/service records and add twelve exact
  helper-body, public-wrapper, service-owner, and guarded-outcome records. Send-front-door and DEV memberships remain
  byte-for-byte unchanged. Inventory moves from **1,430** to **1,433 findings / 0 structural or membership errors**, a
  reviewed net increase of three. Four unchanged local-path records receive scanner-proven `+11` line shifts, and exact
  reconciliation ends at **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/db/attachmentsBranches.test.ts`,
  `test/services/sendAttachmentService.test.ts`, `test/services/sendAccountScope.test.ts`,
  `test/services/sendChatIdentity.test.ts`, `test/services/logicalSendQueueWiring.test.ts`,
  `test/services/outgoingQueueService.test.ts`, and `test/services/sendOutcome.test.ts` pass **7 suites / 104 tests / 0
  snapshots**. A real SQLite trigger retires account A on the final chat-date update and proves full provisional rollback,
  one source-pin release, drain completion, no uploader call, and the predecessor date. A fresh lease commits exact
  provisional state, releases its pin, observes upload outside SQLite, promotes the message, removes the queue row, and
  retains the attachment's temp GUID/local path. All three exact certificates pass **3/3**; the fast scanner passes
  **84/94** with **10 intentional skips / 0 failed**; and Prettier plus `git diff --check` pass. Independent concurrency
  and scanner/inventory reviews are both **GO** with no blocking finding.

  The host fake uploader does not prove Expo legacy-filesystem stat/stream/cancel/progress, content-provider URIs,
  op-sqlite/SQLCipher timing, real transport credential capture/cancellation, process kill, physical
  A→Disconnect→B teardown, or RCS/server echo. Tests do not deterministically retire the lease in the narrow post-
  COMMIT→pre-upload or post-upload→pre-settlement intervals; the explicit source checks and guarded settlement cover the
  constituent logic, while exact native timing remains device/integration evidence. Parent `DB-02B` remains
  **IN_PROGRESS** because text initial persistence, scheduled ownership/handoff, reminder/sync boundaries, and final
  residual-owner closure remain open. Text and scheduled work stay deferred during focused-only work because their
  scheduled-recovery checker coupling requires a broader checker update and full gate. This is post-v57 host proof and
  performs no external write or device action.

- **2026-08-26 — `DB-02B2AK` gives new-reminder creation one explicit guarded owner:**
  `scheduleReminder` no longer delegates first-row persistence to the public self-transacting repository wrapper. The
  new `createReminderWithinTransaction` accepts only an authenticated transaction context and immediately adopts one
  inline join around the bounded reminder INSERT/RETURNING. The public `createReminder` keeps its compatible standalone
  signature, optional creation timestamp, and commit guard. Existing-row moves are deliberately unchanged in this
  focused slice.

  The service opens the transaction only after its message/notification reads and native alarm arm, and supplies the
  captured account lease as the live admission/commit guard. On rollback or persistence failure, the existing outer
  catch retires the candidate alarm after the transaction has closed. Previous-trigger retirement and every native
  schedule/cancel operation remain outside SQLite.

  The notification/reminder and repository-context certificates retire five exact records and add eight helper-body,
  public-wrapper, and service-owner records. Inventory moves from **1,433** to **1,436 findings / 0 structural or
  membership errors**, a reviewed net increase of three. Fifteen common findings change only their recorded line;
  exact reconciliation finishes at **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/remindersService.test.ts` passes **1 suite /
  32 tests / 0 snapshots**. Its new real-SQLite trigger retires account A after INSERT and before COMMIT, proving the row
  rolls back, the candidate alarm is cleaned up, teardown drains, and the raw transaction closes; a fresh lease then
  observes native scheduling outside SQLite and commits the exact durable fields. Both exact certificates pass **2/2**,
  the fast scanner passes **84/94** with **10 intentional skips / 0 failed**, and Prettier plus `git diff --check` pass.
  Independent concurrency/native-effect and scanner/inventory reviews are both **GO** with no blocking finding.

  The focused test does not directly sample transaction state during compensating native cancellation; source ordering
  makes rollback-before-catch explicit, and existing compensation tests cover cancellation. Host better-sqlite3 and the
  injected scheduler do not prove notify-kit/Notifee, op-sqlite/SQLCipher timing, process kill, or physical account
  teardown. Existing-row `scheduleReminder` and `rescheduleReminder` moves still use the public `updateReminderTime`
  wrapper and remain the next focused reminder slice. `reminders.message_guid` is indexed but not unique, so concurrent
  first-ever schedules can still duplicate rows; that separate schema/settlement fix requires migration-level proof.
  Parent `DB-02B` remains **IN_PROGRESS** because reminder moves, text and scheduled ownership, sync justification, and
  final residual closure remain open. This is post-v57 host proof and performs no external write or device action.

- **2026-08-26 — `DB-02B2AL` gives both reminder-time compare-and-set moves explicit guarded owners:**
  `updateReminderTimeWithinTransaction` now accepts only an authenticated transaction context and immediately adopts
  one inline join around the existing id plus optional prior-notification-id UPDATE/RETURNING. The public
  `updateReminderTime(db, id, scheduledFor, notificationId, commitGuard?, expectedNotificationId?)` signature and
  standalone semantics remain compatible, including its boolean mismatch result.

  `scheduleReminder`'s existing-row branch and `rescheduleReminder` each open one short owner with their captured
  account lease as the admission/commit guard. Both pass the notification id observed before native scheduling as the
  compare-and-set predecessor. Reads and native alarm arm stay before SQLite, candidate cleanup follows rollback or a
  false result, and old-alarm retirement occurs only after a true committed move. Distinct caller errors and same-id
  rearm behavior remain unchanged.

  The two exact certificates replace the old repository body/wrapper and two service delegates while rekeying the
  unchanged B2AK create owner. Inventory moves from **1,436** to **1,441 findings / 0 structural or membership errors**:
  eight exact records retire, thirteen explicit records are added, and the net increase is five. Three unchanged cancel-
  owner records receive line-only updates. Exact reconciliation finishes at **0 line shifts / 0 rekeys / 0 additions**.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/services/remindersService.test.ts` passes **1 suite /
  34 tests / 0 snapshots**. Its parameterized real-SQLite proof retires account A from an AFTER UPDATE trigger through
  both production owners, then verifies exact old-row rollback, candidate-only cancellation, drain completion, all
  native scheduling/cancellation outside SQLite, and a fresh-generation successful move that retires exactly the old
  alarm. Both exact certificates pass **2/2**; the fast scanner passes **84/94** with **10 intentional skips / 0
  failed**; and Prettier plus `git diff --check` pass. Independent runtime and scanner/inventory reviews are both
  **GO** with no blocking finding.

  The fake scheduler uses separate observation arrays rather than one real OS alarm registry; exact IDs and ordering are
  asserted, while notify-kit/Notifee and op-sqlite/SQLCipher timing remain device evidence. The non-unique
  `reminders.message_guid` concurrent-first-create risk is unchanged and requires separate schema/settlement proof.
  Reminder creation, moves, and deletion now use context-only bodies at their composing service boundaries. Parent
  `DB-02B` remains **IN_PROGRESS** for text and scheduled ownership, sync justification, and final residual closure.
  This is post-v57 host proof and performs no external write or device action.

- **2026-08-26 — `DB-02B2AM` proves the sync attachment reconciler should remain a standalone guarded owner:**
  Both production sync callers invoke `reconcileOutgoingAttachmentByContent` before their later message-slice owner.
  The helper already owns one short guarded transaction containing its candidate/materialization reads, context-only
  identity handoff, queue delete, and message promotion. Moving it into the 5/50-row slice would alter partial-progress
  recovery and run up to fifty content-match scans under one mutex; wrapping the same one helper at each caller would
  reproduce its current owner with no construction-time safety gain. Production source is unchanged.

  A new real-SQLite AFTER DELETE trigger retires the guard after the queue row changes but before COMMIT. The owner
  rejects and rolls back the temp-to-real alias handoff, queue deletion, message GUID/state update, and local attachment
  path together. After the trigger is removed and the guard refreshed, the same reconciliation promotes the real GUID,
  clears the queue, records the alias, and retains the on-disk path.

  Under pinned Node **24.19.0**, strict TypeScript passes. `test/db/outgoingBranches.test.ts`,
  `test/services/sendAttachmentService.test.ts`, `test/services/syncEngineBranches.test.ts`, and
  `test/services/discardMessage.test.ts` pass **4 suites / 91 tests / 0 snapshots**. Together they cover guard rollback/
  retry, rolling-neighbour isolation, deletion-ledger transfer, RCS sync-first path preservation without duplicates,
  error recovery, old-history non-hijack, both sync caller shapes, and discard-after-promotion behavior. The exact sync
  delegation certificate passes **1/1**; the fast scanner passes **84/94** with **10 intentional skips / 0 failed**;
  inventory remains **1,441 findings / 0 structural or membership errors**; and reconciliation remains **0/0/0**.
  Prettier and `git diff --check` pass.

  This proof does not claim op-sqlite/SQLCipher timing, physical account teardown, or staged RCS-server behavior. No
  production, scanner membership, or inventory record changes. Parent `DB-02B` remains **IN_PROGRESS** for the final
  intentional-owner audit and the text/scheduled ownership work that requires the deferred broader checker/full gate.
  This is post-v57 host proof and performs no external write or device action.

- **2026-08-26 — `DB-02B2AN` makes all four error-report upload phases explicit transaction owners:**
  `listRetryableErrorReportsWithinTransaction`, `claimErrorReportsWithinTransaction`,
  `deleteErrorReportsWithinTransaction`, and `markErrorReportsFailedWithinTransaction` each accept only an
  authenticated transaction context and immediately adopt one inline join. Their public wrappers retain standalone
  compatibility and the existing guarded, bounded behavior.

  `runQueueBody` now owns cleanup plus eligibility selection, lease claim, successful deletion, and failure backoff as
  four separate short transactions. Its HTTP POST/await occurs only after claim COMMIT and before either outcome owner;
  no network, native, or logging effect runs under the process-wide DB mutex. Direct list ownership preserves the old
  lifecycle checks without an unnecessary nested tracked-work admission. Live list/claim/failure clocks remain sampled
  after mutex acquisition, and upload outcomes remain deduplicated and bounded to one hundred ids.

  The exact certificates retire seventeen reviewed records and add twenty-nine helper-body, public-wrapper, and
  service-owner records, moving inventory from **1,441** to **1,453 findings / 0 structural or membership errors**.
  Reconciliation finishes at **0/0/0**. Under pinned Node **24.19.0**, strict TypeScript passes;
  `test/db/errorReportsRepo.test.ts` and `test/services/errorReportQueueService.test.ts` pass **2 suites / 59 tests / 0
  snapshots**; both exact certificates pass **2/2**; and the fast scanner passes **84/94** with **10 intentional skips /
  0 failed**. Success and failure callbacks directly assert that HTTP observes `raw.inTransaction === false`.
  Prettier and `git diff --check` pass. Independent review is **GO**.

  Host better-sqlite3 does not prove op-sqlite/SQLCipher timing, physical account teardown, or a staged diagnostic
  upload. Parent `DB-02B` remains **IN_PROGRESS** for final residual justification and text/scheduled ownership, which
  is deferred to the broader scheduled-recovery checkpoint. This is post-v57 host work and performs no external write
  or device action.

- **2026-08-26 — `DB-02B2AO` closes ordinary-text and scheduled ownership plus the residual boundary:**
  Ordinary text construction now uses one short guarded owner with the captured UI/headless account lease propagated
  through pre-network and outcome settlement. Scheduled create and all four scheduled-edit persistence branches use
  context-only repository helpers inside similarly guarded owners. Text and scheduled HTTP work remains outside SQLite,
  and ownership rejection cannot fall through into retired-account failure settlement.

  The scheduled-recovery checker mutation-pins the new ordinary owner, guard precedence/propagation, direct ownership-
  error rethrow, reviewed AST fingerprint, and exact context-helper call graph. The DB scanner certificate exhaustively
  fixes the residual repository-delegation set at **46 edges: 18 DEV + 9 scheduled state-machine + 19 intentional
  bounded/lifecycle boundaries**. Seventeen inventory records retire and twenty-six replace them, moving **1,453 →
  1,462 findings**; seventy-five line-only shifts are reviewed, report errors remain zero, and reconciliation finishes
  at **0/0/0**.

  Strict TypeScript passes; the focused matrix passes **7 suites / 135 tests**; architecture passes **33/33** plus the
  live 66-file boundary; migrations pass **5/5** at head `0039`; and the hostile scanner passes **95/95**. Broad Jest
  evidence is composite: the aggregate run had **423 suites and 4,872 tests passing**, its one stale test-only
  reachability mock was corrected, and that exact suite then passed **37/37**. A concurrent aggregate retry exited 139
  without an assertion failure during the hostile scanner and is not counted. Prettier and diff checks pass, and the
  independent final review is **GO**.

  Host tests do not prove native op-sqlite/SQLCipher timing, physical account teardown, killed/headless notification
  actions, process-kill recovery, or staged scheduled APIs. Parent `DB-02B` is **DONE**; `DB-02C` is dependency-unblocked
  but not started. This is post-v57 host work and performs no external write or device action.

- **2026-08-26 — `LOG-01D` retires a confirmed persistent-log cleanup issue in-process:** App Logs now removes the
  exact `persistent-logs` / `persistent-log-init-failed` issue from both the active boot state and the process replay
  owner after the file sink positively confirms native deletion or absence. A false, rejected, or timed-out Clear keeps
  the warning, while a boot-time initialization rejection settling after successful Clear cannot recreate it. The UI no
  longer asks for an unnecessary restart after confirmed cleanup.

  The focused boot and App Logs matrix passes **3 suites / 43 tests / 0 snapshots**; strict TypeScript and the diagnostic
  guard pass, including **30/30 guard mutations**, **20 production ERROR calls / 19 finite events**, and **6 finite native
  calls**. Touched source/test formatting, `git diff --check`, and independent lifecycle/privacy review pass. This host
  change does not prove native filesystem behavior or close the remaining opaque crash-site token, finite non-error
  schema, app/server fixture, pre-runtime/native containment, or exact-candidate inspection requirements.

- **2026-08-26 — `LOG-01D` retains one finite push-receipt diagnostic:** Foreground and background FCM delivery now
  emit the versioned `fcm.push_received` event instead of a development-only free-form line. Its capture projector
  accepts only a known server-event category (mapping unknown provider input to `unknown`) and foreground/background
  source; it never copies the push body or arbitrary metadata. Memory and the capped app-private log retain the
  minute-rounded record, restore reprojects it, and the renamed Share diagnostics action reprojects it again. Release
  console output remains ERROR-only, and ErrorReportSink rejects every non-error level, so the receipt is not printed
  to logcat or uploaded over HTTP. The in-app privacy map now states the retained fields.

  The focused matrix passes **8 suites / 92 tests / 0 snapshots**. Strict TypeScript passes; the diagnostic guard passes
  **30/30 mutations** and reports **20 production ERROR calls / 19 finite ERROR events / 6 finite native calls**;
  targeted ESLint has **0 errors** (two existing Jest mock-before-import warnings), touched source/test formatting and
  `git diff --check` pass, and independent privacy/lifecycle review is **GO**. This is post-v57 host work and performs no
  external or device action. `LOG-01` remains open for the opaque crash-site token, committed app/server fixture,
  pre-runtime/native containment decision, and exact-candidate file/share/logcat/HTTP inspection.

- **2026-08-26 — `LOG-01D` replaces enumerable event frames with opaque crash-site ids:** Every production ERROR call
  now supplies one committed, nonsemantic site id paired at compile time with its finite event. The projector retains
  only one unique exact event-owned `at gator.site.<opaque-id>` frame. If no valid exact durable frame exists—or if
  valid durable frames conflict—it produces no frame. The two database-initialization sites remain distinguishable even
  though they share one event.
  DB upload, private-file restore, memory restore, and Share diagnostics revalidate the same exact frame instead of
  regenerating or accepting raw stack text. React Native fatal, uncaught, render, and recoverable boundaries provide
  their own finite ids. Consent and the in-app privacy map now describe the retained code and explicitly exclude the
  original message, filename, function name, and stack trace.

  The focused matrix passes **11 suites / 175 tests / 0 snapshots**; after the final durable-carrier tightening, the
  core privacy suite rerun passes **1 suite / 32 tests**. Strict TypeScript passes. The diagnostic guard passes **32/32
  mutations** and reports **20 production ERROR calls / 19 finite ERROR events / 20 opaque production crash sites / 6
  finite native events**. DB reconciliation finishes at **0 line shifts / 0 rekeys / 0 additions** after mechanically
  recording 26 reviewed line shifts; its exact incoming-ingress certificate also gained the already-committed finite
  FCM receipt spelling that the prior milestone had left stale. Targeted ESLint has **0 milestone errors** and 14
  existing Jest mock-order warnings; the DB scanner retains two pre-existing unused-parameter findings at committed
  HEAD and has no other lint findings. Formatting, `git diff --check`, and independent final privacy/guard review pass.

  This is post-v56 source work and is not evidence for the frozen v56 AAB. No external or device action occurred.
  `LOG-01` remains open for the committed app/server fixture, pre-runtime/native containment decision, and
  exact-candidate file/share/logcat/HTTP inspection.

- **2026-08-27 — `REL-011B` removes service-owned UI presentation:** Send admission now reports a typed capacity
  issue to its screen caller; manual retry and message discard return typed outcomes; attachment upload returns its
  existing typed `ApiError` without touching a toast store; and auto-download returns a saved-image outcome. The
  mounted UI owns all user copy and auto-download batching. An explicit composition adapter synchronously clears
  dialog, toast, and pending auto-download presentation during account teardown, while an absent adapter keeps killed/
  headless delivery UI-free. Shared luminance math moved from UI ownership into platform-free core.

  The architecture guard now rejects service imports of UI aliases and relative UI paths through static imports,
  exports, `require`, dynamic import, and non-literal loading. Strict TypeScript passes; all seven guard cases pass;
  and the live scan passes across **68 core / 115 service files**. The focused Jest invocation ran only named changed-
  boundary cases: **5 behavior tests passed** (typed auto-download handoff/reset, synchronous presentation reset, and
  send-capacity reporting). Database-backed retry/discard cases could not load because this shell is Node 26 (ABI 147)
  while the installed `better-sqlite3` binary targets the repository-pinned Node 24 (ABI 137); this is recorded as an
  environment verification limit, not a passing assertion. Formatting and diff checks pass. Independent architecture/
  lifecycle review found and drove fixes for accurate failed/paused retry outcomes and token-safe adapter retirement;
  the final re-review is **GO**.

  This is post-v56 source work and is not evidence for the frozen v56 AAB. It performs no external, Play, EAS, server,
  or device write. At this checkpoint, parent `REL-011` remained open for `REL-011C`, `REL-011D`, and native killed-app
  composition proof; the 2026-08-30 repository gate later closed the two local children, leaving only the Android proof.

- **2026-08-27 — `REL-011C` starts the UI command boundary at the inbox:** Nine direct UI database command paths in
  the conversation tile, inbox list, and long-press action sheet now call five explicit chat-service operations for
  mute, archive, pin, adjacent pinned-order movement, and local bulk-read state. The chat service opens each simple
  command's short transaction explicitly and delegates reordering to its existing guarded repository owner. Every path
  keeps the screen-captured account lease as both the teardown admission boundary and commit guard. Reactive inbox
  reads remain in UI as the parent contract permits.

  The next production batch removes all nine UI-owned transaction calls from Chat Settings. Theme/background and
  name/color updates now cross typed chat-service commands; the existing mute command is reused; and Reset to Default
  clears name, color, and mute in one guarded transaction instead of two commits that could stop halfway. Native image
  selection, stable-file copying, adaptive-color extraction, and luminance work remain in the mounted screen's tracked
  lifecycle, while the final short database commit is service-owned and still targets the originating chat/account.

  The open-chat route no longer supplies `http` plus a database handle to synced-background work, where omitting its
  mounted lease previously let the lower-level service capture whatever account was current later. A mounted façade
  now acquires the database under the originating lease and forwards that exact lease to the existing bounded transfer
  engine. Composer draft writes likewise use an explicit guarded chat-service command and the shared draft-key prefix;
  the route retains only the permitted tracked draft read.

  Reminder creation, rescheduling, and cancellation no longer require their screens/hooks to pass a database handle or
  native scheduler placeholder. Thin UI-facing reminder commands acquire the composition database under the exact
  captured lease, then reuse the existing DB→native→DB state machines unchanged; native alarm arm/cancel remains outside
  every transaction. Completed scheduled-history deletion likewise moved from a screen-owned transaction into the
  scheduled send service. Reminder and scheduled list queries remain in UI as permitted reads.

  Global custom-theme create, edit, delete, select, and revert now cross a dedicated account-scoped service boundary.
  Create still inserts the row and activates it in one commit; delete still revalidates the persisted active pointer in
  the same transaction; and select now commits only the exact token blob already parsed and validated by the mounted
  screen. The route retains permitted list reads plus UI token parsing and publishes Zustand state only after a committed
  result. It no longer owns a custom-theme write transaction or passes a database handle into one.

  Permission-onboarding completion and explicit error-reporting consent now cross an account-scoped settings service
  instead of receiving a database handle from their screens. Onboarding retains both the mounted-route predicate and
  account commit guard, while consent keeps its existing serialized choice generation and immediate in-memory
  revocation before persistence. Current failures still restore/show the existing error path; retired-account failures
  remain quiet.

  The inbox-mount and open-chat DEV scheduled ticks no longer assemble `getDatabase()` + `http` + the lower-level
  scheduled runner in route code. One send-service façade owns those dependencies and the teardown admission while
  requiring the exact lease captured by the mounted route and preserving the injected fake sender, reply target, and
  per-tick clock. With that change, production `app/` and `src/ui/` contain no direct transaction/mutator command path or
  DB/HTTP command composition; their remaining database handles are query-only.

  Per owner direction to stop test work until production remediation is complete, these batches add or change no tests
  and run no test, typecheck, scanner, or architecture gate. Verification is limited to touched-file formatting,
  skeptical production-diff review, direct-command inventory, and `git diff --check`; deferred gates must run after
  remediation is complete. This is post-v56 source work and is not evidence for the frozen v56 AAB. It performs no
  external, Play, EAS, server, or device write. At this checkpoint, `REL-011C` remained **IN_PROGRESS** only for
  fail-closed command-boundary enforcement; the 2026-08-30 architecture gate later completed that local tail.

- **2026-08-27 — `REL-011D` starts explicit process initialization:** Importing the bounded native-download
  implementation no longer performs filesystem cleanup at module evaluation. A dedicated registration module owns the
  constant-work abandoned-partial sweep, and the bundle entry imports that module explicitly before
  `expo-router/entry`, preserving killed-app/headless startup behavior. If the early native filesystem pass fails, the
  first real transfer still retries before it claims a destination. Synced-background cache pruning likewise no longer
  runs merely because the service module/barrel is evaluated: foreground boot explicitly starts one process-wide
  maintenance pass through the same serialized promotion slot, while successful headless promotion retains its own
  direct postcommit prune. Foreground-boot auto-recovery plus its invalidate/restart/issue bridges also moved out of
  module evaluation into an idempotent composition initializer. Both the first external subscriber and a direct start
  install it before proceeding, retaining the load-bearing internal-listener-before-UI ordering. WorkManager's
  `TaskManager.defineTask` call now lives in a dedicated entry-only wrapper statically imported before Router, so
  foreground imports of the background-sync implementation no longer define a native task. Firebase's killed-app
  background-handler registration now follows the same entry-wrapper pattern; importing foreground FCM operations no
  longer registers it. Root Layout removed its ineffective duplicate notification-event side-effect import and now
  imports its lock command from the direct service leaf, leaving `index.js` as the single explicit headless registration
  owner. The operational service barrel no longer re-exports foreground-boot composition, and its realtime fallback
  namespace plus notification fallback avatar are now initialized on first use instead of during import. No test,
  typecheck, scanner, external, Play, EAS, server, or device operation ran under the owner's production-first direction;
  this remains post-v56 work.

  The DEV welcome shortcut now calls one single-flight feature composition command for DB open → fixture writes → fake
  session publication → delivery-admission resume. The route retains only progress/error presentation and navigation,
  blocks same-turn double taps, and ignores UI completion after unmount. A DB/fixture failure cannot publish the fake
  connected session or reopen delivery; fixed-id/upsert seeding remains safe to retry. Release builds retain both the
  hidden button and a command-level rejection guard.

- **2026-08-28 — Consolidated post-remediation host verification records composite results without repeating broad
  gates:** Under pinned Node `24.19.0`, toolchain checks pass **8/8**, Expo Doctor passes **20/20**, Expo dependency
  checking reports up to date, architecture passes **35/35**, migrations pass **5/5** at **40** migrations with head
  `0040_chats_pin_order`, secret hygiene passes **4/4**, error diagnostics pass **32/32**, strict TypeScript passes,
  `npm ls --depth=0` is clean, and both install and production audits report zero vulnerabilities. DB inventory report
  and reconciliation pass with **1,586 findings / 0 unresolved / 0 nested / 0 membership errors**. The one permitted
  full DB-scanner run passed **96/97** cases; its sole stale fixture was corrected and that exact case then passed
  **1/1**. The one permitted full Jest run exposed 12 stale test harnesses after the completed production moves; all
  observed failed paths were corrected or diagnosed and their focused matrix passes **12 suites / 285 tests**, including
  the unchanged strict attachment-rollback case. No second full scanner or full Jest run was performed per owner
  direction. Formatting and diff checks pass. This is composite host evidence only: it creates no AAB or release
  candidate and supplies no Android runtime, device, Play, EAS, or server evidence.

- **2026-08-30 — Repository-local remediation checkpoint closes the audited host gates:** Under exact
  Node **24.19.0** and npm **11.17.0**, strict TypeScript and zero-warning production lint pass; configured source,
  app, and test formatting passes. The architecture gate passes **46/46** script tests and scans **71 core / 123
  service / 146 UI-app / 451 production files**, **1,561** synchronous runtime edges with **0 cycles**, and all **7**
  ordered entry imports. Migration verification passes **5/5** across **44** sequential migrations at head
  `0044_custom_folder_unread_badge`. The DB report accepts **1,683** reviewed mutations with **0 errors**;
  reconciliation reports **0 line shifts / 0 rekeys / 0 additions**; and the required full scanner passes **97/97**.

  The one permitted full Jest run then reported **429/442 suites** and **4,955/5,002 tests** green, exposing **13**
  suite files whose fixtures or mocks had drifted after deliberate production moves. Twelve stale harnesses were
  repaired without restoring removed plaintext export, retired logging ownership, or loosened reaction identity. The
  thirteenth attachment rollback suite reproduced green **16/16** on unchanged code and was left untouched at that
  checkpoint. Disjoint
  focused reruns now cover that exact failed set at **13/13 suites / 155/155 tests / 0 snapshots**; no second full Jest
  run or full scanner was performed in that batch. A later full run on HEAD `8b27b03` exposed the intermittent
  attachment fixture at **441/442 suites / 5,021/5,022 tests**. Investigation found no deterministic polluting suite
  and replaced the unreliable runtime-trigger fault injection while adding explicit test-database cleanup. A first
  hard-coded RNG/uniqueness fixture passed one full gate but failed the next at **443/444 suites / 5,024/5,025 tests**.
  The final fixture seeds the exact production-supplied attachment GUID before the transaction, removing the remaining
  RNG/module-mock assumption while retaining the real unique-index rollback. Production code did not change. Its
  focused suite passes **16/16**, the prior five-suite reproducer passes **129/129**, and the final pinned working-tree
  gate passes **444/444 suites / 5,025/5,025 tests / 0 snapshots** in **76.338s**. This closes the cumulative functional
  host gate, not the separate `TEST-01` coverage/warning/V8 work. It creates no candidate and supplies no
  killed-process, device, Play, EAS, Firebase, upload, submission, or server proof.

- **2026-08-30 — Clean post-`PLAY-02` Android fixture closes the local packaged-permission tail:** The first live
  artifact scan rejected ignored Android manifests and an AAB last generated before `9046e27` because they still
  contained `android.permission.USE_FULL_SCREEN_INTENT`. Current Expo config already blocked that permission, so a
  clean CI-fixture prebuild regenerated the ignored native project. Autolinking found all four owned modules. The
  debug/native build passed in **4m 3s** across **750** actionable tasks, and the release bundle passed in **8m 42s**
  across **1,278** actionable tasks. The Android artifact guard then passed all **11/11** mutation tests and live
  inspection of the debug manifest, release manifest, and packaged release AAB. This is local fixture/debug-signing
  evidence only: it creates no release candidate and proves no runtime notification action, device, Play, EAS,
  Firebase, upload, submission, or server behavior.

- **2026-08-28 — Expo 57.0.18 clean Android build and release-guard reconciliation:** A disposable archive of exact
  source `edb43f22079c76d9a54fd6735aa8b276ce4784e8` completed clean `npm ci`, Android prebuild, and autolinking under
  Node `24.19.0` and OpenJDK `17.0.20.1`. Autolinking discovered and Gradle compiled the four owned modules:
  `gator-bounded-download`, `gator-paste-input`, `gator-screen-security`, and `gator-share-shortcuts`. Incremental debug
  confirmation passed in **21s** (**750** tasks: **44** executed / **706** up to date); the APK is **184,702,455 bytes**
  with SHA-256 `4d36b632cb1db4f6225c5589ff4fb5d680b5983c59ad5ab9a83d63fc0d48b47f`. The clean release bundle passed in
  **4m 5s** (**1,278** tasks: **1,217** executed / **61** up to date); the AAB is **79,006,207 bytes** with SHA-256
  `c91fa85fd0ea37ae9078192b74bbd700848efe10a2d6b2d79f5b357697836118`. It uses the CI Firebase fixture and Android
  debug certificate SHA-256 `FA:C6:17:45:DC:09:03:78:6F:B9:ED:E6:2A:96:2B:39:9F:73:48:F0:BB:6F:89:9B:83:32:66:75:91:03:3B:9C`.
  The build exposed stale release tooling: fixtures retained the removed full-screen permission and retired entry paths,
  while CI omitted `gator-screen-security`. Commit `4545110` reconciles those rules. The Android guard passes **10/10**
  tests plus exact debug/release/AAB inspection; the workflow guard passes **22/22** tests plus its live scan. No broad
  Jest or DB scan was repeated. This debug-signed fixture build is not a candidate and provides no Android runtime,
  device, Play, EAS, or server evidence.

- **2026-08-28 — `FEAT-02A` implements current-chat search as a bounded local feature slice:** The chat header now
  opens a themed search field, debounces three-character queries, navigates newer/older hits, announces result position,
  and highlights the exact bubble while preserving the mounted composer and disabling conflicting message actions.
  Search reads every qualifying matching row already present in the encrypted local database through nullable-date
  keyset pages, a per-search maximum-id fence, shared visibility/overlay/retraction rules, and account-generation fences.
  Exact message-id anchoring replaces timestamp-only windows, including equal/null timestamp cases and temp-guid
  promotion. Strict TypeScript and the exact focused **3 suites / 26 tests** pass under pinned Node `24.19.0`; no broad
  gate was repeated. `FEAT-02B` safe entity actions and physical Android interaction evidence remain open. This is
  post-v56 source work; it changes no AAB and performs no Play, EAS, server, or device write.

- **2026-08-28 — `FEAT-02B` adds conservative, user-confirmed message entity actions:** Message text now renders only
  validated explicit `http(s)` URLs, strongly formatted phone numbers, and unambiguous four-digit-year dates as
  actionable spans while preserving attributed-body mentions and all original text. URL targets pass a second exact-span
  parse plus the existing scheme allowlist; phone choices construct only canonical dialer/SMS targets or copy; date
  choices open a fixed, all-day Android calendar draft or copy. The app never directly calls, sends, or writes an event,
  and peer text cannot choose the native action, URI, or extras. Bare domains/digits, extensions, ambiguous/relative
  dates, email, addresses, tracking/flight identifiers, and ML extraction stay inert by design. Strict TypeScript and the
  exact focused **1 suite / 4 tests** pass under pinned Node `24.19.0`; no DB, architecture, migration, component, build,
  or broad Jest gate was intentionally run. One mistaken Jest invocation began the Node project before exact-path
  filtering and was stopped immediately; it is not claimed as evidence. Android browser/dialer/SMS/calendar interaction
  evidence remains open. This is post-v56 source work; it changes no AAB and performs no Play, EAS, server, or device
  write.

- **2026-08-29 — `FEAT-01` implements persisted, pre-page inbox filtering:** The main inbox now applies independent
  unread, known/unknown, direct/group, exact mute, and iMessage/SMS/RCS predicates to pinned and unpinned chat
  identities before either branch is limited. One versioned encrypted account-local preference drives a themed
  draft-first Apply/Cancel/Reset sheet and participates in settings-only backups. Unified search and the fixed Archived/
  Unknown Senders routes remain unchanged; the older unknown-sender policy still owns its notification split. Filtered
  views disable pin moves that could skip hidden ranks, Apply returns a deep list to the top, and pinned-only matches no
  longer show a false empty state.

  Under pinned Node **24.19.0**, the exact inbox suite passes **1 suite / 10 tests** and strict TypeScript passes. The
  fast DB-write guard completes **97 cases** (**86 passed / 11 intentionally skipped / 0 failed**), and final inventory
  reconciliation reports **0 line shifts / 0 rekeys / 0 additions** after reviewing the one new three-edge preference
  transaction. Formatting and diff checks pass. Independent production review is **GO**. No component, broad Jest,
  architecture, migration, build, Play, EAS, server, or device gate was run. Physical Android interaction, TalkBack,
  restart persistence, and growing-page observation remain open, so `FEAT-01` remains **IN_PROGRESS**. This is
  post-v56/post-v57 source work and changes no AAB.

- **2026-08-29 — `FEAT-03A` replaces blank interactive balloons with safe local fallbacks:** The bounded
  server-provided Messages extension identifier now survives validation, migration `0041_message_balloon_bundle_id`,
  message upsert, and the full-row, reply, notification, and inbox projections. Handwriting, Digital Touch, unavailable
  URL previews, and unknown extensions render fixed local labels only; raw bundle identifiers are never displayed or
  opened. Real text and subjects still win; ordinary messages retain their Genmoji/attachment descriptions and files;
  and actually rendered URL cards remain the visible surface. The fallback anchors reactions and now reaches reply
  quotes, the composer reply bar, thread rows, notifications, reminders, and inbox subtitles instead of leaving those
  surfaces blank. Payload-backed cards also own their tapback anchor when no text bubble exists.

  The same slice closes a discovered lean-push exposure path: notification-shaped attachment payloads can omit
  `hideAttachment`, so balloon identity now conservatively prevents extension blobs from mounting in an attachment
  view, entering Share/Save/Forward, auto-downloading, or appearing in shared media/fullscreen image queries. Private
  media-route admission also rejects hidden, balloon-owned, retracted, and deleted rows before its single-item fallback.
  Extension descriptions cannot outrank the fixed local label, and a later hydrated sync monotonically promotes the
  stored hidden bit. Malformed identifiers, including SQLite-sensitive NUL strings, normalize to the private generic
  sentinel before persistence. Strict TypeScript passes. Under pinned Node **24.19.0**, the final exact focused matrix
  passes **5 suites / 79 tests**: three Node suites (**41 tests**), the direct bubble suite (**32 tests**), and the
  message-actions hook suite (**6 tests**). The migration guard passes **41 sequential migrations**, head
  `0041_message_balloon_bundle_id`, plus **5/5** guard tests; the fast DB-write guard passes **97 cases** (**86 passed /
  11 intentionally skipped / 0 failed**); and the final inventory report/reconciliation passes with **1,590 findings /
  0 structural or membership errors / 0 line shifts / 0 rekeys / 0 additions**. No broad Jest,
  architecture, full scanner, build, emulator, device, Play, EAS, or server gate was run. Multipart action identity
  (`FEAT-03B`), capability-gated text-plus-attachment sending (`FEAT-03C`), and physical Android observation remain
  open, so primary `FEAT-03` is **IN_PROGRESS**. The post-fix exact DB suite reruns **1/1**, and independent production/
  privacy review is **GO** with no remaining FEAT-03A blocker. This is post-v56/post-v57 source work and changes no AAB.

- **2026-08-29 — `FEAT-03B` lands the bounded multipart action-identity compatibility slice:** Incoming,
  optimistic, scheduled, retried, and echoed message rows now preserve bounded message-part counts and reaction/reply
  part identity. A shared conservative layout heuristic selects the visible text/caption/attachment part for UI
  replies, reactions, edits, unsends, notification Love, DEV actions, and scheduled sends. Reaction aggregation and
  removal stay exact by target, sender, kind, and known part; legacy unknown-part echoes reconcile only when one
  candidate exists. Plain and reply echoes no longer collide. Migration `0042_message_part_identity` adds the three
  nullable fields without rewriting existing rows, and the scanner inventory reviews all **1,594** current mutations.

  Under pinned Node **24.19.0**, two exact Node matrices pass **14 suites / 30 selected tests** with **221** unrelated
  cases skipped; two selected component cases also pass. Four selected chat-route cases did not execute because the
  existing isolated harness first imports unmocked ESM `ky` and, after that was isolated, lacks its required React Query
  client. Per the two-attempt rule, no further harness work was added and these cases are not claimed as evidence.
  Strict TypeScript passes; the migration guard passes **42 sequential migrations** with head
  `0042_message_part_identity` plus **5/5** guard tests; the fast DB-write guard passes **97 cases** (**86 passed / 11
  intentionally skipped / 0 failed**); inventory check passes **1,594 approved mutations**; and final reconciliation
  reports **0 line shifts / 0 rekeys / 0 additions**. Formatting and diff checks pass. Three independent production,
  history, and security/privacy reviews are **GO** after the inventory gate. No broad Jest, architecture, full scanner,
  build, emulator, device, Play, EAS, or server gate was run.

  Stable server per-part topology, received reply-part identity, mention-path propagation, shared partial-retraction
  presentation, `FEAT-03C`, and exact Android/server observation remain open, so parent `FEAT-03` remains
  **IN_PROGRESS**. This is post-v56/post-v57 source work, changes no frozen candidate, and performs no external write.

- **2026-08-29 — `FEAT-04A` adds the custom-folder persistence and service foundation:** Migration
  `0043_custom_folders` introduces ordered account-local folders plus chat-GUID membership that survives chat-row
  resync and repair. Bounded repository and account-leased service commands support list, create, rename, delete,
  exact reorder, and add-before-prune membership replacement. Consistency-sensitive reads share the global database
  coordinator, and disconnect/cache wipe explicitly removes both tables. Settings now disclose that disconnect deletes
  local folders and that backups do not yet contain them; no user-facing folder UI is claimed by this slice.

  Under pinned Node **24.19.0**, strict TypeScript passes. The exact migration/repository suite passes **1 suite / 2
  tests**, and the selected cache-wipe cases pass **1 suite / 2 selected tests** with **26** unrelated cases skipped.
  The migration guard passes **43 sequential migrations**, head `0043_custom_folders`, plus **5/5** guard tests. The
  fast DB-write guard passes **97 cases** (**86 passed / 11 intentionally skipped / 0 failed**); inventory check passes
  **1,654 approved mutations** with **0 structural or membership errors**; and final reconciliation reports **0 line
  shifts / 0 rekeys / 0 additions**. Independent production/migration review is **GO** with no remaining blocker for
  this slice. No broad Jest, architecture, full scanner, build, emulator, device, Play, EAS, or server gate was run.
  Folder UI, unread aggregation/policy, backup/restore integration, and exact Android interaction remain open, so
  parent `FEAT-04` is **IN_PROGRESS**. This is post-v56/post-v57 source work, changes no frozen candidate, and performs
  no external write.

- **2026-08-29 — `FEAT-04B` adds the bounded custom-folder management UI:** Settings now opens an ordered,
  device-local folder manager with create, rename, delete, move-earlier/later, and explicit membership-management
  routes. The membership editor loads the complete stable membership set before exposing edits, pages available
  active/archived/unknown-sender conversations in 50-row increments, preserves selected chats that are unloaded or
  temporarily unavailable, and enforces the existing 5,000-member bound. Folder rows and explanatory copy state
  plainly that this slice manages membership only; folder browsing, search, and unread totals are not yet available.
  Dynamic validation/save failures use Android accessibility alerts. Account-generation invalidation clears the
  screens immediately, and a mutation that completes while its route is covered defers its outcome until that exact
  route regains focus; a removed or deliberately abandoned route never navigates later. Folder reorder state likewise
  recovers from a background completion through an authoritative focus refresh.

  Under pinned Node **24.19.0**, strict TypeScript passes. The focused DB-write scanner remains green at **97 cases**
  (**86 passed / 11 intentionally skipped / 0 failed**). The final inventory guard passes **1,654 approved mutations**
  with **0 structural or membership errors**, after atomically reconciling only **2 Settings line shifts**; the final
  dry reconciliation reports **0 line shifts / 0 rekeys / 0 additions**. Exact-file formatting and diff checks pass,
  and three independent lifecycle/UX re-reviews are **GO** after their late-navigation, synchronous re-entry,
  membership-bound, reorder-recovery, scope-labeling, and TalkBack findings were corrected. No component or broad
  Jest, architecture, migration, build, emulator, device, Play, EAS,
  or server gate was run. Folder-scoped browsing/search, unread aggregation/policy, backup/restore integration, and
  exact Android interaction remain open, so parent `FEAT-04` is **IN_PROGRESS**. This is post-v56/post-v57 source work,
  changes no frozen candidate, and performs no external write.

- **2026-08-29 — `FEAT-04C` adds the bounded custom-folder conversation browser:** A folder row now opens its
  currently available conversations while a separate Manage affordance retains exact membership editing and the
  browse header retains rename/delete recovery even if the combined query fails. The shared inbox projection applies
  stable folder membership before both pinned and unpinned limits, preserves manual-pin/newest ordering, and grows in
  50-row prefixes capped by the existing 5,000-member bound. Folder identity, complete stored membership count,
  available count, and each page share one serialized transaction snapshot, so add-before-prune replacement cannot
  leak an intermediate superset. Active, archived, and unknown-sender members use the existing conversation tile,
  chat navigator, and row actions. Absent or locally hidden members remain saved and counted without promising they
  will return. Account-generation retirement suppresses stale publication, and reactivity covers folder membership
  plus every inbox dependency, including attachment-only preview changes.

  Under pinned Node **24.19.0**, strict TypeScript passes. The focused DB-write scanner suite passes **97 cases**
  (**86 passed / 11 intentionally skipped / 0 failed**). The final inventory guard passes **1,656 approved mutations**
  with **0 structural or membership errors** after reconciling **24 line shifts / 0 rekeys / 2 reviewed additions**;
  final dry reconciliation reports **0 line shifts / 0 rekeys / 0 additions**. Exact-file formatting and diff checks
  pass, and three independent DB-safety, lifecycle/UX, and production/routes reviews are **GO** after transaction-edge,
  unavailable-copy, error-recovery, and attachment-reactivity findings were corrected. No component or broad Jest,
  architecture, migration, build, emulator, device, Play, EAS, or server gate was run. Folder-scoped search, unread
  aggregation/policy, backup/restore integration, and exact Android interaction remain open, so parent `FEAT-04`
  remains **IN_PROGRESS**. This is post-v56/post-v57 source work, changes no frozen candidate, and performs no external
  write.

- **2026-08-29 — `FEAT-04D` adds bounded folder-scoped conversation identity search:** Each folder browser now has an
  Android-inset-safe search field for currently available conversation titles and participant lists, with visible copy
  that message text is excluded. Input is NFC-normalized, bounded to 128 code points, inactive below two characters,
  and settled after 250 ms. Inside the existing serialized folder transaction, a lightweight projection scans at most
  the 5,000-member safety bound and applies the same rendered-title/participant comparison with symmetric Unicode
  normalization before selecting the 50-row growing prefix. Exact matching/available counts, manual-pin/newest order,
  and `hasMore` therefore come from the complete matching identity set rather than the first loaded page. A failed
  continuation retains the successful prefix; retry preserves its query and requested depth. Request-keyed errors and
  folder-keyed drafts cannot leak across a new search, folder, or account generation.

  Under pinned Node **24.19.0**, strict TypeScript passes. The final DB-write inventory report passes **1,656 approved
  mutations** with **0 structural or membership errors** after manually adjudicating the existing folder-read
  callback's **2** expected fingerprint changes and mechanically reconciling **20** one-line location shifts; final dry
  reconciliation reports **0 line shifts / 0 rekeys / 0 additions**. Exact-file formatting and diff checks pass, and
  three independent DB/search, lifecycle/pagination, and product-scope reviews are **GO** after Unicode case-folding/
  normalization, visible-scope, hidden-identity, stale-error, and non-destructive-retry findings were corrected. No
  Jest, component, architecture, migration, build, emulator, device, Play, EAS, or server gate was run. Message-content
  search, unread aggregation/policy, backup/restore integration, and exact Android interaction remain open, so parent
  `FEAT-04` remains **IN_PROGRESS**. This is post-v56/post-v57 source work, changes no frozen candidate, and performs no
  external write.

- **2026-08-29 — `FEAT-04E` adds exact folder unread-conversation badges and a per-folder visibility preference:**
  Migration `0044_custom_folder_unread_badge` persists the original app's default-on, presentation-only preference;
  changing it never changes a message read marker. One shared SQL predicate now owns both existing inbox unread
  filtering/counting and folder aggregation, including the last-read and local-deletion floors. A folder counts each
  available unread conversation once, includes archived and muted members, excludes absent/still-hidden members, and
  remains independent of folder search. A materialized distinct-member CTE evaluates unread state once per unique
  saved chat and reuses it across overlapping folders; non-manager routes retain the lightweight list reader. The
  focused manager reacts to folder/member/chat/message writes, retains its last successful rows across retryable
  failures, coordinates reorder recovery, shows `99+` visually, and exposes the exact count through the containing
  row's TalkBack label. Manage Folder can hide the badge with optimistic, account/route-owned rollback behavior.

  Strict TypeScript passes. Exact-file formatting and diff checks pass. The DB inventory passes **1,668 approved
  mutations** with **0 structural or membership errors** after mechanically reconciling **49 line shifts / 0 rekeys**
  and manually adjudicating **12 additions**; final dry reconciliation reports **0 line shifts / 0 rekeys / 0
  additions**. Three independent DB/performance, lifecycle/accessibility, and product/parity reviews are **GO** after
  migration-head wiring, repeated unread probes, badge-only Back copy, and the Manage TalkBack label were corrected.
  Per the owner's coding-first/no-test instruction, no Jest, component, architecture, migration, full DB-scanner,
  build, emulator, device, Play, EAS, or server gate was run. The focused `0044` upgrade test and test-only `43/0043`
  expectations in the DB driver/relaunch/scanner suites are explicitly deferred to the final test phase; therefore no
  migration execution evidence is claimed yet. Message-content search, folder backup/restore integration, and exact
  Android interaction remain open, so parent `FEAT-04` remains **IN_PROGRESS**. This is post-v56/post-v57 source work,
  changes no frozen candidate, and performs no external write.

- **2026-08-29 — `FEAT-04F` adds bounded portable custom-folder backup and non-destructive restore:** New encrypted
  exports use backup v3. A deduplicated portable identity registry lets overlapping folders reference the same
  service/kind/stable-identifier/participant evidence without copying raw server-specific GUIDs or repeating handles
  throughout the file. Ordered folder rows carry normalized names, the unread-badge preference, complete source
  membership counts, and bounded identity indexes. Temporarily absent or otherwise unportable members are omitted
  from identity data but remain visible in the skipped count. V1/v2 imports keep their original behavior and do not
  touch folders. The unused production plaintext-share function is removed; local files and server slots both receive
  only passphrase-encrypted ciphertext, and privacy copy discloses that portable identity can contain phone numbers or
  email addresses.

  Restore resolves folder members through the same conservative `BACKUP-01` matcher as chat customizations. Multiple
  source identities targeting one local chat, ambiguous/no-match identities, invalid target GUIDs, capacity overflow,
  and unavailable-at-export members are skipped and counted rather than guessed. Existing exact-name folders retain
  their position, receive the saved badge preference, and union matched members without pruning any local row. New
  folders append in file order and existing local folders/members win the 100-folder/5,000-member capacity. Settings,
  themes, chat customizations, folder metadata, and memberships share one guarded rollback-capable transaction; fixed
  temporary mapping tables avoid a JavaScript row loop under the writer lock and are removed on every terminal path.

  Strict TypeScript, exact-file formatting, and diff checks pass. The DB inventory passes **1,683 approved mutations**
  after one manually reviewed chat-update expression change, **19** mechanical line shifts, and **15** reviewed
  coordinated additions; final dry reconciliation reports **0 line shifts / 0 rekeys / 0 additions**. Three independent
  SQL/ownership, contract/privacy, and production-integration reviews are **GO** after duplicate-target ambiguity,
  aggregate-count inflation, invalid target-GUID counting, and merge/order disclosure findings were corrected. Per the
  owner's coding-first instruction, no Jest, component, migration, architecture, build, emulator, device, Play, EAS,
  or server gate was run; v3 SQL execution, schema boundary cases, encrypted round trips, and the removed plaintext
  export fixture are explicitly deferred to the consolidated test phase. Message-content search and physical Android
  interaction remain open, so parent `FEAT-04` remains **IN_PROGRESS**. This is post-v56/post-v57 source work, changes
  no frozen candidate, and performs no external write.

- **2026-08-29 — `FEAT-04G` adds folder-local message-content filtering without a server request:** The existing
  two-character, 128-code-point, 250 ms settled folder search now includes eligible message bodies from the encrypted
  local FTS index alongside conversation titles and participants. Folder membership is applied inside SQL before
  `DISTINCT` and the 5,001-row corruption probe, so unrelated global hits cannot consume the result cap. The query
  reuses the global/in-chat exclusions for reaction and sticker overlays, retracted messages, locally deleted messages,
  and hidden chats. Matching remains conversation-level: one tile appears once in the existing pinned/newest order,
  with exact complete-folder counts and the established growing-prefix, retry, account-generation, folder, and query
  fences. It does not add snippets, per-message counts, hit focusing, subject/attachment/OCR search, or server-assisted
  history search. Both folder screens now describe that local-only scope truthfully.

  Strict TypeScript passes. Exact source-file formatting and whole-diff checks pass. The DB-write inventory remains at **1,683
  approved mutations** with **0 structural or membership errors**. Three independent SQL/search, lifecycle/pagination,
  and product/privacy reviews are **GO** after the initial large-GUID restriction and stale manager copy were corrected.
  Per the owner's coding-first instruction, no Jest, component, migration, architecture, build, emulator, device, Play,
  EAS, or server gate was run. Focused folder-content query/UI coverage and physical Android interaction remain deferred,
  so parent `FEAT-04` remains **IN_PROGRESS**. This is post-v56/post-v57 source work, changes no frozen candidate, and
  performs no external write.

- **2026-08-30 — `FEAT-04` gains retained-state and reorder-handoff regression coverage:** Two focused component
  suites now prove that a same-account folder-summary refresh keeps the last successful rows and error visible until
  one committed result replaces them atomically, that retained rows never cross an account-generation boundary, and
  that a successful optimistic reorder remains visible until a new authoritative row array arrives. The focused run
  passes **2/2 suites / 3/3 tests**, and the pinned full functional gate including them passes **444/444 suites /
  5,025/5,025 tests**. No production code changed. Broader folder-content query coverage and physical Android
  interaction remain open, so parent `FEAT-04` stays **IN_PROGRESS**.

- **2026-09-03 — `FEAT-04` host-side query, reactivity, and backup-v3 coverage closes:** Real-SQL folder-inbox tests
  now cover durable/available counts, visibility exclusions, pinned/newest paging, title/participant/message unions,
  Unicode-equivalent input, the exact 128-code-point boundary, and membership before the 5,001-row FTS cap. A focused
  hook regression proves that a late obsolete 50-row request cannot replace a successful 100-row prefix. Backup-v3
  coverage proves one coordinated snapshot across settings/themes/chat customizations/folders, rejection of a
  neighbor's rolled-back values, one-generation consistency, encrypted portable round trips, shared-identity
  deduplication, complete source counts for absent or oversized members, omission of over-512-participant identities,
  non-destructive merge/order/idempotence, unread preference restore, conservative skip counts, existing-data priority
  at the 100-folder/5,000-member limits, v1/v2 no-op behavior, schema limits, rollback, temporary cleanup, and removal
  of the plaintext export API. The focused evidence is green at **4/4** real-SQL search tests, **12/12** related hook
  tests, and **4/4 suites / 89/89** related backup tests; strict TypeScript, lint, formatting, diff checks, the database
  write guard (**86 pass / 11 intentional skips**), and dry inventory reconciliation (**0 shifts / 0 rekeys / 0
  additions**) also pass. No material host-side gap remains. Physical Android reorder/delete and restore-presentation
  evidence remain open, so parent `FEAT-04` stays **IN_PROGRESS**.

- **2026-09-03 — `FEAT-04F` follow-up bounds the production-v3 base snapshot and corrects the broader closure claim:**
  Commit `4de894a` replaces uncapped base reads under the shared transaction with allowlisted/max-plus-one probes and
  bounded final reads. It rejects oversized allowed settings while ignoring oversized disallowed draft rows, caps
  custom themes, customized chats, participant links, field sizes, and aggregate raw bytes, and accounts for escaped
  participant JSON before SQL materializes it. Participant identity still collapses null and empty services and keeps
  first-seen order. Additive migration `0045_backup_export_indexes` lets the theme/chat probes and final reads stop in
  stable id order without scanning unrelated rows or using a temporary sort. Current migration-count/head certificates
  advance to 45/`0045_backup_export_indexes`; historical 29 and 37/0038 boundaries remain unchanged.

  The exact combined backup/migration/head boundary passes **10 suites / 103 tests**; all eight backup suites pass
  **129/129**. Strict TypeScript, zero-warning focused lint, exact-file formatting, diff checks, architecture **46/46**,
  the 45-migration sequential guard plus **5/5** migration-guard tests, and DB inventory reconciliation at **1,695
  approved mutations / 0 errors / 0 shifts / 0 rekeys / 0 additions** pass. The fast DB scanner passes **86** with
  **11 intentional skips**; its full adversarial mode passes **97/97** with no skips in about 31 minutes 44 seconds.
  The full functional gate passes **453 suites / 5,165 tests**, with one intentional skipped suite/test. Independent
  high-risk review is **GO**.

  The earlier statement that no material host-side backup-v3 gap remained was too broad. The custom-folder selector can
  still perform window work before its outer membership limit and build substantial identity JSON before final
  serialization rejects an oversized document. The exported legacy-v2 `buildBackup` helper is also unbounded, although
  production export uses v3. Host tests do not prove migration/index behavior or transaction liveness on Android
  op-sqlite. Those residuals and exact-device interaction remain open, so parent `FEAT-04` stays **IN_PROGRESS**. No
  build, emulator, device, Play, EAS, server, or remote-branch action occurred in this follow-up.

- **2026-09-03 — `FEAT-04` closes the audited folder-browser presentation gap without overstating device proof:**
  Commit `dd8331d` replaces the Android-native 128-UTF-16-unit search ceiling with a conservative 256-unit ceiling,
  allowing 128 supplementary-plane characters to reach the existing exact 128-code-point JavaScript clamp while still
  bounding large native/bridge input. The new direct screen suite proves that 129 synthetic emoji are clipped to 128,
  the settled query is absent at 249 ms and exact at 250 ms, decomposed input is NFC-normalized and trimmed, a
  one-character query clears immediately, row navigation uses the encoded chat route, long-press and paging are wired,
  and account-generation retirement removes the folder title, row, private GUID, and an already-open action target
  without a manual rerender. Mocked input and list components do not prove the Android IME, layout,
  TalkBack speech/focus, or op-sqlite behavior.

  The exact suite passes **1/1 suite / 3/3 tests** and records **92.95% statements / 64.83% branches / 87.5% functions /
  92.18% lines** for `FolderConversationListScreen.tsx`. Strict TypeScript, zero-warning exact-file ESLint, Prettier,
  diff checks, and the DB inventory at **1,695 mutations / 0 structural or membership errors** pass in a clean
  committed-HEAD-plus-two-file snapshot because an unrelated backup refactor was concurrently incomplete in the shared
  worktree. Independent review is **GO** after retaining the bounded native paste ceiling and extending retirement proof
  to the open action sheet. No broad Jest, architecture, migration, build, server, device, Play, EAS, or remote-branch
  action ran. The custom-folder export pre-cap/identity-JSON and legacy-v2 helper residuals plus physical Android proof
  remain open, so parent `FEAT-04` stays **IN_PROGRESS**.

- **2026-08-30 — owner removes fresh camera-video capture from `FEAT-05`:** `CAM-1` is **NOT_PLANNED**. The composer
  Camera action remains photo-only, and no Video capture tile, long-press action, duration policy, or native capture
  recovery owner will be added. This decision does not remove or weaken existing gallery-video selection, staged
  previews, streaming upload/progress/cancellation/retry, received-video rendering, or playback. No production code,
  dependency, native configuration, server contract, test, build, device, Play, or external state changed.

- **2026-08-30 — exact `0.1.42` / version-code-58 local candidate is frozen and promoted:** Source
  `fd02247578e928d909f0ce73c083c3cbcedffb4c` passed the clean release gate and produced release commit
  `7942ed5bfbdce28ecadfefc54e7bd7cdde2e57d8` plus ignored arm64-v8a AAB
  `gator-release-0.1.42-v58-7942ed5.aab` (55,969,473 bytes), SHA-256
  `ad7538bc3436eea017690801efdaa307a22a0565229c94006f7aacc278270298`. The EAS-backed build was local; validation and
  local promotion passed, and submission remains `not_started`. A Git 2.55 missing-ref exit-code mismatch interrupted
  the first promotion attempt without changing the artifact; the preserved unknown receipt, exact-ref recovery, and
  original rerun ended promoted. The runner now uses a quiet commit-ref probe covered by a disposable-Git regression
  test. No hosted build, Play upload/submission, server/device action, or remote release-branch push occurred.

- **2026-09-01 — `FEAT-07A` adds the bounded Shared Documents explorer:** The conversation-details Documents row is
  now an accessible action with an exact or `50+` bounded count. Its dedicated route loads all eligible locally
  indexed documents in stable 50-row prefixes, retains a successful prefix across a failed continuation, and exposes
  explicit loading, empty, retry, download, open, and cache-refusal states. The query excludes images, videos,
  stickers, plugin payloads, deleted/retracted messages, hidden chats, and pre-chat-tombstone history; a revived chat
  shows only non-null-dated messages newer than its deletion floor. Account-generation retirement removes private
  rows, late-request key/sequence fences prevent a stale 50-row read from replacing a newer 100-row result, and each
  visible local path is pinned against attachment-cache retirement until its row unmounts.

  Under pinned Node **24.19.0**, strict TypeScript, touched-source lint, formatting, and diff checks pass. Focused UI/
  hook coverage passes **5 suites / 89 tests**, and the focused repository suite passes **1 suite / 6 tests**. The
  final full functional gate passes **447 suites / 5,062 tests**, with **1** intentional skipped suite/test and zero
  failures. Architecture passes **46/46** checks; migrations pass the **44-migration** sequential guard at
  `0044_custom_folder_unread_badge` plus **5/5** mutation tests. The fast DB-write scanner passes **97 cases** (**86
  passed / 11 intentionally skipped / 0 failed**), final reconciliation reports **0 line shifts / 0 rekeys / 0
  additions**, and the inventory reports **1,687 mutations / 0 structural or membership errors**. Independent review
  found and drove fixes for cache-path pinning, late pagination publication, and the chat-deletion visibility floor,
  then reported no remaining code blocker. No build, emulator, physical-device, Play, EAS, or server gate was run.
  At this `FEAT-07A` freeze, `FEAT-07B`, `FEAT-07C`, and the Android
  external-open/large-file/malformed-file/TalkBack matrix remained open; parent `FEAT-07` was **IN_PROGRESS**, and no
  release-candidate evidence was claimed.

- **2026-09-01 — `FEAT-07B` makes fullscreen media actions download-aware and replacement-safe:** Remote image/video
  attachments now expose Download, Retry, and progress before secondary actions; Share and Save can perform the
  prerequisite download and then continue. Native media-load errors enter an account-fenced copy-on-write redownload
  path. Exact old-path comparison-and-swap, destination ownership, late-result fences, and continuous cache protection
  prevent stale downloads, incompatible owners, or attachment retirement from publishing the wrong path.

  Under exact Node **24.19.0** and npm **11.17.0** in an isolated snapshot, strict TypeScript passes, the focused Node
  matrix passes **3 suites / 94 tests**, and the focused component matrix passes **3 suites / 81 tests** with only the
  existing VirtualizedList `act(...)` warnings. The pinned full Node run records **315 passing suites / 3,613 passing
  tests** with **1** intentional skipped suite/test; its only remaining suite failed because the temporary snapshot
  deliberately excluded `.git`, then passed **1 suite / 3 tests** when given read-only access to repository history.
  The current working tree's complete functional gate also passes
  **447 suites / 5,098 tests**, with **1** intentional skipped suite/test and zero failures. Architecture passes
  **46/46** checks; migrations pass the **44-migration** sequential guard at `0044_custom_folder_unread_badge` plus
  **5/5** mutation tests. The full DB-write scanner passes **97/97** adversarial checks; the fast scanner passes **97
  cases** (**86 passed / 11 intentionally skipped / 0 failed**), exact reconciliation reports **0 line shifts / 0
  rekeys / 0 additions**, and the inventory reports **1,693 mutations / 0 structural or membership errors**. The
  Android debug shell builds successfully in **12s** (**750** tasks: **44** executed / **706** up to date). Independent
  review reported no remaining `FEAT-07B` code blocker.

  A rare ordinary-RCS manual-versus-automatic collision with different byte/time limits remains recorded as later
  hardening; fullscreen replacement uses one fixed manual limit and is covered by the completed ownership matrix.
  `FEAT-07C` and exact-candidate gallery/video/share/Photos/TalkBack evidence remain open, so parent `FEAT-07` remains
  **IN_PROGRESS**. No Play, EAS, server, or release-candidate evidence is claimed.

- **2026-09-02 — `FEAT-07B` gains supporting physical-device download, restart, Share, and Save evidence:** Initial
  DEV execution exposed two native/dev-client blockers rather than a media-viewer state defect: the synthetic Picsum
  seed URL redirected while the bounded native transport correctly rejects redirects, and Samsung exposed the app
  sandbox through an OS-managed ancestor alias that the attachment and synced-background cache policies mistook for
  a cache-root symlink. The DEV fetcher now uses the direct immutable CDN object, the DEV session runs attachment-cache
  recovery before publishing the inbox, and repeat fixture seeding preserves a recovered local attachment path.
  Native ownership now canonicalizes only the trusted native root's parent, rebuilds the fixed root component, and
  proves each raw descendant maps exactly beneath it. Root, intermediate, and final symlinks; traversal; sibling-prefix
  paths; and malformed layouts remain rejected, while raw Expo/DB/scanner path identity remains unchanged.

  Independent native review is **GO**. The bounded-download policy/scanner unit task passes **35/35 tests**, the new
  DEV-session suite passes **2/2 tests**, the existing DEV seed suites pass **2 suites / 11 tests**, strict TypeScript
  passes, formatting/diff checks pass, and the full functional gate passes **448 suites / 5,110 tests** with **1**
  intentional skipped suite/test and only the existing VirtualizedList `act(...)` warnings. Architecture passes
  **46/46** checks; migrations pass the **44-migration** guard plus **5/5** mutation tests. The fast DB scanner passes
  **97 cases** (**86 passed / 11 intentionally skipped / 0 failed**), the inventory reports **1,692 approved
  mutations**, and exact reconciliation is **0 line shifts / 0 rekeys / 0 additions**. A clean debug rebuild succeeds
  in **3m 1s** (**750 tasks: 677 executed / 73 up to date**) after quarantining one stale generated CMake cache. On a
  physical Samsung device, the in-place debug
  reinstall preserved the 186,575-byte synthetic app-private file; fresh DEV startup recovered it without either
  former canonical-root error, repeat seeding retained it, and fullscreen media immediately rendered `1 of 3` with
  Share and Save enabled. Share foregrounded Android's chooser without inspecting its suggestions. Save created one
  exact 186,575-byte `DCIM/media-keynote.jpg` row without a permission prompt; that synthetic external copy alone was
  deleted after proof, while the app-private source remains.

  This is **`LOCAL-DEV SUPPORTING ONLY`** from debug app version `0.1.41`; it is not staged-server or exact Play-candidate
  evidence and closes no release checkbox. `FEAT-07C`, video playback, TalkBack, staged-server, and exact-candidate
  gallery/share/Photos evidence remain open, so parent `FEAT-07` stays **IN_PROGRESS**. The later DEV-only fetcher
  scoping hardening is completed below; release builds cannot enter that fixture path.

- **2026-09-03 — `FEAT-07B` scopes its synthetic attachment fetcher to the exact DEV fixture session:** Registering
  the public-image progress fetcher no longer changes the process-wide transport choice. Each download or redownload
  selects the synthetic fetcher only while the exact DEV origin/password session is connected; failed fixture starts,
  disconnects, real-server debug sessions, and every release session use the production server fetcher. The selected
  object now remains consistent across cache capability checks, native transfer, replacement, and bounded RCS retries.
  The regression failed against the old behavior by receiving the fixture path outside the DEV session, then passes a
  false→true→false session matrix. The full ownership suite passes **31/31**, the existing DEV session/seed suites
  pass **3/3 suites / 13/13**, strict TypeScript, lint, formatting/diff checks, and architecture **46/46** pass, and
  independent review is **GO**. Exact-candidate media and TalkBack evidence remain open, so parent `FEAT-07` stays
  **IN_PROGRESS**.

- **2026-09-02 — `FEAT-07C` PDF architecture decision is complete; external Android viewing remains the product
  boundary:** Gator will not embed a PDF renderer, WebView/PDF.js bridge, or remote document-conversion service. An
  explicit user tap retains the existing bounded manual download, non-exported FileProvider `content://` handoff with
  temporary read-only URI permission, Android `ACTION_VIEW`, share-sheet fallback, and visible no-handler/error paths.
  This keeps attacker-controlled PDF parsing and its native dependency, licensing, package-size, and maintenance
  surface outside Gator, while acknowledging that the selected viewer or chosen share target can read, copy, cache, or
  upload the plaintext document and is no longer governed by Gator's App Lock, Secure Screen, or accessibility
  implementation.

  Cached bytes can be handed off without Gator network access, but offline behavior depends on the installed viewer;
  share is not an offline-viewing guarantee. Manual downloads remain bounded to 512 MiB and 15 minutes. The external
  viewer owns memory/rendering, malformed-file rejection, encrypted/password UI, and document-reading accessibility;
  Gator cannot reliably observe a parse failure after the viewer accepts the intent. Under pinned Node **24.19.0**,
  the focused external-open, share, document-row, attachment-dispatch, and attachment-view matrix passes **5 suites /
  78 tests**. Three independent reviews returned **GO** for decision-only closure and **NO-GO** for parent or device
  closure. Exact-candidate offline, natural no-viewer, cache-loss, large/encrypted/malformed, FileProvider,
  dynamic-font, and TalkBack evidence remains open in the existing device checklist; parent `FEAT-07` stays
  **IN_PROGRESS**. No production code, dependency, native configuration, build, device, Play, server, or external
  state changed.

- **2026-09-02 — In-chat document chips expose their action and transfer state to Android accessibility:** The
  generic `FileChip` is now one explicit button node named `Download`, `Retry`, `Downloading`, `Open`, or `Uploading`
  plus the attachment filename. It exposes the existing external-app hint and a busy state during transfer. The change
  does not disable the chip, alter press dispatch, add a dependency, or change download/open ownership. Existing
  download and open tests now activate the role instead of relying on descendant text, with a focused state matrix for
  the new names.

  Under pinned Node **24.19.0**, the focused chip suite passes **1/1 suite / 25/25 tests**. The full Jest gate passes
  **448/449 suites / 5,115/5,116 tests / 0 snapshots**, with one configured suite/test skipped. TypeScript, focused
  zero-warning ESLint, Prettier, `git diff --check`, and the architecture and migration guards pass. The shared DB-write
  guard passes **1,692 approved mutations** after its mechanical inventory update of **8 line shifts / 0 rekeys / 0
  additions**, and a subsequent reconcile reports zero drift. The Android debug APK builds successfully.

  A local API-35 arm64 emulator then exposed three native accessibility states for the synthetic `Q3-Report.pdf`
  fixture: `Download`, `Downloading, busy`, and `Retry`. Its synthetic download could not reach `Open` because emulator
  DNS resolution failed, so this run proves no PDF render, FileProvider grant, viewer/share handoff, offline reuse, or
  missing-file recovery. The emulator TalkBack service repeatedly opened its own notification-permission prompt, so no
  spoken announcement/focus result is claimed; its service, touch-exploration, font, and permission baseline was
  restored.

  The same source, local `master` at `e4e364f`, was then delivered through Metro to the existing `0.1.41` debug app on a
  Samsung SM-S938U1 running Android 16/API 36, without a data wipe. For the synthetic `Q3-Report.pdf`, the native
  accessibility tree exposed one `Download Q3-Report.pdf` button before transfer and one `Open Q3-Report.pdf` button
  after completion. The transfer finished too quickly to capture `Downloading, busy`; that state is unobserved on this
  phone, not failed. Activating Open foregrounded Android's system resolver (`ResolverActivity`); Back returned to Gator
  with the chip still Open. No resolver target was selected or inspected.

  The fixture has PDF metadata and a `.pdf` name, but the DEV fetcher stores JPEG bytes. This proves only the physical
  Download-to-Open accessibility-node transition and a non-silent system-resolver round trip. It does not prove valid-PDF
  rendering, third-party viewer/share-target behavior, exact FileProvider URI/grant consumption, offline cached reopen or
  request reuse, cache-loss recovery, large/encrypted/malformed-file handling, or the natural no-handler branch. A
  physical TalkBack attempt earned no reliable chip focus, speech/hint, or double-tap result. The pre-existing
  accessibility service remained enabled, TalkBack and touch exploration were turned back off, font scale remained
  `0.8`, and TalkBack's phone-state permission was explicitly denied afterward.

  This is **LOCAL-DEV SUPPORTING ONLY**: `FEAT-07C` stays done as the product decision, while parent `FEAT-07`,
  `A11Y-01`, `A11Y-03`, exact-candidate PDF/TalkBack work, and every release/device checkbox remain open.

- **2026-09-27 — `FEAT-07` gains additional supporting Samsung document/media evidence:** On an Android 16/API-36
  Samsung SM-S938U1 running debug `0.1.51-debug`, the synthetic `Q3-Report.pdf` moved from Download to Open and twice
  foregrounded Android's `ResolverActivity`. The second handoff still worked after the Metro `tcp:8081` reverse was
  removed, supporting reuse of the cached app-private file without a packager connection. No resolver suggestion was
  selected or inspected. Because the DEV fetcher stores JPEG bytes beneath the PDF name, this does not prove PDF
  parsing, viewer consumption of the FileProvider grant, or full network-off behavior.

  The synthetic image gallery opened at `3 of 3`, paged to `2 of 3`, and handed the current item to Android's outbound
  chooser. Save displayed `Saved to Photos` and created one complete, no-prompt
  `DCIM/media-huge.jpg` MediaStore row of **186,575 bytes** owned by the debug package. After a debug-only data reset,
  the same fixture began at `Download media` with no matching external row; one Save tap completed the prerequisite
  download and produced the same complete external copy. Each synthetic export was deleted by its exact verified
  MediaStore item URI afterward; no personal chooser suggestions or unrelated media rows were inspected.

  This remains **LOCAL-DEV SUPPORTING ONLY** and closes no release checkbox. The fixture cannot prove valid video:
  its remote MP4 path is not app-owned, while the DEV downloader would store JPEG bytes under an `.mp4` name. Parent
  `FEAT-07` therefore stays **IN_PROGRESS** for current exact-Play-candidate plus isolated staged-server evidence with
  valid PDF/VCF bytes, a real downloaded MP4 in both inline and fullscreen controls, Shared Documents pagination
  beyond 50 rows, and actual-byte large/encrypted/malformed documents. Natural no-handler and native failure branches
  remain conditional and must not be forced on a personal device.

- **2026-09-02 — `FEAT-05B` adds privacy-safe Android message grouping, then closes a native child-loss defect:**
  Current, owned ordinary message notices share one fixed Android group. Two distinct valid chats first create one
  generic, child-only-alert summary with the count-neutral body `New messages`; its host-proved route opens the inbox
  without carrying a chat/message identifier or opening the encrypted DB. Locked/status, reminder, FaceTime,
  failed-send, RCS, test, alias, foreign, duplicate, malformed, and pre-feature ungrouped notices remain excluded from
  valid-child counting. Existing detailed children are never rewritten from native snapshots. Posting, withdrawal,
  action/read cancellation, native child press/swipe, startup inspection, and successful warm unlock reconcile through
  the existing serialized, account-owned native-operation boundary. Unknown or effective App Lock state performs no
  grouping inspection or mutation.

  Physical verification contradicted the first host-green implementation: cancelling the summary during a 2→1 child
  transition made Android cancel the surviving grouped child too. The stateful test tray had modeled cancellation as a
  one-record map delete and therefore hid the platform side effect. The corrected state machine creates no summary for
  a first lone child, retains and repairs the fixed summary as a silent scaffold after a multi-chat group shrinks to one,
  and cancels it only after successful native enumeration proves no raw grouped child remains. A raw same-group member
  rejected by strict parsing blocks destructive cancellation while an existing stale/private summary is repaired in
  place. A malformed `MESSAGING` style without an array of messages now fails closed instead of throwing and wedging
  durable retry. Enumeration failure performs no group mutation. The test tray now models Android's cascade semantics,
  and no reconciliation path rebuilds a child from a cached native snapshot.

  Under pinned Node **24.19.0**, strict TypeScript, zero-warning touched-file ESLint, Prettier, and `git diff --check`
  pass. Focused verification passes **7 suites / 197 tests** (**6 / 188** Node and **1 / 9** component), including
  **85/85** notification-service tests. The full Jest gate passes **448/449 suites / 5,131/5,132 tests**, with **1**
  configured suite/test skipped and only the existing `VirtualizedList` `act(...)` warning. Architecture passes
  **46/46** checks. Migrations pass the **44-migration** sequential guard at `0044_custom_folder_unread_badge` plus
  **5/5** mutation tests. The fast DB scanner passes **97 cases** (**86 passed / 11 intentionally skipped / 0 failed**);
  its inventory reports **1,692 approved mutations / 0 structural or membership errors** after the mechanical update
  of **21 line shifts / 0 rekeys / 0 additions**, and final reconciliation reports zero drift. The documentation guard
  passes **3/3** tests and validates **114** primary tasks. Independent review is **GO** with no remaining host
  correctness, privacy, lifecycle, account-ownership, queue-deadlock, malformed-member, or scanner blocker.

  On a physical Samsung local DEV build running Android 16/API 36, native inspection showed exactly two detailed
  children plus the fixed generic summary. The summary used `New messages`, the child-only-alert and summary flags, and
  only the app owner/schema/kind data markers. Pressing one child opened the correct chat and left the other child plus
  the silent summary; Samsung displayed that one-child tail as an ordinary standalone notification. Swiping the final
  child left zero Gator records. Targeted process death and relaunch retained the group, the DEV durable-ingress crash
  lease recovered its queued child, connected startup neither duplicated nor removed records, and inbox reads
  reconciled 2→1→0. DND remained enabled. No Accessibility, permission, or other device setting was changed, and only
  synthetic Gator notices were removed.

  This is **LOCAL-DEV SUPPORTING ONLY**. Samsung renders the summary as a non-actionable group header whose tap only
  expands/collapses, so the host-proved summary route and inbox Back-stack remain unproved physically. DND prevented
  sound, vibration, heads-up, and exact alert-count proof. Clear All, live server withdrawal and background/killed FCM
  delivery, killed App Lock, account teardown, and the exact Play/release candidate also remain unproved. `FEAT-05B` is
  therefore **POST-v57 HOST COMPLETE / LOCAL-DEV ANDROID PARTIAL / RELEASE MATRIX OPEN**; `FEAT-05A` and `FEAT-05C`
  remain **TODO**, and parent `FEAT-05` remains **IN_PROGRESS**.

- **2026-09-03 — `SHARE-01` retires legacy user-pinned Direct Share metadata before account replacement:** Commit
  `9d97eab` expands root cleanup from dynamic/cached removal to a fail-closed inventory of dynamic, cached, and pinned
  shortcuts. Each unsafe pinned survivor is first overwritten with generic Gator labels, app icons, Person, app-only
  intent, non-Direct-Share category, locus, and retirement marker, then disabled; removable rows are cleared and a
  second inventory rejects stale state. A pinned shortcut ID itself may remain until the user removes it, so the task
  stays **IN_PROGRESS** for an exact production-signed candidate and a no-data-wipe natural-upgrade launcher/`dumpsys`
  test.

  Verification passes native Kotlin compile and **8/8** unit tests, four focused Jest suites / **109/109** tests,
  strict TypeScript, zero-warning focused ESLint, Prettier and diff checks, and architecture **46/46**. Independent
  review is **GO**. Commit `06e4291` adds a fail-closed packaged-DEX contract; all **11/11** mutation tests pass, the
  August 30 AAB is correctly rejected as stale, and a fresh local smoke AAB from exact `06e4291` passes the live guard.
  That AAB is version `0.1.42` / code `1`, 79,111,565 bytes, and SHA-256
  `c2b48a5d5f4a144b9266c1ebf290fb6677d0ba9cea9a46da3d258fdb151c842e`; synthetic Firebase configuration and Android
  debug signing make it non-uploadable evidence only.

  The DB-write inventory is not claimed green in the shared dirty worktree: it reported **1,693 mutations / 30
  stale-line errors**, all in the concurrently edited `src/db/repositories/backup.ts`; none of the four `SHARE-01`
  files is a DB owner. No server, device, Play, upload, install, or live-runtime state changed for this slice.

- **2026-09-03 — `FEAT-01` closes its dedicated inbox-filter sheet component gap:** Commit `f781a28` mounts the real
  themed Modal and proves five radio groups with all **15** accessible choices, the supplied selections, draft-only
  edits across every axis, one exact Apply result, Cancel/backdrop without Apply, Reset-to-default before Apply, and
  the legacy Unknown Senders lock that displays Known while clearing only the hidden sender choice. It changes no
  production code or filter behavior.

  Under pinned Node **24.19.0** and npm **11.17.0**, the exact component suite passes **1 suite / 6 tests** with
  **100%** statements, functions, and lines and **90.47%** branches for `InboxFiltersSheet.tsx`. Strict TypeScript,
  zero-warning focused ESLint, Prettier, and diff checks pass; independent review is **GO**. No broad Jest, database,
  architecture, migration, build, server, device, Play, or EAS gate was run for this test-only slice. Parent
  `FEAT-01` remains **IN_PROGRESS** for physical Android interaction, real TalkBack behavior, persistence across
  restart, and growing-page observation.

- **2026-09-03 — `A11Y-03` closes the concealed invisible-ink host privacy gap:** Commit `f62e8fd` removes the hidden
  message subtree from iOS accessibility with `accessibilityElementsHidden` and from Android with
  `importantForAccessibility="no-hide-descendants"`. While concealed, the wrapper exposes only one button named
  **Reveal invisible ink message**; its name cannot be derived from private descendants. After reveal, wrapper
  grouping is removed and the message text and nested action subtree become accessible again. Visual reveal behavior,
  Reduce Motion handling, and animation cleanup are unchanged.

  Under pinned Node **24.19.0** and npm **11.17.0**, the exact component suite passes **1 suite / 17 tests** with
  **100%** statements, functions, and lines and **94.73%** branches for `BubbleEffectView.tsx`. The regression proves
  a private synthetic text/action label cannot be queried while concealed, then becomes discoverable and operable
  after reveal. Strict TypeScript, zero-warning focused ESLint, Prettier, and diff checks pass; independent review is
  **GO**. No broad Jest, database, architecture, migration, build, server, device, Play, or EAS gate was run. Actual
  TalkBack/VoiceOver speech and focus transfer plus the wider layout matrix remain device evidence, so `A11Y-03`
  stays **IN_PROGRESS**.

- **2026-09-03 — `FEAT-02A` closes its direct search-bar and data-hook coverage gap:** The historical three-suite,
  26-test evidence covered `searchEnriched`, `messagesBranches`, and `useMessages`; it did not directly mount
  `ChatSearchBar` or exercise `useChatSearch`. Commit `37aeb87` now proves the controlled query and clear action,
  polite live status, loading indicator, both enabled/disabled result-navigation states, three-character trimmed-query
  gate, generation-scoped cache key, exact repository cursor paging, flattened page order, and preservation of the
  initial total count. Its account-retirement regression first exposes one cached page, starts a deferred second page,
  retires generation 7, proves immediate UI concealment, and then proves the late page is rejected from the hidden
  TanStack Query cache. All fixtures are synthetic.

  Under pinned Node **24.19.0** and npm **11.17.0**, the exact two component suites pass **2/2 suites / 5/5 tests**.
  Both production units have **100% lines and functions** covered; combined coverage is **96.66% statements / 87.5%
  branches / 100% functions / 100% lines**. Strict TypeScript, zero-warning focused ESLint, Prettier, and diff checks
  pass; independent review is **GO** after the cache assertion closed an initial false-pass risk. No production code,
  broad Jest, database, architecture, migration, build, server, device, Play, or EAS gate changed or ran. The direct
  tests intentionally do not claim the screen-owned 250 ms debounce, result-index/exact-hit navigation, mounted
  composer preservation, or physical Android interaction, so `FEAT-02A` remains **IN_PROGRESS**.

- **2026-09-03 — `RECOVERY-02` hardens and directly proves the Deleted Conversations screen:** Audit found that an
  account-generation retirement disabled `useReactiveQuery` but still passed its retained old-account rows to
  `FlashList` until a passive effect cleared them. Commit `df8d19b` now removes the list at the render boundary and
  leaves only a fixed generic account-changed alert plus Back; retained confirmation callbacks stay inert, and late
  restore success cannot publish old-account feedback. The query's reactive dependency list now includes `kv`, which
  its Full Repair retired-shell exclusion actually reads. Loading has polite status text, failures are assertive fixed
  alerts that omit raw errors, and the Restore control grows from 38 to 44 points. Its text and busy spinner use
  `readableTextOn(theme.color.tint)` rather than hardcoded white; the rendered default-theme pair is regression-checked
  at or above **4.5:1** contrast.

  The new direct screen suite first failed **4 of 6** behavioral cases against the prior source, then passes **1/1
  suite / 6/6 tests**. It proves the initial 50-row query and exact semantic table set, 250-row cap, resolved rows and
  accessible controls, loading/empty/safe-error states, exact GUID/tombstone restore call, all-row busy lock, success
  count, safe failure, immediate stale-row concealment, inert retained confirmation, and suppressed in-flight result.
  `DeletedChatsScreen.tsx` records **97.95% statements / 91.17% branches / 100% functions / 100% lines**. Strict
  TypeScript, zero-warning focused ESLint, Prettier, and diff checks pass; two independent reviews are **GO** after
  the stale-data false-pass boundary and contrast defect were addressed. No broad Jest, repository/database,
  architecture, migration, build, server, device, Play, or EAS gate ran for this two-file slice.

  Mocked FlashList, reactive data, dialog, and restore service do not prove native list behavior, real TalkBack speech,
  target-only network paging, unread-floor compare-and-set, or cancellation. Direct targeted-repair orchestration and
  the Server Management/Conversation Details entry controls also remain unproved at their UI boundaries. The exact
  Android delete → new activity → restore/retract/delete, transport cancellation, and queued/in-flight account-switch
  matrix remains open, so `RECOVERY-02` stays **IN_PROGRESS**.

- **2026-09-03 — `RECOVERY-02` directly proves targeted-repair orchestration and closes the settled-promise retry
  race:** Commit `b2d2e9f` separates the raw repair `operation` from the public `result`. A matching-key cleanup now
  runs before callers observe settlement, while the downstream nonrejecting drain slot still owns invalidation-listener
  release and idle tracking. An immediate same-key retry is therefore fresh and still serializes behind the prior
  operation's drain work; an older completion cannot erase a newer coalescing entry.

  The new suite against the old source passed **4 of 6** cases and failed both immediate-retry cases because the retry
  returned the identical settled promise. The final targeted-repair suite passes **1/1 suite / 6/6 tests**; combined
  with the existing sync-tracking suite it passes **2/2 suites / 23/23 tests**. Direct proof covers validation and
  trimmed-key coalescing, exact target-chat plus 500-message requests, an untouched global marker, guarded restore
  transaction and compare-and-set arguments, visible-row fallback/fail-closed behavior, distinct-key serialization
  with an active idle barrier, generation invalidation, and immediate retries after success and failure.

  Strict TypeScript, zero-warning focused ESLint, Prettier, and diff checks pass. The DB inventory accepts **1,695**
  reviewed mutations with **0 structural or membership errors**, reconciliation reports **0 line shifts / 0 rekeys / 0
  additions**, and the fast scanner passes **86** cases with **11 intentional skips / 0 failures**. Two independent
  reviews are **GO** after the distinct-key test was hardened to keep its successor running while asserting the idle
  barrier. Verification used a clean HEAD-plus-two-file snapshot because concurrent backup work was incomplete in the
  shared tree. No broad Jest, architecture, migration, build, server, device, Play, or EAS gate ran. Server Management
  and Conversation Details entry-control proof, real transport cancellation, and the exact Android delete → new
  activity → restore/retract/delete and queued/in-flight account-switch matrix remain open, so `RECOVERY-02` stays
  **IN_PROGRESS**.

- **2026-09-03 — `RECOVERY-02` closes its host entry-control gap and fixes repair progress accessibility:** Commit
  `bfa3251` directly mounts both owning routes. Conversation Details proves confirmation before effect, the exact chat
  GUID, a disabled pending row, fixed success/failure copy without raw-error leakage, retry after failure, and
  old-account confirmation/result suppression. Server Management proves exact `/deleted-chats` navigation, a disabled
  retired-account row, an inert retained old-account callback, and working fresh-account navigation. Existing suites
  separately own the upstream Settings/Conversation Header routes, targeted service contract, and destination Deleted
  Conversations screen.

  The new progress-name assertion first failed with **84 passed / 1 failed** because the row visibly changed to
  **Repairing Conversation…** while retaining the spoken name **Repair this conversation from the server**. The
  production row now changes its accessibility name to **Repairing this conversation from the server** while disabled.
  Final focused verification passes **2/2 suites / 85/85 tests**, clean-snapshot strict TypeScript, zero-warning exact
  three-file ESLint, Prettier, and diff checks. Independent review is **GO**. No broad Jest, database, architecture,
  migration, build, server, device, Play, or EAS gate ran. Real TalkBack announcement, native router behavior, HTTP
  abort, and the exact Android delete → new activity → restore/retract/delete and queued/in-flight account-switch matrix
  remain open, so `RECOVERY-02` stays **IN_PROGRESS**.

- **2026-09-03 — `RECOVERY-02` closes its host transport-boundary abort residual:** Commit `5eee866` adds one focused
  Node suite that composes the real `startChatRepair` controller, sync engine, `httpSyncApi`, exact chat/message
  endpoints, and a real `HttpClient`, with `ky` mocked at the external transport boundary. The database opener supplies
  a real migrated in-memory repository database; unrelated native, contact, and cache composition dependencies remain
  isolated. Calling the real `pauseRealtimeDeliveries` invalidation used by Disconnect synchronously aborts the active
  request signal. The metadata case rejects as a non-retryable `ApiError('cancelled')` after one exact-chat GET and
  writes no chat. The history case first commits the exact chat, then aborts the first bounded message GET after two
  total calls and writes no message. Both owners drain through `awaitSyncIdle`.

  The new suite passes **1/1 suite / 2/2 tests**; together with the targeted orchestration and `HttpClient` cancellation
  suites, focused verification passes **3/3 suites / 27/27 tests**. Strict TypeScript, zero-warning exact-file ESLint,
  Prettier, and diff checks pass. The DB inventory accepts **1,697 mutations / 0 structural or membership errors**; the
  fast scanner passes **86 tests** with **11 intentional skips / 0 failures**; architecture and scheduled-owner checks
  pass **47/47**; and migrations pass **5/5** across **45** sequential migrations. Full Jest passes **460 suites /
  5,213 tests** with one intentional skipped suite/test. Independent review is **GO**.

  No production code, schema, native configuration, build, server, emulator, physical device, Play, EAS, or GitHub
  state changed. This host proof cannot establish actual `ky` → Expo/OkHttp socket or byte cancellation, and
  cancellation cannot undo a request the server already completed. Native routing/TalkBack and the exact Android
  delete → new activity → restore/retract/delete plus queued/in-flight account-switch matrix remain open, so
  `RECOVERY-02` remains **IN_PROGRESS**.

- **2026-09-03 — `FEAT-02A` directly proves bounded chat-screen search orchestration and fixes normalized-query
  anchor loss:** Commit `8642d07` covers the screen's exact 249/250 ms trimmed debounce, initial/loaded/paged
  older/newer result movement by both local row ID and message GUID, pending-navigation lock, late-page account
  retirement, conflicting message-action disablement, ordinary-route Composer instance preservation, and complete
  close/reopen proof for empty visible text and hook query, disabled navigation controls, and absent focus identity.

  Audit found that changing a settled query only by surrounding whitespace cleared its exact selected hit, while the
  normalized state remained unchanged and therefore could not trigger React to reapply it. The new regression first
  failed with expected message ID `901` but received no focus ID. Normalized-equivalent presentation edits now preserve
  the current hit and in-flight page. The initial-result effect also requires the visible normalized input to match its
  query and the account lease to remain current, so refreshed results from an old query cannot re-anchor during a new
  term's debounce window.

  Under pinned Node **24.19.0** and npm **11.17.0**, the route, direct search-bar, and direct data-hook suites pass **3/3
  suites / 57/57 tests**. Strict TypeScript, zero-warning focused ESLint, Prettier, and diff checks pass; independent
  review is **GO** after two false-pass assertions and the old-query refresh guard were added. No broad Jest, database,
  architecture, migration, build, server, device, Play, or EAS gate ran. The screen still re-enables its Composer when
  it requests—not when it has proven receipt of—the live newest message window, and clearing search from a route with
  an existing focus can remount the keyed Composer. Those two host gaps plus physical Android interaction remain open,
  so `FEAT-02A` stays **IN_PROGRESS**.

- **2026-09-03 — `FEAT-04F` closes the production-v3 custom-folder pre-cap and identity-JSON residual:** Commit
  `40a8a07` replaces the single folder-export query with staged bounded reads inside the existing single committed
  transaction. A 101-header probe fails before memberships; the named membership index stops the 25,001-row
  cardinality probe without a temporary sort; and only then do numeric GUID/chat/participant probes run. Raw
  chat-handle work stops at 513 links, folder metadata is returned once, and associations carry only folder/chat ids.
  Escaped participant-object bytes and fixed folder/association/identity overhead share the base snapshot's aggregate
  budget before `json_group_array`. Complete source counts and
  unavailable/oversized omission remain intact, while null/empty-service deduplication, first-seen participant order,
  folder order, and cross-folder identity reuse are preserved.

  Audit then found that `40a8a07` could still aggregate as many as 25,000 candidate identities before enforcing the
  10,000 exact-portable-identity schema cap, and could reparse one exact-invalid identity for every folder that shared
  it. An initial early-count repair was also rejected because SQLite's code-point and trimming rules can admit a
  candidate that JavaScript/Zod must omit. Commit `fd2744d` instead aggregates at most 10,001 candidates per batch,
  validates exact portability inside that batch, retains no more than 10,000, continues past invalid-only batches,
  and returns only prevalidated identities to folder assembly.

  Final focused regressions pass **2/2 suites / 31/31 tests** and prove 25,001-membership rejection before the member/
  chat join, window, or identity work, the captured production membership index plus no-temp-sort plan, shared-budget
  rejection before identity JSON, exact 10,000-identity success, a 25,000-valid-candidate rejection after one captured
  10,001-row JSON
  batch, successful omission of 10,001 SQL-bounded but JavaScript-invalid identities while retaining a later portable
  identity, one-time validation of a shared invalid identity, writer-queue release, raw-link omission, and participant/
  identity ordering. The expanded boundary covering `backup`, `backupService`, `backupV3`, `customFolderBackup`,
  `serverBackupSlots`, and `0045_backup_export_indexes` passes **6/6 suites / 103/103 tests**. Strict TypeScript,
  zero-warning focused ESLint, Prettier, and diff checks pass; architecture passes **46/46** checks; the fast DB scanner
  passes **86** tests with **11**
  intentional skips and no failures; the inventory accepts **1,695** reviewed mutations with no structural/membership
  error; and reconciliation is **0 line shifts / 0 rekeys / 0 additions**. Independent final review is **GO**. An
  earlier detached-`40a8a07` full functional run passed **459 suites / 5,197 tests** with one intentional skip, but the
  narrower final `fd2744d` evidence above—not that earlier run—is the closure proof for the audited identity gap.

  The production-v3 folder residual recorded by the earlier audits is closed. At this checkpoint, legacy-v2 export
  bounding and physical Android/op-sqlite migration/index/transaction/native-crypto liveness evidence remained open;
  the following entry supersedes the legacy-v2 part. No build, emulator, physical-device, Play, EAS, or server gate
  ran.

- **2026-09-03 — `BACKUP-02` closes the legacy-v2 export-reader residual:** Commit `5d1038c` replaces the helper's
  three unbounded, independently timed reads with the same bounded base reader used by production v3, wrapped in its
  own committed database snapshot. The reader selects only allowlisted settings, rejects max-plus-one collections,
  caps every field and participant list, accounts for aggregate base bytes before final materialization, and releases
  the database writer after rejection. `BackupV2Schema` remains the exact JavaScript boundary after SQLite's coarse
  code-point/byte probes. The helper deliberately does not read custom folders, so invalid or oversized v3-only folder
  data cannot break a v2 export. Final serialized plaintext bytes remain enforced by `serializeBackup`/sealing.

  The focused v2 suite passes **1/1 suite / 51/51 tests**, including max-plus-one rejection plus writer release,
  independence from 101 custom folders, and the SQLite-code-point/JavaScript-UTF-16 edge. The expanded `backup`,
  `backupService`, `backupV3`, `customFolderBackup`, `serverBackupSlots`, and `0045_backup_export_indexes` boundary
  passes **6/6 suites / 106/106 tests**. On an exact clean `5d1038c` snapshot, strict TypeScript, architecture **46/46**,
  the **1,697-record** approved database inventory, and dry reconciliation with **0 shifts / 0 rekeys / 0 additions**
  pass. Zero-warning focused ESLint, Prettier, diff checks, and the fast DB scanner (**86 pass / 11 intentional skips /
  0 failures**) also pass. Two independent reviews are **GO** and found no additional v2 regression essential.

  No host-side v2/v3 export-reader residual remains. Exact Android op-sqlite migration/index/transaction liveness,
  synchronous native-crypto liveness, and physical old/new backup round trips remain open, so `BACKUP-02..03` and
  parent `FEAT-04` stay **IN_PROGRESS**. No build, emulator, physical device, Play, EAS, GitHub, or server action ran.

- **2026-09-03 — `WEB-01` closes by enforced removal of its vulnerable execution path:** The generated Find My
  HTML and embedded WebView were already removed in favor of a fixed privacy-disabled placeholder. The architecture
  gate now scans the root JavaScript entry plus every `app`/`src` production file and rejects direct, re-exported,
  required, subpath, and literal dynamic imports of `react-native-webview`; it also fails closed on non-literal module
  loading, which otherwise could hide that dependency. The existing mounted-component regression proves the
  placeholder loads no WebView and renders none of the supplied marker id, label, or coordinates. The dependency
  itself intentionally remains installed.

  The focused architecture suite passes **19/19 tests** and its live scan covers **455 production files / 1,586
  synchronous runtime edges / 0 embedded WebView imports**. The Find My containment suite passes **1/1 suite / 1/1
  test**. Strict TypeScript, zero-warning focused ESLint, Prettier, diff checks, and the documentation guard pass; the
  latter reports **66 Markdown files / 276 links / 114 primary tasks / 112 mappings**. No production component,
  package, native configuration, database path, build, emulator, physical device, Play, EAS, GitHub, or server state
  changed.

  `WEB-01` is therefore **DONE BY PATH REMOVAL** for the shipped product. `WEB-02..03` and `FACE-01` stay conditional
  and open, and exact-candidate observation that no embedded path is reachable remains device/release evidence. Any
  future embedded Find My map must explicitly reopen `WEB-01`, remove or replace this guard, and satisfy the original
  hostile-input and real-WebView criteria before release.

- **2026-09-03 — `FEAT-02A` closes its two remaining host-side Composer-return gaps:** Commit `98ea739` makes
  `useMessages` carry a request-generation proof alongside retained rows. Leaving an anchored window advances that
  generation, so an older newest-window result cannot falsely satisfy a new return request; limit-only pagination
  deliberately stays in the same generation. The chat screen keeps Composer mounted behind its existing display,
  pointer, and accessibility gate until the exact newest request succeeds. A failed newest request remains fail-closed
  with the load error visible rather than restoring Composer over an unproven window.

  The mounted chat subtree now keys on Expo Router's navigator route identity plus chat/share boundaries. Local
  `setParams` focus clearing retains that identity and therefore preserves Composer attachments, subject/mentions,
  reply/edit state, and draft instance. External focused navigation still uses push/replace and receives a new route
  identity, so it resets local search/jump state even when the incoming focus GUID repeats. The first regressions
  directly failed against the old behavior: Composer became active immediately, a same-focus replacement retained the
  local search hit, and the hook exposed no current-window proof. Independent review then caught and reproduced the
  subtler newest → pending-anchor → newest bounce before the implementation was certified; dedicated hook and route
  regressions now cover it.

  Final focused verification passes **6/6 suites / 82/82 tests**. Strict TypeScript, zero-warning focused ESLint,
  Prettier, diff checks, migrations **5/5**, architecture/scheduled-owner checks **46/46**, and independent final review
  are green. The inventory accepts **1,697** reviewed mutations and reconciles at **0 line shifts / 0 rekeys / 0
  additions**; the full adversarial DB scanner passes **97/97** tests. Full Jest passes **459 suites / 5,211 tests**
  with one intentional skipped suite/test. No dependency, database schema, native configuration, build, server, Play,
  EAS, emulator, or physical-device action occurred.

  No host-side `FEAT-02A` implementation gap remains. Physical Android proof is still required for focused-route and
  in-chat search interaction, retained Composer metadata, newest-window return, highlight/scroll behavior, and
  accessibility; therefore `FEAT-02A` remains **IN_PROGRESS** rather than being marked done.

- **2026-09-03 — `LOG-01D` closes the host-side app/server upload-contract fixture residual:** App commit `a6368fd`
  and server commit `3ea6d16` add byte-identical `errorReports.upload.gator.json` fixtures to each repository;
  follow-ups `2922445` and `cab5cacd` harden the endpoint, retry, disabled-state, category, and stored-file proof. The
  732-byte files include their final line feed and share SHA-256
  `ee0505e0a7a810e88bb2e5ddc6b7ecdd51410b4405cda54954d9292284e2a359`. The app regression drives the real report
  queue and batch builder through `uploadErrorReports`, asserts exactly one `/error-reports` call with retries disabled,
  and requires the object handed to the injected fake `HttpClient` to equal that fixture. It opens no network
  connection. The server regression hashes the same fixture bytes, then drives the parsed payload through the real Zod
  operation input, handler, and `ErrorReportStore`; enabled ingestion creates exactly one category with count three and
  a safely manifested filename, then persists all three reports with every report field and fixture-derived safe client
  context. Disabled ingestion acknowledges zero reports and leaves no category or report-file artifacts.

  Final focused verification passes **1 app suite / 32/32 tests** and **1 server suite / 11/11 tests**. The app
  diagnostics gate passes **32/32 tests** plus its live scan (**20 production calls / 19 error events / 20 opaque
  sites / 6 native events**), and its fast database scanner passes **86 tests** with **11 intentional skips** and no
  failures. The app inventory report accepts **1,697 mutations / 0 structural or membership errors**; architecture and
  scheduled-owner checks pass **47/47**, migrations pass **5/5**, and full Jest passes **459 suites / 5,211 tests** with
  one intentional skipped suite/test. Strict TypeScript passes in both repositories. Server focused ESLint and
  test-source formatting pass; the byte-identical JSON follows the existing cross-repository fixture precedent and is
  outside the server formatter scope. App focused ESLint now has **0 findings**, and exact-file formatting and diff
  checks pass. Three independent reviews are **GO**.

  The byte comparison and digest certify the fixture blobs at the audited commits only. Each repository's automation
  pins its own copy rather than checking out and comparing the sibling repository, so later fixture changes must update
  both copies and their expected digest together.

  No production code, schema, database inventory, native configuration, service process, build, emulator, physical
  device, Play, EAS, or GitHub state changed. `LOG-01` remains **IN_PROGRESS** for its native/pre-runtime decision and
  exact-candidate file/share/logcat/live-HTTP inspection; this entry closes only the host-side `LOG-01D` fixture slice.

- **2026-09-03 — `BACKUP-SLOTS-01A` adds the durable server revision fence:** Server commit `9aefedc6` gives every
  named theme/settings slot a random 128-bit lowercase-hex revision, returns that revision with an explicit
  `revisionFence: true` capability, and rotates it on each successful write. Optional conditional inputs distinguish
  create-only (`expectedRevision: null`) from exact-revision update/delete; a mismatch or missing guarded target returns
  the fixed non-retryable `409 backup_revision_conflict` response through both HTTP and Socket.IO. Omitted inputs retain
  legacy behavior for older clients.

  SQLite migration v12 rebuilds the backup table and backfills established rows within the migration engine's atomic
  transaction. It preserves every old field, records no permissive default, retains stable revisions if only the
  migration ledger is safely rewound, and requires real text containing exactly 32 lowercase hexadecimal characters
  and bytes. Store writes compare and replace under `BEGIN IMMEDIATE`; guarded deletion uses one conditional SQL
  statement, and a new random token prevents an old revision from matching a deleted-and-recreated slot except at the
  negligible 2^-128 collision bound. A pre-existing literal NUL source byte in the in-memory key separator was also
  rewritten as the behavior-equivalent readable `\u0000` escape so future diffs remain inspectable.

  Final Node **24.19.0** verification passes the application-database, backup-operation, and Drizzle-store files at
  **90/90 tests**. Strict BBD TypeScript, zero-warning focused ESLint, staged-file lint, and diff hygiene pass; three
  independent reviews are **GO** after catching and closing SQLite BLOB/hidden-NUL constraint gaps and two test
  false-confidence risks. No live installed service, live database, app code, build, emulator, physical device, Play,
  EAS, GitHub, or remote branch changed.

  This closes only the server fence slice. At that point `BACKUP-SLOTS-01` remained **IN_PROGRESS** because the app had
  to consume and present revision conflicts, the server still needed aggregate bounds or pagination/per-slot fetch,
  and closure still required the approved two-device round trip plus direct inspection proving that exercise's rows
  contain ciphertext without the backup's plaintext or passphrase.

- **2026-09-03 — `BACKUP-SLOTS-01B` adopts the revision fence in the app:** App commit `0dc0309` carries the server's
  list-level `revisionFence` capability through the endpoint, service, and query cache even when the list is empty. A
  fenced response must give every row a canonical 128-bit lowercase-hex revision; a malformed claim fails instead of
  silently becoming a legacy response. Creates send `expectedRevision: null`, overwrites and deletes send the exact
  revision captured when the user reviewed the slot, and the exported endpoint helpers no longer expose an
  unconditional-write signature.

  A fixed revision conflict leaves the cached slot and secret fields untouched, starts an authoritative refetch, and
  tells the user that another device changed the backup. Pre-fence servers using the accepted `{ backups: [...] }`
  envelope stay available for bounded list and restore but disable save/delete in both the UI and service. The shared
  passphrase field remains usable for those legacy restores. Repeated account-generation checks also make account
  retirement win over a simultaneously settling list or conflict, so old-account slot metadata cannot escape through
  an adjacent promise continuation. No passphrase or plaintext backup object enters an API argument.

  Final Node **24.19.0** verification passes the endpoint, service, and component suites at **3/3 suites / 37/37
  tests** with **0 snapshots**. Strict TypeScript, zero-warning exact-file ESLint, Prettier, and diff hygiene pass.
  Independent review is **GO** after finding and closing the legacy-restore input regression, the optional low-level
  write footgun, and two account-retirement ordering races. No server process, live service/database, build, emulator,
  physical device, Play, EAS, GitHub, or remote branch changed.

  This closes revision-fence adoption, not the parent. `BACKUP-SLOTS-01` remains **IN_PROGRESS** for server-owned
  per-slot and count bounds, an atomic aggregate byte quota, a worst-case serialized-list response ceiling that covers
  JSON expansion, metadata, and pre-existing rows, plus the approved two-device round trip and direct inspection
  proving that exercise's rows contain ciphertext without the backup's plaintext or passphrase.

- **2026-09-03 — `BACKUP-SLOTS-01C` bounds hosted backup storage and complete-list reads:** Server commit `e6afa6f9`
  enforces the selected non-paginated contract independently for theme and settings backups: at most 10 slots, at most
  80 characters for a new name, at most 900 KiB of UTF-8 data per slot, and at most 9,000 KiB of aggregate data. Both
  fenced and legacy/unconditional writes pass the same projection. The existing revision comparison runs first, then
  the quota and escaped-response checks run inside the same `BEGIN IMMEDIATE` transaction, so a stale writer receives
  the precise `409` and competing final-slot creates cannot both commit.

  Complete-list count/byte preflight and materialization share one read snapshot. A final 12 MiB serialized-response
  ceiling includes JSON escaping and metadata with headroom below the app's 16 MiB transport limit. The fixed
  non-retryable `413 backup_capacity_exceeded` contract is identical over HTTP and Socket.IO. A rejection changes no
  row, revision, timestamp, or event; delete remains available. Datasets already beyond the slot-count, per-slot-data,
  aggregate-data, or response ceilings are never pruned or rewritten, and their complete-list reads fail closed. An
  already-known name through the legacy unconditional delete contract or manual server cleanup is therefore the
  recovery path for an affected database. The 80-character new-name cap is not retroactive; pagination/per-slot fetch
  remains a future product option rather than a safety prerequisite.

  Final Node **24.19.0** verification passes the backup-operation and Drizzle-store files at **78/78 tests**. Strict
  BBD TypeScript, zero-warning exact-file ESLint, Prettier, staged-file lint, and diff hygiene pass. Independent review
  is **GO** after finding and closing a mismatch where the in-memory operation-test store initially admitted an
  escaped response that production rejected. No migration, stored row, running service, live database, app build,
  emulator, physical device, Play, EAS, GitHub, or remote branch changed.

- **2026-09-03 — `BACKUP-SLOTS-01D` gives server-capacity failures accurate app behavior:** App commit `7b06137` maps
  HTTP `413` to a typed `server-capacity` result for complete-list and save calls without adding retry. The Backup
  screen distinguishes that result from local name/ciphertext/count admission, a revision conflict, an unsupported
  endpoint, and an ordinary connection failure. List failures retain Try again and explain that local export/restore
  remains available; save failures recommend deleting a slot or using a smaller backup.

  The current-account check runs before capacity classification. A final list rejection-side check also makes account
  retirement win if it lands between the API rejection and the converted error's continuation, matching the existing
  mutation guarantee. Final Node **24.19.0** verification passes **2/2 suites / 37/37 tests** with **0 snapshots**.
  Strict TypeScript, zero-warning exact-file ESLint, Prettier, and diff hygiene pass; the DB inventory report accepts
  **1,697 mutations / 0 structural or membership errors** and this slice adds none. Independent review is **GO** after
  finding and closing the list/account-retirement microtask race. No endpoint, DB write, native configuration, build,
  emulator, physical device, live server/database, Play, EAS, GitHub, or remote branch changed.

  This completed the then-known repository implementation for `BACKUP-SLOTS-01`; the later `BACKUP-SLOTS-01E` audit
  found and closed one legacy shrinking-repair mismatch. The parent remains **IN_PROGRESS** for the approved live
  two-device create/list/restore/overwrite-conflict/delete exercise and direct inspection of the rows it creates,
  proving their data is ciphertext and contains neither plaintext backup content nor the passphrase.

- **2026-09-03 — `BACKUP-SLOTS-01E` makes bounded legacy repair match the capacity guidance:** Independent review of
  `e6afa6f9` found that the store rejected current oversized usage before projecting an overwrite. Server commit
  `156aab6d` now checks the complete post-write state instead: a stale revision still returns `409` first, one known
  oversized target can be replaced with a smaller value when that makes the whole kind compliant, and any count
  overage or remaining oversized sibling still returns the fixed `413` without mutation. The target is excluded in
  SQL before full backup data is materialized, while the projection, exact serialized-list check, and write remain in
  the same `BEGIN IMMEDIATE` transaction.

  The 80-character policy is explicitly a new-name admission limit, so bounded older names remain listable,
  overwritable, and deletable without permitting their recreation. The list output schema now states the 10-slot
  maximum, and real Fastify plus Socket.IO tests cover the same complete-list `413` envelope rather than only the save
  path. Final Node **24.19.0** verification passes **2/2 focused files / 81/81 tests** and the complete BBD unit gate at
  **3,035/3,035 tests**. Strict BBD TypeScript, zero-warning exact-file ESLint, Prettier, staged-file lint, and diff
  hygiene pass; two independent rereviews are **GO**. The final app freeze passes **461 suites / 5,243 tests**, with
  one additional intentional skipped suite/test, architecture at **47/47**, migrations at **5/5**, and the fast DB
  scanner at **86 passed / 11 intentionally skipped / 0 failed**. The full app run emits the already-recorded
  `MediaViewer`/`VirtualizedList` React `act` warnings but no failure. No migration, stored row, running service, live
  database, app build, emulator, physical device, Play, EAS, GitHub, or remote branch changed.

  This closes the discovered repository mismatch, not the parent. `BACKUP-SLOTS-01` remains **IN_PROGRESS** only for
  the approved live two-device exercise and direct ciphertext-only row inspection described above.

- **2026-09-03 — `A11Y-03` closes the manual-setup host keyboard-configuration gap:** Commit `38e0fb9` replaces the
  Android no-op `KeyboardAvoidingView` branch with the same padding contract used by the app's other edge-to-edge input
  screens. The existing shared keyboard-visibility hook enables that padding only while the keyboard is up, avoiding
  a retained navigation-bar-sized gap after hide, and the route intentionally supplies no vertical-offset
  counterweight. The scrollable form, connection validation, insecure-HTTP acknowledgement, credential handling, and
  safe-area arithmetic are unchanged.

  The focused manual-route and shared-hook matrix passes **2/2 suites / 3/3 tests**. Strict TypeScript, zero-warning
  exact-file ESLint, Prettier, and diff checks pass. The database inventory accepts **1,697 mutations / 0 structural or
  membership errors** after exactly **3 line shifts / 0 rekeys / 0 additions**; the fast scanner passes **86 tests**
  with **11 intentional skips / 0 failures**. On an isolated exact-`38e0fb9` checkout, architecture and scheduled-owner
  checks pass **47/47** over **71** core files, **123** UI-free service files, **148** read-only UI/app files, **454**
  production files / **1,587** synchronous edges, **455** no-WebView files, and **7** ordered entry imports; migrations
  pass **5/5** across **45** sequential migrations at head `0045_backup_export_indexes`; and full Jest passes **460
  suites / 5,214 tests** with one intentional skipped suite/test. The full run emitted the already-recorded
  `MediaViewer`/`VirtualizedList` React `act` warnings but no test failure. Independent review is **GO** with no
  production, privacy, accessibility, or inventory blocker.

  Host rendering proves the configured props and keyboard-event owner, not actual native movement. A future exact
  Play candidate must still exercise long credentials, large font, repeated show/hide, both Android navigation modes,
  reachable Connect/insecure controls, and the absence of a residual gap. No build, emulator, physical device, server,
  Play, EAS, or GitHub action occurred, so `A11Y-03` remains **IN_PROGRESS** for this and the wider TalkBack/layout
  matrix.

- **2026-09-03 — `REL-004` foreground external-handoff failures become visible without crossing owners:** Commit
  `81a6f8e` routes Chat Settings shared links, message URL previews, Find My points, shared-location cards, and the
  foreground FaceTime overlay through one fixed privacy-safe failure toast. Each asynchronous result remains owned by
  its initiating route, URL/attachment, call lifetime, and account lease; repeated taps are coalesced, and delayed
  failures after unmount, replacement, blur, or Disconnect are discarded. No URL, coordinates, call identity, or
  native error enters the toast.

  Focused verification passes **8/8 component suites / 139/139 tests**; the complete component project passes
  **138/138 suites / 1,544/1,544 tests**; TypeScript, zero-warning production lint, configured source/test formatting,
  architecture/scheduled-owner **47/47**, migrations **5/5**, DB inventory **1,697 mutations / 0 errors**, exact
  reconciliation after **2 line shifts / 0 rekeys / 0 additions**, fast scanner **86 passed / 11 intentionally
  skipped**, diff hygiene, and independent review are green. The first full run used the crashed IDE's unpinned Node
  26 shell and failed only because `better-sqlite3` was compiled for the repository's Node 24 ABI. The unchanged cached
  Node **24.19.0** rerun passes **461/461 suites / 5,239/5,239 tests**, plus one intentional skipped suite/test and zero
  snapshots; it retains the already-recorded `MediaViewer`/`VirtualizedList` React `act` warnings.

  This is host evidence only. No build, browser, Maps, custom tab, server, network, emulator, physical device, Play,
  EAS, or GitHub action occurred. `REL-004`, `FACE-01`, `PLAY-02`, `FEAT-02`, applicable accessibility proof, and parent
  `DEVICE-01` remain open; `FEAT-07` document/FileProvider behavior is a separate path and receives no credit here.

- **2026-09-04 — `NET-00` removes the dormant client preview network implementation:** App commit `40b907d` deletes
  `fetchOgMetadata`, its uncached fetch/redirect implementation and process-global deduplication map, the
  `OgFetchResult` contract, and the unused Open Graph HTML parser. The two suites whose **29 tests** exercised only
  those deleted symbols are removed. The remaining service is a pure literal URL classifier for inert metadata; its
  result explicitly does not authorize a request because it neither resolves nor pins DNS.

  Existing behavior stays contained: `MessageBubble` may render text from server-supplied `payloadData` or an
  exact-key legacy `url_previews` row, never mounts remote preview artwork, and leaves a cache miss as a raw link.
  Cards and raw links call the allow-listed external opener only after a user tap. Focused Node and component
  verification passes **4/4 suites / 43/43 tests** with **0 snapshots**. Node **24.19.0** TypeScript, zero-warning
  exact-file ESLint, Prettier, the **1,697/1,697** approved database-write inventory, retired-symbol search, and diff
  hygiene pass; independent review is **GO**.

  This is source/host containment evidence only. No URL request, build, emulator, physical device, packet capture,
  server, database, Play, EAS, GitHub, or remote branch changed. `NET-00` remains **DONE**, while primary `NET-01`
  remains **TODO / CONDITIONAL** for `DEC-01` and `NET-01A..D`.

- **2026-09-04 — `PKG-01-WEBVIEW-REMOVAL` retires the unused direct community WebView boundary:** App commit
  `4fca556` removes the direct `react-native-webview` declaration and authoritative top-level lock entry. The
  toolchain guard now rejects both retired packages from production, development, optional, and peer declarations,
  overrides, and root/nested/legacy lock entries. The existing architecture guard continues to reject direct,
  required, subpath, dynamic, and unverifiable non-literal production imports. The obsolete Find My Jest module mock
  is removed while the mounted privacy-placeholder assertions remain.

  Under pinned Node **24.19.0** and npm **11.17.0**, the toolchain mutation suite passes **18/18**, its live guard
  passes, and the architecture suite passes **19/19**. Its live scan reports **455 production files / 1,596
  synchronous runtime edges without cycles**, plus **456 production files / 0 embedded-WebView imports**. Find My
  containment passes **1/1 suite / 1/1 test** with **0 snapshots**; strict TypeScript, focused zero-warning ESLint,
  touched source/test Prettier, lock/diff checks, and the clean top-level dependency tree pass.
  `npm ls react-native-webview --all` reports an empty tree, and React Native autolinking output has no
  `react-native-webview` entry.

  Expo SDK 57 still owns `@expo/dom-webview` **57.0.1** transitively through Expo/Expo Router. This slice does not
  claim that framework module or all Android WebView code disappeared; it proves only that Gator no longer declares,
  resolves, imports, or autolinks the direct community package. No build, emulator, device, Play, EAS, GitHub, server,
  or network action ran. The child is **DONE**; primary `PKG-01` stays **IN_PROGRESS** until a clean replacement
  candidate supplies its exact package matrix and packaged native-registration absence proof.

- **2026-09-04 — `FEAT-05C` closes cross-repository source work for capability-gated global message search:** The
  server now exposes authenticated `POST /api/v1/message/search/bounded` and advertises
  `supports_message_search` only when the live Messages schema proves message identity/text/date, overlay and
  retraction filtering, routable chat identity, and any present Recently Deleted join. Inputs are normalized and
  fixed at 2–128 Unicode code points; SQL binds and escapes the literal substring; results are deterministic and
  capped at the newest 50 live iMessage/SMS rows. The deployed legacy route and request shape remain available.

  The app remains local-first and calls the Mac only when that capability is explicitly true. Valid remote hits are
  stripped to the endpoint's bounded shape, persisted in guarded 25-message transactions, reread through encrypted
  local visibility rules, merged by GUID with local data winning, and exposed as at most 50 newest-first rows. The
  result surface retains no full message body: a linear, bounded-memory literal locator returns at most 240 Unicode
  code points around the match while the encrypted DB keeps the full text. Account retirement aborts transport and
  immediately conceals chat/message rows, labels, empty states, and stale navigation actions. Copy accurately says
  Mac search covers iMessage/SMS while locally stored RCS matches may still appear; old servers and failures remain
  local-only.

  Final app verification under Node **24.19.0** passes **460 suites / 5,238 tests**, plus one intentional skipped
  suite/test and **0 snapshots**. Strict TypeScript, production lint, configured formatting, architecture/scheduled
  ownership **47/47**, migrations **5/5** across 45 migrations, the fast DB scanner at **87 passed / 11 intentionally
  skipped / 0 failed**, the **1,702/1,702** approved mutation inventory, exact reconciliation at **0 line shifts / 0
  rekeys / 0 additions**, documentation **3/3**, and diff hygiene pass. Final server verification under Node
  **24.19.0** passes the complete BBD unit gate at **3,043/3,043 tests**, protocol at **16/16**, the focused bounded
  read suite at **65/65**, strict BBD/protocol TypeScript and lint, backend bundling, repository formatting, and diff
  hygiene. Independent app, DB/scanner, and server reviews are **GO** after their findings were corrected.

  This is source/host completion, not deployment or native proof. `adb devices -l` found no connected Android device;
  no matching app/server release was installed or deployed, and no live Mac Messages database was queried. The exact
  build pair must still prove Mac-only iMessage and SMS hits, duplicate identity, navigation, newest-50 ordering,
  exclusion rules, old-server/offline fallback, account replacement, and realistic large-database latency. Parent
  `FEAT-05` therefore remains **IN_PROGRESS**: `FEAT-05A` is still server-blocked, `FEAT-05B` retains its release/device
  tail, and `FEAT-05C` retains only server-release and device sign-off work.

- **2026-09-04 — exact `0.1.43` / version-code-59 local candidate is validated and promoted:** Release run
  `android-0.1.43-7a3aa20-20260904145333` built exact source
  `7a3aa2058ad1bea4252379b2ea3df285e1fd94ef` / tree `9c44ead088a8821f48edf4de814f87be483cabfd`
  with the production environment and managed upload signing. Validation and local promotion passed as release commit
  `e108ad7756cf2ae67a6873cbd1e1526df0613e18` / tree `143a2e1508ebd1af978a24a11030a6bc11974ab1`
  on local branch `release/android-0.1.43`. The retained ignored artifact
  `gator-release-0.1.43-v59-e108ad7.aab` is **55,818,682 bytes**, SHA-256
  `e2a60f7b06837b47484f71d79fccb0c585ead745a2e1a1a48952d54cd5bdc0af`, with upload-certificate SHA-256
  `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`.

  The AAB is a valid ZIP and matches the promotion receipt. Package-qualified inspection with
  `apkanalyzer dex packages --defined-only` finds no `com.reactnativecommunity.webview`; `PackageList` DEX contains no
  `Lcom/reactnativecommunity/webview/RNCWebViewPackage;` registration. Expo's expected framework-owned
  `Lexpo/modules/webview/DomWebViewModule;` remains packaged. This closes the clean-candidate static sub-gate for
  `PKG-01-WEBVIEW-REMOVAL`, not primary `PKG-01`'s Firebase/server/device tail. Superseded v58, frozen v57, and retired
  v56 remain historical static evidence only.

  Submission remains `not_started`. No hosted build, Play upload/submission, live Play inspection, server deployment,
  device action, or remote release-branch push occurred. App documentation commit `570f9ba` and separate server
  mention/reply commit `c9d273ed` postdate the frozen app source; their claims must not be treated as content or
  deployment proof from this artifact. Primary task states and counts do not change: `RELEASE-01`, `STORE-01`,
  `STORE-01G`, `PKG-01`, `PERM-01`, `PLAY-02`, and `SHARE-01` retain their recorded external tails, and `DEVICE-01`
  remains **BLOCKED** on its exact-candidate environment and execution evidence.

- **2026-09-04 — `PUSH-RETRY-01` gains immutable server-owned RCS attempt identity:** Server commit `e55f1210`
  gives every admitted physical RCS send one UUID attempt id and carries it with the logical `tempGuid` through an
  opaque, bounded sidecar `tmpID`. The echoed correlation is stored by exact physical-phone namespace plus message id,
  survives BBD restart/status-only frames, and cannot cross a re-pair. Duplicate requests replay the same reservation;
  an authoritative failure releases only its exact generation, even when it races an unsettled owner, so a real retry
  gets a new id and a delayed old failure cannot evict its server reservation. Text, new-chat, and media paths share
  the contract.

  Attempt-aware `message-send-error` uses one logical DTO across authenticated socket, webhook, and FCM before
  transport-specific serialization/encryption. Managed-device FCM requires `messages:write`; unmanaged legacy push
  rows retain compatibility authorization. A canonical per-device key encrypts the DTO; without one, FCM sends only
  type plus empty-object metadata and no temp/chat/attempt ids in plaintext. The current app does not enroll or decrypt
  the server's `AEAD_GCM_V2_DEVICE` scheme, so attempt-aware FCM remains blocked on `PUSH-CRYPTO-01`; exact payload
  delivery is currently socket/webhook-only. Legacy temp-only events also remain socket/webhook-only. Server
  verification under Node **24.19.0** passes strict TypeScript, lint, the backend build, and the complete BBD unit gate
  at **3,059/3,059 tests**; `go test -race -count=1 ./...` passes, and independent review is **GO** after the
  exact-release/pending-owner, phone-namespace, re-pair, cache-failure, and unpair-lifecycle findings were corrected.
  App verification under the same Node version passes strict TypeScript, **4 focused suites / 108 tests**, and the
  complete Jest gate at **460 passed / 1 skipped suites and 5,238 passed / 1 skipped tests**. The architecture gate
  passes **47/47 tests** plus both live guards; the migration gate passes **5/5 tests** at sequential head `0045`; the
  documentation guard passes **3/3 tests / 66 tracked Markdown files / 278 local links**; and the full DB scanner
  certificate passes **98/98 tests**. The DB inventory reports **1,702 mutations / 0 structural or membership errors**
  with exact reconciliation at **0 line shifts / 0 rekeys / 0 additions** after 51 mechanical line-only shifts were
  recorded. ESLint, Prettier, and diff hygiene pass. App runtime behavior is unchanged; the source, test, and checker
  edits replace misleading recovery wording while preserving the fail-closed ingress certificate.

  This is source/host evidence, not deployment or native-service proof. No app build, server deployment, network,
  Firebase delivery, emulator, physical phone, Play, EAS, GitHub, or remote branch changed. Google `tmpID` echo for
  text/media at the supported length, the physical destination-registration namespace, and the exact candidate remain
  open; connected killed-app FCM additionally requires `PUSH-CRYPTO-01`. A crash after Google accepts a send but before
  the first correlated frame reaches durable BBD storage remains outside the guarantee, and correlation becomes
  non-exact after the bounded 90-day/50,000-message cache window. Independent app review also caught two client tails:
  Try Again deliberately refuses a queue-less post-ack error, and a first old-attempt event delayed until after its
  retry is not fenced against the shared tempGuid. The current A → B procedure now holds an admitted RCS attachment's
  loopback fetch through its ack, then releases it as a certified `ECONNREFUSED`, and only replays an already-processed
  A. User-driven post-ack retry and durable active-attempt ownership remain explicit implementation work.
  `PUSH-RETRY-01` therefore remains **IN_PROGRESS**.

- **2026-09-04 — `PUSH-CRYPTO-01A` completes current-server V2 client interoperability on host:** The app now
  consumes `supports_fcm_device_encryption`, serializes registration, persists a canonical-origin-bound pending key
  before POST, requires the exact server acknowledgement before activation, and reuses the pending key after a lost
  response. Pending and active records decrypt strict `AEAD_GCM_V2_DEVICE` frames with the exact event type as
  AES-GCM authenticated data. The unlocked content path rejects malformed state/frame/key/UTF-8, wrong origin,
  plaintext, V1, and unknown schemes after migration; the locked path retains only the existing generic notice.
  Disconnect retires any present key to a keyless tombstone only after realtime work drains, and a capable successor
  creates a fresh key.

  Final verification under pinned Node **24.19.0** passes the complete Jest gate at **463 passed / 1 skipped suites**
  and **5,290 passed / 1 skipped tests**, with **0 snapshots**. The full adversarial DB-write scanner passes **98/98**
  tests; the inventory reports **1,703 mutations / 0 structural or membership errors**, and exact reconciliation is
  **0 line shifts / 0 rekeys / 0 additions**. Strict TypeScript, production ESLint, configured Prettier, diff hygiene,
  architecture/scheduled ownership **47/47**, migrations **5/5** across **45** sequential migrations, secret hygiene
  **4/4**, and documentation **3/3** all pass. The app fixture also decrypts through current server `e55f1210`'s
  actual V2 implementation. Three independent reviews found no remaining blocker or major child-slice defect.

  This is source and host evidence, not Android/native or deployment proof. The parent `PUSH-CRYPTO-01` remains
  **IN_PROGRESS** for authenticated server/account/device/message/time identity, durable replay admission and
  retention, coordinated server revocation/staged migration, HTTPS-only enrollment confidentiality, and exact-device
  Expo Crypto/SecureStore/process-death/Firebase/killed-app evidence. No app build, server deployment, device, Play,
  EAS, GitHub, remote branch, or network state changed.

- **2026-09-07 — `PUSH-RETRY-01` closes durable active-attempt ownership on host:** App migration
  `0046_message_send_attempt_owner` adds a persisted generation, pending-owner fence, and active server attempt to the
  optimistic message. Initial RCS text/contact/attachment sends now resolve the advertised capability before their DB
  insert; an unavailable discovery fails before creating a message or queue row, while a known legacy server stays on
  generation zero. Automatic and manual retry claims atomically advance a modern generation before the request. Each
  local request carries its immutable token, and its HTTP/error/success settlement can mutate only the generation it
  owns.

  The exact server tuple `{tempGuid, attemptGuid, clientAttemptGeneration}` now crosses ordinary RCS sends, new-chat's
  initial RCS message, live success DTOs, and background delivery-error forwarding. Durable server idempotency replay
  retains the physical attempt: an older replay generation is installed under the current local request token rather
  than being allowed to settle a different request. Exact incoming success/error processing defers an unresolved
  owner, rejects stale A after B settles, distinguishes malformed correlation from a legacy absence, and gives a later
  valid copy a different durable identity. A delayed error can recover after temp-alias pruning only when its active
  attempt matches exactly one canonical row. The sync attachment content fallback is generation-zero-only.

  Queue-less retry is deliberately conservative. A certified pre-dispatch attachment failure can rebuild its exact
  queue payload while the local file still exists. Text, mentions, and contact cards remain visibly failed without an
  automatic resend once their original queue row is gone, because the message row cannot reconstruct their original
  kind/data without changing what would be sent.

  Final focused verification under Node **24.19.0** passes app strict TypeScript and **8/8 suites / 178/178 tests**,
  including ownership races, durable replay, malformed-copy identity, attachment-only rearm, and cold capability
  discovery. The 46-migration sequential/head guard and its **5/5** tests passed earlier in this same worktree. Server
  strict TypeScript and the focused background/action/correlation/sender boundary pass **94/94 tests**; the new-chat
  subset independently passed **32/32**. Diff whitespace checks pass. The broad app DB-write scanner was not certified:
  it reported **69 passed / 18 failed / 11 skipped** while another active remediation session was adding repair/sync
  write paths, so its global inventory cannot be safely reconciled until that independent slice stabilizes.

  A final skeptical review then found and closed three host tails: incomplete and corrected send-error tuples now have
  distinct durable identities; alias-prune attachment recovery restores the temp-to-real mapping before a generation-3
  claim; and the server client-send ledger now has 65,536 slots instead of 4,096. The added focused checks pass **53/53
  app tests** and **91/91 server tests**. A temporary production composition admitted **4,097** simultaneous retained
  successes, directly exercising the first request the old capacity rejected, and reported the configured 65,536
  bound. App/server formatting and diff checks pass for the touched PUSH files, and independent rereview returned GO.

  This is local source/host evidence only. No app build, service deployment, Google/Firebase delivery, emulator,
  physical phone, Play, EAS, GitHub, or remote branch changed. The signed v59 artifact predates this work. A new local
  candidate plus matching deployed server must still prove physical `tmpID` echo/phone namespace, connected killed-app
  FCM recovery, and the staged A → B race. `PUSH-RETRY-01` remains **IN_PROGRESS** for those external/native gates.

- **2026-09-07 — concurrent DB-write guard and inventory reconciliation completed:** This follow-up supersedes the
  moving-tree scanner failures recorded in the PUSH/RECOVERY implementation checkpoints above. The final live set is
  **1,742** mutations. Review preserved metadata across **60** straightforward rekeys and **18** manually matched old
  approvals covering **20** replacement writes, removed the one obsolete second full-repair crawl, and approved **38**
  genuine additions: migration `0046`, incoming-event deferral, exact RCS attempt success/ACK/error ownership, and no
  unrelated write. The remaining **284** changes were line numbers only and were applied by the atomic reconciler.

  Strict inventory checking passes **1,742/1,742** with no missing, stale, unassigned, unreviewed, or unproven entry;
  a second reconciliation is exact **0 / 0 / 0**. The focused scanner file is Prettier-clean, diff hygiene passes, and
  the default scanner suite completes **98 tests / 87 passed / 11 skipped / 0 failed** in 20.1 seconds. The selected
  full-only driver/capability mutation proof separately passes **1/1**. A skeptical metadata audit found and corrected
  two initially mis-targeted evidence strings, then proved zero non-line changes to retained IDs, zero unknown fields,
  and zero missing evidence paths. Two independent read-only reviews agree that all replacements/additions remain
  coordinated and that the net sync reduction is the intentional removal of the redundant second crawl. No app build,
  device, deployment, Play, EAS, GitHub, remote branch, or network state changed.

- **2026-09-07 — composer and voice sends retain the authored copy until durable queue admission:** Cold capability
  discovery can now delay initial RCS persistence without clearing text, subject, mentions, reply context, staged
  attachments, or a stopped voice recording. Text/reply/image observers fire only after the optimistic message and
  outgoing queue transaction commits. The composer blocks duplicate taps during that handoff, removes only attachment
  URIs whose rows committed, and ignores results from a retired account. A pre-queue voice failure keeps the exact
  stopped file in its modal for retry; a post-queue upload failure is instead owned by the durable bubble and queue.
  DEV text/reply helpers now expose the same post-insert handoff and no longer treat a missing-chat no-op as success;
  scheduled DEV and notification-inline sends forward that handoff instead of clearing their only authored copy early.

  Focused verification under Node **24.19.0** passes **4 component suites / 131 tests** and **3 Node suites / 70
  tests**. Strict TypeScript, targeted formatting, targeted lint (**0 errors; six pre-existing test warnings**), and diff
  whitespace checks pass. Two independent reviews are **GO** after the DEV no-op and retired-account publication gaps
  were corrected. The live DB report contains no `nested-coordinator` defect, but exact inventory certification is not
  claimed: callback-fingerprint changes in the shared moving worktree currently produce **526 structural/membership
  differences** and must be reconciled only after the combined candidate freezes. No full Jest gate, app build, device,
  deployment, Play, EAS, GitHub, remote branch, or network state changed. `PUSH-RETRY-01` remains **IN_PROGRESS** for
  its recorded matching-release and physical-device gates.

- **2026-09-07 — foreground and killed-process RCS sends bind capability to one authorized transport:** Direct
  text, reply, contact, and attachment sends now pin the HTTP transport before capability discovery and retain one
  origin/revision/currentness lease through queue admission, network dispatch, and settlement. The monotonic transport
  revision rejects an A → B → A server switch that an origin-only comparison could miss. Server-info publication from
  bootstrap, Server Management, and FCM setup is conditional on that same lease, so a late old response cannot replace
  the active session's feature flags. Post-admission rotation leaves the durable outgoing row retryable instead of
  stranding the authored message.

  Background scheduling carries the exact task-local `{client, serverInfo}` pair from authorized vault inspection to
  each physical send. A killed-process notification reply likewise builds a fixed client from the still-authorized
  vault record and uses the durable account-revocation marker as its admission guard. Neither path reads from or
  publishes to the unhydrated foreground Zustand store. Retry owners also pin their client; ownerless automatic/manual
  claims fail closed, alias pruning retains aliases referenced by the outgoing queue, and queue-health classification
  follows those aliases instead of reporting a promoted row as orphaned.

  Final focused verification under Node **24.19.0** passes **18 suites / 271 tests** for HTTP/session fencing, direct
  sends, queue/retry ownership, scheduling, background sync, notification reply, and account scope; the Server
  Management component suite separately passes **33/33 tests**. Strict TypeScript, targeted ESLint, configured
  formatting, and diff whitespace checks pass. An independent concurrency/background review is **GO** after the first
  design's killed-process coupling to foreground state was removed; its separate **5 suites / 94 tests** pass.

  The live DB report finds **1,744 mutations / 711 structural or membership differences** and no
  `nested-coordinator` defect. The required fast scanner suite records **98 tests / 68 passed / 19 failed / 11 skipped**;
  the failures are exact-set/certificate drift in the shared moving worktree, so this checkpoint does not reconcile or
  claim global DB certification. No full Jest gate, app build, device, deployment, Play, EAS, GitHub, remote branch, or
  network state changed. The matching-release/device gates remain open, so `PUSH-RETRY-01` stays **IN_PROGRESS**.

- **2026-09-07 — killed-process notification actions bind network work to durable credentials:** Reply, Love,
  FaceTime Answer, and enabled Mark-as-read receipts no longer depend on the empty Zustand-backed HTTP singleton in a
  fresh notification runtime. One shared action resolver either pins the complete connected foreground transport or
  re-authorizes an immutable task-local client through vault, App Lock, and revocation-marker inspection. Reply keeps
  the exact RCS capability provenance for its pinned client; Love and FaceTime reuse the same client for their complete
  network effect. Cold results never hydrate or publish the foreground session store.

  Mark Read retains its bounded account-guarded local transaction and now resolves receipt credentials lazily only
  after the newest-message marker commits and only after persisted feature settings hydrate successfully. Missing or
  locked credentials, failed settings hydration, and network errors therefore suppress the optional receipt without
  restoring the local unread badge. Mark Unread adopts the same fail-closed hydration condition. Reaction settlement
  deliberately keeps the separate account/revocation guard rather than transport currentness, so a tunnel rotation
  after queue admission cannot strand the durable row as `sending`.

  Focused verification under Node **24.19.0** passes **2 suites / 65 tests / 0 snapshots**, including exact fixed-client
  use for killed-process Reply/Love/FaceTime, lazy Mark Read authorization, persisted read-receipt opt-out, hydration
  failure, local-state preservation, and existing account-switch races. Strict TypeScript, targeted ESLint (**0 errors;
  four pre-existing test import-order warnings**), configured formatting, and diff whitespace checks pass. Independent
  network/concurrency rereview is **GO** after finding and closing the unhydrated-default privacy leak.

  The live scanner still finds no `nested-coordinator` defect; its shared moving inventory currently reports **1,744
  mutations / 782 structural or membership differences**, so no global DB certificate or reconciliation is claimed.
  No full Jest gate, app build, device, Firebase delivery, Play, EAS, GitHub, remote branch, or network state changed.
  `SEND-01` and `PLAY-02` retain their recorded exact-device/release tails. At this checkpoint `REL-001` retained both
  killed-FCM prerequisite-recovery and auto-download source gaps; the later attachment checkpoint below closes the
  auto-download source gap without marking the parent complete.

- **2026-09-07 — realtime synced wallpapers use an authorized, transport-fenced client:** A chat-background group
  event received by a fresh killed-process FCM runtime no longer reaches the empty foreground HTTP singleton. The
  detached callback carries the originating account-generation identity, then captures a fresh lease and either pins
  the exact connected foreground transport or re-authorizes one immutable vault tuple through App Lock and the
  durable revocation marker. A fast disconnect/reconnect cannot adopt an old chat GUID into the replacement account,
  and cold credentials are never published into Zustand.

  The synced-background service now includes HTTP transport currentness in every network/native/DB ownership check.
  An approved same-account origin rotation therefore cancels the retired metadata/download path before it can publish
  a file or URI. The ordinary mounted-chat entry point also pins its selected transport. Fixed headless clients accept
  the same revocation guard at the HTTP layer, preventing an internal retry after account authority is lost.

  Focused verification under Node **24.19.0** passes **6 suites / 128 tests / 0 snapshots**, covering cold and warm
  transport selection, account-generation handoff, transport rotation, guarded settlements, realtime composition,
  and the related notification-action factory contract. Strict TypeScript, configured formatting, diff whitespace,
  and targeted ESLint pass with **0 errors / five pre-existing test style warnings**. Independent review is **GO**;
  its ordinary-Node DB-suite launch hit the known local `better-sqlite3` ABI mismatch, while the pinned Node 24 run
  above passed that same suite. The live scanner finds no `nested-coordinator` defect; the shared moving inventory reports
  **1,744 mutations / 810 structural or membership differences**, so no global certificate or reconciliation is
  claimed.

  This is source/host evidence only: no app build, device, Firebase delivery, Play, EAS, GitHub, remote branch, or
  network state changed. At this checkpoint `REL-001` retained killed-FCM prerequisite recovery and attachment
  auto-download as source gaps; the next checkpoint closes the latter. `DL-01` still retains its recorded exact-device
  proof. Completed `REL-006`'s shared HTTP retry identity remains intact; this closes the wallpaper caller's adoption
  of that contract rather than reopening the core helper.

- **2026-09-07 — attachment auto-download adopts authorized transport and cache recovery:** The
  post-commit realtime message hook now carries its runtime account generation into a detached entry point. That
  entry point resolves the same warm-pinned or cold durable transport used by synced wallpapers, then supplies the
  exact task-local client and currentness lease to the full automatic-download operation. A fresh FCM process no
  longer reaches the empty foreground HTTP singleton, and account or transport rotation prevents a late native file
  from becoming the attachment's authoritative `localPath`.

  A killed-process runtime does not execute foreground attachment-cache startup recovery. The new entry point
  therefore checks readiness and joins or starts the existing bounded, generation-serialized recovery flight before
  reserving persistent bytes. Only a `ready` result under the same current lease proceeds; stale or failed recovery
  remains a contained best-effort no-op. The explicit-client download path preserves the in-app development fixture's
  installed synthetic fetcher rather than contacting its placeholder origin.

  Focused verification under Node **24.19.0** passes **2 suites / 51 tests / 0 snapshots**, covering task-client
  propagation, recovery-before-download, stale/error refusal, the development fetcher, and existing account/cache
  settlement behavior. Strict TypeScript, formatting, scoped whitespace checks, and targeted ESLint pass with **0
  errors / three pre-existing test style warnings**. The live scanner finds no `nested-coordinator` defect and reports
  **1,746 mutations / 822 structural or membership differences** in the shared moving worktree. Its fast suite reports
  **98 tests / 67 passed / 20 failed / 11 skipped** because exact-set certificates and the actively edited inventory
  disagree; this checkpoint does not reconcile or claim global DB certification.

  This is source/host evidence only: no app build, device, Firebase delivery, Play, EAS, GitHub, remote branch, or
  network state changed. Independent review is **GO** for this narrow transport/cache-admission slice and **NO-GO**
  for killed-process lifecycle closure: `DbEventSink` still fire-and-forgets the hook, the native FCM callback may then
  settle, and replay skips the hook after the authoritative DB checkpoint. `DL-01` retains that lifetime gap plus its
  native hostile-server/process-death matrix. `REL-001`/`PUSH-RETRY-01` remain **IN_PROGRESS** for this durable handoff,
  task-local missing-prerequisite recovery, and exact-device killed-FCM proof.

- **2026-09-07 — killed-FCM prerequisite recovery owns repair, due time, and retry:** Replaced foreground-only
  `ensureChatSynced`/`startSync` callbacks with a task-local authorized runner serialized through the sync owner. It
  performs targeted chat metadata/message repair where a safe guid exists and bounded account/deletion repair
  otherwise, with transport, account, App-Lock, timeout, and generation-abort guards around every continuation.

  Missing-message-chat, read-status, and malformed-group failures now inherit the incoming dependency marker. The
  drain emits an ownership signal only after the exact five-second deferral commits, including wait-only RCS attempt
  ownership. An FCM collector starts that clock at settlement, awaits it concurrently with recovery, and performs one
  20-second bounded retry; it does not add recovery duration to the backoff or recursively launch another repair.
  Read-status uses an exact chat guid and the chat runner is capped at eight seconds so its 15-second receipt still has
  retry headroom. Malformed group snapshots retain a safe raw guid for targeted repair when available.

  Focused Node **24.19.0** verification passes **4 suites / 87 tests / 0 snapshots**. Strict TypeScript, formatting,
  whitespace checks, and targeted ESLint pass with **0 errors / ten pre-existing test style warnings**. The DB scanner
  reports **1,754 mutations / 848 moving structural or membership differences** and no `nested-coordinator` finding.
  The core/UI architecture checks pass, while the combined architecture command remains red in the concurrently edited
  scheduled-owner certificates (`backgroundSync.ts`, `send/index.ts`, `useChatScheduledCatchup.ts`, and `home.tsx`);
  this milestone does not reconcile that other session's moving work.

  This closes the prerequisite-recovery source lifetime only. No app build, device, Firebase delivery, Play, EAS,
  GitHub, remote branch, or network state changed. `REL-001` and `PUSH-RETRY-01` remain **IN_PROGRESS** for exact-device
  killed-FCM/matching-deployment evidence, and the detached attachment auto-download lifetime remains open under
  `DL-01`/`REL-001`.

- **2026-09-07 — killed-background-FCM owns a bounded app-cache auto-download tail:** Each background delivery now
  captures an absolute attachment-effect deadline at callback receipt plus 40 seconds. After FIFO admission it opens
  a generation-bound collection. `DbEventSink` invokes its post-commit hook synchronously, which registers a keyed
  `auto-download:<messageId>` factory rather than starting native work. Revisions of one message share the same task;
  collection close stops admission and runs distinct factories sequentially only after durable dispatch and
  notification presentation return.

  The native FCM callback awaits this tail outside the account-teardown tracking slot. Account invalidation, App Lock,
  transport rotation, or deadline expiry makes the composed effect/transport lease stale; deadline expiry allows at
  most two additional seconds for cooperative native cancellation. An expired active collection rejects adoption
  instead of escaping to the ordinary detached path. Headless mode deliberately persists only the Gator app-cache
  copy because `expo-media-library` exposes no abort signal.

  Focused verification under Node **24.19.0** passes **5 suites / 124 tests / 0 snapshots**. Strict TypeScript,
  configured formatting, scoped whitespace checks, and targeted production/new-test ESLint pass with zero errors.
  Independent concurrency/lifecycle review is **GO** and independently reproduced **4 suites / 98 tests** plus
  TypeScript and whitespace checks. The live DB report finds **1,755 mutations / 856 moving structural or membership
  differences** and no `nested-coordinator` defect; this checkpoint does not reconcile or claim the other session's
  moving global inventory. Core, service/UI, UI-DB, runtime-cycle, and static headless-entry architecture checks pass.
  The combined architecture command remains red only in the concurrently edited scheduled-work checker: its expected
  call shapes/fingerprints disagree with `backgroundSync.ts`, `send/index.ts`, `useChatScheduledCatchup.ts`, and
  `home.tsx`. This checkpoint leaves those other-session files and certificates untouched.

  This closes only the former detached **app-cache effect-tail source gap**. It is not a durable retry: process death
  after the DB checkpoint can still skip or interrupt the copy. A configured Gallery/Gator Album destination is not
  fulfilled on this path and has no later receipt after `localPath` is stored. The 40-second window does not bound
  preceding FIFO/dispatch/presentation or final log flushing, and native cancellation/partial cleanup still needs an
  exact Android candidate. No app build, device, Firebase delivery, Play, EAS, GitHub, remote branch, or network state
  changed. `DL-01`, `REL-001`, `SCHED-01`, and `PUSH-RETRY-01` therefore remain **IN_PROGRESS** for their recorded
  durable destination, full-callback, matching-deployment, WorkManager, hostile-server, and exact-device gates.

- **2026-09-07 — killed-FCM final log persistence has an absolute callback cutoff:** Background FCM now captures one
  callback-entry timestamp and retains separate absolute limits: 40 seconds for post-commit attachment effects and 55
  seconds for final persistent-log settlement, leaving five seconds before RNFB's Android callback ceiling. The log
  sink adopts serialized work that predates the barrier, owns its newly queued work, suppresses owned debounce/retry
  continuations, and revokes asynchronous native-file mutation authority before an expired public wait returns.

  One persistent owner remains discoverable for the complete three-attempt headless session. If a newer, shorter
  callback overlaps it, cancellation therefore reaches both the older current attempt and every possible later retry
  child; it cannot regain write authority between attempts. Later independent Clear, timer, and callback owners remain
  outside the older scope. Wall-clock guards also cover promise resumption before a deadline timer dispatches. Expo's
  already-entered synchronous file calls remain inherently non-interruptible.

  Focused verification under Node **24.19.0** passes **3 suites / 86 tests / 0 snapshots**. Strict TypeScript, exact
  five-file ESLint, configured formatting, diff whitespace checks, the **20/20** architecture-boundary test, and the
  live core/service/UI-DB/runtime-cycle/headless-entry boundary scan pass. Two independent lifecycle/concurrency
  reviews are **GO**; one independently reran the direct logging suite at **41/41**. The shared moving DB inventory
  reports **1,755 mutations / 880 structural or membership differences**, so this checkpoint neither reconciles nor
  claims that other session's global certificate. The combined architecture command remains red only in concurrently
  edited scheduled-work expectations/fingerprints; those files and certificates remain untouched.

  This is host/source evidence only. Earlier FIFO admission, dispatch, and presentation can consume the whole window
  before finalization starts, and a synchronous native call cannot be recalled after entry. No app build, device,
  Firebase delivery, Play, EAS, GitHub, remote branch, or network state changed. Parent `REL-001` therefore remains
  **IN_PROGRESS** for the whole-callback bound and exact `adb shell am kill` Android proof.

- **2026-09-08 — `FEAT-03` completes its currently implementable source scope:** The app and server now preserve
  bounded exact part topology and received reply/reaction part identity through normalization, migration
  `0047_message_retraction_topology`, persistence, and every action/retry boundary. The shared retraction classifier
  keeps proven surviving text and attachments visible consistently across bubbles, inbox/search, notifications, and
  attachment-cache ownership. Supported iMessage contact-card replies retain their selected message GUID and exact part
  through durable queue admission and the endpoint. Whole-message Google Messages reactions use part zero only for a
  proven `rcs-*` target and do not advertise unsupported RCS reply threading.

  The RCS text-plus-one-attachment path is capability-gated and owns one logical optimistic/retry identity; older
  servers fail closed without discarding authored composer state. Focused app/server host tests cover topology,
  retraction survivors, action targets, contact replies, combined RCS sends, whole-message reactions, and capability
  fallback. This is not device or deployment evidence. A matching staged server and packaged Android candidate must
  still prove the supported RCS cross-repository paths. Server follow-up `FP-006` permanently retires the
  helper-dependent iMessage combined-send positive for this release, so it is no longer a completion requirement.
  Parent `FEAT-03` therefore remains **IN_PROGRESS** only for the matching RCS device proof.

- **2026-09-08 — the current-tree disposable Android DB/backup matrix refreshes physical evidence
  through migration `0047`:** A locally built debug APK (`9498df4c3370612400febcab2f90affcb7cf04949c1f17ee45159e1e12cd7724`)
  ran on the physical API-36 arm64 Samsung. The DB contract passed **28/28**; process relaunch passed
  **7/7 READY, 12/12 final, 3/3 host**; active-WAL write death passed **9/9, 12/12, 5/5**;
  active-migration death passed **11/11, 15/15, 6/6**; runtime concurrency passed **22/22 + 3/3
  host**; and backup/restore passed **22/22 + 3/3 host**. All **158/158** retained booleans are true
  in the privacy-safe artifacts written between `2026-09-09T04:09:53Z` and `04:11:27Z`. Every lane
  used and cleaned its fixed disposable database; none targeted `gator.db`.

  This refresh satisfies the stale unchecked post-v56 `DB-02C` line in the device checklist but does
  not change authoritative task statuses: `DB-02C`, the controlled `DB-03A/B` children, and
  `BACKUP-02` were already **DONE**; power-loss/torn-write, genuine scheduled CI, signed upgrade,
  exact release-candidate, and production-file proofs remain open under their existing owners. The
  installed native metadata is local-debug `0.1.41`/version-code 1, and these database lanes do not
  prove FEAT-03 against a matching staged server.

  Ordinary app startup also reported that the preserved development `gator.db` lacks
  `pending_retraction_part_index` even though current code expects it. This is consistent with that
  phone having applied an earlier in-development shape of migration `0047` while the uncommitted
  migration was still changing; the device data was deliberately not cleared. Back up or replace
  that disposable development install before ordinary interactive feature QA. This observation is
  not evidence against the fresh disposable current-tree migration contract, which passed on the
  fixed throwaway databases above.

- **2026-09-15 — `TLS-02` selects and proves system-CA-only HTTPS trust:** Owner decision `DEC-12`
  excludes authorities added through Android Settings. An Expo config plugin now generates one
  app-wide `src="system"` trust-anchor policy and its manifest reference while preserving only the
  static cleartext allowance required by `TLS-00`'s separate in-app consent gate. The artifact guard
  follows the compiled manifest id through the AAB resource table to the actual runtime-selected
  protobuf XML, rejecting aliases, qualifiers, disabled/multiple values, extra rules, and competing
  references. Manual setup, Storage & Privacy, README, workstream, release, and post-remediation copy
  state the selected boundary and record user-CA support as optional future `POST-TLS-02` work.

  A local nondebuggable release APK and AAB built from the recorded source checkpoint. On the exact
  APK installed to a disposable API-35 emulator, a CA visibly installed in Android's user store was
  rejected with three certificate-unknown alerts, zero completed TLS sessions, and zero HTTP
  requests. With that CA still installed, a public system-CA endpoint reached one authenticated
  server-info request. The focused guard passed **17/17**, the two UI-copy suites passed **5/5**, and
  strict TypeScript passed. Exact Play v64 retains the unchanged public-CA multi-transport and bare
  self-signed baseline but predates this explicit policy; a compact repeat on the next exact Play
  candidate remains in the release checklist. The complete local Android guard's unrelated missing
  Maps-key and native absolute-path failures remain visible. Exact identities, limits, and cleanup
  are in [`TLS_02_SYSTEM_CA_DEVICE_PROOF_2026-09-15.md`](../TLS_02_SYSTEM_CA_DEVICE_PROOF_2026-09-15.md).
  `TLS-02` is **DONE**; the primary register is now **45 DONE / 51 IN_PROGRESS / 3 BLOCKED / 8 TODO**,
  leaving **62 of 107** remediation tasks open.

- **2026-09-15 — `DL-01` closes its remaining host/source gaps for destination receipts and wallpaper
  admission:** An eligible incoming non-sticker image with a configured Gallery/Gator Album
  auto-download now requires a bounded encrypted destination receipt before starting the
  private-cache transfer. Pending receipts are fulfilled after the authoritative `localPath`
  commits; completed receipts permit cache repair without a second export; missing, terminal,
  mismatched, ineligible, full, or failed receipt admission refuses the automatic transfer. This
  preserves later eligible foreground retry without making the uncancellable MediaStore operation
  part of a killed-FCM callback.

  Synced wallpapers now perform a strict native pre-admission pass before directory creation or network I/O. The
  pass must prove at most **90 MiB / 255 files**, leaving room for one bounded **10 MiB / one-file** transfer beneath
  the final **100 MiB / 256-file** ceiling. Its streaming, no-follow traversal recognizes only the current and legacy
  owned layouts, caps one scan at **8,192 files / 32,768 nodes**, protects the active wallpaper, and fails closed on
  malformed, unreadable, symlinked, raced, deletion-failed, or overflowing state. Android API 24/25 fail closed
  before NIO construction; the product/min-SDK decision remains open.

  Focused Node 24 verification passes **4 suites / 85 tests / 0 snapshots**. The Kotlin cache-policy suite passes
  **17/17**, and release Kotlin compilation succeeds. Strict TypeScript, touched-file ESLint and Prettier, whitespace,
  migration (**48 sequential migrations; 5/5 guard tests**), architecture (**52/52 guard tests plus live boundary
  scans**), and the DB fast scanner (**91 passed / 13 intentionally skipped / 0 failed**) pass. Inventory
  reconciliation is exact at **1,961 mutations / 0 structural or membership errors / 0 line shifts / 0 rekeys / 0
  additions**. The already-run full Node project also passes **348 suites / 4,171 tests**, with one suite and one test
  intentionally skipped. Independent review is **GO** with no high- or medium-severity finding; its one low-severity
  malformed-native-result hardening request was implemented and covered by the focused rerun.

  [Exact v66 Play-extracted split bytes, sideloaded onto a clean API-35 emulator](../DL_01_SUPPORTING_V66_DOWNLOAD_PROOF_2026-09-15.md),
  supplied supporting valid/invalid image-download evidence, but that run
  predates these receipt and strict-admission changes and is not closure evidence. `DL-01` therefore remains
  **IN_PROGRESS** until a fresh exact candidate proves destination receipt drain/restart and bounded duplicate
  behavior; strict wallpaper admission; the remaining hostile-server, cancellation, low-storage, image-bomb,
  process-death/restart, legacy-upgrade, account-isolation, and physical DB/file assertions; and the API 24/25
  support decision. No Play release, store state, production server, or physical-phone app data changed in this
  checkpoint.

- **2026-09-15 — Exact Play v67 packages the current `DL-01` source but supplies only a narrow
  candidate/lifecycle checkpoint:** Release `0.1.50` / code `67`, built from `2c7f426` and released
  at `12a4592`, reached Google Play Internal Testing with live status `completed`. Play updated the
  owner-enrolled Samsung/API-36 phone from v66 without uninstall or app-data clearing. The existing
  session remained, and an ordinary `adb shell am kill` followed by App Lock biometric retry returned
  to Messages with zero scoped fatal/ANR/native-crash markers. Installed split and bundle inspection
  found the current strict wallpaper-admission markers.

  The [sanitized v67 proof](../DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md) deliberately gives no
  `DL-01` behavioral checkbox credit: no hostile staged transport, active-download kill, destination
  receipt/MediaStore ordering, private DB/filesystem assertion, cache or wallpaper near-quota state,
  low-storage/cancellation/image-bomb case, or API24/25 disposition ran. Production conversations
  were not used as fixtures. `DL-01` remains **IN_PROGRESS**, `DEVICE-01` remains **BLOCKED**, and the
  primary register at that checkpoint stayed **45 DONE / 51 IN_PROGRESS / 3 BLOCKED / 8 TODO**;
  the current register at the top of this file supersedes that historical count.

- **2026-09-15 — `DELETE-SYNC-01` device closure:** The exact-build stopped-process/reconnect and
  App-Lock/unlock branches both passed on the physical Android 16 Samsung, using the same source as
  the host-green atomic v2 ledger implementation. The owner explicitly deferred pruning and the
  separate mutable-message/global-hard-delete/recovery protocol ideas rather than misrepresenting
  them as current lossless behavior. The item is **DONE**; detailed evidence and provenance live in
  [`DELETE_SYNC_DEVICE_RUNBOOK.md`](../DELETE_SYNC_DEVICE_RUNBOOK.md).

- **2026-09-18 — `DL-01` v75 checkpoint exposes an install-provenance tail:** Play-delivered version
  `0.1.55` / code `75` passed the API-36 boundary smoke. The same Google-generated, Play-signed APK
  passed the scoped synthetic hostile-transport, cancellation, ordinary process-death, low-storage,
  Gallery/Gator Album receipt, image-validation, wallpaper, visible Disconnect/reconnect cleanup,
  aggregate reconciliation, and API-37 checks, but it was sideloaded because that Google-APIs AVD has
  no Play Store or tester account. The current evidence rule makes that matrix supporting-only. The
  [sanitized checkpoint](../DL_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md) records exact limits,
  provenance, observations, final Welcome/public-media cleanup, and exclusions. `DL-01` remains
  **IN_PROGRESS** pending a genuine Play-installed API-37 repeat or an explicit owner scope transfer;
  the primary register remains **47 DONE / 49 IN_PROGRESS / 3 BLOCKED / 8 TODO**, leaving **60 of
  107** remediation tasks open.

- **2026-09-18 — `DL-01` closes under the owner-approved evidence split:** The physical Samsung's
  Play-installed v75 build passed all five scoped groups: hostile transport, cache/lifecycle,
  Gallery/Gator Album destination behavior, image validation, and synced wallpapers. Supporting
  Play-signed API-37 evidence supplies current-latest compatibility, low-storage refusal, full
  aggregate reconciliation, and the bounded three-attempt post-MediaStore fault case; controlled
  host/native tests retain destructive private-state, exact-quota, and receipt-before-byte proof.
  The Samsung was neither filled nor rooted, and its whole-report capture failed twice, so the proof
  reports separately observed top/bottom aggregates rather than claiming one successful capture.
  The API-37 install remains truthfully labeled a sideload. The owner transferred genuine per-OS
  Play-install provenance to `DEVICE-01`/release; prepared upgrade, distinct-account, and general
  staged-device work remain there. `DL-01` is **DONE**; the primary register is now **48 DONE / 48
  IN_PROGRESS / 3 BLOCKED / 8 TODO**, leaving **59 of 107** remediation tasks open.

- **2026-09-18 — `IPC-01` and `SHARE-01` close on the exact Play-v75 migration boundary:** Two
  natural Google Play code-53→75 migrations supplied complementary proof. The first retained the
  same pinned legacy shortcut across replacement, captured it before the first v75 foreground
  launch, and then observed generic disablement plus repeat-cleanup idempotence. The second began
  with a visibly distinct synthetic bitmap avatar; Play unexpectedly launched `MainActivity` during
  replacement, and the attributed post-launch dump showed the same launcher-owned pinned ID with
  its bitmap, private label, deep link, and Direct Share category removed before disablement. Exact
  v75 package validation/autolinking, four inbound resolver negatives, and an outbound attachment-
  share control passed. The synthetic pin, files, fixture mapping, app data, temporary Contacts
  grant, and Play device setting were cleaned up; fresh Play v75 remains installed with Contacts
  denied and no shortcut rows. The [sanitized proof](../IPC_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md)
  preserves the evidence and its limits. `REL-005B` receives only the shortcut-system-state
  subproof and remains **IN_PROGRESS** for the full A→disconnect→B wipe. The primary register is now
  **50 DONE / 46 IN_PROGRESS / 3 BLOCKED / 8 TODO**, leaving **57 of 107** remediation tasks open.

- **2026-09-18 — `ENV-01` closes with authenticated named-environment proof:** The retained
  project-scoped plaintext `GATOR_ENVIRONMENT_PROBE` has separate, distinct values matching
  `development`, `preview`, and `production`. Pinned EAS CLI 21.5.0 `env:exec` selected and matched
  each value without reading secret values, starting a build, submitting an artifact, or using a
  phone. The existing exact Node 24.19.0/npm 11.17.0 controlled smoke passed all four local,
  CI/development, preview, and production lanes; its focused suite passed **19/19** and the
  documentation guard passed **5/5**. `ENV-01` is **DONE**; the primary register is now **51 DONE /
  45 IN_PROGRESS / 3 BLOCKED / 8 TODO**, leaving **56 of 107** remediation tasks open.

- **2026-09-18 — `PKG-01` closes on the exact Play-v75 native boundaries:** Frozen source
  `546750a` resolves all seven reviewed versions exactly; the pre-install/toolchain guard passes
  **19/19**, and the retained isolated `npm ci`, clean production build, hash-bound AAB validation,
  autolinking, manifest, and DEX evidence prove the five Android package registrations while direct
  community WebView and retired share-intent packages remain absent. The accepted v75 download run
  supplies end-to-end encrypted Firebase receive/decrypt/process evidence after ordinary process
  death. A final synthetic physical-phone smoke rendered and refocused one native Google marker,
  showed attribution and its callout, completed the external Maps handoff/return, and exposed zero
  WebViews. Cleanup returned Gator to onboarding and removed the fixture/reverse mapping. Current
  Doctor is truthfully **19/20** because 27 non-boundary SDK 57 packages now have newer recommended
  patches; that broader dynamic recommendation remains open on the release checklist and did not
  change the frozen lockfile. The [sanitized proof](../PKG_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md)
  records the exact scope. `PKG-01` is **DONE**; the primary register is now **52 DONE / 44
  IN_PROGRESS / 3 BLOCKED / 8 TODO**, leaving **55 of 107** remediation tasks open.

- **2026-09-24 — `FEAT-01` closes with host and API-36 Samsung evidence:** The existing focused
  inbox repository, real sheet, and route suites pass **3 suites / 53 tests**. They cover every
  choice branch across the five independent axes, a five-axis conjunction before the page limit,
  versioned persistence, Apply/Cancel/Reset, and the legacy sender-policy lock. On an SM-S938U1
  running local debug `0.1.51`, the iMessage-filtered inbox exposed **87 distinct opaque row
  identities** across the initial view plus eight deep-scroll snapshots. A row first seen only in
  the ninth snapshot was reversibly muted, appeared under `iMessage + Muted`, retained its read
  state, and disappeared immediately without refresh when unmuted; the truthful filtered-empty
  state then rendered. `Direct + iMessage` and the **2 active** badge survived a real process stop
  (`PID 32448` gone) and fresh process (`PID 2823`), with both exact radio selections restored from
  the encrypted preference. The original filter and mute states were restored.

  Samsung TalkBack was bound with touch exploration while the pre-existing Bitwarden accessibility
  service remained enabled. Real accessibility focus highlighted the Group radio, activation moved
  selected state from Direct to Group, and the draft remained unapplied. No audible-wording claim is
  made. A later live accessibility-event collector interfered with focus and opened an existing HTTPS
  link in Vivaldi; it was stopped immediately, performed no send/save/data mutation, and all original
  accessibility settings were restored exactly. Device testing also exposed and fixed the DEV-only
  Home overlay: it is now a safe-area-aware normal-flow footer, and account removal routes through
  Settings' confirmation instead of a direct destructive action. Its focused route suite passes
  **1 suite / 16 tests**. The post-change common Gate B passes strict TypeScript, zero-warning source
  lint, configured formatting, and full Jest (**491 suites passed / 2 intentionally skipped; 5,812
  tests passed / 2 intentionally skipped; 0 snapshots**). The current shared-worktree DB inventory
  report is not claimed green: it reports **1,992 findings / 670 structural or membership errors**,
  including one missing `sendVoice` candidate outside the touched files. Independent closure review
  is **GO**. This is local debug evidence only; `PERF-02`, release-candidate, and Play-install work
  remain separate.

- **2026-09-25 — Accessibility/TalkBack requirements leave remediation scope; `FEAT-04` closes:** By explicit owner
  decision, `A11Y-01`, `A11Y-02`, and `A11Y-03` are **DROPPED**, not marked complete. Existing accessibility code,
  completed host tests, and dated evidence remain in the repository, but TalkBack, screen-reader, Accessibility
  Scanner, Reduce Motion, dynamic-font/large-text, and accessibility-specific device proof are no longer acceptance
  gates. Older statements that such proof “remains open” are historical and superseded. Fifteen accessibility-only
  `DEVICE-01B3/B4` fields are retired, reducing that retained exact-candidate matrix from 131 to **116** fields;
  ordinary keyboard/layout, visual-readability, and account-isolation checks remain. `UI-01`, `FEAT-07`, and
  `FEAT-08` remain open only for their named non-accessibility evidence. `FEAT-04` had no other residual: API-36
  CRUD/order/membership/badges/search/relaunch/delete/restore, focused keyboard/inset behavior, exact native op-sqlite
  folder query plans, and **4 suites / 8 focused host tests** passed, so it is **DONE**. Security/privacy controls that
  prevent private data from entering the Android accessibility tree remain required. The primary register is now
  **55 DONE / 39 IN_PROGRESS / 3 BLOCKED / 6 TODO / 4 DROPPED**, leaving **48 of 107** remediation tasks open.

- **2026-09-27 — `FEAT-08` closes on the owner's U.S.-English-only scope:** The product does not claim translated
  locale or right-to-left support. Existing `en-XA`, `ar-XB`, and root-direction helpers remain development-only code;
  their presence does not create pseudo-locale or RTL acceptance work. The typed U.S.-English catalog, stable-key
  contribution rules, exact runtime-value separation, and English singular/plural behavior remain the supported
  foundation. No production source was changed for this decision.

  Under pinned Node **24.19.0**, the focused Welcome, Connect, Manual, Scan, Syncing, and Permissions component proof
  passes **6 suites / 16 tests / 0 snapshots**. A disposable `0.1.51-debug` run on the Android 16/API-36 Samsung
  SM-S938U1 confirmed system locale `en-US` with no per-app override. Welcome, Connect, Scan's camera-permission
  explanation, Manual Connection, and its inert `http://example.test` warning rendered ordinary readable English,
  navigated correctly, showed no pseudo-text markers, and had no visible clipping in the reviewed portrait screen.
  No camera permission, server connection, credential, personal conversation, Play data, or production state was
  used. `FEAT-08` is **DONE**; the primary register is now **57 DONE / 38 IN_PROGRESS / 3 BLOCKED / 5 TODO / 4
  DROPPED**, leaving **46 of 107** remediation tasks open.

- **2026-09-27 — `UI-01` closes with focused contrast proof and Play-v78 visual review:** Under pinned Node
  **24.19.0**, the focused theme, sent/received mention, outgoing iMessage/SMS/RCS bubble, filled-button,
  unread-badge, and swipe-action checks pass **7 suites / 113 tests / 0 snapshots**. Their exact runtime assertions
  require at least 4.5:1 and choose the foreground from the background that is actually rendered.

  The Google-Play-installed version-code 78 candidate (`0.1.57`) ran on the Android 16/API-36 Samsung SM-S938U1.
  Private-reviewed screenshots covered Settings and the inbox under both enabled presets, OLED Dark and Gator:
  fixed and secondary copy, selected-theme marks, actions, search, service labels, and unread-count badges remained
  visible. A safe direct route to the candidate's unchanged Connect screen showed the production filled action using
  dark readable text on the bright blue and green preset accents. One owner-selected existing chat supplied a
  read-only visual check of ordinary outgoing and received bubbles; no draft was entered and no message was sent,
  edited, or otherwise changed. No approved synthetic candidate mention row existed, so no personal mention
  screenshot is claimed; the explicit rendered sent/received mention suites provide that named acceptance proof.
  The original OLED Dark selection was restored, temporary screenshots were deleted after review, and no credential,
  account, permission, or server state changed. `UI-01` is **DONE**; the primary register is now **58 DONE / 37
  IN_PROGRESS / 3 BLOCKED / 5 TODO / 4 DROPPED**, leaving **45 of 107** remediation tasks open.

- **2026-09-27 — `THEME-01A` closes on the Play-v78 dark-only matrix:** The Google-Play-installed `0.1.57` /
  version-code-78 package ran on the Android 16/API-36 Samsung SM-S938U1 in three-button navigation. Recorded cold
  starts covered OLED Dark and Gator under both Android light and dark appearance. Every branch retained a black
  splash and dark first paint, readable status glyphs, and a dark or theme-matched navigation bar with light buttons;
  the white OS-light navigation bar previously exposed by Play v77 did not recur. Each preset persisted, and Settings
  stayed dark under both Android appearance inputs. Android light is only a regression-test condition, not a supported
  app light theme.

  Under pinned Node **24.19.0**, the focused native-appearance, navigation-theme, enabled-preset,
  provider-rendering, and theme-store gate passes **5 suites / 33 tests / 0 snapshots**. No production code changed:
  Play v78 already contains the audited native navigation-bar fix. The phone's original Android dark setting and OLED
  Dark selection were restored, ordinary screen timeout was restored, all temporary private recordings/screenshots/UI
  hierarchies were deleted from the Mac and phone, and no message, credential, permission, account, or server state
  changed. This task-scoped v78 proof does not rebind the frozen v77 release checklist. `THEME-01A` is **DONE**; the
  primary register is now **59 DONE / 36 IN_PROGRESS / 3 BLOCKED / 5 TODO / 4 DROPPED**, leaving **44 of 107**
  remediation tasks open.

- **2026-09-27 — `HANDLE-COLOR-01` closes on device-owned selection and Samsung proof:** Inbound server colors are
  ignored; the current-account editor writes only an exact `(address, service)` member and offers Default plus seven
  fixed colors. Ordered JSON projections preserve participant alignment, readable foregrounds cover avatars and
  received bubbles, backup v4 carries a bounded exact-identity set, older restores preserve local choices, and
  migration `0051` normalizes the legacy column and adds its export index. Independent high-risk review returned
  **GO**. Focused Node proof passed **5 suites / 66 tests**, the Settings component suite passed **1 / 44**, the final
  certificate-adjacent rerun passed **4 / 61**, strict TypeScript and migrations passed, and no HANDLE nested writer
  was found.

  On the Android 16/API-36 Samsung SM-S938U1 running disposable `0.1.51-debug`, Pale yellow and Navy reacted
  immediately in Settings and avatar/inbox presentation. Pale yellow survived a force-stop cold relaunch plus DEV
  re-seed; a Mom fixture rendered readable dark text on its pale received bubble; both touched fixtures were reset to
  Default. This is local-development evidence, not a Play or release-candidate claim. Repository-wide inventory
  reconciliation remains explicitly unclaimed while unrelated held FEAT-06 runtime certificates make scanner
  contexts fail closed. `HANDLE-COLOR-01` is **DONE**; the primary register is now **60 DONE / 35 IN_PROGRESS / 3
  BLOCKED / 5 TODO / 4 DROPPED**, leaving **43 of 107** remediation tasks open.

- **2026-09-27 — `ANDROID-02` closes on a frozen packaged candidate and Samsung replay:** The final design places
  Welcome, Connect, Manual, Scan, Syncing, and Permissions inside one nested headerless `ExperimentalStack`. Finishing
  Permissions therefore replaces one outer `(setup)` route with `(app)` instead of asking Fabric to commit several
  setup pops together. Direct authenticated recovery to `/permissions` remains unanchored. The build guard now freezes
  all three route-layout boundaries and passes **23/23**.

  Isolated source `6244127` produced a nondebuggable embedded-bundle release APK for the disposable `.debug` package,
  113,876,637 bytes, SHA-256 `276a6bd733e2ecc0d39262accdedb95c9f620ea4590e0874039a22fd275321ae`;
  Gradle passed **1,561 tasks (71 executed)**. On the Android 16/API-36 Samsung SM-S938U1, a committed setup Back
  returned Connect to Welcome, Permissions completion reached Messages in the same process, root Back reached the
  Samsung launcher, and relaunch returned to Messages. Logcat contained no fatal or non-top-pop marker. The Play
  version-code-78 production package remained untouched.

  Pinned-Node-24 full Jest passes **493 suites / 5,865 tests** with two intentional skips; strict TypeScript,
  architecture **51/51**, migrations **5/5** over 49 sequential migrations, formatting, and focused lint pass.
  The frozen-candidate diagnostic DB report retains 334 pre-existing inventory issues across 2,016 mutations; after
  surgical integration, the unrelated moving shared tree reports 2,060 mutations / 1,579 issues. No finding belongs
  to the setup-layout/guard slice, and neither report is misrepresented as clean. Independent review is **GO**, and
  the detailed proof records the rejected sequencing attempts and exact native error. `ANDROID-02` is **DONE**; the
  primary register is now **61 DONE / 34 IN_PROGRESS / 3 BLOCKED / 5 TODO / 4 DROPPED**, leaving **42 of 107**
  remediation tasks open.

- **2026-09-28 — `THEME-01B` leaves remediation scope by owner decision:** The owner wants OLED Dark and Gator as
  the only supported presets and does not want a light theme. The optional audited light/system axis is therefore
  **DROPPED**, not completed; no production code, build, device, Play, server, or external state changed. Completed
  `THEME-01A` remains the truthful dark-only product promise. The primary register is now **61 DONE / 34 IN_PROGRESS /
  3 BLOCKED / 4 TODO / 5 DROPPED**, leaving **41 of 107** remediation tasks open.

- **2026-09-28 — `FEAT-07` closes on an exact Play-v78 isolated Android matrix:** The Play-installed Samsung package
  supplied the unmodified `com.bluegreengatorapps.messages` `0.1.57` / version-code-78 split set used on a disposable
  Android 17/API-37 arm64 emulator. The source package reported `com.android.vending`; the installed base and
  arm64/en/xxhdpi split SHA-256 values were respectively `9106d086…d96a420`, `d502bb7f…bdc5fdd`,
  `d233e0c8…b870ef38`, and `09bfdfdf…a9363c37`, with Play signer certificate SHA-256
  `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`. The package has min/target SDK 36; the
  same Play-v78 identity remained installed on the Android 16/API-36 Samsung while the isolated fixture work stayed
  off that personal app and its data. This task-scoped candidate evidence does not rebind the separately frozen
  release checklist or close `DEVICE-01`.

  A production-shape authenticated fixture staged 55 iMessage rows: 52 documents, two valid PNGs, and one real
  14,704,688-byte H.264/AAC MP4. Shared Documents exposed `50+`, grew through the final page, and opened the oldest
  `52-oldest-page.pdf`. A valid PDF showed Download→Retry after one controlled 503→Open on the second request, then
  rendered through the system PDF viewer from Gator's read-only FileProvider `content://` URI. Removing the fixture
  reverse after that download still reopened the cached PDF with no third request. The valid VCF reached Google
  Contacts' import screen from a `text/vcard` FileProvider grant without importing it. Android's viewer requested the
  password for the encrypted PDF and rendered it after the staged `gator` password; the malformed PDF was accepted by
  the viewer activity and then rejected back to Gator. The exact 6 MiB PDF arrived once at `6,291,456` bytes, matched
  the staged SHA-256 `bf97bc50…e2045`, and rendered. These are bounded transfer/handoff observations; the external apps still own
  document parsing, password behavior, retention, and offline rendering.

  The two-image fullscreen gallery paged from `2 of 2` to `1 of 2`; Share opened Android's chooser for the selected
  item, and Save displayed `Saved to Photos` and created the exact 128-byte Gator-owned MediaStore copy. Starting Save
  on the still-remote MP4 exposed `Downloading media to save…` at 4% and 100%, then created an exact 14,704,688-byte
  external copy. The app-private MP4 SHA-256
  `974c0a037493e9ac4229f14267f5df64de68ca2307b4d8b0382cef2fc98168c7` matched the staged source. Android Media3
  reported `PLAYING` with advancing positions for both fullscreen and in-chat players. Deleting only that synthetic
  private cache file produced `Media file unavailable` plus Retry; copy-on-write recovery fetched the same hash under
  a new filename. After a second controlled deletion, a cold app start repaired the stale DB path; the bubble then
  said `Video, not downloaded`. Tapping Share caused exactly one new full-byte request before Android's chooser
  opened. This proves the separate remote Save and remote Share continuations rather than inferring one from the other.

  The opt-in fixture leaves the existing DL-01 default unchanged, rejects incompatible FCM/RCS options, bounds and
  validates the supplied MP4, redacts status, and isolates hidden routes. Its focused Node suite passes **17/17**;
  strict TypeScript and the DB-write report pass with **2,121 mutations / 0 structural or membership errors**.
  Independent review returned **GO**. Natural no-handler, unavailable native action, and permission-denial branches
  were not manufactured and remain conditional, not acceptance gates; accessibility-specific proof was removed by
  owner decision. The two exact synthetic MediaStore rows, disposable app data, fixture, reverse, and emulator were
  removed after verification. `FEAT-07` is **DONE**; the primary register is now **65 DONE / 30 IN_PROGRESS / 3
  BLOCKED / 4 TODO / 5 DROPPED**, leaving **37 of 107** remediation tasks open.

- **2026-09-28 — `SHARE-02` closes on the owned intake and Samsung lifecycle matrix:** Product-owned
  `gator-share-intake` and `gator-share-shortcuts` provide bounded durable capture and opaque, account-fenced Direct
  Share targeting without restoring `expo-share-intent`. Focused native/host proof passed 29/29 intake cases, the
  final 3/3 token cases, 2 JavaScript suites / 31 tests, 2 settlement Node suites / 51 tests, 3 settlement component
  suites / 133 tests, strict TypeScript, and the exact 21-record SHARE DB certificate. The SHARE-owned exact-AAB
  boundary passed 3/3; the separately deferred Maps metadata and reviewed native-symbol path findings still keep the
  full Android release guard red.

  A real version-code-1→2 `adb install -r` preserved first-install time. Across the upgraded debug and connected
  embedded-release surfaces, all ten conservative generic/Direct Share text, image, real-video, PDF, and two-image
  route pairs reached review exactly once and were cleared or discarded without sending. The exact release then
  passed its required fresh-install/background replay and a final killed relaunch retained no composer or batch.
  With the owner present, App Lock cleared personalized targets, hid a killed-app image share behind the lock gate,
  and delivered one attachment only after fingerprint authentication; the batch was discarded, App Lock returned to
  its original off state, and another killed relaunch replayed nothing. The disposable provider app, isolated
  loopback fixture, exact reverse, and every matching temporary proof file were removed. `SHARE-02` is **DONE**; the
  primary register is now **66 DONE / 30 IN_PROGRESS / 3 BLOCKED / 3 TODO / 5 DROPPED**, leaving **36 of 107**
  remediation tasks open. The sanitized evidence is in
  [`SHARE_02_DEVICE_PROOF_2026-09-28.md`](../SHARE_02_DEVICE_PROOF_2026-09-28.md).
