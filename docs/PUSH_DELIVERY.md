# Push notification delivery — architecture, the 2026-07-24 outage, and the fixes

Written after diagnosing "I stopped getting push notifications." The root cause was a **silent
total failure of killed-app push** that had been masquerading as flakiness. This document records
the chain, what was actually broken, what changed, and how to diagnose it next time — so nobody
re-derives it.

Spans two repos: this one (the RN app) and `bluebubbles-server` (`packages/bbd`, the Gator daemon).

---

## 1. The delivery chain

Ten links. Any one can break it, and until this work most of them broke it _silently_.

| #   | Link                                                                        | Where                                                            |
| --- | --------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1   | An iMessage/RCS event reaches the server's domain bus                       | `packages/bbd/src/serialize/messageFanout.ts`                    |
| 2   | The fanout calls `pushMessageSink`                                          | `packages/bbd/src/backend.ts`                                    |
| 3   | It reads registered devices                                                 | `configStore.listDevices()`                                      |
| 4   | The body is trimmed under FCM's hard 4096-byte data cap                     | `packages/bbd/src/serialize/pushPayloadCap.ts`                   |
| 5   | The registry fans out, deduping by send target (token)                      | `packages/bbd/src/notifications/NotificationRegistry.ts`         |
| 6   | FCM v1: mint an OAuth token from the service account, POST the data message | `packages/bbd/src/notifications/FcmProvider.ts`                  |
| 7   | Google delivers to the device                                               | —                                                                |
| 8   | The app's background/foreground handler receives it                         | `src/services/notifications/fcmMessaging.ts`                     |
| 9   | Envelope parsed → decrypted → normalized → deduped                          | `fcmPayload.ts`, `fcmDecrypt.ts`, `core/realtime/eventRouter.ts` |
| 10  | DB write (source of truth), then intent → Android notification              | `dbEventSink.ts` → `intents.ts` → `notifeeService.ts`            |

Properties worth knowing:

- **Priority is split deliberately.** Only `new-message` is sent at FCM `high` priority.
  `updated-message` (delivered/read/edit receipts) and `message-deleted` are silent data-only syncs
  sent at `normal`, so they don't burn the app's finite high-priority Doze wake quota — once that
  quota is spent, Android downgrades the _real_ message pushes and defers them by minutes.
- **The device token is re-registered on EVERY reconnect**, not once (`startRealtime()`). The server
  dedups by token, so it's idempotent. That per-connect retry is the only thing that recovers a
  registration broken by a first-boot failure, a server change, or an FCM token rotation.
- **Dead targets self-prune.** An FCM 404 / Web Push 410 removes the device row via `onDeadDevice`.
- **Socket and FCM share ONE `EventRouter`**, so its `seen` set dedups a message delivered by both.

---

## 2. What was actually broken

### 2.1 ROOT CAUSE — the FCM background handler was never registered (killed-app push dead)

**Symptom.** Push worked, then stopped, then worked again after opening the app. Server logs showed
nothing. The phone's permissions, notification channel, and battery state were all healthy.

**Evidence.** With the app's process alive but its UI never mounted, a push produced exactly this:

```
D/RNFirebaseMsgReceiver: broadcast received for message
W/ReactNativeJS: No task registered for key ReactNativeFirebaseMessagingHeadlessTask
```

The message reached the device and was dropped there. Server-side, the same push reported
`{total: 2, sent: 2, failed: 0}` — every layer claimed success.

**Cause.** `setBackgroundMessageHandler` (RNFB), `notifee.onBackgroundEvent`, and
`TaskManager.defineTask` each register a _named headless task_ that Android looks up the instant it
wakes the app — with **no render**. All three were registered by side-effect imports at the top of
`app/_layout.tsx`. But `_layout.tsx` is a **route module**: expo-router loads it lazily through its
`require.context`, at render time. A headless wake evaluates the bundle entry and never renders, so
that module was never evaluated and the tasks were never registered.

