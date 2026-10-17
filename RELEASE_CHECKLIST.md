# Release checklist

This is the short, operational checklist for one Android release candidate. Remediation status lives
in [`docs/WORK_PLAN_2026-08-03.md`](./docs/WORK_PLAN_2026-08-03.md), while release-task status and
dispositions live in [`docs/RELEASE_PLAN.md`](./docs/RELEASE_PLAN.md). The superseded v63 Internal
Testing snapshot lives in
[`docs/STORE_01G_INTERNAL_TESTING_RUNBOOK.md`](./docs/STORE_01G_INTERNAL_TESTING_RUNBOOK.md) and must
be refreshed before any current staged-server round;
[`docs/DEVICE_VERIFICATION_CHECKLIST.md`](./docs/DEVICE_VERIFICATION_CHECKLIST.md) is retired v56
history and is not executable evidence for a replacement candidate. Its explicitly labelled Play-v78
`UI-01` and `THEME-01A` observations are task-scoped only and do not rebind this checklist's exact v77
candidate. Do not copy status from an older build into this file. Section 0 is the next private
Internal Testing gate; Sections 1–7 remain the broader Closed/Open/Production release gate.

Current frozen release-checklist status — **INTERNAL TESTING; broader release remains NO-GO.** Exact
v77 was built, validated, and submitted only to Google Play Internal Testing; that submission
reports `completed`. Play `0.1.57` / version code `78` is now the latest live Internal artifact, but
its `PERM-01`, `UI-01`, and `THEME-01A` results are task-scoped and this checklist has not been
rebound to it. A newer `0.1.58` / code `79` artifact was successfully submitted to Internal Testing,
then Play-updated the enrolled Android 16/API 36 Samsung from v78 to v79 after a short propagation
delay. The non-debuggable arm64 split passed only Welcome-screen cold/hot/ordinary-kill relaunch
smoke; it has no Android Publisher readback, authenticated staged journey, installed-certificate
inspection, or broader matrix and does not rebind this checklist. A Play-installed Android 16/API 36
Samsung has a narrow v77 killed-FCM and
attachment-download result, but not the full candidate journey or installed-split signature result.
The superseded Play-delivered v75 passed the five-group `DL-01` matrix on a physical Android 16/API 36
Samsung; its Play-signed, sideloaded Android 17/API 37 compatibility result remains supporting-only.
Under the owner-approved split, `DL-01` stays done, while v77 Play/device provenance belongs to
`DEVICE-01`/release. Historical v75 checkmarks below do not transfer exact-device credit to v77.
The staged-server, device-matrix, tester-administration, policy, and rollout gates remain open;
Internal availability is not public-release approval.

Exact replacement frozen from one release run:

- Version/build number: `0.1.56 (versionCode 77)`
- Exact source and release commits: `da05b66cfcbd9b3c35ebd6d0ec3ba0ed781bf7d0` /
  `694d65bce9effde40a50c100e264cc50d0ef594b`
- Release branch/run: `release/android-0.1.56` /
  `android-0.1.56-da05b66-20260919025209`
- Submitted AAB: `gator-release-0.1.56-v77-694d65b.aab`
- AAB size/SHA-256: `57,879,683` bytes /
  `ba85e8356be306bd8d820ef0f09ed4cb5a9781afb2e601d76b792a9bf843f6d2`
- Upload certificate SHA-256:
  `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`
- Submission: EAS id `e7ca0440-81f3-40a0-ae6e-b05f2c52e59b`, finished; Android Publisher readback
  at `2026-09-19T03:18:57Z` found only Internal release `0.1.56`, code `77`, status `completed`
- Tester/device/Android/test date: Samsung SM-S938U1, Android 16/API 36, 2026-09-18 local
- Exact v77 device slice: Play update and clean Play reinstall of code 77; disposable loopback
  connection, ordinary `am kill`, encrypted FCM process restart, one completed background attachment
  request, then one DB attachment row/local path and zero active transfers. A warm-background
  WorkManager run executed and contacted the fixture, but two forced runs after `am kill` started
  processes without executing native `doWork` or proving durable work. Installed-split signature
  inspection remains open because local `apksigner` crashed with Java `SIGBUS`; `REL-001`/`DEVICE-01`
  remain open.

