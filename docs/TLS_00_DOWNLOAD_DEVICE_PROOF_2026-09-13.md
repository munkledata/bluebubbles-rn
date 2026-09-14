# TLS-00 local-release owned-download proof — 2026-09-13

## Scope and boundary

This report records physical-Android redirect and success evidence for the app-owned bounded
attachment downloader. It advances, but does not close,
[`TLS-00`](./WORK_PLAN_2026-08-03.md#-tls-00--centralize-feasible-cleartext-consent-and-enforcement).
The tested app was a locally built, nondebuggable release variant with a local development signer,
not a Play-delivered or production-signed candidate.

- Device: Samsung `SM-S938U1`, Android API 36, `arm64-v8a`.
- App: `0.1.42`, version code `1`, package `com.bluegreengatorapps.messages`.
- Source boundary: the installed release contains ordinary JSON redirect repair `ea92eca` and the
  existing `GatorBoundedDownload` native owner.
- APK: `android/app/build/outputs/apk/release/app-release.apk`, 111,133,630 bytes, SHA-256
  `b31082ce3c3a83a2eca14a0a9a514679fc7d344fa0fba47e9ec2401ff9fe93b6`.
- Local signer certificate SHA-256:
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`.
- Server: isolated `TestBackendHost` from clean commit
  `7ba80144e78605f6b71ce7c507fcbc2dad59d04a`, containing synthetic backup data and a disposable
  credential only.
- Transient fixture SHA-256:
  `0967c0c399dc4c1c00760f8df8628a848de02de1ab8381052d890f235635a891`.

A checksum-verified temporary Cloudflare tunnel supplied the approved public-CA HTTPS origin. A
second temporary public-CA tunnel supplied the cross-origin HTTPS target, and a USB-reversed local
listener supplied a phone-reachable cleartext target. The fixture retained only aggregate request,
body-byte, connection, and Authorization-presence counts. It did not print or retain hostnames, the
disposable credential, private message data, or downloaded content.

## Redirect matrix

The active UI path was the synthetic image attachment in `Synthetic Backup`. Before success, its
accessibility label was `Photo, not downloaded`. Each retry invoked the authenticated production
request:

```text
GET /api/v1/attachment/synthetic-attachment/download
```

The phone exercised `301`, `302`, `303`, `307`, and `308` against each required destination class:

- a relative target on the same public-CA HTTPS origin;
- a target on a separately hosted public-CA HTTPS origin; and
- a cross-origin HTTP target reachable through the USB reverse rule.

All 15 approved first hops were authenticated GET requests with zero body bytes. During the app
cases, every target remained exactly zero requests, zero body bytes, and zero Authorization-bearing
requests. The separate-origin targets also remained at zero TCP connections.

After the app matrix, bounded direct controls proved that all three targets were live:

- the same-origin HTTPS control returned HTTP 204 and changed only its target to one unauthenticated,
  zero-byte request;
- the cross-origin public-CA HTTPS control returned HTTP 204 and changed only that trap to one
  connection and one unauthenticated, zero-byte request; and
- a direct phone-originated `toybox nc` control changed only the cleartext trap connection count.

The controls ran after the app cases, so they do not weaken the preceding zero-target result.

## Successful public-CA download

The stock synthetic attachment fixture labels nine literal bytes as PNG, which Android correctly
rejects during native image validation. For this positive transport control only, the transient
front returned the app's existing valid `assets/favicon.png`: a 96-by-96 PNG of exactly 13,191 bytes.
This changed no production or server-repository file.

After the success case was armed, one phone tap completed the authenticated public-CA HTTPS download.
The fixture counted exactly one successful download control and returned the complete 13,191-byte
PNG. The phone's accessibility label changed from `Photo, not downloaded` to `Photo`, proving that
the native downloader accepted, stored, and rendered the validated image. No unarmed download request
occurred.

The fixture's final aggregate state, including the three deliberate post-matrix controls, was:

```text
front_connections=26
front_requests=33
front_authorization_requests=32
front_upgrade_requests=1 (Authorization present)
redirects=15
successful_download_controls=1
unarmed_download_requests=0
same_origin_target: requests=1, body_bytes=0, authorization_requests=0
separate_targets: connections=2, requests=1, body_bytes=0, authorization_requests=0
```

## Result, limits, and cleanup

This closes the local-release owned-download redirect matrix and public-CA download control. It is
native physical-device evidence: the request traveled through `GatorBoundedDownload`, and the valid
image reached the app's rendered attachment state. It does not provide exact-candidate or Play-signer
credit.

`TLS-00` remains **IN_PROGRESS** for the active legacy attachment-upload matrix, successful
public-CA upload, explicit untrusted/self-signed rejection, the dormant raw-multipart disposition,
and final exact-candidate evidence.

The download fixture and second public-CA tunnel were stopped, and the USB reverse rule was removed.
The first disposable tunnel and synthetic app account remain temporarily available for the next
isolated upload test; final test-account and temporary-tool cleanup therefore remains pending.