**Why it looked intermittent.** As long as the process stayed alive from the last time the user
opened the app, the handler _was_ registered and push worked. The moment Android reclaimed the
process — routine, and aggressive on Samsung One UI — every push was dropped until the app was
manually reopened.

**Fix.** A real bundle entry, `index.js`, referenced by `package.json` `main`:

```js
import './src/services/notifications/backgroundEvents'; // notify-kit headless taps
import './src/services/background/backgroundSync'; // TaskManager.defineTask('gator-bg-sync')
import './src/services/notifications/fcmMessaging'; // setBackgroundMessageHandler
import 'expo-router/entry'; // MUST be last
```

`app/_layout.tsx` keeps its imports (the module cache makes them a no-op) so the app still works if
the entry is ever changed. This also fixed a related error the same flaw produced at boot:
`Cannot start headless task, CatalystInstance not available` from expo-task-manager.

> This needs a **native rebuild** to take effect — the release bundle is embedded at build time.

### 2.2 The one end-to-end probe could only report false negatives

The server's "Send Test Notification" button sends event type `test-notification`. The app had no
entry for it in `SERVER_EVENTS` and no `normalize()` case, so `EventRouter` hit `default: return
null` and dropped it. The server reported `sent: N, failed: 0` while the phone showed nothing.

The single tool for answering "is push working?" was therefore incapable of ever saying yes. During
this investigation it had to be bypassed entirely (logcat was used instead). A diagnostic that can
only produce false negatives is worse than none — it actively misleads.

**Fix.** `test-notification` is now a fully handled event through all six touch points. It carries no
conversation content, and seeing it _is_ the passing result. It deliberately bypasses the "Message
Notifications" toggle and unknown-sender filter because it is a user-initiated diagnostic rather
than a message.

### 2.3 The server was blind to its own push failures

`NotificationRegistry` logged a delivery failure at `debug` — which the file and console sinks drop
— and `pushMessageSink` discarded the `DeliveryResult[]` entirely. A 100%-failing FCM config (a
revoked service account, a spent quota, an HTTP 403) produced **no visible server log at all**.

**Fix.**

- Delivery failures log at `warn`, naming the device and carrying the provider's error message.
  Dead targets (404/410) stay at `debug` — expected, self-healing via the prune, and otherwise they
  would warn on every message until the prune lands.
- `pushMessageSink` logs the failure _shape_: `2/2 device deliveries failed` means the pipeline is
  down; `1/2` means one phone is gone.
- `send-test-notification` returns the actual error strings (`errors: string[]`), so
  "FCM send returned HTTP 403: …" reaches the user instead of a bare `failed: 1`.

### 2.4 One channel failure killed message notifications permanently

`ensureChannel()` in `notifeeService.ts` memoized the `createChannel` promise but never cleared it
on rejection — unlike the FaceTime and Reminder channels, which always had that guard. One transient
failure poisoned the cache for the whole JS context: every later `postNotification` awaited the same
rejected promise and threw, so message notifications stopped until the app restarted.

Compounding it, all three `postNotification` call sites were bare `void postNotification(intent)`,
so the throw surfaced only as an unhandled rejection with no attribution.

**Fix.** `ensureChannel` clears its memo on rejection, matching the other two. A new
`postNotificationSafely` wrapper contains failures and emits a development-only `warn`; release
builds suppress free-form non-error logs, while durable deliveries keep their retry/backoff path.
The three near-identical status-notification blocks were folded into one `postStatusNotification`
helper rather than adding a fourth copy.

### 2.5 Not a bug (recorded so it isn't "fixed")

- **Two registered devices.** The server had two FCM rows, "Gator (Android 36)" and "Gator (Android
  37)". These are two _distinct tokens_, i.e. two distinct installs — the phone under test is API 36.
  The registry dedups by token, so this is correct behaviour, not duplicate delivery. Purging would
  have deregistered a live device.
- **`hoistChatGuid`** (`fcmPayload.ts`) folds a top-level envelope `chatGuid` into the body, but the
  Gator server only ever sends `{type, data}` — the sibling key doesn't exist. It is harmless (the
  guid is inside the serialized body already) and kept as tolerance for other server builds.