The first 0.1.56 build consumed code 76 and failed in Gradle without an artifact or submission. A
separate diagnostic reproduced D8 Java-heap exhaustion at 2 GiB; the committed bounded 4 GiB fix
passed the diagnostic and this exact signed v77 build. The current AAB passed identity, signature,
hash, Maps-key, and native-path validation. No Closed, Open, Production, or wider-track promotion
occurred. The prior Play v75 Samsung update and five-group `DL-01` pass remain in the
[`v75 device proof`](./docs/DL_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md), not as v77 runtime proof.

Superseded v75 candidate — historical scoped `DL-01`, `IPC-01`, `SHARE-01`, and `PKG-01` evidence:
`0.1.55` / code `75`, source `546750a`, release `9c73c1f`, submitted AAB SHA-256
`86e7ee236f2caa644e97b645fc9d0ec1fa562fc105ffa5bb26549d44f42b3197`. Play naturally
updated the Samsung from code 73 to 75 without data clearing. Its Play-signed API-37 sideloaded
matrix remains supporting-only. Those owner-approved task completions remain done, but fresh v77
install, prepared private-cache upgrade, staged use, and broader device rows remain open.

Superseded v67 candidate — historical natural-update/App Lock evidence only; no result transfers to
v77 unless the owning row explicitly combines it:

- Version/build `0.1.50` / `67`, source `2c7f426`, release `12a4592`.
- Play naturally updated v66 to v67 on API 36 and one ordinary-kill/App Lock resume passed.
- The recorded limitations remain in
  [`docs/DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md`](./docs/DL_01_PLAY_V67_DEVICE_PROOF_2026-09-15.md).

Superseded v64 candidate — historical `TLS-00` device evidence only; no result transfers to v77
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
for v77.

Superseded v63 candidate — historical Play, `NET-01`, and `RT-01A` device evidence only; no result
transfers to v77 unless repeated:

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
clean-install evidence, not fresh-install evidence for v77.

Superseded v62 candidate — historical Play and bounded-device evidence only; no result transfers to
v77 unless repeated:

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
remain historical for v77.

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
- [x] A v77 tester device, Android version, and test date are recorded above; the v75 device record
      remains historical.
- [ ] The intended tester list, opt-in link, feedback destination, and named response owner work.
- [ ] Testers use a stable non-production server/setup path and no production-user data or credentials.
- [ ] The exact AAB installs/updates and completes the staged connect, sync, send, receive, notification,
      restart, and disconnect journeys selected for this test round.
      The historical Play build-73→75 update, boot, visible session continuity, and scoped `DL-01`
      journey are task evidence only. The v77 Play install and narrow killed-FCM slice above do not
      complete the general staged journey.
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
      The historical exact v75 rerun reported 19/20 plus a failing `expo install --check` because 27
      non-`PKG-01` SDK 57 packages now have newer recommended patches; the frozen lockfile was
      unchanged. This remains a release follow-up, as recorded in the
      [bounded package proof](./docs/PKG_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md).
- [ ] Full and production dependency audits have no unreviewed high/critical advisory on the frozen
      lockfile; every remaining lower-severity advisory has a recorded disposition.
- [ ] The replacement production Android Expo export completes with `__DEV__` false.
- [ ] The replacement lockfile is unchanged after its clean install.

## 3. Environment and credentials

- [x] `GOOGLE_SERVICES_JSON` is configured as an EAS **file** variable in the `development`,
      `preview`, and `production` environments and matches the Android application id.
- [x] Project-scoped plaintext `GATOR_ENVIRONMENT_PROBE` is retained with distinct matching values in
      `development`, `preview`, and `production`; authenticated pinned EAS CLI 21.5.0 `env:exec` checks passed
      without fetching secret values or starting a build.
