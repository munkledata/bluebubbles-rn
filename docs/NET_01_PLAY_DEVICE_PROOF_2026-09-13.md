# NET-01 Google Play device proof — 2026-09-13

This record is limited to `NET-01`, the automatic rich-link preview pipeline. It is not a general
release, staged-server, privacy, or Android-device sign-off. The authoritative task status remains
in [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md#net-01--build-a-bounded-private-network-safe-preview-pipeline).

## Exact app and server identities

| Boundary                 | Observed identity                                                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Play app                 | `0.1.46` / version code `63`; installed by `com.android.vending` on Samsung `SM-S938U1`, Android 16 / API 36                                   |
| App source               | `dc32380c6cb17d85e7ab08c4d5b9118660f763c8`; app `NET-01` commit `4b89431` is an ancestor and its five preview files are byte-identical         |
| Release                  | branch `release/android-0.1.46`; commit `a1ba9af51c46aac08f9c00e2c7c84762bb78cb2b`; run `android-0.1.46-dc32380-20260913175233`                |
| AAB                      | `gator-release-0.1.46-v63-a1ba9af.aab`; 56,150,828 bytes; SHA-256 `4a9c83a521b6eb20404d502b535a2001e201ae71f1a9f3a88d703aed79221a06`           |
| Play delivery            | Internal track release `0.1.46`, version code `63`, release status `completed`; EAS submission `63ddf33f-b3f1-496d-afcf-b7ee4c53a751` finished |
| Installed Play signature | SHA-256 `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                                                                     |
| Server                   | preview implementation `76097f75846acf4ece8685b90803bad8a20f19f8`; isolated-fixture commit `f6940a0b61fda89ae21ae4cf040c97811e626a30`          |

The release receipt reports validation `passed` for ZIP integrity, packaged-artifact identity,
signature, hash, and native-path proof. Google Play API read-back showed only version code `63` in
the completed Internal release. No build or submission was rerun during device proof.

## Isolated execution

The real backend composition ran against a temporary data root and a deterministic injected
resolver/request adapter. The phone connected only to `http://127.0.0.1:1236` through
`adb reverse tcp:1236 tcp:18181`. A disposable 20-character credential was delivered as the first
stdin line with terminal echo disabled; `ps eww` confirmed it was absent from the listener's
arguments and environment.

The fixture fails closed for unprovided preview, DDNS, FCM, Web Push, AppleScript, and Find My
effects. Its five Find My cache paths, Messages database, private-helper paths, uploads, and config
databases stay under its temporary root. Runtime inspection found only loopback sockets, temporary
fixture files, and the TypeScript loader child; it found no production Messages/Find My/Keychain/
LaunchAgent access or AppleScript/native-launch child. An independent review returned GO after the
fixture was changed to clean up on `stop`, stdin EOF/close, `SIGHUP`, `SIGINT`, and `SIGTERM`.

The injected outbound adapter is deliberate: it lets the production proxy policy execute every
hostile DNS/HTTP outcome without contacting an uncontrolled or private machine. It verifies every
outbound attempt is `GET`, uses manual redirects, has an empty body, and carries no
`Authorization`, `Cookie`, or `Referer` header. This proves the application/server orchestration
and the proxy's policy decisions; it is not a packet-level proof of a real macOS socket to a public
target.

## Twenty-case Android matrix

Opening the synthetic conversation automatically exercised all 20 rows. The fixture recorded the
exact expected 49 resolver/request/cancellation events:

| Cases                                                              | Server observation                                                   | Android result                                              |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------- |
| Initial private answer; mixed public/private answers               | one resolution and zero requests each                                | raw links; no cards                                         |
| Public-to-private redirect                                         | one public request; no request to the private redirect               | raw link; no card                                           |
| Rebound peer mismatch                                              | one resolution, one request, one cancellation                        | raw link; no card                                           |
| Nested image private redirect                                      | page and image host each resolved/requested once; no private request | safe text card; no image                                    |
| Redirect loop                                                      | exactly four resolutions and four requests                           | raw link; no card                                           |
| Forged content type; compressed expansion; chunked over-limit body | one resolution/request each                                          | raw links; no cards                                         |
| Oversized image dimensions                                         | page and image host each resolved/requested once                     | safe text card; no image                                    |
| Four stalled responses                                             | one resolution, request, and cancellation for each                   | raw links; no cards                                         |
| `file:`, `content:`, and `javascript:`                             | zero fixture events                                                  | inert raw text                                              |
| Valid JPEG                                                         | page and image each resolved/requested once                          | automatic text plus decoded native image                    |
| Two identical valid PNG links                                      | one shared page request and one shared image request total           | both cards render automatic text plus decoded native images |

The visible JPEG and PNG cards showed colored decoded artwork, their preview text, and the immutable
original hosts even though the supplied site name was `Spoofed Trusted Bank`. Android exposed these
semantic descriptions:

- `Link preview: JPEG preview. Destination: good-jpeg.preview.test`
- `JPEG preview preview image`
- the corresponding `good-png.preview.test` destination and PNG image description

Both the raw link and the rendered preview card launched
`https://good-jpeg.preview.test/article` in the external browser. The browser displayed that exact
host/path; Android's activity log recorded a `VIEW` intent from the Gator UID for the exact original
HTTPS URL.

## Phone destination observation

A fresh watcher sampled the production app UID's kernel TCP/TCP6/UDP/UDP6 tables every 200 ms from
before Connect through completion of all automatic preview work. Every observed socket was an
IPv4-mapped loopback connection to `127.0.0.1:1236`; no page, redirect, image, or other non-loopback
destination appeared. A scoped `NetworkDnsEventReported` statsd metric for the app UID retained
zero bytes during the same window. The server ledger remained at zero before the chat opened and
then reached exactly 49 events, which correlates the successful cards with server-side work.

These are authoritative kernel/OS observations but not a full packet capture: `/proc` was sampled,
and Android may sample the DNS atom. An earlier discarded setup-only window observed a router DNS
socket and Google HTTPS socket from the same UID, demonstrating that the watcher could report
non-loopback activity; those events occurred before the clean preview window and were unrelated to
the synthetic preview hosts.

## Host checks added at closure

The app's focused lifecycle evidence now directly covers:

- removal of queued account-A work on invalidation, abortion/drop of active results, and admission
  of replacement-account work;
- retry after the fixed queue is full and later drains;
- a same-account transport revision causing the mounted hook to re-read through the new transport.

The server's real-composition test now proves its fixture defaults fail closed for public-IP/DDNS
and preview traffic and that an explicitly injected preview adapter survives a full fixture reset.

## Limits and cleanup

An extra `am force-stop` experiment returned this synthetic setup to Welcome instead of reopening
the account, so it earns no app-process-restart cache-persistence credit. Cache byte/count/age,
positive/negative TTL, coalescing, active cancellation, and late-result behavior remain supported
by the focused host suites; the duplicate PNG rows supply device coalescing evidence. TalkBack was
not enabled; this run proves Android accessibility semantics, not spoken focus order or speech.

Cleanup completed and was checked:

- fixture emitted `NET01_CLOSED`; its listener and exact temporary root were absent;
- USB reverse was removed;
- the temporary statsd config was no longer active;
- the phone's original `stay_on_while_plugged_in=2` value was restored;
- synthetic app data, logcat, UI dumps, and screenshots were deleted;
- Google Play `0.1.46` / `63` remains installed, at the clean Welcome state;
- this run did not enable or alter TalkBack, any accessibility service, a proxy, a VPN, or
  certificate interception; Bitwarden's pre-existing accessibility service remained enabled.
