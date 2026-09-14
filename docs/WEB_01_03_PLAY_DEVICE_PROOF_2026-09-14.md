# WEB-01..03 native Find My map — Play v65 device proof

> **Evidence class:** frozen-source, production-signed Google Play Internal candidate plus an
> isolated synthetic server fixture on 2026-09-14.
>
> **Disposition:** this closes `WEB-01`. It advances `WEB-02` and `WEB-03`, but those items remain
> **IN_PROGRESS** for the human-only App Lock, TalkBack, Play Data Safety, and owner/legal gates
> listed below.

## Candidate identity

- App source: `edc1888fc7c618ba50564c6c31189dcf4483f0fb`; release commit:
  `560be51865cbaef48cc24f7cbbc40156f7904f50`; run:
  `android-0.1.48-edc1888-20260914111202`.
- Google Play Internal artifact: `gator-release-0.1.48-v65-560be51.aab`, version `0.1.48`, version
  code `65`, 56,798,319 bytes, SHA-256
  `adf5f26e206fc202e9cf97d87825df30668aad353be2747caa5e728dec9b5828`.
- The release validator passed zip integrity, packaged-artifact, identity, signature, hash, Google
  Maps key binding, and native-path proof. The receipt stores only the restricted Maps key's
  SHA-256 digest, never its value.
- Google Play reported the Internal submission complete. The phone then installed the candidate
  through `com.android.vending`; the installed package reported version `0.1.48` / code `65`, was
  nondebuggable, and used the expected Play delivery certificate SHA-256
  `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`.
- The delivered base APK SHA-256 was
  `0b8f80a6543c508cdc175364da73a53bf54da76d8d2a3e473de41c1b0b7d7e1f`.

The first local build attempt is retained as a terminal failure and receives no evidence credit. It
failed before compilation because the clean worktree had no `node_modules`. The successful run used
the pinned Node 24/npm/EAS toolchain after a clean `npm ci`.

## Isolated fixture

- The approved fixture SHA-256 was
  `8fdaf9446b32cc3b5e4b320aef5a8bdd66dfaabe1b9996e98f605a4dd5500fd2`.
- It exposed one finite `Synthetic Phone` location only through loopback/USB reverse. An
  unauthenticated request returned 401 and the disposable authenticated request returned 200.
- The server runtime/helper paths were unchanged from the independently reviewed fixture baseline.
  No production account, contact, message, coordinate, server address, or credential was used.

## Exact-candidate results

| Check                 | Result                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native surface        | One native Google map, one marker, one list row, and one external-Maps action rendered. The Android accessibility hierarchy contained zero `android.webkit.WebView` nodes.                                                                                                                                                                                                                                     |
| Marker bridge         | The marker and list exposed only the bounded synthetic label. The focused host suite covers invalid and range-edge coordinates, duplicates, marker and label caps, punctuation, markup-like text, emoji, and Unicode separators.                                                                                                                                                                               |
| Repeated focus        | A first pan moved the marker from `[669,572][771,712]` to `[1200,868][1302,1008]`; tapping its row returned it to `[669,572][771,712]` and opened the native callout. A second pan moved it to `[147,279][249,419]`; tapping the same row again returned it to the same centered bounds and reopened the callout.                                                                                              |
| Attribution           | Online and outage screenshots showed the SDK-provided Google logo visible and unobscured at the bottom of the map.                                                                                                                                                                                                                                                                                             |
| External fallback     | **Open Synthetic Phone in Maps** launched the installed Google Maps app. Completing the system-app Back stack returned to Gator and recreated exactly one native map and marker with zero WebViews.                                                                                                                                                                                                            |
| Route lifecycle       | Returning to Settings removed the map node; reopening Find My recreated exactly one map and marker.                                                                                                                                                                                                                                                                                                            |
| Android background    | One already-started load settled during the first background window and is not credited as a zero-request result. From the resulting stable baseline, a second 65-second background window changed no fixture counter. Resume recreated the map and immediately refreshed all three Find My lists.                                                                                                             |
| Reliable outage       | Wi-Fi and mobile data were disabled while airplane mode remained unchanged; a phone-side Internet probe changed from reachable to unreachable. An uncached pan degraded to partial tiles without a crash, while the Google logo, location list, row focus/callout, and external-Maps action remained usable. Restoring the original network settings restored Internet reachability and retained the map/list. |
| Account teardown      | Confirmed Disconnect returned to onboarding with no map, marker, or synthetic conversation. Across the following 65 seconds every fixture counter remained unchanged.                                                                                                                                                                                                                                          |
| Location minimization | The installed Play package declared no coarse, fine, background, or foreground-service location permission. It exposed no phone-location layer or control.                                                                                                                                                                                                                                                     |
| Disclosure            | The exact candidate's Privacy & Data Use screen described the native map, server-provided precise coordinates, Google data categories, panning/zooming, and the absence of phone-location collection. Its Legal screen named Google Maps and exposed named controls for the Maps additional terms and Google privacy policy.                                                                                   |

Privacy-safe screenshot hashes retained during review were:

- online/native map and unobscured attribution:
  `49de29ef99cacde7aa440ee8fad22600a93463b62227840debb5f7dbf67e3cff`;
- second same-row focus and reopened native callout:
  `3af5f054ebbfa41949dbae8412238333a200eb45e14257b4ddf1ec2371763900`;