- [ ] No `.env`, Firebase config, signing key, service-account file, password, token, or local build
      artifact is present in the replacement uploaded source bundle.
- [x] The managed Android upload-signing credential produced the v77 candidate, its
      certificate is recorded above, and the credential is not stored in Git. The superseded v59
      signing result is historical only.
- [ ] Play submission credentials and live Console access are available to the release owner.
- [ ] Production error reporting is either deliberately disabled or uses a reviewed redacting sink;
      there is no hidden telemetry or placeholder credential.

## 4. Clean native candidate

V77 completed the isolated build, validation, promotion, and separately authorized Internal
submission recorded above. Its exact local runner receipts are retained under `dist/release/`;
do not rerun a consumed phase or silently reuse a superseded artifact. The failed code-76 run is
terminal and never produced an uploadable AAB.
For a future candidate only, run each phase separately and review its receipt before continuing.
Preflight refuses a `--source` commit that is not on GitHub or has no passing CI run, so push the
source and wait for CI first:

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

Validation first checks that `unzip`, `jarsigner` and `keytool` run; a missing local tool stops it
with the run still `built`, so install the tool and rerun validate. Validation refuses an AAB that
the pinned upload certificate did not sign (`EXPECTED_UPLOAD_CERTIFICATE_SHA256` in
`scripts/release-android.mjs`; update it in a reviewed change only if the upload key is reset in
Play Console).

Use `dist/release/<run-id>/validation.json` and `promotion.json` for the version, exact source,
environment, size, SHA-256, and upload-certificate record. Do not infer identity from a filename or
from the remote EAS version counter. A local build still contacts EAS and may consume a remote
`versionCode` before compilation finishes, so a failed build run is never retried silently.
If preparation, build, or submission is interrupted, use
`npm run release:android:reconcile -- --run <run-id>`. Safely rerun validation or promotion from
their recorded state. Reconciliation never invokes EAS or submits an artifact. Whenever a build
leaves its EAS workspace on disk (kept for inspection after a failed native-path proof or receipt
binding, a workspace cleanup that fails, or an interrupted build that reconcile closes), the runner
first deletes the signing keystore and `credentials.json` from it, says what it deleted, and points
to `npm run release:android:cleanup -- --run <run-id>` for the rest.

Build from a clean generated Android project. CI must perform the equivalent checks before release:

The Android CI job fixes `GRADLE_USER_HOME` outside the checkout and supplies exact
`-ffile-prefix-map` plus `-fdebug-prefix-map` flags for both the checkout and Gradle cache, mapping
them to `/gator/source` and `/gator/gradle`. The release runner creates equivalent owner-only,
run-scoped directories beneath `/private/tmp`; do not inherit a caller-selected Gradle home, C/C++
flags, or retained EAS local-build workspace.

The two packaging commands pass `-PreactNativeArchitectures` because React Native and Hermes build
from source in their own included Gradle build, which ignores `android/gradle.properties`; without
the flag they compile all four ABIs, which pushed the CI Android job past two hours. EAS builds,
including the local release runner's, get the same flag from each profile's `gradleCommand` in
`eas.json`, which `npm run check:toolchain` pins to EAS's default task plus the profile's ABIs.

```sh
GOOGLE_SERVICES_JSON=./test/fixtures/google-services.ci.json \
  npx expo prebuild --platform android --clean --no-install
npx expo-modules-autolinking search -p android
cd android
./gradlew \
  :gator-paste-input:compileDebugKotlin \
  :gator-share-shortcuts:compileDebugKotlin \
  :gator-share-intake:compileDebugKotlin \
  :gator-bounded-document:compileDebugKotlin \
  :gator-bounded-download:compileDebugKotlin \
  :gator-screen-security:compileDebugKotlin \
  --no-daemon
./gradlew \
  :gator-paste-input:testDebugUnitTest \
  :gator-share-shortcuts:testDebugUnitTest \
  :gator-share-intake:testDebugUnitTest \
  :gator-bounded-document:testDebugUnitTest \
  :gator-bounded-download:testDebugUnitTest \
  :expo-file-system:testDebugUnitTest \
  :expo-task-manager:testDebugUnitTest \
  :expo-background-task:testDebugUnitTest \
  :react-native-screens:testDebugUnitTest \
  --no-daemon
./gradlew :app:assembleDebug -PreactNativeArchitectures=arm64-v8a,x86_64 --no-daemon
./gradlew :app:bundleRelease -PreactNativeArchitectures=arm64-v8a --no-daemon
cd ..
npm run check:android-native-paths
npm run check:android-build
```

