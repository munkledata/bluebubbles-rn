# Google Play Internal device proof — 2026-09-09

This is a bounded, privacy-safe receipt for the first Google Play install and no-server device
checks of the replacement Android candidate. It does not claim staged-server, notification, live
message, update-path, multi-device, or cross-version evidence.

## Exact candidate and delivery

| Field                             | Observed value                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| App/package                       | Gator / `com.bluegreengatorapps.messages`                                                         |
| Version                           | `0.1.44` / version code `61`                                                                      |
| Candidate source                  | `daa345d716283ef3cee96d3dc64081d38ac08fa6`                                                        |
| Release commit/branch             | `26df7143b94cdc1410584bf5da070cc6717b2d5b` / `release/android-0.1.44`                             |
| Release run                       | `android-0.1.44-daa345d-20260910032310`                                                           |
| Artifact                          | `gator-release-0.1.44-v61-26df714.aab` / 56,141,718 bytes                                         |
| Artifact SHA-256                  | `62beed106e3bce7655b12693d745c8f9260d82bb9aa52e34fe800f6234ff402e`                                |
| Upload certificate SHA-256        | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43` |
| Submission                        | Google Play Internal Testing; release receipt status `submitted` at `2026-09-10T03:37:11.685Z`    |
| Install source                    | Fresh Google Play install; `installerPackageName=com.android.vending`                             |
| Installed identity                | `versionName=0.1.44`, `versionCode=61`                                                            |
| Play delivery certificate SHA-256 | `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                                |

The different upload and delivery certificate fingerprints are expected with Play App Signing. The
installed base APK passed `apksigner verify --print-certs`. The release receipt's packaged-artifact,
identity, signature, hash, and native-path checks all passed before submission.

## Device boundary

- Evidence alias: `galaxy-s25u-a16-owner-01` (no device serial retained).
- Samsung `SM-S938U1`, Android 16 / API 36, `arm64-v8a`.
- Security patch: `2026-08-05`.
- Three-button navigation (`navigation_mode=0`), so this run does not prove predictive-Back preview.
- This single phone does not substitute for Android 14/15, Android 17, API 24/25, x86_64, Pixel, or
  other manufacturer coverage.

## Passed checks

- Cold launch reached Gator Welcome in 463 ms; the final cleaned-up cold launch took 400 ms. No Gator
  fatal exception or ANR was present.
- Background/foreground retained the same process and resumed HOT in 24 ms.
- An ordinary background `adb shell am kill` removed the process. Relaunch was COLD in 393 ms and
  did not retain the synthetic URL or password fields.
- Welcome, Get Started, Connect, Scan QR Code, Enter Manually, Grant Camera Access, and Try Again
  controls exposed meaningful accessibility text to Android UI automation.
- Camera denial returned safely to the in-app rationale. A foreground-only grant opened the scanner
  and exposed “Point your camera at the server QR code.” No QR payload or camera image was retained.
- The temporary camera grant was revoked after the check. Notification, contacts, microphone, and
  media permissions remained ungranted.
- Manual setup masked the credential field. Connect was disabled while required fields were empty.
- Font scale `2.0` left Welcome and Connect readable and operable. The original `0.8` setting was
  restored. Connected-app large-text coverage and the known Back-label gap remain open.
- The installed package is neither debuggable nor test-only, and `run-as` access to app-private data
  was denied.
- Installed requested permissions omit `USE_FULL_SCREEN_INTENT`, `QUERY_ALL_PACKAGES`, broad/external
  storage permissions, and SMS permissions.
- No Gator activity resolved `ACTION_SEND` for `text/plain`; public inbound sharing remains disabled
  on this clean install.
- Synthetic setup values were absent from Gator output. Android's `adbd` process did log the literal
  `adb input text` commands, so real credentials must never be entered with ADB automation.

Android/Samsung emitted non-fatal platform noise about deprecated `ashmem`, an unavailable optional
graphics service/library, and a Samsung policy file. The app stayed foreground and responsive; none
of those lines was a Gator exception or ANR.

## Open release blocker found on device

Manual setup did not reject the explicit unsupported scheme `ftp://example.com`. It attempted a
connection and displayed “Could not reach your server” instead of “Please enter a valid server URL.”

Source inspection found the cause in `sanitizeServerAddress`: any value that does not start with
`http://` or `https://` is prefixed with `https://`. An explicit unsupported scheme can therefore be
reinterpreted as a different HTTPS hostname. With a real credential, that can send the authorization
header to a host other than the one the user intended.

