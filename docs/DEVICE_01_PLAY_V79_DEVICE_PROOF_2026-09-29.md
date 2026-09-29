# DEVICE-01 exact Play v79 device proof — 2026-09-29

> **Campaign status: IN PROGRESS; parent `DEVICE-01` remains BLOCKED.** This is the executable,
> sanitized evidence ledger for Android `0.1.58` / code `79`. It replaces neither the frozen v77
> release checklist nor the retired v56 device matrix. Record only results observed from this exact
> Play installation. Do not put credentials, server addresses, phone numbers, conversation
> identifiers, message bodies, private paths, or raw screenshots in Git.

## Candidate and device binding

| Field             | Bound value / result                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| App source        | `a0add484c00fdda06b7ee2c0a5bb5221d256d292` on local `master`                              |
| Release run       | `android-0.1.58-a0add48-20260929062534`                                                   |
| Release commit    | `4cbb05064ec9f891f00cb0a4f697435206f54fce`                                                |
| Artifact          | `gator-release-0.1.58-v79-4cbb050.aab`, 58,215,008 bytes                                  |
| Artifact SHA-256  | `c60cc661a318399afc5d30ed6d914303df41674cfafadfef9d835bfe3c442e19`                        |
| EAS submission    | `3138fc9b-c658-4fbc-b144-6a19f68a9e6e`; `FINISHED`; Internal / `COMPLETED`                |
| Installed package | `com.bluegreengatorapps.messages`, `0.1.58` / code `79`                                   |
| Install source    | Google Play (`com.android.vending`)                                                       |
| Device            | Samsung SM-S938U1; Android 16 / API 36; arm64-v8a                                         |
| Installed splits  | Base plus arm64, English, and xxhdpi configuration splits                                 |
| SDK/debug state   | min/target API 36; production package has no `DEBUGGABLE` flag                            |
| Mac server        | Gator `2.0.15`, source `75537204`; local health HTTP 200 after safe stale-helper recovery |

## Result ledger

| Campaign                                | Result           | Exact evidence / remaining boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play delivery and package identity      | **PASS**         | Package Manager reports v79, Google Play installer, expected SDK/ABI/splits, and no debuggable flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Play delivery certificate               | **BLOCKED**      | One `apksigner` attempt pulled all four installed APKs but aborted with exit `134` before printing the certificate. Per owner instruction, the known Java-native failure was not troubleshot or retried.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Welcome-screen lifecycle smoke          | **PASS**         | 439 ms cold launch, 22 ms hot resume, ordinary `am kill`, 430 ms cold relaunch, replacement PID, and no scoped fatal exception were recorded when v79 arrived from Play.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Play v79 phone/portrait enforcement     | **PASS**         | Baseline `accelerometer_rotation=1` and `user_rotation=0`; after forcing `0/1`, MainActivity reported `SCREEN_ORIENTATION_PORTRAIT` and the display remained `ROTATION_0`; the baseline `1/0` settings were restored. This is system-state proof, not visual-render proof, because the device reached keyguard before capture.                                                                                                                                                                                                                                                                                                                                                     |
| Fresh setup navigation                  | **PARTIAL PASS** | The manual server form kept both fields and Connect reachable above the open keyboard; one root Back returned to the Connect choice screen. The already-authorized session resumed before camera denial/manual fallback could be isolated, so that branch remains open.                                                                                                                                                                                                                                                                                                                                                                                                            |
| Mac server health prerequisite          | **PASS**         | Fresh helper socket, handshake, and ownership receipt were observed after a graceful restart; `GET /api/v1/health` returned HTTP 200. This proves readiness only, not authenticated pairing or an isolated staged-server matrix.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Authenticated connection/core messaging | **PARTIAL PASS** | An existing scoped credential resumed automatically after Mac health recovery, completed the setup transition, began the historical sync, and opened Messages while optional permissions remained denied. After Home plus ordinary `am kill`, PID `12192` was absent; a 457 ms cold launch created PID `12860`, returned directly to Messages, and produced zero scoped fatal lines. Send/receive and mutation checks remain barred on the non-synthetic account.                                                                                                                                                                                                                  |
| Notification/push/headless/scheduling   | **PARTIAL PASS** | The app continued into Messages with notification permission denied. Its enable flow reached Android's prompt; denial produced the expected foreground-only guidance and recovery action. A reversible package grant established `POST_NOTIFICATIONS: granted=true` / default app-op `allow`, with unrelated runtime permissions still denied; `Notification Access…` opened Android's app-notification settings. The controlled foreground, alive-background, and ordinary-killed Firebase test-notification branches all passed; exact process and visible-notice evidence is recorded below. WorkManager, message-specific policy/actions, retries, and scheduling remain open. |
| Account A to Disconnect to B            | **NOT RUN**      | Requires two distinct isolated identities and controlled delayed operations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| App Lock and private Recents            | **OWNER INPUT**  | Biometric authentication cannot be completed unattended.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Genuine Play-installed API 37           | **EXTERNAL**     | No approved API-37 Play device is currently available.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Independent second-device backup slots  | **EXTERNAL**     | The Pixel is owner-excluded; Samsung-only partial proof cannot close `BACKUP-SLOTS-01`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Controlled Firebase test-notification checkpoint