---

## 3. How to diagnose push next time

Work the chain from the middle out; each step tells you which side you're on.

1. **Is the server sending?** Fire the test push and read the counts _and_ errors:

   ```bash
   curl -s -X POST http://127.0.0.1:1235/api/v1/admin/command \
     -H 'content-type: application/json' -H "x-bbd-local-auth: $TOKEN" \
     -d '{"channel":"send-test-notification","data":{}}'
   ```

   `sent: N, failed: 0` means links 1–6 are healthy. Any `errors[]` entry now names the real cause.
   (The local-auth token is on the Gator renderer process's command line: `--bbd-local-auth=…`.)

2. **Are the right devices registered?** `{"channel":"get-devices"}` — check `lastActiveAt` and that
   the token count matches the number of real installs.

3. **Did it reach the phone?** This is the step that found the bug:

   ```bash
   adb logcat -c
   # fire the push
   adb logcat -d | grep -E 'RNFirebaseMsgReceiver|No task registered|HeadlessTask'
   ```

   `broadcast received for message` with **no** following warning = delivered and handled.

4. **Is the device even allowed to show it?**
   ```bash
   adb shell dumpsys package <pkg> | grep POST_NOTIFICATIONS   # granted=true
   adb shell am get-standby-bucket <pkg>                       # 5=exempt … 45=restricted
   adb shell dumpsys deviceidle whitelist | grep <pkg>         # battery exemption
   adb shell dumpsys notification | grep -A3 <pkg>             # channel importance, mDeleted
   ```

### The `am kill` vs `am force-stop` trap

Use **`adb shell am kill <pkg>`** to simulate the OS reclaiming the process. Do **not** use
`am force-stop`: it puts the app in Android's "stopped" state, where the OS cancels _all_ broadcasts
until a manual launch (`logcat` shows `broadcast intent callback: result=CANCELLED`). The bug then
looks unreproducible. This cost real time during the investigation.

---

## 3a. Follow-up, 2026-07-26 — the second round

Push was still missing "at times", on a **second device** (Pixel 10 Pro XL, Android 17 / API 37;
the first investigation was driven entirely against a Galaxy S25 Ultra on Android 16). Findings:

**The §2.1 fix works.** The S25 now logs `RNFirebaseMsgReceiver: broadcast received` with **no**
`No task registered` — the original signature is gone.

**Ruled out on the Pixel, with evidence:** token registration (its row is current, re-registers on
launch, token unchanged, FCM returns `failed: 0` — a dead token would 404 and auto-prune); app
version (0.1.33 vc46, _newer_ than the S25's vc44); OS restrictions (`POST_NOTIFICATIONS` granted,
standby bucket 5, battery-exempt, Data Saver off, `RUN_ANY_IN_BACKGROUND: allow`, not dozing);
app-side errors (the development build's App Logs showed no `[fcm]`/`[notify]` failures); and the
server (every send `sent: 2, failed: 0`).

**The Pixel's chain does work.** Killed its process (`am kill-all`, 0 processes), fired a push, and
Android logged `Start proc … for broadcast {ReactNativeFirebaseMessagingReceiver}` followed by the
notification posting. Killed → woken → shown.

**But it is genuinely intermittent.** Two _identical_ killed-process tests a minute apart: the first
never started the process and posted nothing; the second worked. Same device, same push, same state.
Root cause of that last hop is **NOT yet established** — do not assume it is.

Two theories were falsified along the way and are recorded so they aren't retried: a locked-device
Keystore failure aborting `dispatchRealtimeEvent` at `ensureDatabase()` (dead — unlocking changed
nothing), and the Pixel running an older build (dead — it is newer).

**What was added:** a development-only receipt breadcrumb,
`[fcm] push received {event, source}`, in `deliverRespectingLock` — the single entry point both the
headless background handler and foreground `onMessage` share, with `source` recording which. Until
then a dropped push and a silently-handled one were indistinguishable in the development App Logs:
both simply absent (an `updated-message` receipt posts no notification by design). Event NAME only —
never the body, which carries message text. `LOG-01B` now suppresses and does not persist this
free-form line in release builds; candidate release investigation must use native traces, temporary
instrumentation, or a future finite diagnostic event rather than expecting this breadcrumb in App
Logs.

Also of note: measurement artifacts cost real time here. `RNFirebaseMsgReceiver` was briefly believed
not to be emitted (it is — the capture window was wrong), and `dumpsys notification` counts are
useless for repeat tests because the test notification uses a FIXED id and updates in place — read
its `when=` epoch field instead.

## 4. The lesson

Every layer reported success while the outcome was wrong: the server said `sent: 2, failed: 0`,
Google delivered, the phone's permissions were perfect, and the app's own logs were empty. The only
evidence was a single `W/` line in logcat.

When a chain of systems all claim success but the result is missing, the failure is in a **handoff
nobody logs**. Instrument the seams, not the components — which is what §2.3 and §2.4 are.

Related: `AGENTS.md` ("Every headless registration must be imported from `index.js`") and
`docs/APP_SERVER_PARITY.md`.

## 5. Native notification package ownership

`src/services/notifications/nativeNotificationAdapter.ts` is the only production module allowed to import
`react-native-notify-kit` (currently pinned to `10.4.8`). It owns the small native surface Gator uses: channel and
permission calls, display/trigger/cancel operations, foreground/background event registration, and the cold-start
notification lookup. `notifeeService.ts` continues to own Gator's domain policy and serialized mutation queue; UI,
features, and headless handlers consume the owned adapter instead of the package singleton. The ESLint boundary covers
the package root and every subpath across `index.js`, `app/`, and `src/`, including static, dynamic, and CommonJS
imports.

Keep `index.js` importing `backgroundEvents` before `expo-router/entry`. Passing registration through the adapter does
not make route-time registration safe: the background callback must still reach notify-kit during bundle-entry
evaluation.

Before a notify-kit upgrade, verify all of the following against the pinned Expo/RN versions and an Android build:

- maintained release/security posture, license continuity, React Native New Architecture support, and no unresolved
  upstream regression affecting APIs Gator uses;
- permission state/request behavior and app/per-chat channel creation, deletion, and settings handoff;
- foreground action/body events, background/headless actions, killed-start `getInitialNotification`, and pending-tap
  navigation after App Lock;
- displayed/trigger/all/targeted cancellation truth, trigger scheduling, messaging-style rendering, and full-screen
  FaceTime behavior.

Replace the package behind the adapter when it becomes incompatible with the pinned Expo/RN toolchain, loses a safe
maintained release path, develops an unresolved security/licensing problem, or cannot meet the lifecycle/cancellation
matrix above. Host mocks and the import boundary prove ownership, not Android delivery or cancellation timing; those
remain exact-device evidence.

## 6. Bounded per-chat message history

Ordinary message notifications use one Android `MessagingStyle` notice per chat. The notification mutation queue owns
the complete native read-merge-post operation, so concurrent deliveries cannot overwrite one another. A pure merge
keeps the newest six lines, replaces duplicate local message ids deterministically, and ignores a delayed delivery
that has already fallen outside the retained window instead of alerting again.

The schema-2 native payload stores only the parallel opaque local SQLite message ids. Server message GUIDs, chat GUIDs,
addresses, and sender handles do not enter that routing data. Existing native history is adopted only when its owner,
schema, chat id, line count, local-id list, and `MessagingStyle` shape all validate exactly; malformed state is never
merged.

Delete and retraction events resolve the target to its local id and rebuild the notice without only that line. A read
event still clears the whole chat. If Android cannot enumerate safe history, the adapter cancels the chat notice; if
Android rejects a withdrawal rebuild, it cancels the original notice before reporting the failure so withdrawn text
is not knowingly left visible. These are host-verified contracts. Foreground/background/killed-process ordering and
rendering still require the `NOTIF-03D` Android candidate matrix.