- [ ] All six local Expo modules are discovered by autolinking and compile through Expo's aggregate
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
- [x] The v77 AAB hash at the top of this file was computed after validation and local
      promotion.
- [x] The byte-identical hashed v77 AAB is the artifact submitted to Play Internal Testing after
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
      That result has not been repeated on v77.
- [ ] Connect to a valid public-CA HTTPS server; verify server info/full sync, one live socket event,
      one upload, and one download. Superseded exact Play v64 completed those paths through the isolated fixture
      recorded in
      [`docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md`](./docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md),
      but v77 has not repeated it.
- [ ] A bare untrusted/self-signed certificate is rejected. Superseded exact Play v64 completed no TLS session
      or HTTP request and sent no Authorization header or body; the trusted Mac control reached HTTP 200. See
      [`docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md`](./docs/TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md).
      V77 has not repeated this boundary.
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
      it. Removal commit `66869d3` is an ancestor of v77 source `da05b66`; prior exact-tree scans
      found no pinning API/dependency or certificate-validation bypass. This is source/static
      evidence, not a v77 device repeat of the next row.
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
      That historical device result has not been repeated on exact Play v77.
- [ ] The exact map-enabled candidate keeps Find My marker data bounded/inert, contains exactly one
      Maps API-key metadata value matching the release preflight digest, leaves Google Maps
      attribution unobscured, never asks for the phone's location from Find My, and passes
      online/outage, focus/background/App-Lock, fallback, and controlled network checks. Exact Play v75
      passed the narrower native render/attribution/focus/fallback subset for `PKG-01`; the broader
      release matrix remains open. See the
      [bounded package proof](./docs/PKG_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md).
- [ ] The exact candidate declares coarse/fine foreground location for the explicit Current Location
      action, omits background location and `FOREGROUND_SERVICE_LOCATION`, and presents confirmation
      before Android's prompt. On a supported one-to-one conversation, prove approximate and precise
      success, plus denial, cancellation/backgrounding, services-off, acquisition-error, and
      15-second-timeout paths with no queue row or server request. Prove that a successful coordinate
      is encrypted at rest, retry reuses that exact snapshot without reacquisition, and no retry is
      attempted at or after 15 minutes. Reconcile the exact privacy screen, Play Data Safety answers,
      foreground-service declaration, merged manifest/AAB, and installed `dumpsys package`; historical
      no-location-permission candidates do not satisfy this gate.
- [x] The replacement clean isolated build, guarded autolinking, and exact-AAB inspection confirm
      that the app-owned `react-native-webview` package/native registration is absent. Exact v77 DEX
      omits `Lcom/reactnativecommunity/webview/RNCWebViewPackage;`; the Play-v75 map hierarchy
      historically contained zero WebViews, but v77 has no phone hierarchy proof. Expo’s transitive
      `@expo/dom-webview`/`DomWebViewModule` remains framework-owned and is not evidence of a
      reachable product surface. See the
      [bounded package proof](./docs/PKG_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md).
- [ ] Logs never expose message text, server URLs, credentials, or raw internal identifiers;
      notifications, channels, and alarms honor App Lock's generic-notification boundary, while
      Recents and screenshots honor its protected-screen boundary without leaking identity or message
      content.

## 6. Android/device matrix

