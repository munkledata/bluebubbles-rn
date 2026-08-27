# Release checklist

This is the short, operational checklist for one Android release candidate. The authoritative
engineering backlog and release dispositions live in
[`docs/WORK_PLAN_2026-08-03.md`](./docs/WORK_PLAN_2026-08-03.md). Current Internal Testing preparation
lives in [`docs/STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](./docs/STORE_01G_INTERNAL_TESTING_RUNBOOK.md);
[`docs/DEVICE_VERIFICATION_CHECKLIST.md`](./docs/DEVICE_VERIFICATION_CHECKLIST.md) is retired v56
history and is not executable evidence for v57. Do not copy status from an older build into this
file. Section 0 is the current private Internal Testing gate; Sections 1–7 remain the broader
Closed/Open/Production release gate.

Record the candidate before testing:

- Version/build number: `0.1.41 (versionCode 57)`
- Git commit: `8564b348d02c4e218e8a75a6a36e265ec5740772`
- Local AAB: `gator-release-0.1.41-v57-8564b34.aab` — ignored; never commit it
- AAB SHA-256: `3ad096fe474fb35b8f0619ca9b9ac337dc3613d16a1df1f98d638176ef25be2b`
- Upload certificate SHA-256: `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`
- EAS build URL or local build log: local EAS production build on 2026-08-25; Gradle
  `BUILD SUCCESSFUL` (1,227 tasks in 4m40s); no hosted build, Play upload, or submission
- Tester/device/Android versions: `__________`
- Test date: `__________`

Retired historical candidate — static proof only: `0.1.40` / versionCode `56`, source
`5d367eb58e38126258423f1cd9ce0da42b179f7f`, AAB
`gator-release-0.1.40-v56-5d367eb.aab`, SHA-256
`926ce40c8ada2b69b093aaafb7a5f3a2a08bd7f5ae061c526c8a33b5462b9eac`. Its Play, tester,
install/update, device, notification, and cleanup evidence never transfers to the current candidate.

## 0. Private Google Play Internal Testing gate

Owner decision `DEC-11` limits the current distribution target to private testers through Google
Play Internal Testing. `STORE-01A-UGC-SAFETY`, production listing assets, and later-track policy
completion do not block this internal test; they are not waived and become gates before any Closed,
Open, or Production promotion, or earlier if Play flags the internal app.

- [ ] `eas.json` still declares `track: "internal"` as the only explicit submission track. The local
      build phase cannot submit; the separate submit phase previews by default and requires `--execute`,
      an interactive candidate-specific phrase, and reviewed operator approval. Play Console confirms
      no Closed, Open, or Production release is active before submission.
- [ ] Version/build, commit, AAB SHA-256, build provenance, tester devices, and test date are recorded
      above.
- [ ] The intended tester list, opt-in link, feedback destination, and named response owner work.
- [ ] Testers use a stable non-production server/setup path and no production-user data or credentials.
- [ ] The exact AAB installs/updates and completes the staged connect, sync, send, receive, notification,
      restart, and disconnect journeys selected for this test round.
- [ ] Every declaration or permission review that Play actually prompts for this internal artifact is
      completed truthfully; no missing prompt is treated as exempt by assumption.
- [ ] Known limitations and unfinished safety/release work are disclosed to testers, and no result from
      this internal round is described as public-release or policy-compliance evidence.

## 1. Release blockers and decisions

- [ ] Every `BLOCKER` in §3.1 of the master work plan is `DONE` for this exact commit.
- [ ] Every open `CONDITIONAL` item has its affected feature disabled, with evidence that the path
      is unreachable in this candidate.
- [ ] The owner has resolved `DEC-02` (license/ownership) and the selected license and third-party
      notices are present.
- [ ] The first-release/update strategy, halt thresholds, access, and incident owners required by
      `RELEASE-02` have been rehearsed and recorded.
- [ ] No checklist item is accepted solely because a Jest test passed; native and device items have
      candidate-specific evidence.

## 2. Toolchain, dependencies, and static gates

Run from a clean checkout with the versions declared by `.nvmrc` and `package.json`:

```sh
node --test scripts/check-workflow-security.test.mjs
node scripts/check-workflow-security.mjs
npm run check:toolchain
npm ci
npm run check:architecture
npm run check:db-writes:full
npm run check:secret-hygiene
npm run typecheck
npm run lint -- --max-warnings=0
npm run format:check
npm run check:migrations
npm test -- --runInBand
npm test -- --runInBand
CI=1 ./node_modules/.bin/expo install --check
npm run doctor
npm audit --audit-level=high
npm audit --omit=dev --audit-level=high
npm ls --depth=0
GOOGLE_SERVICES_JSON=./test/fixtures/google-services.ci.json \
  ./node_modules/.bin/expo export --platform android --output-dir dist-ci
```

- [ ] The workflow supply-chain, architecture-boundary, and secret-hygiene guards pass their tests
      and live scans.
- [ ] Both complete Jest runs pass; neither has order-dependent failures or unexpected console noise.
- [ ] Expo dependency validation and the pinned Doctor pass without ignored findings.
- [ ] Full and production dependency audits have no unreviewed high/critical advisory.
- [ ] The production Android Expo export completes with `__DEV__` false.
- [ ] The lockfile is unchanged after the clean install.

## 3. Environment and credentials

- [ ] `GOOGLE_SERVICES_JSON` is configured as an EAS **file** variable in the `development`,
      `preview`, and `production` environments and matches the Android application id.
- [ ] A non-secret smoke variable proves that each named EAS environment selects the intended values.
- [ ] No `.env`, Firebase config, signing key, service-account file, password, token, or local build
      artifact is present in the uploaded source bundle.
- [ ] Android signing and Play submission credentials are available to the release owner and are not
      stored in Git.
- [ ] Production error reporting is either deliberately disabled or uses a reviewed redacting sink;
      there is no hidden telemetry or placeholder credential.

## 4. Clean native candidate

For a future candidate only—not to rebuild the frozen candidate recorded above—run each phase
separately and review its receipt before continuing:

```sh
npm run release:android:preflight -- --version <x.y.z> --source <full-sha>
npm run release:android:prepare -- --run <run-id>
npm run release:android:build -- --run <run-id> --execute --confirm-remote-version-increment
npm run release:android:validate -- --run <run-id>
npm run release:android:promote -- --run <run-id>
npm run release:android:submit -- --run <run-id>
# Only after explicit upload approval:
npm run release:android:submit -- --run <run-id> --execute
```

Use `dist/release/<run-id>/validation.json` and `promotion.json` for the version, exact source,
environment, size, SHA-256, and upload-certificate record. Do not infer identity from a filename or
from the remote EAS version counter. A local build still contacts EAS and may consume a remote
`versionCode` before compilation finishes, so a failed build run is never retried silently.
If preparation, build, or submission is interrupted, use
`npm run release:android:reconcile -- --run <run-id>`. Safely rerun validation or promotion from
their recorded state. Reconciliation never invokes EAS or submits an artifact.

Build from a clean generated Android project. CI must perform the equivalent checks before release:

```sh
GOOGLE_SERVICES_JSON=./test/fixtures/google-services.ci.json \
  npx expo prebuild --platform android --clean --no-install
npx expo-modules-autolinking search -p android
cd android
./gradlew \
  :gator-paste-input:compileDebugKotlin \
  :gator-share-shortcuts:compileDebugKotlin \
  :gator-bounded-download:compileDebugKotlin \
  :app:assembleDebug \
  :app:bundleRelease \
  --no-daemon
cd ..
npm run check:android-build
```

- [x] All three local Expo modules are discovered by autolinking and compile through Expo's aggregate
      Android module during the app builds.
- [x] The candidate is a new signed native build; this project does not currently ship
      `expo-updates` or EAS update channels.
- [x] The release bundle/export completes with production behavior (`__DEV__` false).
- [x] The generated entry still registers FCM, notification, and background tasks before
      `expo-router/entry`.
- [x] The final AAB manifest, not only `app.config.ts`, passes the permission/share-target/headless
      guard.
- [x] `WRITE_CONTACTS`, `READ_MEDIA_AUDIO`, `SCHEDULE_EXACT_ALARM`, `USE_EXACT_ALARM`, and
      `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` are absent from the AAB.
- [ ] Every remaining dangerous permission maps to a visible feature and a runtime request.
- [ ] The AAB hash at the top of this file is computed after all checks and is the artifact uploaded
      to Play.

## 5. Network and security smoke tests

- [ ] Connect to a valid public-CA HTTPS server; verify server info/full sync, one live socket event,
      one upload, and one download.
- [ ] An untrusted/self-signed certificate is rejected unless Android itself trusts its issuer.
- [ ] Product copy is explicit that the app uses Android's normal TLS validation and does **not**
      claim certificate pinning. An inert legacy `certPins` SecureStore value on an upgraded install
      is harmless because no code reads it.
- [ ] On the exact candidate, traffic capture proves a forged/rejected `new-server` event cannot
      persist, contact, or send credentials to another origin or downgrade HTTPS. An approved
      rotation displays both origins and requires foreground confirmation, a freshly entered
      password, and separate cleartext consent when applicable; interruption cannot mix old/new
      credentials. The host flow is included in source commit `8564b34` and candidate versionCode
      `57`; exact Android network and SecureStore behavior remains unproven.
- [ ] URL previews make no automatic third-party request. Exercise the enabled preview fallback and
      record proxy/network-capture evidence.
- [ ] Find My and any other WebView surface passes its hostile-input, navigation, and real-device
      network checks, or is disabled in the candidate.
- [ ] Logs, notifications, channels, alarms, Recents, and screenshots expose no hidden identity,
      message text, server URL, credential, or raw internal identifier in privacy mode.

## 6. Android/device matrix

Complete the detailed device checklist using the exact AAB. At minimum:

- [ ] Fresh install and upgrade from the latest shipped build both boot and preserve intended data.
- [ ] Connect, full sync, send, receive, edit/unsend, react, attach, retry, search, and local delete work.
- [ ] Kill with `adb shell am kill <package>` (never `am force-stop` for delivery testing); an FCM push
      writes to the encrypted DB and posts the expected notification.
- [ ] Notification privacy transitions, actions, reminders, channels, killed/background/foreground
      taps, and FaceTime alerts pass with no stale private system state.
- [ ] App Lock, generic locked notifications, Android Recents, biometric resume, account switch, and
      forget/wipe pass.
- [ ] IPC-01 containment passes: the exact candidate's merged manifest, AAB, and autolinking contain
      no inbound `SEND`/`SEND_MULTIPLE` filter, Direct Share target, or `expo-share-intent`; after
      startup clears shortcuts cached by an older build, neither Gator nor conversation chips appear
      in Android share sheets for text or files.
- [ ] Ordinary outbound sharing, such as exporting a backup or sharing downloaded media, still opens
      Android's share sheet through `expo-sharing`.
- [ ] Keyboard/navigation-bar behavior passes gesture and three-button navigation.
- [ ] Dark appearance, contrast, large text, TalkBack labels/focus order, reduced motion, and supported
      display sizes pass. The store listing makes no light/system-theme promise.
- [ ] Permission denial, restricted battery settings handoff, offline/reconnect, low-storage, and
      process-death paths fail visibly and recover.

### Historical pre-v57 DEV host evidence

These four DEV results stop at the then-current migration head `0038`; they do not include migration
`0039_message_error_message` and give no current-v57 or exact-AAB credit.

- The local API-35 arm64 DEV V3 lane passed the disposable SQLCipher/op-sqlite/Drizzle contract:
  exact then-current production migrations `0001`–`0038`, per-migration `0030` rollback/retry over an
  audited head-`0029` fixture, plus encrypted logical fixtures for the reviewed repository heads
  `0024` and `0027`. The earlier fixtures close, reject the wrong key, verify read-only, and apply
  their exact tails through `0038`; production FTS triggers, integrity/idempotency, all three
  adapter routes, rekey/reopen, old-key rejection, and cleanup also pass.
- The local API-35 arm64 DEV relaunch lane proved one controlled process boundary on a separate
  fixed throwaway database: process A is alive with its encrypted handle retained at READY, the
  harness force-stops it and observes no process, process B has a different PID, and B verifies
  the existing head-`0029` state read-only before applying `0030`–`0038` and cleaning up.
- The local API-35 arm64 DEV active-WAL lane proved one controlled ordinary-write crash on a third
  fixed throwaway database: process A commits the baseline, checkpoints WAL, leaves a bounded
  uncommitted transaction open, and emits READY; the host observes physical WAL growth, crashes
  that exact process, and requires distinct process B to prove the exact baseline-only state
  read-only before recovery commit, read-only reopen, and exact database/sidecar/marker cleanup.
- The local API-35 arm64 DEV active-migration lane proved one controlled post-statement crash on a
  fourth fixed throwaway database: process A prepares exact head `0037` and an exact 133-row
  fixture, then emits READY only after the exact production migration `0038` `UPDATE` resolves
  inside its open transaction while the ledger remains at `0037` and before ledger insert/commit.
  The host proves WAL beyond its header before and after crashing exact A; distinct B first proves
  the exact original head-`0037` state read-only, then retries exact `[0038]`, verifies persistence,
  and cleans all eight fixed paths. This is not statement-in-flight evidence.

### Current v57 native/device proof

- [ ] The exact release candidate and a supported physical device repeat the native contract and
      pass the crypto self-test, fresh install plus an actual signed prior-build install-over,
      spontaneous process death, active-migration crash, power-loss/torn-write recovery, and
      production-file continuity checks. The local DEV logical fixtures and controlled active-WAL and
      active-migration crashes do not establish Play/store artifact provenance and do not satisfy
      this final release item, scheduled-CI evidence, or physical-device proof.

## 7. Store, policy, and rollout

- [ ] Store screenshots and copy match this exact build and disclose the Android-only, dark-only,
      third-party-server-client product accurately.
- [ ] Privacy policy/data-safety answers match observed network, notification, contact, file, crash,
      backup, and telemetry behavior.
- [ ] Contacts, full-screen intent/call behavior, foreground service, and notification declarations
      have current Play-policy justification; inbound share-target declarations are absent.
- [ ] Play pre-launch/device-catalog results have been reviewed; unsupported device classes are
      excluded or clearly documented.
- [ ] Internal testing receives the hashed candidate first; rollout follows the rehearsed staged plan.
- [ ] Named owners can halt the rollout and access logs/builds/Play/Firebase/server systems.
- [ ] After rollout begins, crash, ANR, delivery, sync, send-failure, and support thresholds are
      monitored at the agreed checkpoints.

Release decision: `GO / NO-GO`

Approver and date: `__________`