On 2026-09-29, the owner invoked the installed Mac Gator app's **Devices → Manage → Send Test
Notification** exactly once for each branch below. The owner refreshed/confirmed one row in the
**Android Devices** push table. A read-only server check independently found one eligible FCM target,
named `Gator (Android 36)`, bound to the Samsung's current scoped credential. The longer **Paired Client
Credentials** table is authorization history and does not expand notification fanout. No registration
or credential was removed, revoked, or created for this campaign.

The sole row's non-secret key-version marker was `1`, with no rotation metadata. In the installed
server source this marker is written by V3 enrollment only, so it supports the retained V3 enrollment
state. No secret, key, or sealed envelope was read; this metadata is not per-send decryption or
replay-rejection evidence.

| Branch                  | Result   | Observed physical-device evidence                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foreground              | **PASS** | A Firebase receiver broadcast was observed at 13:19:30 MDT after Gator had been brought to the foreground. Process `27746` was running, and Android displayed the fixed app-authored `Gator` / `Test notification received.` notice.                                                                                                                                                                                                                                     |
| Alive background        | **PASS** | The fixed first notice was dismissed and confirmed absent. Home remained the resumed activity, process `27746` remained running, a new Firebase receiver broadcast arrived at 13:22:29 MDT, and the fixed test notice appeared again.                                                                                                                                                                                                                                    |
| Ordinary killed process | **PASS** | The fixed second notice was dismissed and confirmed absent. Home plus ordinary `am kill --user 0` removed process `27746`; `pidof` confirmed no Gator process before the send. At 13:24:48 MDT Android started process `29477` specifically for the Firebase receiver broadcast. Home stayed resumed and the fixed test notice appeared without opening Gator. No `ReactNativeFirebaseMessagingHeadlessTask` registration warning was observed. Force-stop was not used. |

These results prove exact-Play-v79 Firebase receipt and test-notice presentation across the three
lifecycle branches. They advance `DEVICE-01`, `REL-001`, `PUSH-RETRY-01`, and the retained-delivery
slice of `PUSH-CRYPTO-01E`; none of those tasks is closed by this checkpoint. The test notice is
app-authored and exercises no contact message, conversation mutation, message-specific notification
action, scheduled send, retry fault, replay, key rotation, or account replacement. Mac result-counter
toasts were not captured, so no `{configured,total,sent,failed}` values are inferred.

Baseline Do Not Disturb was priority mode (`zen_mode=1`), app standby bucket was active (`10`), and
the app was not device-idle-whitelisted. Do Not Disturb was temporarily disabled for these sends and
restored to `1` afterward. Only the located fixed test notices were dismissed. Temporary device UI
dumps were deleted, the bounded two-minute keep-awake helper was stopped, and Gator was successfully
foregrounded again. No scoped Android fatal line was observed in the killed-branch trace.

## Session notes

- Only Samsung serial alias `R5C…RXW` is in scope. The connected Pixel is not used.
- USB stay-awake was enabled, but the Samsung reached keyguard once. The owner then unlocked it;
  later checks explicitly woke and rechecked keyguard state between milestones.
- The installed v79 app began at the fresh Welcome screen.
- Once the Mac server recovered, the phone resumed an existing scoped credential. No new credential
  was created or entered. The connected server contains real user data, so the run stopped short of
  send, reply, reaction, scheduling, location, account replacement, and destructive recovery tests;
  their current runbooks require an approved isolated staged Mac and synthetic identity.
- The Mac server initially failed closed because two stale helper artifacts lacked the matching
  ownership receipt. After a graceful Gator restart, a fresh socket, handshake, and `messages`
  ownership receipt were observed, and `GET /api/v1/health` returned HTTP 200. The guarded
  quarantine path was not used. The recovery procedure did not intentionally edit app repository
  source, server configuration, credentials, the message database, or user content.
- Do not credit unchecked rows from `DEVICE_VERIFICATION_CHECKLIST.md`; that file is retired v56
  history. Each task owner remains open until its own acceptance boundary is satisfied.
