# TLS-00 local-release JSON redirect proof — 2026-09-13

## Scope and boundary

This report records the failed-before and passed-after physical-Android proof for ordinary
authenticated JSON API redirects. It advances, but does not close,
[`TLS-00`](./WORK_PLAN_2026-08-03.md#-tls-00--centralize-feasible-cleartext-consent-and-enforcement).
The tested app was a locally built, nondebuggable release variant with a local development signer,
not a Play-delivered or production-signed candidate.

- Device: Samsung `SM-S938U1`, Android API 36, `arm64-v8a`.
- App: `0.1.42`, version code `1`, package `com.bluegreengatorapps.messages`.
- Repair: source and focused regression test committed as `ea92eca`.
- Repaired APK: `android/app/build/outputs/apk/release/app-release.apk`, 111,133,630 bytes,
  SHA-256 `b31082ce3c3a83a2eca14a0a9a514679fc7d344fa0fba47e9ec2401ff9fe93b6`.
- Local signer certificate SHA-256:
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`.
- Fixture: isolated `TestBackendHost` from clean server commit `7ba80144e78605f6b71ce7c507fcbc2dad59d04a`,
  with only synthetic backup data and a disposable credential.
- Transient JSON redirect fixture SHA-256:
  `f6702e89fa295afb3527dbe707b368ac5286817179f38a99f5865e3878ef1d51`.

A checksum-verified temporary Cloudflare tunnel supplied a public-CA HTTPS origin. The fixture
counted the approved first hop and a separate, phone-reachable cleartext trap. It retained only
aggregate connection/request/body-byte counts and Authorization/content-type presence booleans; it
did not print or retain the random hostname, disposable credential, request body, phone identifier,
or private message data.

## Failed-before result and root cause

The pre-repair local release APK (SHA-256
`5ce28a00ad99c015bc2e13712db155c77ceddeb1187e779602dd6648d170b7b6`) received a cross-origin `301`
from `POST /api/v1/chat/query`. The approved HTTPS first hop received one authenticated JSON POST
with an 83-byte body. The trap then received one unauthenticated GET with a zero-byte body:

```text
approved: method=POST, body_bytes=83, authorization=true, json_content_type=true
trap: connections=1, requests=1, body_bytes=0, authorization_requests=0
```

No credential or body crossed origins, but the second request violated the required no-follow
policy, so the remaining status matrix was stopped.

The installed React Native `Request` polyfill neither stores nor clones its `redirect` member. Ky
1.14.3 constructs and clones that Request, then deliberately omits standard Request fields from the
final fetch options because browsers retain them on the Request object. Expo fetch therefore saw no
redirect mode and used its default `follow` behavior. Commit `ea92eca` keeps `src/core` platform-free
and wraps only the ordinary JSON fetch supplied to Ky, forcing `redirect: 'error'` again at the final
dispatch. The separate native attachment-upload path is unchanged.

## Repaired release proof

Gradle `assembleRelease` completed successfully in 43 seconds. The repaired APK was installed in
place over the synthetic account. The two touched files in the built working tree are byte-identical
to their versions in `ea92eca`.

A fresh-fixture normal control then used a true process stop and cold launch. The app completed two
authenticated chat-query controls and two authenticated WebSocket handshakes through the public-CA
origin. The trap remained at zero:

```text
front_connections=6
front_http_requests=10 (Authorization present on all 10)
front_upgrade_requests=2 (Authorization present on both)
successful_chat_query_controls=2
trap_connections=0
trap_requests=0
trap_body_bytes=0
trap_authorization_requests=0
```

For each of `301`, `302`, `303`, `307`, and `308`, the app process was removed with
`am stop-app --user current`, its PID was confirmed absent, and Android reported a cold launch. The
next `POST /api/v1/chat/query` received that status with a Location pointing to the cross-origin
cleartext trap. Every approved first hop had the same bounded shape:

```text
method=POST, body_bytes=83, authorization=true, json_content_type=true
```

After all five statuses, aggregate fixture counters were:

```text
front_connections=28
front_http_requests=44 (Authorization present on all 44)
front_upgrade_requests=7 (Authorization present on all 7)
successful_chat_query_controls=2
redirect_statuses=[301,302,303,307,308]
trap_connections=0
trap_requests=0
trap_body_bytes=0
trap_authorization_requests=0
```

A final direct phone-originated `toybox nc` control changed only `trap_connections` from zero to one;
requests, bytes, and Authorization-bearing requests remained zero. This proves the target was
reachable from the phone and that the five preceding zeros came from app-side redirect rejection.

## Supporting verification and remaining boundary

- Focused HttpClient suites: 2 suites, 32 tests passed.
- TypeScript typecheck: passed.
- Fast DB-write safety gate: 104 cases, 91 passed, 13 intentionally skipped, 0 failed.
- Architecture gate: 52/52 passed.
- Independent security review: GO; it separately reproduced the lost-redirect handoff and verified
  the wrapper restores the final fetch option without changing method/body or the multipart path.

This closes the local-release ordinary JSON redirect row only. `TLS-00` remains **IN_PROGRESS** for
the active native attachment-upload path, owned bounded downloads, successful public-CA upload and
download, explicit untrusted/self-signed rejection, the dormant raw-multipart disposition, and final
exact-candidate evidence.
