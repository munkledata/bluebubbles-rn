# PKG-01 Play v75 native-boundary proof — 2026-09-18

> **Disposition:** `PKG-01` is `DONE`. Frozen source and exact-AAB inspection prove the seven
> reviewed package pins and the five Android package registrations. Existing accepted device
> evidence covers the unchanged database, list, and notification boundaries; the exact Play-v75
> Firebase transport and native Maps checks close the two replacement-candidate gaps.
>
> **Scope limit:** This is the small package-compatibility smoke required by `PKG-01`. It does not
> close the broader release-checklist notification, map outage/App Lock/accessibility/network, or
> full-candidate functional gates.

## Candidate identity

| Field                 | Verified value                                                        |
| --------------------- | --------------------------------------------------------------------- |
| Package               | `com.bluegreengatorapps.messages`                                     |
| Version/build         | `0.1.55` / `75`                                                       |
| Built source          | `546750a0844adc48733436f26d81ebea63f0319c`                            |
| Release commit        | `9c73c1ffb0d4d63ecc562ab988ae73f28c8750dc`                            |
| AAB SHA-256           | `86e7ee236f2caa644e97b645fc9d0ec1fa562fc105ffa5bb26549d44f42b3197`    |
| Android boundary      | minimum/target API 36                                                 |
| Physical installation | Google Play (`com.android.vending`), Android 16 / API 36, arm64 phone |

The recorded release validation result passed ZIP integrity, artifact identity, signature, hash,
Google Maps key binding, and native-path checks. At validation time, the AAB, frozen source, release
receipt, and Play-installed package all resolved to the identity above.

## Pin, install, and packaged-artifact proof

The frozen source's `npm ls --depth=0` completed successfully and resolved the reviewed boundaries
exactly:

| Boundary                           | Version  | Packaged role               |
| ---------------------------------- | -------- | --------------------------- |
| `@op-engineering/op-sqlite`        | `17.1.2` | Android package             |
| `drizzle-orm`                      | `0.45.2` | JavaScript adapter contract |
| `react-native-notify-kit`          | `10.4.8` | Android package             |
| `@react-native-firebase/app`       | `25.1.0` | Android package             |
| `@react-native-firebase/messaging` | `25.1.0` | Android package             |
| `@shopify/flash-list`              | `2.0.2`  | JavaScript/runtime contract |
| `react-native-maps`                | `1.27.2` | Android package             |

The exact-pin guard and its focused suite passed **19/19** under Node `24.19.0` and npm `11.17.0`.
The guard rejects ranges, aliases, misplaced declarations, overrides, optional duplicates, nested
lockfile copies, and retired packages before installation. The release run's isolated `npm ci` and
local production build completed without changing the lockfile.

Expo autolinking and AAB inspection found op-sqlite, notify-kit, both Firebase packages, and
react-native-maps. Drizzle and FlashList correctly remain JavaScript-only. The compiled manifest
contains Firebase initialization, messaging receiver/headless-service, and notification components;
the Maps metadata contains exactly one provider-key value whose digest matches release preflight,
with no phone-location permission. Direct community `react-native-webview`, its
`RNCWebViewPackage`, and `expo-share-intent` are absent. Expo's separate framework-owned
`@expo/dom-webview` remains transitive and is not an app product surface.

## Required future upgrade protocol

Upgrade only one boundary (or the inseparable same-version Firebase pair) at a time. Review its
changelog and Expo SDK compatibility, change the exact production dependency, regenerate the lock
with the pinned Node/npm pair, and require the pre-install guard plus its mutation suite before
`npm ci`. Ranges, tags, aliases, overrides, optional/peer redeclarations, duplicate lock entries, and
another lockfile authority remain forbidden. After the clean install, run the focused contract tests
below, clean-prebuild/rebuild Android, inspect autolinking plus the merged manifest/AAB, and complete
the named physical smoke before accepting the new pin. The direct community WebView and
`expo-share-intent` absence guards run in every boundary upgrade.

