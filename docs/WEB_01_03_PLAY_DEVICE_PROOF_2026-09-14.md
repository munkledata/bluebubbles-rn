# WEB-01..03 native Find My map — Play v65/v66 device proof

> **Evidence class:** frozen-source, production-signed Google Play Internal candidates plus
> isolated synthetic server fixtures on 2026-09-14.
>
> **Disposition:** this closes `WEB-01`, `WEB-02`, and `WEB-03`. Per the owner's 2026-09-14
> decision, accessibility validation is not a `WEB-03` completion requirement. The owner approved
> the exact screens, Google destinations, and conservative Maps-only Data Safety draft below for
> the current private Internal Testing scope.

## Play v65 candidate identity

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

## Play v65 isolated fixture

- The approved fixture SHA-256 was
  `8fdaf9446b32cc3b5e4b320aef5a8bdd66dfaabe1b9996e98f605a4dd5500fd2`.
- It exposed one finite `Synthetic Phone` location only through loopback/USB reverse. An
  unauthenticated request returned 401 and the disposable authenticated request returned 200.
- The server runtime/helper paths were unchanged from the independently reviewed fixture baseline.
  No production account, contact, message, coordinate, server address, or credential was used.

## Play v65 exact-candidate results

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

## Play v65 supporting traffic observation

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

## Play v65 host and cleanup evidence

- The six focused map/config/location/privacy/legal suites passed **6/6 suites and 35/35 tests**.
- Strict TypeScript and the DB-write report had already passed after the candidate source froze;
  the DB report counted 1,953 mutations with zero structural or membership errors.
- The fixture ended with a final bounded summary and `WEB02_CLOSED`. Its listener and USB reverse
  were removed, its helper-owned temporary backend was deleted, and its staging directory plus the
  installed-APK evidence directory were moved to Trash for recoverable cleanup.
- At the end of the v65 run, Wi-Fi, mobile data, airplane mode, and normal phone sleep behavior
  were restored. Gator remained the Play-delivered v65 app, disconnected on onboarding. TalkBack
  and App Lock were not changed.

## Play v66 App Lock completion

- Reviewed app source `360d873301e54541b0dbedf97caa4c26b10451ef` was packaged by release commit
  `6b592755f35665ac5fff951e861006686301cb23`, whose only source-tree differences were the version
  values in `package.json` and `package-lock.json`. The Google Play Internal artifact
  `gator-release-0.1.49-v66-6b59275.aab` reported version `0.1.49` / code `66`, measured 56,801,803
  bytes, and had SHA-256
  `9dfb0d3c9ea9f1e54ed32f2e6f008d57132f9e4d74cc76e5c3cb803447141570`.
- The installed package came from `com.android.vending`, was nondebuggable, and retained the
  expected Play delivery certificate SHA-256
  `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`. Its delivered 75,384,958-byte
  base APK had SHA-256 `c0d617dd5634cc6817efbba4c351f5201bd697103a1f8842732f61b494835675`;
  `apksigner` verified its v2 and v3 signatures.
- With App Lock enabled and process `19110` already unlocked, Settings -> Find My rendered exactly
  one native map summary, one `Synthetic Phone` marker, one matching list row, and one external
  Maps action, with zero WebViews. Gator was then sent Home from 18:54:32 to 18:55:10 MDT: 38 seconds,
  beyond its 30-second grace period, while the same process remained alive.
- Resume presented Android's owner-controlled biometric window explicitly titled `Gator` /
  `Unlock Gator`. Before authentication, its hierarchy exposed zero map, marker, row, action, or
  WebView nodes. Android then recorded a successful fingerprint authentication for Gator at
  18:55:38; no PIN or biometric was sent through ADB.
- After authentication, the protected navigation tree remounted at Messages as designed. One normal
  Settings -> Find My navigation recreated exactly one native map summary, one marker, one matching
  row, and one external action with zero WebViews, zero lock nodes, and zero empty-state nodes. PID
  `19110` was unchanged throughout. The post-unlock screenshot SHA-256 was
  `32ff20150fafdcb3c5b24bb0885eacade0f9580bcc561500333324f6aed42760`.
- The lifecycle log contained only the expected test-owned Home, Gator launch, and later Back/launch
  commands; it contained no process kill or competing shell lifecycle command. The independently
  rerun lock/Find My source gate passed **9/9 suites and 81/81 tests**.
- Cleanup restored App Lock to off, disconnected the disposable fixture through Gator, and confirmed
  onboarding with no synthetic conversation. The fixture emitted its final bounded summary and
  `WEB02_CLOSED`; its listener and `tcp:1236` USB reverse were removed, and normal phone sleep was
  restored. The v66 Play app remains installed and disconnected. Privacy-safe evidence was moved
  recoverably to Trash under `web02-v66.9tNskK`; no production account or credential was retained.

