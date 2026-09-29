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
| App Lock and private Recents            | **PARTIAL PASS** | Enabling App Lock requested authentication immediately; after the killed push, foregrounding again required owner authentication before returning to Messages. The separate locked-notification/admission/drain branch below failed. Private Recents visual proof was not run.                                                                                                                                                                                                                                                                                                                                                                                                     |
| Locked killed-Firebase admission/drain  | **FAIL**         | Firebase started a new process, but no generic notice appeared before unlock and no fixed test notice appeared after owner authentication within five minutes of the native receiver broadcast. The candidate source contains a locked-session authorization rejection on this path; details below.                                                                                                                                                                                                                                                                                                                                                                                |
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

## Locked killed-Firebase checkpoint

The owner then completed one additional Samsung-only test on the same exact Play-v79 package.
App Lock and Secure Screen were initially off. Enabling App Lock produced Android's `Unlock Gator`
prompt. After Home, the first immediate `am kill` left process `29477` alive; a second attempt after
confirming Home was resumed removed it. `pidof` confirmed no Gator process and Android had no Gator
notification before the owner invoked the trusted Mac test control once. Force-stop was not used.

At 13:43:38 MDT, Android started process `32036` for the Firebase receiver and logged receipt.
Home remained resumed. At 13:43:59 and one follow-up, there was no Gator notification record;
`You have new messages` and `Test notification received.` were both absent. Foregrounding Gator
produced `Unlock Gator`. After owner authentication, at 13:47:10 the app displayed Messages in the
same process, but there was still no Gator notification record or fixed test notice. This was within
five minutes of receipt. No package-scoped Android fatal or missing-headless-task warning was
observed. This is a **failed locked admission/notice/drain branch**, not a partial pass for it.

**Source diagnosis:** `persistAuthenticatedLockedFcmV3Event` calls
`resolveAuthorizedRealtimeTransport`. In a fresh process the resolver calls
`inspectBackgroundSession`, which returns `kind: 'locked'` when persisted App Lock is enabled.
The resolver accepts only `kind: 'ready'`. Any fresh-process locked V3 delivery that reaches this
helper receives no transport and returns `not-enqueued`, preventing both the generic notice and
later drain. The affected files are unchanged
between candidate source `a0add484` and the audited local master. Independent source review confirms
this contradiction. It is a definite source defect matching the result; native receiver receipt
alone does not prove this specific envelope completed V3 authentication or reached that line.
The finite in-app JS receipt was not captured, and release logcat intentionally omits the detailed
warning diagnostics, so those missing observations are not treated as evidence of callback failure.

`PUSH-CRYPTO-01E`, `NOTIF-02`, `REL-007`, and `DEVICE-01` remain open for this failed branch. The
three unlocked delivery passes above remain valid. No code fix or replacement candidate is claimed
by this device checkpoint; the later host correction below does not change the installed v79 result.
App Lock and Secure Screen were verified off afterward; Do Not Disturb was restored to `zen_mode=1`.
Temporary device UI dumps were removed. The test procedure did not intentionally send a contact
message or create, change, or remove credentials, accounts, or user content.

## Post-v79 host correction — replacement build deferred

**2026-09-29: HOST FIX AND REQUIRED HOST GATES COMPLETE / NEW BUILD AND DEVICE PROOF DEFERRED.**
The validated durable session tuple is now available to a dedicated locked-V3 transport resolver.
Only `persistAuthenticatedLockedFcmV3Event` uses this resolver. Ordinary background work still
requires `ready` and exits before client creation or DB access when the session is `locked`.
The narrow path retains account generation, transport revision, durable revocation, transport
currentness, and the caller's lock/deadline ownership. It does not hydrate foreground credentials,
unlock the app, drain while locked, or post a notice before durable admission.

The new six-case regression uses the real session inspection, transport resolution, and admission
composition from cold store defaults, mocking native/database leaves. Its positive case failed
before the fix (`enqueued` expected; `not-enqueued` received), then passed with the correction.
Negative cases reject an already-revoked account or generation, transport-revision, revocation,
and lock-owner changes during DB open. The focused gate passed **5 suites / 119 tests**; TypeScript,
focused ESLint, and source formatting passed. Independent review found no blocking issue. The DB
proof's two exact incoming-ingress fingerprints and the scheduled-recovery inspector fingerprint
were renewed after review, without widening eligibility or changing the write inventory.

Full Jest passed **529 suites / 6,407 tests**, with two intentional skipped suites/tests;
architecture/recovery passed **51 tests**, migrations **5 tests**, and documentation **5 tests**.
The 2,187-write guard and zero-drift reconciliation passed; the required full adversarial DB gate
passed **115/115 tests**, with zero failures, cancellations, or skips. Source/test ESLint has no
errors; linting the renewed guard scripts retained one unchanged unused-helper warning in
`check-scheduled-recovery.mjs`. These are not evidence of native delivery or SQLCipher. Final host suites used the
installed compatible Node `24.21.0`, not the machine-default Node `26.10.0`:
the existing host SQLite test module requires Node ABI `137`, while Node 26 requires `147`.
The incompatible run was stopped; no dependency rebuild or system-wide runtime change was made.
This is not an exact release-toolchain certificate (the build tooling pins Node `24.19.0` / npm
`11.17.0`).

At the owner's direction, **do not build or upload yet**. After an approved replacement build is
installed, repeat only the failed Samsung branch first: enable App Lock; Home plus ordinary
`am kill` and confirm no process or prior fixed test notice; send the trusted built-in Samsung test
once; verify a generic notice without opening Gator; authenticate within the event lifetime and
verify the fixed test notice drains once. Restore App Lock/Secure Screen/DND to their prior states.
Record the replacement candidate identity and actual observations, including failure if any.
`PUSH-CRYPTO-01E`, `NOTIF-02`, `REL-007`, and `DEVICE-01` remain open. No build, upload, installation,
AMFI change, or device retest is part of this host correction.

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
