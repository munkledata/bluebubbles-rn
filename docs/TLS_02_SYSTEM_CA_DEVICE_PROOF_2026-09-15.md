# TLS-02 system-CA-only Android proof — 2026-09-15

This report closes the selected remediation behavior for
[`TLS-02`](./WORK_PLAN_2026-08-03.md#x-tls-02--define-and-enforce-the-android-ca-trust-policy):
Gator trusts Android's built-in system certificate authorities for HTTPS and does not trust
authorities added through Android Settings. It combines generated-source and packaged-resource
proof with a negative user-CA attempt and a positive public-CA attempt on the exact installed local
artifact.

This is remediation evidence, not Google Play submission or general release sign-off. The next
exact Play candidate must repeat the compact positive/negative boundary recorded in
[`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md).

## Exact local artifact and target

| Boundary          | Observed identity                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source checkpoint | Base commit `626ae931995a424eaebda78c38c61d3bfb68657e` plus the reviewed uncommitted `TLS-02` diff documented here                                       |
| Installed app     | Package `com.bluegreengatorapps.messages`; `0.1.42` / version code `1`; release variant; nondebuggable                                                   |
| APK               | `android/app/build/outputs/apk/release/app-release.apk`; 112,805,877 bytes; SHA-256 `e06447b5f2df6c204c2d6613dba5be2fa28865287a958a7d1185289cf8b7220d`   |
| APK signature     | Local Android development certificate; SHA-256 `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`                                        |
| AAB               | `android/app/build/outputs/bundle/release/app-release.aab`; 80,238,983 bytes; SHA-256 `e3fc3e7e872f4b5e614f0ef7ef596446fdd5a799b42c593a3dc3469d2ed7f194` |
| Android target    | Disposable `bluebubbles_api35` emulator, API 35, `sdk_gphone64_arm64`, serial `emulator-5556`, started read-only without snapshots                       |

The local release was deliberately not uploaded to Play and is not production-signed. The personal
Samsung connected to the Mac was not targeted; every mutating ADB command used the emulator serial
explicitly.

## Generated and packaged policy

The Expo config plugin generates one manifest reference to `@xml/network_security_config` and this
one unqualified policy:

```xml
<network-security-config>
  <base-config cleartextTrafficPermitted="true">
    <trust-anchors>
      <certificates src="system" />
    </trust-anchors>
  </base-config>
</network-security-config>
```

The static cleartext setting exists only to preserve completed `TLS-00` behavior: Gator's runtime
gate requires separate consent before using a user-entered HTTP origin. It does not broaden HTTPS
trust.

A clean disposable `npx expo prebuild --platform android --no-install` generated the exact manifest
reference and XML above. The release APK and AAB both built successfully. The strengthened artifact
checker then decoded the compiled manifest's resource id `0x7f160009`, resolved it through
`base/resources.pb` to the app's sole active, unqualified `xml/network_security_config` file, opened
the optimizer-selected protobuf XML, and found exactly four elements with `src="system"`. It rejects
missing resources, aliases, multiple or qualified variants, disabled variants, extra rules, user or
raw trust anchors, and a different manifest reference.

The optimizer renamed the APK copy to `res/8G.xml`; resolving the compiled reference instead of
assuming a source filename proves the file Android actually selects.

## Installed user-CA rejection

A disposable certificate authority named `Gator TLS-02 Disposable User CA` was installed through
Android Settings and remained visible under **Trusted credentials > User** during both attempts.
Its DER SHA-256 was
`d8e8461142cd2c6fc42a5cbeefa0c1ac40e7fc08b17307f8c120f420e81f1338`.

The HTTPS fixture used a valid-at-test-time leaf signed by that authority, with SANs for
`127.0.0.1` and `localhost`, `CA:false`, and PEM SHA-256
`803ffa595f4594cd0b02cc3666e14778639963f4110726c98eb659e024877f71`.
The Mac explicitly trusted the disposable CA for its control request and received
`{"ok":true}` through one completed TLS and HTTP request.

After resetting the fixture counters to zero, the freshly installed Gator APK attempted manual
setup at the same HTTPS endpoint. The app remained on **Server details** and showed its reachability
error. The fixture recorded:

- 3 raw TCP connections;
- 0 completed TLS sessions;
- 0 HTTP requests and 0 HTTP body bytes; and
- 3 `ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN` client alerts.

The authority was therefore present in Android's user store, but Gator rejected the chain before
credentials or request data could reach HTTP.

## Built-in system-CA positive control

A fresh local HTTP fixture was exposed temporarily through a checksum-verified official
`cloudflared` 2026.9.0 quick tunnel, providing a public hostname and publicly trusted certificate.
After its counters were reset, the same installed Gator APK connected through that URL and issued
exactly one authenticated `GET /api/v1/server/info`. The fixture intentionally returned HTTP 404,
and the app showed the expected server-info failure. Reaching the authenticated HTTP request proves
that the system-CA TLS handshake succeeded; the later 404 was deliberate application-layer failure.

The installed user CA was still visible after this positive control, so the two results did not
come from adding and removing trust between attempts.

Exact Play v64 separately proved the unchanged public-CA paths for server info, synchronization,
WebSocket, upload, and download, plus bare self-signed rejection, in
[`TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md`](./TLS_00_PLAY_CANDIDATE_PROOF_2026-09-14.md). That older
candidate did not contain this newly generated explicit policy, so its transport matrix is retained
only as evidence that the default Android-trust implementations are active; it is not mislabeled as
`TLS-02` candidate proof.

## Verification, limits, and cleanup

Focused verification at the source checkpoint passed:

- Android build-guard tests: 17/17;
- manual-setup and Storage & Privacy component tests: 2 suites / 5 tests;
- strict TypeScript;
- local `assembleRelease` and `bundleRelease`; and
- the narrow runtime-selected AAB policy inspection described above.

The complete `check:android-build` command also reported two unrelated release-environment failures:
the local build had no release Google Maps API key, and existing native debug metadata contained
absolute Mac paths. Those are release-candidate prerequisites and were not weakened or represented
as passing `TLS-02` checks.

This proof does not claim certificate pinning, universal online revocation checking, every Android
version, or a production-signed/Play-delivered result. Android owns its system trust store,
certificate and hostname validation, and whatever blocklist, Certificate Transparency, or
stapled/platform revocation signals that Android version provides; this proof does not assert that
API 35 exercised each mechanism. A future request to support user-installed authorities is new work tracked as
[`POST-TLS-02`](./POST_REMEDIATION_PLAN.md#post-tls-02).

Cleanup was verified: the listener, tunnel, and fixture stopped; the ADB reverse rule was removed;
the disposable authority was deleted; the read-only/no-snapshot emulator was stopped; and all
temporary certificate, key, and tunnel files were individually deleted. `adb devices -l` then
listed only the untouched personal Samsung.