Historical exact v75 completed all five scoped `DL-01` groups on the Play-installed API-36 Samsung.
Supporting API-37 behavior and controlled host/native evidence cover its private fault branches,
not v77 device behavior. The owner explicitly transferred per-OS Play-install
provenance—including a future genuine Play-installed API-37 repeat—to `DEVICE-01`/release, so the
five `DL-01` rows are closed without relabeling the sideloaded API-37 run. `DEVICE-01` still owns
every unchecked general row; superseded task-specific results transfer only where their owning task
explicitly says so. Remaining work includes:

- [ ] Fresh install and upgrade from the latest shipped build both boot and preserve intended data.
      The natural Play build-73→75 update, boot, and visible session continuity passed; the
      fresh-install half and prepared private data/cache invariants remain open.
- [ ] Connect and full sync work; existing-chat iMessage plain text/local read-unread-delete and
      supported RCS text/contact/media/whole-message reaction, retry, search, and receive flows pass.
      Retired helper-backed edit/unsend/reply/attachment actions remain absent.
- [ ] After v77 has a fresh scoped V3 enrollment against the isolated compatible staged server in
      the Internal Testing runbook, kill with `adb shell am kill <package>` (never `am force-stop`
      for delivery testing); a compatible per-device-encrypted FCM push writes to the encrypted DB
      and posts the expected notification. The v75 download run proves Google acceptance plus
      killed-process receive/decrypt/process behavior for `PKG-01`; it did not separately inspect the
      encrypted row or expected notification, so this broader release row remains open. See the
      [bounded package proof](./docs/PKG_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md).
- [ ] Notification privacy transitions, supported actions, reminders, channels, and
      killed/background/foreground taps pass. An upgrade removes any stale FaceTime notification,
      route, or channel state and never recreates call presentation.
- [ ] App Lock, generic locked notifications, Android Recents, biometric resume, account switch, and
      forget/wipe pass. Only an ordinary-kill relaunch, a failed first biometric attempt, and a
      successful owner-authenticated retry back to Messages passed on historical v67.
- [x] `IPC-01` task containment passed on exact-v75 packaged validation and autolinking: no inbound
      `SEND`/`SEND_MULTIPLE` filter, Direct Share target, or `expo-share-intent`. Two natural Play
      code-53→75 migrations prove legacy pinned-row retirement, and text, one-image, multiple-image,
      and PDF resolver checks found neither Gator nor conversation chips. See the
      [sanitized proof](./docs/IPC_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md).
- [x] Ordinary outbound attachment/media sharing still opens Android's chooser through
      `expo-sharing`; the exercised synthetic attachment path passed on Play v75. Backup export was
      not separately exercised and receives no additional task-specific credit from this row.
- [ ] Keyboard/navigation-bar behavior passes gesture and three-button navigation.
- [x] `UI-01` task closure passes the focused 7-suite / 113-test gate and the newer Play-v78 OLED
      Dark/Gator Settings, inbox, filled-action, unread-badge, and ordinary-bubble visual review.
      This task-scoped evidence does not rebind this checklist's exact v77 release candidate or close
      any v77-only row.
- [x] `THEME-01A` task closure passes the focused 5-suite / 33-test gate and the newer Play-v78 four-
      branch OLED Dark/Gator × Android light/dark cold-start and Settings matrix on three-button
      navigation. Android light is a regression-test condition, not an app light theme. This
      task-scoped evidence does not rebind this checklist's exact v77 release candidate.
- [ ] A future bound release candidate repeats dark appearance/system-bar verification and passes
      the supported-display-size release matrix. Frozen v77 retains its known OS-light navigation-
      bar failure; the newer task-scoped v78 result does not repair or close any v77-only row. The
      store listing makes no light/system-theme promise. Large-text, TalkBack, focus-order, and
      reduced-motion evidence are not release requirements.