## Final disposition

`WEB-01` is complete: its source/host containment and exact Play marker/focus acceptance both pass.

`WEB-02` is complete: the source/AAB/native-map containment passed on v65, and the behavior-equivalent
v66 Play candidate completed the real owner-authenticated App Lock cycle. The protected map tree was
absent before authentication and remounted exactly once after unlock without a WebView or process
restart.

`WEB-03` is complete. Exact Play v65/v66 evidence covers visible native attribution, native/list
fallback, controlled lifecycle and outage behavior, truthful disclosure, and safe legal destinations.

The owner removed accessibility validation from `WEB-03` on 2026-09-14. That decision changes only
this task's acceptance boundary; no accessibility code or runtime behavior changed. A short TalkBack setup attempt was
stopped at the owner's request. Cleanup restored touch exploration to off and preserved Bitwarden as the phone's sole
enabled accessibility service.

### Owner approval packet

Google Play currently exempts apps that are active exclusively on Internal Testing from publishing
the Data Safety form. The remediation gate still requires an approved draft so a later promotion
cannot invent answers under release pressure. Based on Google's current
[Maps SDK data disclosure](https://developers.google.com/maps/documentation/android-sdk/play-data-disclosure)
and [Play Data Safety definitions](https://support.google.com/googleplay/android-developer/answer/10787469),
the owner-approved conservative Maps-only draft is:

| Play data type       | Collected | Required | Purpose           | Shared draft |
| -------------------- | --------- | -------- | ----------------- | ------------ |
| Precise location     | Yes       | Optional | App functionality | Yes          |
| Approximate location | Yes       | Optional | App functionality | Yes          |
| App interactions     | Yes       | Optional | Analytics         | Yes          |
| Crash logs           | Yes       | Optional | Analytics         | Yes          |
| Diagnostics          | Yes       | Optional | Analytics         | Yes          |
| Device or other IDs  | Yes       | Optional | Analytics         | Yes          |

“Precise location” here means the server-provided Find My coordinate, not this Android phone's
location. Approximate location is included conservatively because Google documents receipt of the
phone IP. Optional is supportable because Maps mounts only when the user opens optional Find My with
a valid location. Do not claim ephemeral processing or that every app flow is encrypted in transit;
Gator permits a separately warned HTTP server connection. A service-provider or user-initiated
sharing exception may apply, but the owner chose **Shared: Yes** unless a later full release review
approves and documents an exception.

The owner viewed and approved the actual Play v66 map screenshot (SHA-256
`f9b7263bf713cbdfc7abd10aa129729234616ebfdd817c26ebcc97fde3e87f34`), the v66 Privacy & Data Use
screen (SHA-256 `6336115cee14e4e2e73016c441a20abed48753aea1aa32903b8511c9a2890806`), and the v66 Legal & Notices
screen (SHA-256 `3e8e6bf796baf54da000b2235424d3d2ca558c86e581ae7258a960e81a38c7ab`). The map hierarchy exposed
one native map, one marker, one external action, and zero WebViews. The legal actions target exactly
`https://maps.google.com/help/terms_maps/` and `https://policies.google.com/privacy`; the first v66
action also opened its exact destination in the installed browser. Focused host tests cover both
safe-HTTPS destinations.

The closeout rerun passed **6 suites / 25 tests / 0 failures / 0 snapshots**: five map/config/screen/
privacy/legal suites passed 24 tests, and the focused lifecycle polling suite passed its one test.
This approval is bounded to `WEB-03` and private Internal Testing. It is not a complete app-wide Data
Safety declaration, broader-distribution legal approval, or transfer of another candidate's proof.

Final approval cleanup disconnected the synthetic account through Gator and exposed only onboarding's
**Get Started** action. The fixture stopped with `WEB02_CLOSED` after a final bounded summary of 124 requests, 121
authenticated requests, and 33 authorized Find My responses. USB reverse `tcp:1236` was removed while the unrelated
pre-existing `tcp:8081` reverse was preserved; normal phone sleep reported `stay_on_while_plugged_in=0`. TalkBack and
touch exploration were off, Bitwarden remained the sole enabled accessibility service, and the disposable fixture
directory moved recoverably to Trash as `web03-v66.9tNskK`.

The local EAS build's Expo Doctor check was nonblocking but reported **19/20** checks because 27
Expo SDK 57 dependencies have newer recommended patch versions. That is broader dependency/release
follow-up, not a failure of this frozen map acceptance. Also harden future verbose release logs so
they do not echo the restricted Maps key during configuration; the key itself remains Android
package/signature/API restricted and is necessarily embedded in the delivered app.