Treat this as a release blocker: reject explicit non-HTTP(S) schemes before normalization, add
focused sanitizer and connect tests, and build a new exact candidate before using real staged
credentials. Do not promote version code 61 beyond Internal Testing.

### Local source remediation after the device finding

The local source now uses a positive grammar for schemeless input: a hostname with an optional
numeric port, or bracketed IPv6 with an optional numeric port. Explicit HTTP(S) still works, while
unsupported/malformed schemes, empty authorities, leading URL delimiters, embedded credentials,
backslashes, whitespace/control characters, and oversized input fail before any request starts. The
same sanitizer protects manual and QR setup.

Focused verification after the final edit:

- Sanitizer and QR suites: 2 suites passed, 66 tests passed, 0 failed.
- TypeScript: passed.
- Architecture: 52 tests passed, 0 failed; core/UI/cycle/WebView and scheduled-recovery guards
  passed.
- Prettier and `git diff --check`: passed for the changed source/test/report.
- Independent security review: no blocker after two earlier reviews found and drove closure of
  malformed-scheme and leading-delimiter bypasses.

The repository-wide DB-write fast gate is not green: two unchanged reruns each reported 68 passing,
22 failing, and 13 skipped certificate tests. The direct report completed but found 678 existing
structural/membership errors across 1,948 mutations. This URL change contains no DB access and did
not create those findings; do not reconcile unrelated inventory as part of this fix. The corrected
source is therefore verified for its focused boundary but is not a fully green release candidate.
No corrected AAB has been built, uploaded, or installed.

## Startup cleanup observation

One rapid force-stop/start sequence after a failed synthetic connection produced the fail-closed
screen:

> Gator could not safely finish clearing the previous connection. Restart the app and try again
> before connecting.

The next restart recovered, and a controlled live change to font scale `2.0` did not reproduce it.
This is not attributed to font scaling. Retain it as an open lifecycle observation until the rapid
restart/failed-connect cleanup sequence is reproduced or ruled out on a corrected candidate.

## Remediation disposition

This run advances, but does not close, the following records:

- `STORE-01`, `STORE-01G-TESTER-READINESS`, `RELEASE-01`: replacement build, validation, Internal
  submission, Play delivery, Play signing, and one clean-install branch now have evidence. Live
  track/list/link administration, non-admin enrollment, update from the approved prior build,
  declarations, staged journey, and teardown remain open.
- `DEVICE-01`, `ENV-01`, `PKG-01`: exact package/version/device and bounded production smoke are
  proven on one Galaxy/API-36 device only.
- `ONBOARD-01`: fresh-install Welcome, setup choice, manual form, and camera rationale/deny/grant are
  proven. Other just-in-time permission flows still require their real feature contexts.
- `PERM-01`, `PLAY-02`: the API-36 runtime snapshot and packaged forbidden-permission absence are
  proven. API-32 behavior and Android 14/15/16 notification body/action rows remain open.
- `REL-001`, `SCHED-01`: ordinary process-kill/relaunch behavior passed without FCM. Killed-process
  push delivery and WorkManager behavior remain open.
- `SHARE-01`: clean-install inbound-share absence is proven. Natural Play update evidence remains
  open.
- `A11Y-01..03`, `ANDROID-02`: UI semantics and two onboarding screens at font scale `2.0` are
  partial evidence only. TalkBack, RTL, motion, connected screens, and predictive-Back preview were
  not proved.
- `LOG-01`, `PRIV-02`: bounded crash/log inspection and non-debuggable private-data isolation passed.
  File, encrypted-DB, share, proxy, denied-consent network, and connected-session inspection remain
  open.

No isolated staged server or synthetic credential exists. The local server may access the real
Messages database and must not be used as staging. This blocks 41 prepared live rows covering
messages, notifications/FCM, files, media, account switching, and cleanup. A fresh Play install also
does not prove the required prior-build update path.

## End state

- Phone remains on the Gator Welcome screen.
- Font scale is restored to `0.8`.
- Camera permission is revoked; unrelated runtime permissions remain ungranted.
- Gator `0.1.44` / code `61` remains installed from Google Play for bounded follow-up only.
- Temporary phone and Mac screenshots/XML/APK proof copies used during inspection were removed;
  none contained QR, server, account, or message data.

## Replacement candidate closure — 2026-09-10

The sections above remain the historical receipt for version code 61 and the URL defect it exposed.
This section records the corrected replacement delivered through Google Play Internal Testing.