- proven-outage focus/list/fallback and attribution:
  `ff1bdf1376617194d4376c12b87e27c437f3f14aab470f82dd9e04e418a63e87`.

## Supporting traffic observation

Android's live BPF counter was sampled for Gator's unique Play-installed Linux UID. It includes all
Gator traffic and cannot identify Maps traffic separately; some SDK work may also occur in Google
Play services. It is therefore supporting lifecycle evidence, not a provider-destination proof.

| 30-second state                |                   Received |                       Sent | Map state                                                                   |
| ------------------------------ | -------------------------: | -------------------------: | --------------------------------------------------------------------------- |
| Visible map with uncached pans | 77,450 bytes / 108 packets | 19,184 bytes / 105 packets | Mounted                                                                     |
| Find My route unfocused        |   2,010 bytes / 23 packets |   3,706 bytes / 29 packets | Unmounted                                                                   |
| Android background             |        0 bytes / 0 packets |      208 bytes / 4 packets | App not resumed; separate 65-second fixture window had no poll              |
| Proven Internet outage         |   3,236 bytes / 40 packets |   6,643 bytes / 47 packets | Mounted with list/fallback; USB loopback and failed attempts can contribute |

The outage delta is deliberately not described as Internet or Maps traffic: the phone had no
working Internet route, while the fixture remained available over USB loopback.

## Host and cleanup evidence

- The six focused map/config/location/privacy/legal suites passed **6/6 suites and 35/35 tests**.
- Strict TypeScript and the DB-write report had already passed after the candidate source froze;
  the DB report counted 1,953 mutations with zero structural or membership errors.
- The fixture ended with a final bounded summary and `WEB02_CLOSED`. Its listener and USB reverse
  were removed, its helper-owned temporary backend was deleted, and its staging directory plus the
  installed-APK evidence directory were moved to Trash for recoverable cleanup.
- Wi-Fi, mobile data, airplane mode, and normal phone sleep behavior were restored. Gator remains
  the Play-delivered v65 app, disconnected on onboarding. TalkBack and App Lock were not changed.

## Remaining gates

`WEB-01` is complete: its source/host containment and exact Play marker/focus acceptance both pass.

`WEB-02` remains **IN_PROGRESS** only for a real App Lock cycle on this candidate: enable App Lock,
authenticate through Android's owner-controlled biometric/PIN UI, verify the protected map tree is
absent while locked, and verify one clean remount after unlock. This must not be bypassed or driven
with a real PIN through ADB.

`WEB-03` remains **IN_PROGRESS** for:

- a human listening/focus traversal with TalkBack covering the map summary, marker, tabs, list,
  external fallback, and Google attribution without a focus trap;
- owner/legal approval of the candidate screenshot and wired terms/privacy wording; and
- reconciliation and approval of the matching Google Play Data Safety answers.

### Owner approval packet

Google Play currently exempts apps that are active exclusively on Internal Testing from publishing
the Data Safety form. The remediation gate still requires an approved draft so a later promotion
cannot invent answers under release pressure. Based on Google's current
[Maps SDK data disclosure](https://developers.google.com/maps/documentation/android-sdk/play-data-disclosure)
and [Play Data Safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469),
the conservative Maps-only draft is:

| Play data type      | Collected | Required | Purpose           | Shared draft |
| ------------------- | --------- | -------- | ----------------- | ------------ |
| Precise location    | Yes       | Optional | App functionality | Yes          |
| App interactions    | Yes       | Optional | Analytics         | Yes          |
| Crash logs          | Yes       | Optional | Analytics         | Yes          |
| Diagnostics         | Yes       | Optional | Analytics         | Yes          |
| Device or other IDs | Yes       | Optional | Analytics         | Yes          |

“Precise location” here means the server-provided Find My coordinate, not this Android phone's
location. Optional is supportable because Maps mounts only when the user opens optional Find My with
a valid location. Do not claim ephemeral processing or that every app flow is encrypted in transit;
Gator permits a separately warned HTTP server connection. Google's documented IP collection has no
standalone Play category. Owner/legal must decide whether its use also requires **Approximate
location**. A service-provider or user-initiated sharing exception may apply, but **Shared: Yes** is
the safe draft until owner/legal approves an exception.

Before closing `WEB-03`, the owner must view the actual candidate screenshot—not only its hash—and
approve that image, the exact in-app disclosure/legal wording, both Google destinations, and this
draft matrix. The store pack still names an older candidate and must be updated only after that
decision.

The human phone pass is deliberately small:

1. Preserve the current accessibility-service state, enable TalkBack, and audibly traverse Refresh,
   the one-location map summary, marker, Google attribution, all three tabs, list row, and external
   Maps action. Confirm focus leaves the map and returns from external Maps without trapping, then
   restore the original accessibility state.
2. Connect the disposable fixture, enable App Lock, and authenticate personally. Open Find My,
   background Gator beyond its 30-second grace period, and resume. Confirm the protected map tree is
   absent before authentication, then use the owner's biometric/PIN and verify exactly one fresh map
   and marker. Restore the original App Lock setting. Never send the real PIN through ADB.

The local EAS build's Expo Doctor check was nonblocking but reported **19/20** checks because 27
Expo SDK 57 dependencies have newer recommended patch versions. That is broader dependency/release
follow-up, not a failure of this frozen map acceptance. Also harden future verbose release logs so
they do not echo the restricted Maps key during configuration; the key itself remains Android
package/signature/API restricted and is necessarily embedded in the delivered app.
