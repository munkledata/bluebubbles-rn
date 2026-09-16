# DL-01 exact Play v67 candidate/device checkpoint — 2026-09-15

> **Evidence class:** Exact Google Play Internal candidate identity, natural Play update,
> packaged-source-marker inspection, and narrow owner-phone lifecycle observations.
>
> **Disposition:** Version 67 is the fresh candidate containing the current `DL-01` implementation,
> but this checkpoint does **not** close `DL-01` or any of its five device-matrix rows. No isolated
> hostile-download fixture or authorized private DB/filesystem inspection was available.

## Exact candidate and delivery

| Field                             | Observed value                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| App/package                       | Gator / `com.bluegreengatorapps.messages`                                                         |
| Version                           | `0.1.50` / Android version code `67`                                                              |
| DL-01 implementation              | `9139cf72bb56d613f1b848de63fe882b2029e91a`                                                        |
| Built source                      | `2c7f426e3549127972fdd5c601bf98f651a75870`                                                        |
| Release commit/branch             | `12a45924a2e8b5dc998e0b56e0df6c58f8186960` / `release/android-0.1.50`                             |
| Release run                       | `android-0.1.50-9139cf7-20260915234900`                                                           |
| Submitted AAB                     | `gator-release-0.1.50-v67-12a4592.aab`; 56,806,011 bytes                                          |
| AAB SHA-256                       | `1bec41156c38e556eb9dbe079bc0cf83ee1577d07d0912144fb0524739304702`                                |
| Upload certificate SHA-256        | `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43` |
| Submission                        | EAS submission `67253f5c-6f5c-47a9-b669-c0ea25c4f5de`; completed                                  |
| Live Play state                   | Internal track; release `0.1.50`; status `completed`; version code `67`                           |
| Installed identity                | `versionName=0.1.50`, `versionCode=67`, installer `com.android.vending`                           |
| Device                            | Owner-enrolled Samsung `SM-S938U1`, Android 16 / API 36, `arm64-v8a`                              |
| Play delivery certificate SHA-256 | `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                                |

The different upload and delivery fingerprints are expected with Play App Signing. The host update
and reboot removed the private release workspace, receipt directory, and local AAB bytes after the
recorded validation and submission. The AAB must therefore not be described as locally retained or
reused. The release branch, archived session record, EAS submission, live Play state, installed
identity, and recorded artifact digest remain available as provenance.

The run ID retained the short hash from its initial `DL-01` source allocation. The frozen release
commit's parent is `2c7f426`, which adds only the reviewed release-runner correction on top of
`9139cf7`; the table records both identities so the different short hashes are not mistaken for a
provenance conflict.

## Build and packaged identity

- The pinned Node 24.19.0, npm 11.17.0, and EAS CLI 21.5.0 release path installed locked
  dependencies inside its managed worktree before EAS config resolution.
- The focused release/toolchain suites passed **37/37 tests**.
- Gradle completed successfully: **1,334 tasks in 8m55s**.
- Validation, promotion, and Internal submission completed through the guarded release runner.
- `apkanalyzer` read package `com.bluegreengatorapps.messages`, version `0.1.50`, and code `67`
  from the Play-delivered base APK.
- Every installed split used the expected Play App Signing certificate.

| Installed split              |      Bytes | SHA-256                                                            |
| ---------------------------- | ---------: | ------------------------------------------------------------------ |
| `base.apk`                   | 75,401,423 | `6e2915abab46e5a38d689e311c218982ed20483d61fd64428d2c55a9e57c2f51` |
| `split_config.arm64_v8a.apk` | 35,208,104 | `1114de9da93bb74fad404ccaa55a286093a6a10be01e6258ba149e728d9a6838` |
| `split_config.en.apk`        |    119,193 | `04f5cf7e3ae89ac1e9c10b78564f307aceef7bb1e16b6d10334f85e9bf5c1b6d` |
| `split_config.xxhdpi.apk`    |    664,987 | `73130c5df38e9e96d5fab8c6cd4c19bd5afe761e988d2101c358dab4e23f8759` |

Native and Hermes-bundle inspection found the current strict synced-wallpaper admission markers,
including `prepareSyncedBackgroundCacheForDownload`, `SyncedBackgroundCacheScanLimits`,
`prepareNativeSyncedBackgroundCacheForDownload`, and the fail-closed
`synced-background cache admission unavailable` path. This proves that the implementation was
packaged; string presence does not prove its runtime behavior.

## Narrow phone observations

- Google Play updated the installed v66 app to v67 without an uninstall, app-data clear, or
  sideload. Android recorded `firstInstallTime=2026-09-14 05:28:05` and
  `lastUpdateTime=2026-09-15 18:52:24`.
- The existing account/session remained and the app reached Messages rather than onboarding.
- Before the process-death check, Downloads displayed Auto-download Attachments on, Wi-Fi-only off,
  two parallel downloads, and `Gator album` as the destination. These were observed without a saved
  change. All four are source defaults, so they do not prove settings migration.
- The first post-update view temporarily displayed `Connection problem`. After the authenticated
  relaunch described below, that warning and `Retry live updates` were absent. This is a visible UI
  recovery observation, not positive server-connectivity proof.
- With Gator backgrounded, `adb shell am kill com.bluegreengatorapps.messages` removed its process.
  Launcher relaunch presented the Android biometric App Lock prompt.
- The first prompt timed out or was cancelled and received no pass credit. After **Try again**, the
  owner authenticated on the phone and Messages reopened.
- The final scoped process-log count contained zero Gator fatal-exception, ANR, or native-crash
  markers.

This proves an ordinary Play update, process replacement, App Lock challenge, and authenticated
relaunch. It is not an in-flight download kill, FCM-delivery, WebSocket-connectivity, or encrypted-DB
recovery test.

## DL-01 work that remains open

None of the five `RELEASE_CHECKLIST.md` `DL-01` rows receives a check mark from this run:

1. Gallery/Gator Album durable receipt ordering and bounded duplicate-attempt behavior.
2. False/missing/chunked/endless/stalled hostile transport, byte/deadline enforcement,
   cancellation, and in-flight process-kill cleanup.
3. The 2 GiB/4,096-file cache, 512 MiB free-space floor, eviction protection, failed-delete
   accounting, recovery, legacy promotion, and account isolation.
4. Invalid/oversized/image-bomb rejection plus valid-image, low-storage, cancellation, and
   process-death behavior.
5. Strict synced-wallpaper admission near 90 MiB/255 files, protected-file handling, hostile
   directory states, quota pruning, and the Android API 24/25 disposition.

Those checks require an isolated staged server, synthetic content, controlled filesystem states,
and an approved way to observe private DB/filesystem outcomes. The production account and
conversations were not used as a substitute. API 36 evidence cannot decide the API 24/25 product
boundary.

## Evidence limitations

Do not claim that this checkpoint proves:

- a fresh install—the observed path was a Play update;
- any attachment or wallpaper actually downloaded;
- destination-receipt ordering, DB truth, partial-file cleanup, quota behavior, or MediaStore output;
- process-death safety for an active download;
- staged connect/sync/send/receive/notification/disconnect behavior;
- `STORE-01`, `DEVICE-01`, or broader release completion;
- tester-list, opt-in-link, Play-declaration, Closed/Open/Production-track, or public-release state;
- Android 14/15, API 24/25, Pixel, x86_64, or other-manufacturer behavior; or
- runtime correctness merely from DEX/Hermes string markers.

## Privacy and cleanup

- No production message body, credential, private endpoint, raw push payload, device serial, or
  private app-database content is retained in this report.
- One transient raw Android UI hierarchy unexpectedly contained private visible screen content. It
  was immediately deleted from both phone and host, was not quoted, and received no evidence credit.
  Subsequent UI reads emitted only an explicit allowlist of safe labels.
- The privately copied APK splits, extracted Hermes bundle, UI captures, and their mode-700
  temporary directory were deleted after hashes and non-sensitive identity results were recorded.
- USB-only stay-awake was restored from temporary value `2` to its original value `0`.
- Gator remains the Google Play v67 installation with its existing app data. It was not uninstalled
  or cleared, and no download preference was intentionally changed.
