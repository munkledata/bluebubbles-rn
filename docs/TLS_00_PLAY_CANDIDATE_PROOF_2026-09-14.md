# TLS-00 exact Google Play candidate proof — 2026-09-14

This report closes the remaining exact-candidate boundary for
[`TLS-00`](./WORK_PLAN_2026-08-03.md#-tls-00--centralize-feasible-cleartext-consent-and-enforcement).
It is limited to transport trust, redirect containment, and the removal of the dormant raw multipart
path. It is not a general Android-device, messaging-delivery, Play-policy, or public-release sign-off.

## Exact candidate

| Boundary                 | Observed identity                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Installed app            | `0.1.47` / version code `64`; package `com.bluegreengatorapps.messages`; installed by `com.android.vending`; nondebuggable           |
| Device                   | Owner-enrolled Samsung, Android 16 / API 36                                                                                          |
| App source               | `fa6e907beb776fc690cc392f7268d772705bf717`; required implementation commits `78e7e96`, `ea92eca`, and `ce0b8c0` are ancestors        |
| Release                  | branch `release/android-0.1.47`; commit `e22aacdca959c2e04f0a83a205bd7c012644acf6`; run `android-0.1.47-fa6e907-20260914045445`      |
| AAB                      | `gator-release-0.1.47-v64-e22aacd.aab`; 56,150,684 bytes; SHA-256 `b53b272a757ccb1346928787b927a2cb63dfa2edf57fe44820367a2552784178` |
| Upload certificate       | SHA-256 `6E:18:F9:93:61:DC:D6:58:F1:A7:5B:9F:47:E8:66:AC:8D:A6:AF:EF:B9:E7:F4:7C:BF:41:F5:E0:F6:CE:2F:43`                            |
| Installed Play signature | SHA-256 `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                                                           |
| Delivery                 | Submitted only to Google Play Internal Testing; Play delivered version code `64` to the enrolled phone                               |

The release receipt reports validation `passed` for ZIP integrity, packaged-artifact identity,
signature, hash, and native-path proof. The phone identity above was read from Android after the Play
install; it was not inferred from the AAB filename.

## Valid public-CA transport smoke

The unmodified Play app connected to an isolated server fixture through a temporary public-CA HTTPS
origin. The fixture required the exact disposable credential for every protected request and retained
only counters and request shape, not the credential or multipart bytes.
The independently reviewed combined fixture had SHA-256
`6691f25f499adef04142e98c8589e77c2b43b741aefae6ea133abb80aff1a8f6`.

The phone completed these visible and server-observed paths:

- authenticated server information, chat query, message synchronization, device, and ping traffic;
- the visible `Synthetic Backup` conversation and its `synthetic message` after synchronization;
- two exact-authenticated WebSocket upgrades;
- one emitted `new-server` socket event, which displayed `Approve server change?` with the current and
  proposed origins; the proposal was cancelled and the invalid proposed origin was never approved;
- one exact-authenticated 13,191-byte PNG download, SHA-256
  `b56fdb8a77c6959edc9e92c5ad589c0624848e03213360cf0245f7d051ecf6f2`, rendered as `Photo` and opened
  in the app's media viewer; and
- one exact-authenticated, complete 13,968-byte multipart upload selected through Android's document
  picker and rendered as `Sent` after the synthetic acknowledgement.

The positive fixture recorded one successful download and one successful upload. Its unarmed,
unauthorized, rejected, incomplete, and oversized upload counters were all zero. The synthetic
acknowledgement proves the production native upload and acknowledgement path, not real iMessage
delivery.

An attempted `am kill` did not actually remove the process and receives no cold-process credit. After
the synthetic account was disconnected, `am stop-app --user current` did remove the process; relaunch
returned to `Get Started` and produced no additional connection, request, authorization, upgrade,
upload, download, or proposal event.

## Ordinary JSON redirect matrix

The active authenticated `POST /api/v1/chat/query` path exercised every combination of these sets:

- status: `301`, `302`, `303`, `307`, and `308`;
- destination: same-origin HTTPS, cross-origin HTTPS, and HTTPS-to-HTTP.

The JSON redirect fixture had SHA-256
`570d7fdca69ad1e2ed6200573d7c2858bc5fb8caa53b0e68dbe36b2de8579f21`.

The frozen checkpoint contained exactly 15 records. Every approved first hop was an authenticated
JSON `POST` with an 83-byte body. Before any control request, all redirect targets had zero
connections or requests where the fixture could observe TCP, zero body bytes, and zero Authorization
headers. The app was process-stopped before the checkpoint was read.

Separate post-checkpoint controls established that the targets were reachable:

- the same-origin HTTPS target returned HTTP 204 and recorded one unauthenticated, zero-byte request;
- the cross-origin HTTPS target returned HTTP 204 and recorded one unauthenticated, zero-byte request;
  and
- a phone-originated TCP probe connected to the USB-reversed HTTP target.

These controls were recorded separately and do not replace the frozen zero-contact checkpoint.

## Active native upload redirect matrix

The production legacy filesystem uploader reused one durable failed attachment row through its
visible `Try Again` action. A fresh append-only fixture exercised the same 15 status/destination
combinations as the JSON matrix. The upload fixture had SHA-256
`0c2d250890242d3e4d3a9d7dd532bd3a50ef3fbf534e42d1867f6400aa9d47b9`.

Every frozen record had this exact shape:

```text
method=POST
authorization_present=true
multipart_content_type=true
request_complete=true
body_bytes=13974
declared_body_bytes=13974
```

Immediately after case 15, the app was process-stopped and the frozen fixture state was read. It had
the exact 15-member set, `unarmed_upload_requests=0`, `incomplete_upload_requests=0`, no armed action,
and no success action. The same-origin, cross-origin HTTPS, and HTTPS-to-HTTP targets all had zero
requests, zero body bytes, and zero Authorization headers; both separate-origin targets also had zero
TCP connections.

Post-freeze reachability controls then produced:

| Target             | Control                                        | Observed result                                                                         |
| ------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| Same-origin HTTPS  | Direct unauthenticated request                 | HTTP 204; one request; zero body bytes; zero Authorization headers                      |
| Cross-origin HTTPS | Direct unauthenticated request                 | HTTP 204; one connection and request; zero body bytes; zero Authorization headers       |
| HTTPS-to-HTTP      | Phone TCP probe through the exact reverse rule | Connected; one TCP connection; zero HTTP requests, body bytes, or Authorization headers |

An earlier fixture attempt was discarded in full after the retry worker consumed one armed case and
then issued unarmed requests. The clean fixture above restarted from zero and reran all 15 cases. The
app was stopped to freeze the clean matrix, the reachability controls ran while it remained stopped,
and it was then relaunched solely to navigate to Disconnect. One additional unarmed upload occurred
during that later cleanup navigation. The fixture returned its fail-closed response, no redirect was
issued, and no target counter changed. It is cleanup chronology, not a sixteenth matrix case or part
of the frozen result.

After Disconnect, an ordinary stop/relaunch returned to `Get Started` with zero delta in fixture
connections, requests, authorization, upgrades, redirects, unarmed uploads, or incomplete uploads.

## Untrusted-certificate rejection

The Play app attempted setup through a correctly named, currently valid, non-CA self-signed leaf with
SANs for `127.0.0.1` and `localhost`. The Mac explicitly trusted that exact leaf for its control and
received HTTP 200. Android was not given that trust material.

The phone showed `Could not reach your server`. The fixture observed three raw TCP connections, zero
completed TLS sessions, zero HTTP requests, zero Authorization-bearing requests, and zero request-body
bytes. It recorded three client alerts of kind
`ERR_SSL_SSL/TLS_ALERT_CERTIFICATE_UNKNOWN`. Relaunch returned to `Get Started` with no account
persisted.

## Exact-tree removal and retained active paths

An exact scan of source commit `fa6e907beb776fc690cc392f7268d772705bf717` found zero production
occurrences of every removed raw multipart construct:

```text
AttachmentRequestBody
uploadMultipart(
opts.form
form?: FormData
new FormData(
export function sendAttachment(
```

The same scan still found the active native upload and download boundaries: `createUploadTask` (four
occurrences), `/message/attachment/upload` (one), and `attachmentDownloadUrl` (two). This proves the
orphaned raw `HttpClient` FormData route stayed removed without deleting the production attachment
features that replaced it.

## Result, limits, and cleanup

This exact Play candidate repeats the release-gating JSON and active-upload redirect matrices, the
ordinary public-CA upload/download/socket smoke, and explicit untrusted-certificate rejection. The
earlier physical local-release records remain the detailed evidence for the unchanged WebSocket and
owned-downloader redirect matrices. Together with the exact-tree removal check, the remaining
`TLS-00` acceptance boundary is satisfied.

This result does not prove real iMessage delivery, a natural Play upgrade, every Android version, or
any broader release-plan item. It does not claim certificate pinning; Android's normal certificate
and hostname validation remains the policy.

Cleanup was verified: the synthetic account and credentials were removed, the staged phone PNG was
deleted, the app returned to `Get Started`, all USB reverse rules were removed, all disposable
fixtures/tunnels/listeners stopped, and no owned temporary backend root remained. Play `0.1.47` / `64`
remains installed.