### Exact replacement and release gates

| Field                             | Observed value                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| App/package                       | Gator / `com.bluegreengatorapps.messages`                                                         |
| Version                           | `0.1.45` / version code `62`                                                                      |
| Candidate source                  | `8179d0a3a99c4e2e28a01fd83212fee919bad41c`                                                        |
| Release commit/branch             | `644a566fb54da7d2c195e369d11677acfce097ea` / `release/android-0.1.45`                             |
| Release run                       | `android-0.1.45-8179d0a-20260910075110`                                                           |
| Artifact                          | `gator-release-0.1.45-v62-644a566.aab` / 56,141,406 bytes                                         |
| Artifact SHA-256                  | `110efe12a0d5cc620b2a523787bb95139f3f2ddf86550449d16de7d8fcd2bd51`                                |
| Upload certificate SHA-256        | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43` |
| Submission                        | Google Play Internal Testing; release receipt status `submitted` at `2026-09-10T08:07:26.541Z`    |
| EAS submission                    | `736e29d7-d0d1-48f7-8f68-6095ce240d10`                                                            |
| Play delivery certificate SHA-256 | `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                                |

The frozen candidate passed the reconciled DB inventory with 1,948 approved mutations, zero
unresolved findings, zero nested coordinators, and zero reconciliation drift. The required full
adversarial scanner passed 104/104 tests. The focused product evidence remained 2 suites / 66 tests,
and the pinned focused DB evidence passed 9 suites / 189 tests. TypeScript, architecture (52/52),
migration (5/5 at head `0048`), formatting, and inventory guards passed. The production build then
passed Expo Doctor 20/20 and Gradle 1,299/1,299 tasks before the release runner validated the AAB's
identity, signature, hash, legal inventory, and native paths.

An initial run, `android-0.1.45-8179d0a-20260910071440`, stopped before Gradle because its disposable
checkout could not resolve `expo-router` without installed dependencies. A pinned EAS query proved
the remote counter remained at 61. That failed receipt was retained, dependencies were installed in
the isolated outer checkout, and the successful fresh run consumed version code 62 exactly once.

### Natural Google Play update proof

- Before update, Android reported `0.1.44` / code `61`, installer
  `com.android.vending`, first-install time `2026-09-09 22:22:02`, and last-update time
  `2026-09-09 22:22:02`.
- The Play listing visibly offered **Update** to the enrolled tester. The existing app was neither
  uninstalled nor cleared, and no APK was sideloaded.
- After update, Android reported `0.1.45` / code `62`, the same Google Play installer and first-install
  time, and the newer last-update time `2026-09-10 02:11:04`.
- The delivered base APK passed v2 and v3 signature verification and carried the expected Play App
  Signing delivery certificate above.

This closes the previously missing natural Play update branch for this exact Galaxy/API-36 device.
It does not substitute for the other Android versions, manufacturers, enrollment roles, or staged
server journeys listed earlier.

### Corrected URL boundary and lifecycle proof

On the Play-installed v62 build, the bounded manual setup sequence used only the synthetic values
`ftp://example.com` and `proofonly`. Tapping Connect immediately rendered:

> Please enter a valid server URL.

The screen did not enter a Connecting state or show the old “Could not reach your server” result.
This is exact-device UI proof that the v61 blocker is corrected; it is not packet-capture evidence
and makes no claim about broader network behavior.

The app was then backgrounded with Home and stopped with ordinary `adb shell am kill`, not
force-stop. `pidof` confirmed the process was gone. Relaunch was COLD in 428 ms, created a new
process, and returned cleanly to Get Started without retaining the synthetic values or error.

### Remediation disposition and end state

- The exact build, validation, promotion, Internal submission, accepted outcome receipt, natural
  Play update, and corrected blocker proof support marking primary `RELEASE-01` **DONE**.
- Version code 61 remains retired and must not be promoted. Version code 62 was submitted only to
  Internal Testing; no production or wider-track rollout occurred.
- Broad connected messaging, files/media, FCM, notification actions, account switching, and teardown
  remain blocked on a privacy-safe staged server and synthetic account. This bounded run does not
  close those records.
- The phone ends on Gator Get Started with `0.1.45` / code `62` installed from Google Play. The
  temporary pulled APK and screenshots contained only public release metadata or the synthetic setup
  values and were removed after this receipt was recorded. USB stay-awake was restored to its normal
  setting.
