# WEB-02 exact Play disabled-path proof — 2026-09-14

## Outcome

`WEB-02` is **DONE BY DISABLED-PATH CONTAINMENT** for the shipped product. The exact Google Play
Internal candidate contains no Gator-owned embedded WebView path, remote map executable, or map
asset. On the physical Android device, Find My rendered its fixed privacy-disabled placeholder both
with ordinary networking available and with Wi-Fi and mobile data disabled. A future embedded-map
implementation must reopen `WEB-01..03` and complete the original WebView, hostile-navigation,
network, attribution, and tile-policy matrix.

This receipt proves only the disabled Find My map boundary. It does not close `WEB-03`, `FACE-01`,
or general release readiness.

## Exact candidate identity

| Item                  | Evidence                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Installed app         | `com.bluegreengatorapps.messages`, `0.1.47` / version code `64`, installed by `com.android.vending`, nondebuggable |
| App source            | `fa6e907`; release commit `e22aacd`; the release-only delta changes package version fields                         |
| AAB                   | `gator-release-0.1.47-v64-e22aacd.aab`; 56,150,684 bytes                                                           |
| AAB SHA-256           | `b53b272a757ccb1346928787b927a2cb63dfa2edf57fe44820367a2552784178`                                                 |
| Play base APK SHA-256 | `6950e6a1a2e355b83bce9251d822437bac94936fbb561bb5e2ae4f5ba28a1c0e`                                                 |
| Device                | Physical Samsung, Android 16 / API 36                                                                              |

The retained AAB was read from the frozen release workspace. Its byte count and SHA-256 matched the
release record, and `unzip -t` passed without compressed-data errors.

## Packaged and source boundary

An independent read-only scan covered the AAB manifest, six DEX files, assets, and Hermes bundle:

- `com.reactnativecommunity.webview`, `RNCWebViewPackage`, `RNCWebViewManager`, and
  `RNCWebViewModule` were absent.
- No Leaflet/map HTML, JavaScript, or CSS asset was packaged.
- The Hermes bundle contained no `unpkg`, Leaflet, OpenStreetMap tile host, Mapbox, MapLibre,
  jsDelivr, or cdnjs endpoint.
- The Hermes bundle did contain the fixed `Embedded map disabled for privacy` presentation.
- Expo SDK 57's transitive `DomWebViewModule` remained packaged as expected. This is framework
  capability, not evidence that Gator imports or mounts it.

Under the pinned Node 24.19.0 toolchain, `scripts/check-core-boundaries.test.mjs` passed **20/20**.
The live guard passed **489 production files without embedded-WebView imports**. `npm ls
react-native-webview --all` resolved no package.

## Isolated fixture controls

The phone used a temporary USB-reversed loopback endpoint backed by `TestBackendHost` from clean
server commit `ffe8a68f3a774579744b00e649f69fd6c55f4dfb`. A reviewed temporary proxy replaced only the
three authenticated Find My GET bodies after the real upstream operation returned HTTP 200. It
returned one finite synthetic coordinate and no personal messages, locations, server credentials,
or account data. Its source SHA-256 was
`8fdaf9446b32cc3b5e4b320aef5a8bdd66dfaabe1b9996e98f605a4dd5500fd2`.

Before phone use, the same endpoint returned HTTP **401** without authentication and HTTP **200**
with the synthetic credential. The accepted response contained exactly one device and two finite
coordinate numbers. Independent fixture review was **GO** for loopback isolation, authentication
preservation, synthetic-only data, and bounded cleanup.

The final fixture summary recorded 26 HTTP requests, 25 requests carrying an auth header, 11 Find
My attempts, and 10 upstream-authorized Find My substitutions. The one remaining attempt was the
deliberate unauthenticated 401 control. Upgrade counts were attempts only and are not claimed as
authenticated WebSocket evidence.

## Physical-device results

| Check                  | Result                                                                                                                                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Connected online route | `Synthetic Phone` and its finite synthetic location rendered                                                                           |
| Map containment        | Fixed privacy-disabled map message rendered                                                                                            |
| Android hierarchy      | Zero `android.webkit.WebView` nodes                                                                                                    |
| Explicit fallback      | `Open Synthetic Phone in Maps` was present; it was not tapped, so the proof created no map-app traffic                                 |
| Network-off replay     | Wi-Fi and mobile data were disabled, the route was reopened, the same device and placeholder rendered, and WebView nodes remained zero |
| App-owned destinations | A 200 ms app-UID `/proc/net/tcp*` observer saw only IPv4-mapped loopback port `18765`, the configured Gator fixture                    |

The socket observer is connection sampling, not a packet capture; an extremely short connection
could fall between samples. The exact packaged-string/asset absence, source import guard, controlled
fixture, and identical network-off result are complementary evidence. The fixture's WebSocket path
was not part of this acceptance and is not credited.

## Cleanup

- The synthetic account was disconnected and a fresh hierarchy showed `Get Started`.
- Wi-Fi and mobile data were restored to their original enabled settings; airplane mode remained
  unchanged and off.
- The exact `tcp:18765` USB reverse rule was removed; no reverse rules remained.
- The fixture closed through its supervised shutdown, its listener and process were absent, and
  `TestBackendHost` removed its owned temporary root.
- The temporary proxy source and pulled APK copies were moved to the Mac Trash, so they remain
  recoverable. The frozen release workspace and AAB were not removed.
