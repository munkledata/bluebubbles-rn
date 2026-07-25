# Push notification delivery — architecture, the 2026-07-24 outage, and the fixes

Written after diagnosing "I stopped getting push notifications." The root cause was a **silent
total failure of killed-app push** that had been masquerading as flakiness. This document records
the chain, what was actually broken, what changed, and how to diagnose it next time — so nobody
re-derives it.

Spans two repos: this one (the RN app) and `bluebubbles-server` (`packages/bbd`, the Gator daemon).

---

## 1. The delivery chain

Ten links. Any one can break it, and until this work most of them broke it *silently*.

| # | Link | Where |
|---|------|-------|
| 1 | An iMessage/RCS event reaches the server's domain bus | `packages/bbd/src/serialize/messageFanout.ts` |
| 2 | The fanout calls `pushMessageSink` | `packages/bbd/src/backend.ts` |
| 3 | It reads registered devices | `configStore.listDevices()` |
| 4 | The body is trimmed under FCM's hard 4096-byte data cap | `packages/bbd/src/serialize/pushPayloadCap.ts` |
| 5 | The registry fans out, deduping by send target (token) | `packages/bbd/src/notifications/NotificationRegistry.ts` |
| 6 | FCM v1: mint an OAuth token from the service account, POST the data message | `packages/bbd/src/notifications/FcmProvider.ts` |
| 7 | Google delivers to the device | — |
| 8 | The app's background/foreground handler receives it | `src/services/notifications/fcmMessaging.ts` |
| 9 | Envelope parsed → decrypted → normalized → deduped | `fcmPayload.ts`, `fcmDecrypt.ts`, `core/realtime/eventRouter.ts` |
| 10 | DB write (source of truth), then intent → Android notification | `dbEventSink.ts` → `intents.ts` → `notifeeService.ts` |

Properties worth knowing:

- **Priority is split deliberately.** Only `new-message` is sent at FCM `high` priority.
  `updated-message` (delivered/read/edit receipts) and `message-deleted` are silent data-only syncs
  sent at `normal`, so they don't burn the app's finite high-priority Doze wake quota — once that
  quota is spent, Android downgrades the *real* message pushes and defers them by minutes.
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
`TaskManager.defineTask` each register a *named headless task* that Android looks up the instant it
wakes the app — with **no render**. All three were registered by side-effect imports at the top of
`app/_layout.tsx`. But `_layout.tsx` is a **route module**: expo-router loads it lazily through its
`require.context`, at render time. A headless wake evaluates the bundle entry and never renders, so
that module was never evaluated and the tasks were never registered.

**Why it looked intermittent.** As long as the process stayed alive from the last time the user
opened the app, the handler *was* registered and push worked. The moment Android reclaimed the
process — routine, and aggressive on Samsung One UI — every push was dropped until the app was
manually reopened.

**Fix.** A real bundle entry, `index.js`, referenced by `package.json` `main`:

```js
import './src/services/notifications/backgroundEvents';  // notify-kit headless taps
import './src/services/background/backgroundSync';       // TaskManager.defineTask('gator-bg-sync')
import './src/services/notifications/fcmMessaging';      // setBackgroundMessageHandler
import 'expo-router/entry';                              // MUST be last
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

**Fix.** `test-notification` is now a fully handled event through all six touch points. It renders
even under redacted mode (it carries no user content, and seeing it *is* the passing result) and
deliberately bypasses the "Message Notifications" toggle and unknown-sender filter, since it is a
user-initiated diagnostic rather than a message.

### 2.3 The server was blind to its own push failures

`NotificationRegistry` logged a delivery failure at `debug` — which the file and console sinks drop
— and `pushMessageSink` discarded the `DeliveryResult[]` entirely. A 100%-failing FCM config (a
revoked service account, a spent quota, an HTTP 403) produced **no visible server log at all**.

**Fix.**
- Delivery failures log at `warn`, naming the device and carrying the provider's error message.
  Dead targets (404/410) stay at `debug` — expected, self-healing via the prune, and otherwise they
  would warn on every message until the prune lands.
- `pushMessageSink` logs the failure *shape*: `2/2 device deliveries failed` means the pipeline is
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
`postNotificationSafely` wrapper logs failures at `warn` so a notification that fails to post is
visible in App Logs instead of silently absent. The three near-identical status-notification blocks
were folded into one `postStatusNotification` helper rather than adding a fourth copy.

### 2.5 Not a bug (recorded so it isn't "fixed")

- **Two registered devices.** The server had two FCM rows, "Gator (Android 36)" and "Gator (Android
  37)". These are two *distinct tokens*, i.e. two distinct installs — the phone under test is API 36.
  The registry dedups by token, so this is correct behaviour, not duplicate delivery. Purging would
  have deregistered a live device.
- **`hoistChatGuid`** (`fcmPayload.ts`) folds a top-level envelope `chatGuid` into the body, but the
  Gator server only ever sends `{type, data}` — the sibling key doesn't exist. It is harmless (the
  guid is inside the serialized body already) and kept as tolerance for other server builds.

---

## 3. How to diagnose push next time

Work the chain from the middle out; each step tells you which side you're on.

1. **Is the server sending?** Fire the test push and read the counts *and* errors:
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
`am force-stop`: it puts the app in Android's "stopped" state, where the OS cancels *all* broadcasts
until a manual launch (`logcat` shows `broadcast intent callback: result=CANCELLED`). The bug then
looks unreproducible. This cost real time during the investigation.

---

## 4. The lesson

Every layer reported success while the outcome was wrong: the server said `sent: 2, failed: 0`,
Google delivered, the phone's permissions were perfect, and the app's own logs were empty. The only
evidence was a single `W/` line in logcat.

When a chain of systems all claim success but the result is missing, the failure is in a **handoff
nobody logs**. Instrument the seams, not the components — which is what §2.3 and §2.4 are.

Related: `AGENTS.md` ("Every headless registration must be imported from `index.js`") and
`docs/APP_SERVER_PARITY.md`.
