# RT-01A Google Play device proof — 2026-09-13

This record is limited to `RT-01A`, client containment for `new-server` rotation. It proves the
cleartext approval/rejection path, native interrupted-credential recovery, and Android-trusted
HTTPS-to-HTTP downgrade rejection on the exact installed candidate. `RT-01A` is complete in
[`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md).

## Exact boundaries

| Boundary                 | Observed identity                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| Play app                 | `0.1.46` / version code `63`; installed by Google Play on Samsung `SM-S938U1`, Android 16 / API 36    |
| App source and release   | source `dc32380c6cb17d85e7ab08c4d5b9118660f763c8`; release `a1ba9af51c46aac08f9c00e2c7c84762bb78cb2b` |
| Installed Play signature | SHA-256 `fd45704222c77c48bee372e8b93525ff396c527c8c786841179f9e63da074d60`                            |
| Server fixture           | `bluebubbles-server` commit `c33a1ee3`, `packages/bbd/test/support/rt01aDeviceFixture.ts`             |
| Test data                | isolated temporary server root, disposable credential, and one synthetic conversation                 |

The candidate and Play-delivery identity above reuse the frozen, independently recorded boundary
in [`NET_01_PLAY_DEVICE_PROOF_2026-09-13.md`](./NET_01_PLAY_DEVICE_PROOF_2026-09-13.md). No app
build, upload, or Play submission occurred during this run.

## Isolated topology and counter meaning

After clearing only Gator's app data, the phone connected through three temporary USB reverse
rules:

- A/current: `http://127.0.0.1:1236` -> authenticated counting proxy -> isolated server;
- B/candidate: `http://127.0.0.1:1237` -> authenticated counting proxy -> the same isolated server;
- C/trap: `http://127.0.0.1:1238` -> TCP accept counter that immediately closed every connection.

The fixture logs method and path plus a boolean for HTTP `Authorization` header presence. It never
logs the header value, credential, query, WebSocket frame, device serial, private hostname, or
message content. `authorizationRequests` does not inspect Socket.IO authentication frames; a zero
TCP count at C is the stronger proof that no transport contacted that rejected origin.

Counter tuples below are cumulative `connections / HTTP requests / socket upgrades /
Authorization-present requests`. Periodic A or B pings can advance the active origin while a prompt
is open; the rejected/nonactive origin deltas are the security-relevant values.

## Results

### Fresh app data and wrong-password rejection

The clean-data launch displayed the manual URL, credential, and separate **Allow insecure
connection** control. Connecting to A reached Messages and the synthetic conversation. Initial
counters were:

| Origin | Counter             |
| ------ | ------------------- |
| A      | `3 / 6 / 1 / 7`     |
| B      | `0 / 0 / 0 / 0`     |
| C      | `0` TCP connections |

An A-to-B proposal displayed both exact origins, an empty secure password field, a separate
**Allow insecure server change** switch, and a disabled approval button. Before interaction, B and
C were both zero. Entering a wrong password with the switch enabled produced **The password does
not match your current server password.** B and C remained exactly zero afterward. A advanced only
through its expected periodic pings (`4 / 7 / 1 / 8` before the attempt and `7 / 10 / 1 / 11`
after it).

### Deferred validation after backgrounding

The fixture held B's authenticated `/api/v1/server/info` response after correct approval input. The
app was sent to the launcher before that response was released. After release, B remained at one
connection, one HTTP request, zero upgrades, and one Authorization-present request. It received no
reconnect or synchronization traffic.

Bringing Gator back to the foreground reconnected only A. A then passed a real background
`adb shell am kill` plus cold relaunch and returned to Messages. The cumulative controls were:

| Point                                | A                  | B               | C   |
| ------------------------------------ | ------------------ | --------------- | --- |
| Response released while backgrounded | `10 / 13 / 1 / 14` | `1 / 1 / 0 / 1` | `0` |
| Hot foreground return                | `13 / 17 / 2 / 19` | unchanged       | `0` |
| Cold relaunch after `am kill`        | `16 / 22 / 3 / 25` | unchanged       | `0` |

This proves the late validation result neither persisted B nor replaced A's socket.

### Approved A-to-B rotation and killed-process persistence

A fresh A-to-B proposal again displayed both origins. Approval required the correct freshly entered
credential and separate cleartext switch. B first received an authenticated server-info validation,
then a distinct authenticated socket upgrade and normal ping/synchronization traffic. Messages
remained usable and C stayed at zero.

| Point                         | A                  | B                 | C   |
| ----------------------------- | ------------------ | ----------------- | --- |
| Before approval               | `16 / 22 / 3 / 25` | `1 / 1 / 0 / 1`   | `0` |
| After live cutover            | `17 / 23 / 3 / 26` | `3 / 6 / 1 / 7`   | `0` |
| Cold relaunch after `am kill` | unchanged          | `6 / 11 / 2 / 13` | `0` |

The unchanged A counters and fresh B server-info/socket/sync traffic after cold launch prove that
the complete B credential tuple was persisted and selected. A later B-to-C proposal was cancelled;
its before/after counters were byte-for-byte identical and C remained at zero connections.

### Interrupted SecureStore commit and fail-safe recovery

One calibration interruption landed after a complete B-to-A commit; cold launch coherently used A.
This control shows that stopping the process alone does not clear a complete session.

For the decisive trial, the app began another A-to-B rotation and the fixture held B's authenticated
server-info response. Two already-running control sessions then dispatched the response release and
scheduled a foreground `am force-stop` one millisecond later, reducing ordinary command-startup
delay. This `force-stop` was used only to interrupt the foreground SecureStore owner; it is not
push-delivery or killed-FCM evidence.

The next cold launch showed the clean **Gator / Get Started** screen. At the held-response boundary,
the counters were A `24 / 33 / 5 / 38`, B `13 / 19 / 3 / 22`, and C zero. After release, process
interruption, cold bootstrap, and the visible fail-safe recovery, the final counters were exactly
the same. Neither A nor B received a connection, HTTP request, socket upgrade, or Authorization
header during recovery.

The held-boundary tuple was reconstructed from the immediately preceding summary plus the fixture's
subsequent one-line event ledger; the identical final tuple came from the direct closing summary.

This is strong native behavioral evidence—by inference from the exact bootstrap code and the
coherent-force-stop control—that the trial reached the partial `writing` / cleanup-required branch
and bootstrap removed the mixed tuple instead of authenticating with old/new parts. The internal
SecureStore keys were not directly inspectable in this nondebuggable Play build. The result is
stronger than a timing-adjacent A-or-B outcome because the source-defined partial-state branch is
the path that reaches clean setup with zero authenticated traffic.

## Android-trusted HTTPS downgrade rejection

A second clean-data run put the same isolated current counting proxy behind an in-memory TLS
terminator on the Mac. The app used `https://rt01a.backloop.dev`; that test hostname resolved to
`127.0.0.1` on the phone, and USB reverse forwarding carried device port 443 only to the temporary
Mac listener. The listener used the project's current public Let's Encrypt `*.backloop.dev`
certificate (issuer `YR1`, valid 2026-07-31 through 2026-10-29, SHA-256 fingerprint
`E0:89:A6:27:B7:BE:A6:B6:44:3F:58:34:E2:E4:C2:CA:75:64:E7:86:4B:65:34:C1:6C:7A:89:F3:C6:1B:59:60`).
A Mac control reported certificate verification result zero, and the unmodified Play app completed
authenticated server-info, synchronization, and WebSocket traffic without any custom trust install.
The transient proxy received the certificate and its deliberately shared development key in
memory; this run created or retained no additional certificate or key file. Only synthetic fixture
data and the disposable credential crossed that listener.

With the app visibly on Messages, the fixture emitted C's hardcoded
`http://127.0.0.1:1238` address over A's authenticated socket. The app displayed no approval modal
and stayed on Messages. C's TCP counter remained exactly zero, B remained entirely untouched, and A
advanced by one authenticated ping:

| Point                                   | A                 | B               | C   |
| --------------------------------------- | ----------------- | --------------- | --- |
| Before HTTP downgrade proposal          | `4 / 8 / 1 / 8`   | `0 / 0 / 0 / 0` | `0` |
| After proposal with no approval display | `5 / 9 / 1 / 9`   | unchanged       | `0` |
| Cold relaunch after confirmed `am kill` | `7 / 14 / 2 / 15` | unchanged       | `0` |

Before relaunch, the app was backgrounded and `am kill` removed its process. Cold launch returned
directly to Messages and A then received fresh authenticated `/api/v1/server/info`, socket upgrade,
device, ping, chat-query, and message-query traffic. C remained at zero, proving that the rejected
HTTP address neither persisted nor replaced the HTTPS origin. One final periodic A ping before
cleanup produced the closing tuple A `8 / 15 / 2 / 16`, B `0 / 0 / 0 / 0`, C zero.

The initial Tailscale attempt remains useful boundary history: Serve required a separate
tailnet-admin policy change, so no account policy was changed. The loopback public-CA fixture avoided
that dependency and did not expose the server to the internet. Redirect rejection and explicit
upload/download TLS behavior remain separate release-checklist rows, not `RT-01A` closure
conditions; this evidence must not be reused as proof for those rows.

The successful ordinary public-CA server-info, synchronization, and WebSocket connection also
supplies `TLS-01A`'s normal-HTTPS device gate. That narrowly shared fact does not supply `TLS-00`'s
cleartext transport matrix or the separate redirect, upload/download, or untrusted-certificate
release rows.

## Cleanup

- The fixture printed `RT01_CLOSED`; its temporary root, process, and all listeners were absent.
- Every USB reverse rule from both runs was removed.
- The TLS proxy printed `RT01_TLS_CLOSED`; its final counters were 11 TLS connections, 15 HTTP
  requests, and two WebSocket upgrades, and this run retained no additional certificate/key file.
- Tailscale's phone UI was restored to **Not connected** and Mac Serve retained zero entries.
- No screenshot, UI hierarchy, logcat capture, private URL, or credential was retained.
- Gator `0.1.46` / version code `63` remains installed at a clean Get Started screen after the
  synthetic HTTPS session's app data was cleared.
- The phone's Tailscale connection was temporary; no accessibility setting or stay-awake value was
  changed.
