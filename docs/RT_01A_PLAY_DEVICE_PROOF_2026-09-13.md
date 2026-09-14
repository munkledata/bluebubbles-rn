# RT-01A Google Play device proof — 2026-09-13

This record is limited to `RT-01A`, client containment for `new-server` rotation. It proves the
cleartext approval/rejection path and native interrupted-credential recovery on the exact installed
candidate. It does **not** prove HTTPS-to-HTTP downgrade rejection; that remaining result keeps
`RT-01A` open in [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md).

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

## Remaining RT-01A proof

The irreducible open case is an HTTPS current origin receiving a proposed HTTP downgrade. It needs
an Android-trusted HTTPS front end to A, followed by an emitted C proposal, with all of these results:

1. no approval prompt;
2. zero TCP connections to C;
3. continued authenticated traffic only to HTTPS A; and
4. a killed-process relaunch that still selects HTTPS A and leaves C at zero.

The Mac and phone Tailscale clients were available, but Tailscale reported **Serve is not enabled on
your tailnet** and required an account-admin policy change. The run stopped at that boundary rather
than silently changing the tailnet. A different public-CA HTTPS fixture would also satisfy this
case. Redirect rejection remains a separate release-checklist row and is not an `RT-01A` closure
condition.

## Cleanup

- The fixture printed `RT01_CLOSED`; its temporary root, process, and four listeners were absent.
- All three USB reverse rules were removed.
- Tailscale's phone UI was restored to **Not connected** and Mac Serve retained zero entries.
- No screenshot, UI hierarchy, logcat capture, private URL, or credential was retained.
- Gator `0.1.46` / version code `63` remains installed at the clean Get Started screen produced by
  the fail-safe recovery.
- The phone's Tailscale connection was temporary; no accessibility setting or stay-awake value was
  changed.
