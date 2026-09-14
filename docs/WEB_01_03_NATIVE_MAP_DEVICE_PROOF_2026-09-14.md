# WEB-01..03 native Find My map — local device proof

> **Evidence class:** local debug/native supporting evidence from 2026-09-14.
>
> **Not release closure:** this is not a frozen source tree, production-signed AAB, Play-delivered
> candidate, approved public policy, or final Data Safety/terms review. `WEB-01`, `WEB-02`, and
> `WEB-03` therefore remain **IN_PROGRESS** in the remediation plan.

## Scope and identity

- Android target: physical Samsung phone on Android 16 / API 36. The device serial and network
  identity are intentionally omitted.
- Native shell: local debug APK, app `0.1.42`, version code `1`, package
  `com.bluegreengatorapps.messages`.
- APK SHA-256:
  `dac397721ff66c4bc930ab73f338c5d99cac98bf2bee7118e358505d0de72c44`.
- Signing certificate SHA-1:
  `5e8f16062ea3cd2c4a0d547876baa6f38cabf625` (`CN=Android Debug`).
- The native shell was built from the current working tree and the JavaScript screen was served by
  the local development bundle. This binds the native module/config proof, but not a frozen release
  source snapshot.
- Installing the debug-signed shell required removing the differently signed Play install. That
  cleared only Gator's prior app data; the product owner explicitly authorized the uninstall and
  replacement.

## Implementation and build evidence

- Expo SDK 57's exact compatible `react-native-maps` `1.27.2` package replaces the retired
  Leaflet/generated-HTML/WebView implementation.
- A clean Expo Android prebuild and `assembleDebug` completed. The final rebuild completed in about
  2 minutes 6 seconds.
- The merged and installed manifests contained the native Google Maps API-key metadata and no
  `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`, `ACCESS_BACKGROUND_LOCATION`, or
  `FOREGROUND_SERVICE_LOCATION` declaration.
- The project uses one dedicated billed Maps key restricted to the Gator Android package, Maps SDK
  for Android, and four reviewed signing certificates. The clean local debug certificate and
  retained upload certificate match reviewed entries. The key value is intentionally absent from
  this receipt.
- The development, preview, and production EAS environments contain the Maps value as a project
  Secret for hosted builds. Secret values are unavailable to EAS local builds, so the supported
  local release runner requires a caller-provided value and binds only its SHA-256 digest to the
  exact AAB.
- Two superseded key values appeared in local command/SDK output during setup and were deleted from
  the Google project. The active restricted key was created and handled through redacted command
  paths; no key value belongs in repository evidence.

## Physical-device results

All locations below were synthetic fixtures; their labels and coordinates are intentionally omitted.

| Check                  | Result                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native surface         | One `findmy-native-map` Android view rendered streets and six marker nodes; no WebView node was present.                                                          |
| Attribution            | The SDK-provided Google logo was visible and unobscured at the bottom of the map.                                                                                 |
| Location minimization  | Installed package declarations contained none of the four blocked location permissions, and the map did not expose a phone-location control/layer.                |
| Initial framing        | Six finite synthetic server locations were fitted into the visible native map.                                                                                    |
| Marker focus           | Tapping a list row centered the corresponding marker and opened its label callout.                                                                                |
| Repeated focus         | After panning away, tapping the same row again returned that marker to the map center and reopened its callout.                                                   |
| Route lifecycle        | Navigating to Messages removed the native map node; reopening Find My recreated one map and six markers.                                                          |
| Explicit fallback      | The named **Open in Maps** action opened the installed system Maps app with the same synthetic coordinate and label; returning to Gator remounted the native map. |
| Provider authorization | After the final certificate restriction was added and the app rebuilt, the map rendered streets without a new authorization or API-token error.                   |

A privacy-safe screenshot showing the synthetic native map, marker pins, and unobscured Google logo
was retained only as local temporary evidence at
`/private/tmp/gator-findmy-native-map-authorized-2.png`; it is not a store asset or committed user
artifact.

## Host support

The focused host gate exercises marker range/duplicate/count/label containment, the native-provider
and disabled-control props, repeated same-row focus, route/background/App-Lock unmounting, privacy
copy, configuration resolution, and location-coordinate validation. It passes **6 suites / 34
tests**. The Android build/release guards pass **34/34**, the legal inventory/AAB guards pass
**12/12**, the toolchain guard passes **19/19** plus its four-lane live environment smoke, and the
workflow-security guard passes **37/37** plus its live scan. Strict TypeScript also passes.

## Deliberately uncredited or remaining evidence

- The offline attempt is **not credited**: the Android Wi-Fi status command used by automation was
  unsupported, so the script could not prove when connectivity changed. Wi-Fi and mobile data were
  restored immediately afterward.
- Exact Play candidate: clean/frozen source, release AAB identity/signature, native dependency,
  manifest key-digest match, WebView absence, location-permission absence, install identity, and
  device replay.
- Physical lifecycle/privacy: actual app-background and App-Lock transitions, account teardown, and
  controlled observation showing when Google Maps traffic begins/stops.
- Outage/fallback behavior with a reliably observed offline transition.
- TalkBack traversal of the map summary, markers, SDK attribution, list, and external fallback with
  no focus trap.
- Candidate screenshot review; owner/legal review of the wired Google Maps terms/privacy
  destinations; Play Data Safety reconciliation; owner/legal approval.

The prior
[`WEB_02_PLAY_DEVICE_PROOF_2026-09-14.md`](./WEB_02_PLAY_DEVICE_PROOF_2026-09-14.md) remains valid
historical proof that Play v64 shipped the disabled map path. It cannot be transferred to this
restored native implementation.