| Boundary                           | Minimum focused and physical upgrade smoke                                                                                                                                                                                                                                                         |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@op-engineering/op-sqlite`        | Preserve the Drizzle adapter and the `sqlcipher`/`fts5` native flags; inspect the packaged native library, then run the physical SQLCipher/FTS/reactive DB contract and writer-concurrency contract.                                                                                               |
| `drizzle-orm`                      | Review every adapter-facing API/result shape, run adapter/query/migration tests, then repeat the combined physical op-sqlite/Drizzle DB contract. It is JavaScript-only and must not acquire an autolink entry.                                                                                    |
| `react-native-notify-kit`          | Keep all use behind the owned notification adapter, verify its Android package and manifest components, then grant notification permission and post one real MessagingStyle notification with the supported actions.                                                                               |
| `@react-native-firebase/app`       | Upgrade with Messaging to the same exact version, verify Google-services application identity plus Firebase initialization providers, then prove fresh physical initialization and scoped token/key registration.                                                                                  |
| `@react-native-firebase/messaging` | Upgrade with App to the same exact version, verify receiver/headless-service registration, then deliver one real encrypted FCM message in foreground/background and after ordinary `am kill`, including the expected receive/process result.                                                       |
| `@shopify/flash-list`              | Keep the v2 prop contract, run list/message component tests, and physically render and scroll seeded inbox/chat rows through recycle/remount. It is JavaScript-only and must not acquire an autolink entry.                                                                                        |
| `react-native-maps`                | Use the Expo-SDK-compatible exact version, clean-rebuild, verify exactly one preflight-matching Maps key and no phone-location permission in the AAB, then physically render attribution plus one bounded marker and prove row focus/callout and external-Maps fallback/return with zero WebViews. |

## Exact-v75 Firebase smoke

The accepted [`DL-01` v75 run](./DL_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md) used the same
Play-installed package and a loopback-only hostile fixture. Its `fcmSends` counter reached **18**;
that counter advances only after a fresh device registration supplies an FCM token and V3 key, the
fixture obtains an OAuth token, posts the encrypted data message to Google's FCM HTTP v1 endpoint,
and receives a successful response. The aggregate proves 18 Google-accepted sends, not 18 handset
delivery receipts.

Handset delivery is established separately by the killed-process maximum-download case. The fixture
had no realtime socket path, yet after ordinary `adb shell am kill` the encrypted FCM delivery
started the Play-v75 process and completed the exact 5 MiB private attachment transfer before the
app was foregrounded. Foreground receipt draining then exported one copy and did not duplicate it.
That is sufficient end-to-end Firebase receive/decrypt/process smoke for this package boundary. The
broader release row still requires its separately observed encrypted DB row and expected
notification, so it remains open.

## Exact-v75 native Maps smoke

The Play-installed app connected only to the reviewed disposable fixture over an ADB loopback
reverse. The fixture returned one finite device named `Synthetic Phone` at a public, non-sensitive
test coordinate and no people or items.

- Find My rendered exactly one `findmy-native-map` Android `FrameLayout`, one Google Maps
  `TextureView`, one marker, one matching row, and one external-Maps action. The hierarchy contained
  **zero** `android.webkit.WebView` nodes.
- The online map visibly rendered Google tiles and unobscured Google attribution. Its privacy-safe
  screenshot SHA-256 was
  `bca87e4cd0c8f7d42da93927a3b7cda891e6987190421397c206b6faa7ec7b5a`.
- A controlled pan moved the marker from `[669,572][771,712]` to `[1026,795][1128,935]`. Tapping the
  synthetic row returned it to `[669,572][771,712]` and visibly opened the native
  `Synthetic Phone` callout. That screenshot SHA-256 was
  `e876b3e5c71280cf6f02abbe33a63eb173cd11fdf2ee9c5801b53ff2a40a8f84`.
- `Open Synthetic Phone in Maps` foregrounded the installed Google Maps activity with the synthetic
  label and Directions/Start actions. Completing its normal Back stack returned to Gator, which
  again exposed exactly one native map, marker, row, and external action, with zero WebViews and no
  crash.

The final bounded fixture summary reported **29 requests, 29 authenticated requests, 9 authorized
Find My responses, and zero unauthenticated application requests**. No production server, account,
contact, message, coordinate, or credential was used.

## Dynamic Expo recommendation and cleanup

On the frozen source, current Expo dependency validation exits `1` and current pinned Expo Doctor
reports **19/20** because 27 Expo SDK 57 packages now have newer recommended patch releases. None is
one of `PKG-01`'s seven reviewed boundaries; Maps remains the reviewed SDK-compatible `1.27.2`.
This same dynamic patch recommendation was already recorded as broader SDK/release follow-up for the
accepted v65/v66 map work. It is retained truthfully here and on the release checklist instead of
forcing a 27-package update that would invalidate the frozen v75 candidate. The check changed no
lockfile bytes.

Cleanup disconnected the disposable account through Gator and confirmed the `Get Started` screen.
The fixture stopped, its one USB reverse mapping was removed, the phone's stay-awake setting returned
to `0`, and the two temporary screenshots and UI captures were deleted after visual review. No
public or exported files were created by Gator during this smoke.
