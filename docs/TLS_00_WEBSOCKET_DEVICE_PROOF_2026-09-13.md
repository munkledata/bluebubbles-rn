# TLS-00 local-release WebSocket redirect proof — 2026-09-13

## Scope and boundary

This report records physical-Android evidence for the React Native WebSocket redirect fix in commit
`78e7e96`. It advances, but does not close, [`TLS-00`](./WORK_PLAN_2026-08-03.md#-tls-00--centralize-feasible-cleartext-consent-and-enforcement).
The installed app was a locally built, nondebuggable release variant—not a Play-delivered candidate—so
this report must not be cited as exact-Play evidence.

- Device: Samsung `SM-S938U1`, Android API 36, `arm64-v8a`.
- App: `0.1.42`, version code `1`, package `com.bluegreengatorapps.messages`.
- Source: `78e7e96`.
- APK: `android/app/build/outputs/apk/release/app-release.apk`, 111,133,562 bytes, SHA-256
  `5ce28a00ad99c015bc2e13712db155c77ceddeb1187e779602dd6648d170b7b6`.
- Build/signing boundary: Gradle `assembleRelease` succeeded and Android reported the app as
  nondebuggable. The APK used the local development signer, not the production/Play signer.
- Server: the isolated `TestBackendHost` from server commit `c33a1ee3`, with only synthetic chat data
  and a disposable credential.
- Transient redirect fixture script SHA-256:
  `059306f42bb09717cabe53d43a7133b8fd311a91e09a5ccdab803d0f43b07018`.

The fixture returned redirects from the approved WebSocket handshake and counted the approved first
hop separately from a second, reachable TCP trap. It recorded only aggregate connection, HTTP-request,
received-byte, and Authorization-presence counters; no credential, payload, phone identifier, or
private message was printed or retained.

## HTTP WebSocket redirect matrix

After a clean setup, the app explicitly approved `http://127.0.0.1:1236`. Authenticated server-info,
synchronization, and seeded-chat loading succeeded. Successive Socket.IO WebSocket handshakes received
`301`, `302`, `303`, `307`, and `308` responses. Every response pointed to the cross-origin cleartext
trap at device port `1238`.

The approved first hop saw an Authorization header on every upgrade. After all five statuses and
continued retries, the trap remained exactly:

```text
connections=0, bytes=0, authorization_requests=0
```

A direct phone-originated `toybox nc` control then changed only the trap connection counter from zero
to one. This proves the target was reachable from the phone and that the preceding zero was caused by
the app rejecting redirects rather than a broken USB reverse route.

## Public-CA WSS-to-WS downgrade

A preliminary local TLS listener used the formerly public `*.backloop.dev` development certificate.
The current phone rejected it: the app displayed `Could not reach your server`, while the listener
counted three TCP connections, zero completed TLS connections, and three
`SSL/TLS alert certificate unknown` failures. This attempt receives no public-CA or self-signed row
credit.

For the valid-certificate case, a checksum-verified, temporary Cloudflare `cloudflared` 2026.9.0
binary created an accountless quick tunnel from a transient public-CA HTTPS origin to the isolated
fixture. The downloaded Darwin arm64 archive SHA-256 was
`c0eccb3758420d1f4e46cbf2b8ecde01d9802a154232a817f25133340009fcc7`. The extracted binary SHA-256 was
`2d67b7315f96799123e19442580ce7c7616d6d7f322686fa829dd4e3fddfe715`, and that executable digest
matched Cloudflare's published Darwin arm64 checksum. Only synthetic test data was exposed, and the
random hostname and disposable credential are not retained here. A Mac control received HTTP 401
from the fixture through the tunnel, establishing that the TLS endpoint and forwarding path were live
without authenticating.

The app then completed HTTPS setup and authenticated REST synchronization through that public-CA
origin. Its derived Socket.IO transport began as WSS. The fixture returned a cross-origin `308` whose
destination was `http://127.0.0.1:1238`, making it both a redirect and a TLS downgrade. The approved
first hop repeatedly received authenticated upgrade attempts; the trap stayed at its pre-run baseline
of one connection, zero bytes, and zero Authorization-bearing requests.

On the Messages screen, the seeded chat was visible and the explicit live state read
`Reconnecting…`. A first `am kill` attempt did not remove the process and receives no restart credit.
The subsequent `am stop-app --user current` control did remove the PID. Cold launch returned directly
to Messages, authenticated HTTPS REST data loaded again, the socket remained safely reconnecting, and
the trap remained unchanged. A final direct phone-originated TCP control then changed the trap count
from one to two, again proving reachability after the WSS test.

Immediately before that final control, the fixture's cumulative counters across the HTTP and WSS
phases were:

```text
front_connections=100
front_http_requests=35
front_authorization_requests=34
front_upgrade_requests=79 (Authorization present on all 79)
trap_connections=1
trap_bytes=0
trap_authorization_requests=0
```

After the final phone control, the trap tuple was exactly `2 / 0 / 0`; the extra connection was the
deliberate control and not an app redirect.

Together these observations prove that the local release containing `78e7e96` rejects React Native
cross-origin HTTP WebSocket redirects for `301/302/303/307/308`, and rejects a representative
public-CA WSS-to-WS cross-origin `308`, before any redirected TCP connection or credential-bearing
request.

## What remains open

`TLS-00` remains **IN_PROGRESS**. This proof is deliberately limited to React Native WebSockets and
does not satisfy the complete transport matrix required by the task specification and
[`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md#5-network-and-security-smoke-tests). Remaining evidence
includes:

- ordinary JSON API redirect rejection;
- the active Expo legacy attachment-upload path, including body/credential zero at the target;
- the owned bounded attachment-download path;
- successful public-CA HTTPS upload and download;
- explicit rejection of an untrusted/self-signed certificate;
- a decision and documentation correction for the dormant raw-multipart branch that has no production
  caller; and
- final exact-candidate artifact/device evidence after the remaining paths are green.

The earlier exact Play v63 setup, cleartext consent, server rotation, normal HTTPS, and new-server
downgrade evidence remains separately scoped in
[`RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md`](./RT_01A_PLAY_DEVICE_PROOF_2026-09-13.md).

## Cleanup

- The app's synthetic account data was cleared and the phone was left at **Get Started**.
- All USB reverse rules created by this test were removed.
- The fixture and both TLS/tunnel processes were stopped. The former quick-tunnel URL returned HTTP
  530 after shutdown.
- The transient test folder, including the checksum-verified tunnel binary and in-memory TLS wrapper,
  was moved to macOS Trash and is recoverable until Trash is emptied.
- The local nondebuggable `0.1.42` / version-code-1 APK remains installed; the prior Play build is not
  currently installed.