- [ ] The exact candidate enforces the selected Android support boundary: release configuration and
      the generated manifest/AAB report `minSdkVersion` 36, Play targeting and store copy exclude
      Android versions below Android 16 / API 36, and the candidate passes the applicable smoke
      matrix on both Android 16 / API 36 and the current latest Android 17 / API 37. API 24/25 device
      execution is not required because those versions are outside the selected product boundary.
      V77 passed artifact validation only. Historical v75 passed Play API-36; its API-37 runtime
      matrix is supporting-only.
      Play-installed API-37, store-copy, and broader `DEVICE-01` evidence keep this composite row open.
- [ ] Permission denial, restricted battery settings handoff, offline/reconnect, low-storage, and
      process-death paths fail visibly and recover. Supporting v75 API-37 evidence passed the scoped
      `DL-01` low-storage and active-download process-death cases; other permission/battery/offline
      release cases remain open.
- [x] `DL-01` Gallery/Gator Album proof on Play-installed Samsung v75 passed killed/background
      no-save, foreground export, repeated-drain deduplication, and destination/off cancellation.
      Supporting API-37 evidence passed post-MediaStore stops at attempts one, two, and three with no
      fourth copy; controlled proof retains receipt-before-byte ordering and the check-only,
      no-passive-prompt state machine. Modern MediaStore needs no retired broad-storage permission.
      See the
      [sanitized v75 checkpoint](./docs/DL_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md).
- [x] `DL-01` ordinary attachment transport on Play-installed Samsung v75 plus supporting API-37 v75
      passed false smaller/larger lengths, missing-length EOF, finite chunked and endless bodies,
      stall/deadline expiry, actual-byte overflow, cancellation, ordinary process kill/restart,
      cleanup, and exact-once valid controls.
- [x] `DL-01` ordinary cache proof combines the Play-installed Samsung maximum transfer, lifecycle
      recovery, and safe aggregate snapshots with supporting API-37 low-space refusal and full
      reconciliation. Controlled host/native proof retains the literal **2 GiB / 4,096-file / 512
      MiB-free** limits, failed/raced deletion, protected paths, zero-byte repair,
      legacy/two-generation adoption, and corrupt private state that must not be fabricated on a
      tester candidate.
- [x] `DL-01` image validation on Play-installed Samsung v75 and supporting API-37 v75 rejected
      invalid bytes and 8,193 × 8,193 dimension bombs and accepted valid maximum images. The combined
      evidence preserved quota/DB truth across low storage, cancellation, and process death.
- [x] `DL-01` synced-wallpaper proof on Play-installed Samsung v75 and supporting API-37 v75 passed
      foreground-only admission of one valid 10 MiB file plus invalid/dimension-bomb rejection.
      Controlled host/native proof retains the 90 MiB/255 preflight, 100 MiB/256 final limit,
      protected wallpaper, safe pruning, corrupt/symlink/race, failed-delete, overflow, and
      8,192-file/32,768-node scan-limit branches.
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
  configured 2026-09-01 07:17 UTC schedule occurrence remained unobserved through 08:17:09 UTC. Child
  `DB-03C1-SCHEDULED-ANDROID-CI` was later closed by genuine scheduled run 33508444928 on 2026-09-19 (see the
  work plan), but the weekly lane is not reliably green since: it passed on 2026-09-29, failed in "Run real
  Android database lanes" on 2026-10-06 (run 37476974988), and was skipped on 2026-10-13 because earlier jobs
  failed. The non-database failures in those runs (dependency audit, guard steps) were addressed by `eb6293d` and
  `896ddaf`. Treat the database lane as unconfirmed until the next genuine `event=schedule` run passes it again.

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
      store copy advertises no incoming-call feature.
- [ ] Play pre-launch/device-catalog results have been reviewed; unsupported device classes are
      excluded or clearly documented.
- [ ] Internal testing receives the hashed candidate first; rollout follows the rehearsed staged plan.
- [ ] Named owners can halt the rollout and access logs/builds/Play/Firebase/server systems.
- [ ] After rollout begins, crash, ANR, delivery, sync, send-failure, and support thresholds are
      monitored at the agreed checkpoints.

Release decision: `GO / NO-GO`

Approver and date: `__________`
