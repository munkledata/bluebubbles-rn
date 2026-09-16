# Release checklist

This is the short, operational checklist for one Android release candidate. Remediation status lives
in [`docs/WORK_PLAN_2026-08-03.md`](./docs/WORK_PLAN_2026-08-03.md), while release-task status and
dispositions live in [`docs/RELEASE_PLAN.md`](./docs/RELEASE_PLAN.md). The superseded v63 Internal
Testing snapshot lives in
[`docs/STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](./docs/STORE_01G_INTERNAL_TESTING_RUNBOOK.md) and must
be refreshed before any current staged-server round;
[`docs/DEVICE_VERIFICATION_CHECKLIST.md`](./docs/DEVICE_VERIFICATION_CHECKLIST.md) is retired v56
history and is not executable evidence for a replacement candidate. Do not copy status from an older
build into this file. Section 0 is the next private Internal Testing gate; Sections 1–7 remain the
broader Closed/Open/Production release gate.

Current release-candidate status — **INTERNAL TESTING; broader release remains NO-GO.** The exact
replacement was built, validated, submitted only to Google Play Internal Testing, installed from
Play through a natural v66→v67 update, and exercised for one narrow ordinary-kill/App Lock resume.
The live Internal release reports `completed`; that means Play serves version code 67, not that
`STORE-01`, `DEVICE-01`, `DL-01`, or the staged journey is complete. The remaining staged-server,
device-matrix, tester-administration, policy, and rollout gates below stay open; this Internal result
is not public-release approval.

Exact replacement frozen from one release run:

- Version/build number: `0.1.50 (versionCode 67)`
- Exact source and release commits: `2c7f426e3549127972fdd5c601bf98f651a75870` /
  `12a45924a2e8b5dc998e0b56e0df6c58f8186960`; source contains `DL-01` implementation
  `9139cf72bb56d613f1b848de63fe882b2029e91a`
- Release branch/run: `release/android-0.1.50` /
  `android-0.1.50-9139cf7-20260915234900`
- Submitted AAB: `gator-release-0.1.50-v67-12a4592.aab`; the later host update removed the local
  AAB bytes and receipt directory, so neither may be described as retained or reused
- AAB size/SHA-256: `56,806,011` bytes /
  `1bec41156c38e556eb9dbe079bc0cf83ee1577d07d0912144fb0524739304702`
- Upload certificate SHA-256:
  `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`
- Submission: EAS id `67253f5c-6f5c-47a9-b669-c0ea25c4f5de`, completed; Android Publisher
  readback found Internal release `0.1.50`, version code `67`, status `completed`
- Tester/device/Android/test date: owner-enrolled Samsung, Android 16 / API 36, 2026-09-15
- Exact device receipt:
  [`docs/DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md`](./docs/DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md)

Android reports the installed v67 package came from `com.android.vending` and carries the recorded
Play app-signing certificate. Play updated v66 to v67 without uninstall or app-data clearing; the
existing session remained and an ordinary `am kill`/biometric retry returned to Messages. This is
partial update and App Lock evidence only: fresh install, full staged use, hostile downloads, private
DB/filesystem outcomes, and the remaining composite device rows are unproved. No Closed, Open,
Production, or wider-track promotion was performed.

Superseded v64 candidate — historical `TLS-00` device evidence only; no result transfers to v67
unless repeated:

- Version/build number: `0.1.47 (versionCode 64)`
- Exact source and release commits: `fa6e907beb776fc690cc392f7268d772705bf717` /
  `e22aacdca959c2e04f0a83a205bd7c012644acf6`
- Release branch/run: `release/android-0.1.47` /
  `android-0.1.47-fa6e907-20260914045445`
- AAB: `gator-release-0.1.47-v64-e22aacd.aab`; 56,150,684 bytes; SHA-256
  `b53b272a757ccb1346928787b927a2cb63dfa2edf57fe44820367a2552784178`
- Submission: Google Play Internal Testing at `2026-09-14T05:14:29.810Z`; release receipt status
  `submitted`; Play delivered version code `64` to the enrolled phone
- Device receipt:
  [`docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md`](./docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md)

V64 passed its bounded redirect, public-CA, and self-signed-certificate matrix. It predates the
current `DL-01` receipt and strict-wallpaper source, and its exact-candidate results remain historical
for v67.

Superseded v63 candidate — historical Play, `NET-01`, and `RT-01A` device evidence only; no result
transfers to v67 unless repeated:

- Version/build number: `0.1.46 (versionCode 63)`
- Source/release commits: `dc32380c6cb17d85e7ab08c4d5b9118660f763c8` /
  `a1ba9af51c46aac08f9c00e2c7c84762bb78cb2b`
- Release branch/run: `release/android-0.1.46` /
  `android-0.1.46-dc32380-20260913175233`
- AAB: `gator-release-0.1.46-v63-a1ba9af.aab`; 56,150,828 bytes; SHA-256
  `4a9c83a521b6eb20404d502b535a2001e201ae71f1a9f3a88d703aed79221a06`
- Submission: Internal Testing, EAS submission `63ddf33f-b3f1-496d-afcf-b7ee4c53a751`,
  2026-09-13
- Device receipts:
  [`docs/NET_01_PLAY_DEVICE_PROOF_2026-09-13.md`](./docs/NET_01_PLAY_DEVICE_PROOF_2026-09-13.md) and
  [`docs/RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md`](./docs/RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md)

The installed local-signature build could not update to the Play-signed v63 artifact, so it was
removed and v63 was installed from Google Play with prior permission. That historical result is
clean-install evidence, not fresh-install evidence for v67.

Superseded v62 candidate — historical Play and bounded-device evidence only; no result transfers to
v67 unless repeated:

- Version/build number: `0.1.45 (versionCode 62)`
- Source/release commits: `8179d0a3a99c4e2e28a01fd83212fee919bad41c` /
  `644a566fb54da7d2c195e369d11677acfce097ea`
- Release branch/run: `release/android-0.1.45` /
  `android-0.1.45-8179d0a-20260910075110`
- AAB: `gator-release-0.1.45-v62-644a566.aab` — 56,141,406 bytes; SHA-256
  `110efe12a0d5cc620b2a523787bb95139f3f2ddf86550449d16de7d8fcd2bd51`
- Submission: Internal Testing, `736e29d7-d0d1-48f7-8f68-6095ce240d10`, 2026-09-10
- Device receipt:
  [`docs/PLAY_INTERNAL_DEVICE_PROOF_2026-09-09.md`](./docs/PLAY_INTERNAL_DEVICE_PROOF_2026-09-09.md#replacement-candidate-closure--2026-09-10)

Version code 61 remains retired because its device run exposed the unsupported-scheme bug. V62
rejected that same synthetic setup URL and passed an ordinary-kill cold relaunch, but those results
remain historical for v67.

Superseded v59 candidate — historical static artifact proof only; no result transfers to a
replacement:

- Version/build number: `0.1.43 (versionCode 59)`
- Source commit: `7a3aa2058ad1bea4252379b2ea3df285e1fd94ef`
- Release commit/branch: `e108ad7756cf2ae67a6873cbd1e1526df0613e18` / `release/android-0.1.43` (local only)
- Release run: `android-0.1.43-7a3aa20-20260904145333`
- Local AAB: `gator-release-0.1.43-v59-e108ad7.aab` — ignored; never commit it
- AAB size/SHA-256: `55,818,682` bytes / `e2a60f7b06837b47484f71d79fccb0c585ead745a2e1a1a48952d54cd5bdc0af`
- Upload certificate SHA-256: `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`
- Build provenance: local EAS production build on 2026-09-04; Gradle `BUILD SUCCESSFUL`; validation and local promotion passed; no hosted build or submission
- Tester/device/Android versions: `[OPEN]`
- Test date: `[OPEN]`

The v59 build, validation, promotion, signing, manifest, and package-inspection records are retained
only to explain what happened on 2026-09-04. Any checklist item that requires the exact candidate,
AAB, install, Play delivery, or device behavior must be repeated for the replacement.

Superseded pre-WebView-removal candidate — static artifact proof only; do not upload, submit, or use
it as current runtime, package-removal, Play, or device evidence because it predates `4fca556`:

- Version/build number: `0.1.42 (versionCode 58)`
- Source commit containing `9046e27`: `fd02247578e928d909f0ce73c083c3cbcedffb4c`
- Release commit/branch: `7942ed5bfbdce28ecadfefc54e7bd7cdde2e57d8` / `release/android-0.1.42` (local only)
- Release run: `android-0.1.42-fd02247-20260830231420`
- Local AAB: `gator-release-0.1.42-v58-7942ed5.aab` — ignored; never commit it
- AAB size/SHA-256: `55,969,473` bytes / `ad7538bc3436eea017690801efdaa307a22a0565229c94006f7aacc278270298`
- Upload certificate SHA-256: `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`
- Build provenance: local EAS production build on 2026-08-30; Gradle `BUILD SUCCESSFUL` (1,264 tasks in 9m42s); validation and local promotion passed; no hosted build or submission

Frozen nonconforming candidate — static proof only; do not upload, submit, or use it as current
runtime evidence because it predates the approved `PLAY-02` removal in `9046e27`:

- Version/build number: `0.1.41 (versionCode 57)`
- Git commit: `8564b348d02c4e218e8a75a6a36e265ec5740772`
- Local AAB: `gator-release-0.1.41-v57-8564b34.aab` — ignored; never commit it
- AAB SHA-256: `3ad096fe474fb35b8f0619ca9b9ac337dc3613d16a1df1f98d638176ef25be2b`
- Upload certificate SHA-256: `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`
- EAS build URL or local build log: local EAS production build on 2026-08-25; Gradle
  `BUILD SUCCESSFUL` (1,227 tasks in 4m40s); no hosted build, Play upload, or submission

Retired historical candidate — static proof only: `0.1.40` / versionCode `56`, source
`5d367eb58e38126258423f1cd9ce0da42b179f7f`, AAB
`gator-release-0.1.40-v56-5d367eb.aab`, SHA-256
`926ce40c8ada2b69b093aaafb7a5f3a2a08bd7f5ae061c526c8a33b5462b9eac`. Its Play, tester,
install/update, device, notification, and cleanup evidence never transfers to a replacement candidate.

## 0. Private Google Play Internal Testing gate

Owner decision `DEC-11` limits the current distribution target to private testers through Google
Play Internal Testing. `STORE-01A-UGC-SAFETY`, production listing assets, and later-track policy
completion do not block this internal test; they are not waived and become gates before any Closed,
Open, or Production promotion, or earlier if Play flags the internal app.

- [x] `eas.json` still declares `track: "internal"` as the only explicit submission track. The local
      build phase cannot submit; the separate submit phase previews by default and requires `--execute`,
      an interactive candidate-specific phrase, and reviewed operator approval.
- [ ] Play Console confirms no Closed, Open, or Production release is active before submission.
- [x] The replacement version/build, source and release commits, AAB SHA-256, upload certificate,
      and build provenance are recorded above. The superseded v59 record does not satisfy this gate.
- [x] Tester devices, Android versions, and test date are recorded above.
- [ ] The intended tester list, opt-in link, feedback destination, and named response owner work.
- [ ] Testers use a stable non-production server/setup path and no production-user data or credentials.
- [ ] The exact AAB installs/updates and completes the staged connect, sync, send, receive, notification,
      restart, and disconnect journeys selected for this test round.
      Play v66→v67 update, boot, visible session continuity, and one ordinary-kill/App Lock resume are
      partial evidence only; no fresh install or full staged journey was run.
- [ ] Every declaration or permission review that Play actually prompts for this internal artifact is
      completed truthfully; no missing prompt is treated as exempt by assumption.
- [ ] Known limitations and unfinished safety/release work are disclosed to testers, and no result from
      this internal round is described as public-release or policy-compliance evidence.

## 1. Release blockers and decisions

- [ ] Every `BLOCKER` in §3.1 of the
      [remediation plan](./docs/WORK_PLAN_2026-08-03.md#31-release-disposition-register) is `DONE` for
      this exact commit.
- [ ] Every open `CONDITIONAL` item has its affected feature disabled, with evidence that the path
      is unreachable in this candidate.
- [ ] The owner has resolved `DEC-02` (license/ownership) and the selected license and third-party
      notices are present.
- [ ] The first-release/update strategy, halt thresholds, access, and incident owners required by
      [`RELEASE-02`](./docs/RELEASE_PLAN.md#release-02) have been rehearsed and recorded.
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

- [ ] On the frozen replacement source, the workflow supply-chain, architecture-boundary, and
      secret-hygiene guards pass their tests and live scans.
- [ ] Both replacement-source Jest runs pass; neither has order-dependent failures or unexpected
      console noise.
- [ ] Expo dependency validation and the local pinned Doctor pass 20/20 on the replacement source.
      Clean native autolinking, compilation, tests, and AAB inspection prove all five owned modules
      are present; an older EAS-worker module-directory advisory supplies no replacement credit.
- [ ] Full and production dependency audits have no unreviewed high/critical advisory on the frozen
      lockfile; every remaining lower-severity advisory has a recorded disposition.
- [ ] The replacement production Android Expo export completes with `__DEV__` false.
- [ ] The replacement lockfile is unchanged after its clean install.

## 3. Environment and credentials

- [x] `GOOGLE_SERVICES_JSON` is configured as an EAS **file** variable in the `development`,
      `preview`, and `production` environments and matches the Android application id.
- [ ] A non-secret smoke variable proves that each named EAS environment selects the intended values.
- [ ] No `.env`, Firebase config, signing key, service-account file, password, token, or local build
      artifact is present in the replacement uploaded source bundle.
- [x] The managed Android upload-signing credential produced the v67 candidate, its
      certificate is recorded above, and the credential is not stored in Git. The superseded v59
      signing result is historical only.
- [ ] Play submission credentials and live Console access are available to the release owner.
- [ ] Production error reporting is either deliberately disabled or uses a reviewed redacting sink;
      there is no hidden telemetry or placeholder credential.

## 4. Clean native candidate

V67 already completed the isolated build, validation, promotion, and separately authorized Internal
submission recorded above. The later host update removed its local artifact and receipt directory;
do not reconstruct a receipt, rerun a consumed phase, or silently reuse any superseded artifact. For
a future candidate only, run each phase separately and review its receipt before continuing:

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

The Android CI job fixes `GRADLE_USER_HOME` outside the checkout and supplies exact
`-ffile-prefix-map` plus `-fdebug-prefix-map` flags for both the checkout and Gradle cache, mapping
them to `/gator/source` and `/gator/gradle`. The release runner creates equivalent owner-only,
run-scoped directories beneath `/private/tmp`; do not inherit a caller-selected Gradle home, C/C++
flags, or retained EAS local-build workspace.

```sh
GOOGLE_SERVICES_JSON=./test/fixtures/google-services.ci.json \
  npx expo prebuild --platform android --clean --no-install
npx expo-modules-autolinking search -p android
cd android
./gradlew \
  :gator-paste-input:compileDebugKotlin \
  :gator-share-shortcuts:compileDebugKotlin \
  :gator-bounded-document:compileDebugKotlin \
  :gator-bounded-download:compileDebugKotlin \
  :gator-screen-security:compileDebugKotlin \
  --no-daemon
./gradlew \
  :gator-paste-input:testDebugUnitTest \
  :gator-share-shortcuts:testDebugUnitTest \
  :gator-bounded-document:testDebugUnitTest \
  :gator-bounded-download:testDebugUnitTest \
  :expo-file-system:testDebugUnitTest \
  --no-daemon
./gradlew :app:assembleDebug --no-daemon
./gradlew :app:bundleRelease --no-daemon
cd ..
npm run check:android-native-paths
npm run check:android-build
```

- [ ] All five local Expo modules are discovered by autolinking and compile through Expo's aggregate
      Android module during the replacement app build.
- [ ] Every discovered release/RelWithDebInfo native compiler command contains exactly one correct
      source and Gradle file/debug prefix map; the checker rejects missing, duplicate, conflicting,
      stale, symlinked, or wrong-tree evidence before AAB validation.
- [ ] The replacement candidate is a new signed native build; this project does not currently ship
      `expo-updates` or EAS update channels.
- [ ] The replacement release bundle/export completes with production behavior (`__DEV__` false).
- [ ] The replacement generated entry registers FCM, notification, and background tasks before
      `expo-router/entry`.
- [ ] The replacement AAB manifest, not only `app.config.ts`, passes the
      permission/share-target/headless guard. Its compiled manifest must reference exactly one
      unqualified `xml/network_security_config` resource, and the resource table must resolve that
      runtime value to the guarded system-CA-only compiled XML.
- [ ] `WRITE_CONTACTS`, `READ_MEDIA_AUDIO`, `SCHEDULE_EXACT_ALARM`, `USE_EXACT_ALARM`,
      `USE_FULL_SCREEN_INTENT`, and `REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` are absent from the AAB.
- [ ] Every remaining dangerous permission maps to a visible feature and a runtime request.
- [x] The v67 AAB hash at the top of this file was computed after validation and local
      promotion.
- [x] The byte-identical hashed v67 AAB is the artifact submitted to Play Internal Testing after
      separate approval.

## 5. Network and security smoke tests

- [ ] On the exact candidate, 301/302/303/307/308 responses are rejected before a second request for
      ordinary JSON API traffic and active legacy upload traffic. Test same-origin, cross-origin,
      and HTTPS-to-HTTP destinations and prove no request body or credential reaches the redirect
      target. Bind the candidate to source containing `ce0b8c0` or a reviewed descendant and confirm
      that the removed raw `HttpClient` FormData transport and its attachment-send wrapper remain
      absent; do not recreate a dormant runtime path solely to test it. Superseded exact Play v64
      passed both 15-case matrices with zero target contact at the frozen checkpoints; the source scan and
      separate reachability controls are recorded in
      [`docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md`](./docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md).
      That result has not been repeated on v67.
- [ ] Connect to a valid public-CA HTTPS server; verify server info/full sync, one live socket event,
      one upload, and one download. Superseded exact Play v64 completed those paths through the isolated fixture
      recorded in
      [`docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md`](./docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md),
      but v67 has not repeated it.
- [ ] A bare untrusted/self-signed certificate is rejected. Superseded exact Play v64 completed no TLS session
      or HTTP request and sent no Authorization header or body; the trusted Mac control reached HTTP 200. See
      [`docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md`](./docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md).
      V67 has not repeated this boundary.
- [x] The `TLS-02` source/build boundary and disposable API-35 emulator prove the selected policy:
      the AAB's manifest resource id resolves through `resources.pb` to one unqualified compiled XML
      that trusts only `src="system"`; an authority installed in Android's user store was rejected
      with three certificate-unknown TLS alerts and zero HTTP requests, while a public system-CA
      endpoint reached the authenticated server-info request. This local debug-signed release is
      remediation evidence, not exact Play-candidate evidence. See
      [`docs/TLS_02_SYSTEM_CA_DEVICE_PROOF_2026-09-15.md`](./docs/TLS_02_SYSTEM_CA_DEVICE_PROOF_2026-09-15.md).
- [x] Product copy states that HTTPS trusts Android's built-in system authorities, excludes
      authorities added in Android Settings, and does **not** claim certificate pinning. An inert
      legacy `certPins` SecureStore value on an upgraded install is harmless because no code reads
      it. Removal commit `66869d3` is an ancestor of v67 source `2c7f426`; exact-tree scans found no
      pinning API/dependency or certificate-validation bypass. This is source/static evidence, not a
      v67 device repeat of the next row.
- [ ] On the replacement exact Play candidate, repeat the selected `TLS-02` boundary: a public
      system-CA endpoint succeeds and an authority visibly installed in Android's user store is
      rejected before TLS completes or credentials/body reach HTTP. This is a release repeat, not
      open remediation implementation.
- [ ] On the exact candidate, traffic capture proves a forged/rejected `new-server` event cannot
      persist, contact, or send credentials to another origin or downgrade HTTPS. An approved
      rotation displays both origins and requires foreground confirmation, a freshly entered
      password, and separate cleartext consent when applicable; interruption cannot mix old/new
      credentials. Superseded Play v63 passed cleartext reject/approve, approved-origin persistence,
      held late-result rejection, native interrupted-SecureStore fail-safe recovery, and
      Android-trusted HTTPS-to-HTTP downgrade rejection with zero trap TCP contact before and after
      `am kill`. Exact identities, counters, limits, and cleanup are recorded in
      [`docs/RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md`](./docs/RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md).
      Superseded exact Play v64 displayed and cancelled one isolated-fixture proposal during its TLS smoke, but
      the full candidate-specific rotation matrix has not been repeated.
- [ ] On superseded Play v63, automatic preview text and optional JPEG/PNG data images used only the
      authenticated bounded Gator-server proxy. The controlled 20-case matrix, app-UID destination
      observation, server request ledger, duplicate coalescing, original-URL tap, limitations, and
      cleanup are recorded in
      [`docs/NET_01_PLAY_DEVICE_PROOF_2026-09-13.md`](./docs/NET_01_PLAY_DEVICE_PROOF_2026-09-13.md).
      That historical device result has not been repeated on exact Play v67.
- [ ] The exact map-enabled candidate keeps Find My marker data bounded/inert, contains exactly one
      Maps API-key metadata value matching the release preflight digest, omits phone-location
      permissions, leaves Google Maps attribution unobscured, and passes online/outage,
      focus/background/App-Lock, TalkBack, fallback, and controlled network checks.
- [ ] The replacement clean isolated build, guarded autolinking, and exact-AAB inspection continue
      to confirm that the app-owned `react-native-webview` package/native registration is absent. The
      superseded v59 packaged DEX omitted
      `Lcom/reactnativecommunity/webview/RNCWebViewPackage;`, but that historical inspection does not
      satisfy this gate. Expo’s transitive `@expo/dom-webview`/`DomWebViewModule` remains
      framework-owned and is not evidence of a reachable product surface.
- [ ] Logs never expose message text, server URLs, credentials, or raw internal identifiers;
      notifications, channels, and alarms honor App Lock's generic-notification boundary, while
      Recents and screenshots honor its protected-screen boundary without leaking identity or message
      content.

## 6. Android/device matrix

Candidate-specific device work has begun for v67: Play delivery, the natural v66→v67 update, visible
session continuity, packaged current-`DL-01` markers, and one ordinary-kill/App Lock biometric resume
were observed on the recorded Samsung/API-36 device. `DEVICE-01` still owns the unproved matrix below
for this exact AAB; superseded v64 `TLS-00`, v63 `NET-01`/`RT-01A`, and earlier results must not be
used as v67 evidence. V67 satisfies the prerequisite of containing the current `DL-01` receipt and
strict-wallpaper source, but it did not execute any of the five behavioral rows tagged `DL-01` below.
The superseded v64 and supporting sideloaded v66 runs do not transfer to those rows. Remaining work
includes:

- [ ] Fresh install and upgrade from the latest shipped build both boot and preserve intended data.
      Only the Play v66→v67 update, boot, and visible session continuity passed; the fresh-install half
      and private data/cache invariants remain open.
- [ ] Connect, full sync, send, receive, edit/unsend, react, attach, retry, search, and local delete work.
- [ ] After v67 has a fresh scoped V3 enrollment against the isolated compatible staged server in
      the Internal Testing runbook, kill with `adb shell am kill <package>` (never `am force-stop`
      for delivery testing); a compatible per-device-encrypted FCM push writes to the encrypted DB
      and posts the expected notification.
- [ ] Notification privacy transitions, actions, reminders, channels, killed/background/foreground
      taps, and FaceTime alerts pass with no stale private system state.
- [ ] App Lock, generic locked notifications, Android Recents, biometric resume, account switch, and
      forget/wipe pass. Only an ordinary-kill relaunch, a failed first biometric attempt, and a
      successful owner-authenticated retry back to Messages passed on v67.
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
      process-death paths fail visibly and recover. V67 recovered visibly from one ordinary process
      kill with zero scoped fatal/ANR/native-crash markers; the other cases and any active-download
      process death remain open.
- [ ] `DL-01` Gallery/Gator Album receipt proof uses that fresh replacement candidate and an eligible
      incoming non-sticker image: a background/killed delivery performs no immediate Photos write,
      and DB/filesystem/native observation proves the encrypted destination receipt commits before
      any native partial or final download bytes are created. The private-cache file and
      authoritative `localPath` then commit before an active/unlocked/connected foreground drain
      with existing permission exports it. Repeated drains normally do not duplicate; denied
      permission opens no passive prompt; destination/off changes cancel pending work; and
      controlled stops after each MediaStore success but before receipt completion prove the
      three-total-attempt ceiling: at most two duplicate copies after the first saved copy.
- [ ] `DL-01` ordinary attachment transport proof uses false smaller/larger lengths, missing length,
      chunked and endless bodies, a stalled response, actual-byte overflow, deadline expiry, native
      cancellation, and process kill/restart. Every refusal leaves no abandoned partial, promoted
      file, or false `localPath`; startup cleanup removes interrupted partials; a valid bounded
      control still commits exactly once.
- [ ] `DL-01` ordinary cache proof fills toward **2 GiB / 4,096 files** and the **512 MiB free-space
      floor**. Failed/raced deletion remains charged and refuses unsafe admission; recent, mounted,
      in-flight, and outgoing/retry inputs survive eviction. Zero-byte completion recovery, legacy
      two-level adoption/promotion, canonical account-generation layout, two-account isolation, and
      account cleanup each converge without cross-account deletion or ledger/DB disagreement.
- [ ] `DL-01` image validation rejects an oversized/invalid image and image-bomb dimensions without
      committing a wallpaper or attachment path, while a valid bounded image succeeds. Low-storage,
      cancellation, and process-death cases preserve both the file quota and authoritative DB state.
- [ ] `DL-01` synced-wallpaper proof starts near 90 MiB/255 files, protects the current wallpaper,
      admits one maximum 10 MiB transfer, and finishes at or below 100 MiB/256 files. Corrupt,
      unreadable, symlinked, raced, numerically overflowing, failed-delete, or scan-count-over-limit
      state (more than 8,192 files or 32,768 nodes) refuses admission; ordinary quota excess is
      pruned when safe. Record the Android 7/API24–25 disposition. The sideloaded exact-v66-split
      API-35 valid/invalid image run predates this native admission boundary and is
      [supporting evidence only](./docs/DL_01_SUPPORTING_V66_DOWNLOAD_PROOF_2026-09-15.md).
- [ ] The exact candidate's backup picker/provider path accepts a near-limit document, rejects an
      oversized stream even when the provider lies about size, times out a stalled provider, cancels
      without continuing work, deletes every partial copy, and leaves the UI responsive.

### Historical pre-v57 DEV host evidence

These four DEV results stop at the then-current migration head `0038`; they do not include migration
`0039_message_error_message` and give no replacement-candidate or exact-AAB credit.

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

### Current post-v57 hosted DEV supporting evidence

- Manual GitHub Actions
  [`workflow_dispatch` run 33476443641](https://github.com/munkledata/bluebubbles-rn/actions/runs/33476443641)
  built and ran exact source `80a44d309030c80410e110ab2f5b5b7c119146a9` on an API-36 x86_64 emulator. The
  current 44-migration registry ended at `0044_custom_folder_unread_badge`; the disposable contract passed **28/28**,
  relaunch passed **7/7 READY / 12/12 final / 3/3 host**, active-WAL death passed **9/9 / 12/12 / 5/5**, and
  active-migration death passed **11/11 / 15/15 / 6/6**. All **108/108** retained report booleans were true. The
  configured 2026-09-01 07:17 UTC schedule occurrence remained unobserved through 08:17:09 UTC, so child
  `DB-03C1-SCHEDULED-ANDROID-CI` remains open until one genuine `event=schedule` run passes and its reports are
  validated.

### Replacement candidate native/device proof

- [ ] The exact release candidate and a supported physical device repeat the native contract and
      pass the crypto self-test, fresh install plus an actual signed prior-build install-over,
      spontaneous process death, active-migration crash, power-loss/torn-write recovery, and
      production-file continuity checks. The local and manually dispatched hosted DEV fixtures and controlled
      active-WAL and active-migration crashes do not establish Play/store artifact provenance and do not satisfy this
      final release item, the still-unproved genuine schedule event, or exact-candidate physical-device proof.

## 7. Store, policy, and rollout

- [ ] Store screenshots and copy match this exact build and disclose the Android-only, dark-only,
      third-party-server-client product accurately.
- [ ] Privacy policy/data-safety answers match observed network, Google Maps/FCM provider,
      notification, contact, file, crash, backup, and telemetry behavior; approved end-user terms
      contain the required Google Maps terms and privacy destinations.
- [ ] Contacts, foreground service, and notification declarations have current Play-policy
      justification; `USE_FULL_SCREEN_INTENT` and inbound share-target declarations are absent, and
      incoming-call copy promises only heads-up capability.
- [ ] Play pre-launch/device-catalog results have been reviewed; unsupported device classes are
      excluded or clearly documented.
- [ ] Internal testing receives the hashed candidate first; rollout follows the rehearsed staged plan.
- [ ] Named owners can halt the rollout and access logs/builds/Play/Firebase/server systems.
- [ ] After rollout begins, crash, ANR, delivery, sync, send-failure, and support thresholds are
      monitored at the agreed checkpoints.

Release decision: `GO / NO-GO`

Approver and date: `__________`
