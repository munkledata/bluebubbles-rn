# TLS-00 local-release legacy-upload proof — 2026-09-13

## Scope and boundary

This report records physical-Android redirect and synthetic-success evidence for the production
legacy attachment uploader. It advances, but does not close,
[`TLS-00`](./WORK_PLAN_2026-08-03.md#-tls-00--centralize-feasible-cleartext-consent-and-enforcement).
The tested app was a locally built, nondebuggable release variant with a local development signer,
not a Play-delivered or production-signed candidate.

- Device: Samsung `SM-S938U1`, Android API 36, `arm64-v8a`.
- App: `0.1.42`, version code `1`, package `com.bluegreengatorapps.messages`.
- Source boundary: the installed release contains ordinary JSON redirect repair `ea92eca` and the
  existing patched Expo legacy uploader.
- APK: `android/app/build/outputs/apk/release/app-release.apk`, 111,133,630 bytes, SHA-256
  `b31082ce3c3a83a2eca14a0a9a514679fc7d344fa0fba47e9ec2401ff9fe93b6`.
- Local signer certificate SHA-256:
  `fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c`.
- Server fixture: isolated `TestBackendHost` from clean server commit
  `ffe8a68f3a774579744b00e649f69fd6c55f4dfb`, containing synthetic backup data and a disposable
  credential only. Its upload route and test host were unchanged from the earlier clean
  `7ba80144e78605f6b71ce7c507fcbc2dad59d04a` boundary.
- Redirect fixture SHA-256:
  `a6a30c384f3a6e611e271aee5680c61a3845a5238a54633eef2bad7204afdd8e`.
- Startup-armed success fixture SHA-256:
  `0c2d250890242d3e4d3a9d7dd532bd3a50ef3fbf534e42d1867f6400aa9d47b9`.

The phone selected the existing valid 13,191-byte `assets/favicon.png`, staged temporarily as
`gator-tls-upload.png` in Downloads. The app path was `Attach photo or file` → `Attach a file` → the
Android DocumentsUI picker → `Send message`. The active production uploader issued a multipart
request with an Authorization header:

```text
POST /api/v1/message/attachment/upload
file field: attachment
```

The fixture counted request shape and complete body length without retaining the multipart content,
credential, hostnames, chat/message identifiers, or file bytes. A checksum-verified temporary
Cloudflare tunnel supplied the approved public-CA HTTPS origin. A second disposable public-CA tunnel
and an isolated USB-reversed listener supplied the two separate redirect targets.

## Frozen redirect-matrix checkpoint

The initial `301` produced the expected `Message not delivered. Show options` UI. Each later case
reused that exact durable failed row through `Try Again`, preserving the selected file and temporary
message identity. The phone exercised `301`, `302`, `303`, `307`, and `308` against each destination
class:

- a relative target on the same public-CA HTTPS origin;
- a target on a separately hosted public-CA HTTPS origin; and
- a cross-origin HTTP target reachable through the USB reverse rule.

Immediately after the fifteenth armed app attempt completed, the append-only fixture reported
exactly the expected 15 combinations. Every record had the same validated shape:

```text
method=POST
authorization_present=true
multipart_content_type=true
request_complete=true
body_bytes=13946
declared_body_bytes=13946
```

At this frozen checkpoint, `unarmed_upload_requests=0` and `incomplete_upload_requests=0`. The
same-origin, cross-origin HTTPS, and HTTPS-to-HTTP targets were all at zero requests, zero body bytes,
and zero Authorization-bearing requests. The two separate-origin targets were also at zero TCP
connections. This establishes the local-release redirect result before any reachability control
changed a target counter.

## Post-checkpoint controls and retry chronology

After the frozen checkpoint, a direct request to the same public-CA origin's relative target returned
HTTP 204 and changed only that target to one unauthenticated, zero-byte request. A direct request
through the second public-CA tunnel also returned HTTP 204 and changed only that trap to one
connection and one unauthenticated, zero-byte request.

The intended phone-originated cleartext HTTP control had a shell-formatting error before it wrote an
HTTP request. It nevertheless opened the USB-reversed TCP target and changed its connection count
from zero to one while requests, bytes, and Authorization remained zero. This supplies TCP
reachability only; it receives no HTTP-control credit and is not part of the redirect matrix.

During those post-checkpoint controls, the app's scheduled retry issued one additional upload after
the matrix with no fixture action armed. The fixture fully consumed it, returned its fail-closed HTTP
503, and changed `unarmed_upload_requests` from zero to one. It supplied no redirect, and no redirect
target counter changed. The earlier append-only checkpoint remains the authority for the 15 clean
matrix cases; the later request is neither counted as a case nor presented as an uncontaminated final
aggregate.

## Successful public-CA upload control

The success control used a fresh fixture process with the response armed at startup, removing the
scheduled-retry timing race. One explicit `Try Again` completed the same production native upload.
Its only upload record was:

```text
method=POST
authorization_present=true
multipart_content_type=true
request_complete=true
body_bytes=13946
declared_body_bytes=13946
successful_upload_controls=1
unarmed_upload_requests=0
incomplete_upload_requests=0
```

The transient front returned a schema-valid success envelope containing a unique synthetic message
GUID and `viaPrivateApi: true`. The phone removed the failure control and displayed `Sent` beneath the
outgoing image. This proves the native multipart transfer and normal Private API acknowledgement
path over public-CA HTTPS. The front deliberately did not invoke the fixture's unavailable macOS
iMessage transport, so this is not evidence that a real server delivered an iMessage.

An independent review verified that the fixture reserves an arm when a request starts, drains the
entire body before responding, isolates the HTTPS and HTTP targets, and fails unarmed uploads closed.

## Result, limits, and cleanup

This closes the local-release legacy-upload redirect matrix and synthetic public-CA upload transport
control. It does not provide credit for the separate dormant raw `HttpClient` multipart helper or
for an exact Play candidate.

`TLS-00` remains **IN_PROGRESS** for explicit untrusted/self-signed-certificate rejection, the
dormant raw-multipart disposition, and final exact-candidate evidence.

Both upload fixture processes and the second public-CA tunnel were stopped, and the USB reverse rule
was removed. The synthetic `Sent` row, its 13,191-byte staged source PNG, the first disposable tunnel,
and the test account remain temporarily available until the remaining local TLS work is complete.
