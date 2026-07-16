# Device Verification Checklist

A plain-English, tick-the-box guide for your next on-device session. `npm run typecheck`
and `npm test` already pass on your machine, but a lot of this app only actually _runs_ on a
real Android phone (notifications, FCM push, the encrypted database, the crypto backend,
full-screen call screens). This checklist walks through everything that changed in the
SDK 57 / notify-kit upgrade so you can confirm it works before trusting it.

Work top to bottom. Each `- [ ]` is one thing to check off. If something fails, note which
box and what you saw — that's the bug report.

---

## (a) Clean rebuild first

A plain "reload JS" is NOT enough this time — several native pieces changed, so you must
recompile the Android app from scratch.

- [ ] Close other heavy apps first (the build is memory-hungry; the build machine has very
      little free RAM and the OS will kill the build if it runs out).
- [ ] From the project root, run `rm -rf android && npx expo run:android` to delete the old
      native project and recompile from scratch.
- [ ] If the build gets killed partway (out-of-memory), re-run the same command — Gradle
      resumes from its cache. Passing `--no-daemon` (no long-lived Gradle process) and
      building arm64-only keeps memory use down on a low-RAM machine.

**Why a clean rebuild is required (not optional):**

- The notification library was swapped from the archived `@notifee/react-native` to
  `react-native-notify-kit`, whose native core now **compiles from source** — different
  native code than before.
- `POST_NOTIFICATIONS` moved: notify-kit does NOT auto-add it (notifee did), so it's now
  declared explicitly in `app.config.ts` under `android.permissions`. That only takes effect
  after a native rebuild.
- Expo bumped to **SDK 57** (React Native 0.86) and **React Native Firebase to v25** — both
  ship new native code.

---

## (b) Notifications (via notify-kit)

Send yourself (or have someone send) a normal iMessage while the app is in the background.

- [ ] The notification renders in **thread/conversation style** — it shows the **sender's
      name and their avatar**, not a generic app icon (this is the Android `MESSAGING` style
      in `postNotification`, `src/services/notifications/notifeeService.ts`).
- [ ] Tap the **Reply** field on the notification, type a message, send it — it actually goes
      out and appears in the chat (routes to `sendTextMessage`).
- [ ] Tap **Mark as read** — the notification clears and the chat's unread marker advances.
- [ ] Tap **♥ Love** — a Love tapback is applied to that message (routes to
      `sendReactionMessage`).
- [ ] Open **per-chat notification settings**: from a conversation's settings, open its
      notification channel — Android's system settings for _that chat's own channel_ open, so
      you can give one conversation a custom sound/importance.
- [ ] Turn on **Hide preview / redacted mode** (Settings), then trigger a notification. The
      body, chat title, sender name, and avatar are all masked (generic "New message"). Check
      this for **every** notification path, not just a normal message: a reminder, a FaceTime
      call, and an alias-removed notice should all redact too.
- [ ] With **app-lock enabled**, get a push while locked: you should see a single
      **content-less** "You have new messages" notice (from `postLockedNotification`) — no
      sender, no content. The real per-chat notifications appear only after you unlock.

---

## (c) FaceTime incoming call

Have someone FaceTime the linked Apple ID (or trigger one from the server).

- [ ] A **full-screen incoming-call** notification appears (full-screen intent, `CALL`
      category) — not just a small heads-up banner. (If it's only a small banner, the
      `USE_FULL_SCREEN_INTENT` permission didn't take — recheck the rebuild.)
- [ ] Tap **Answer** — the call is answered on the server and the FaceTime link opens (in a
      Chrome custom tab). The ringing notification clears.
- [ ] Tap **Decline** — the ringing notification clears and nothing else happens.

---

## (d) Reminders

- [ ] Set a message reminder for ~1–2 minutes out, then wait: the reminder notification
      **fires** near that time. (It uses an _inexact_ alarm that survives Doze, so it may be a
      little late — that's expected and needs no special permission.)
- [ ] Tap the fired reminder — it routes to the right chat and the reminder is cleared (its DB
      row is deleted).

---

## (e) Killed-app FCM push

This is the important one — it proves push works when the app isn't running at all.

- [ ] **Force-stop** the app (Android Settings → Apps → Gator → Force stop; or swipe it away
      AND force-stop to be sure it's fully killed).
- [ ] Send yourself a message. A notification should **still arrive** (the killed-app wake
      re-runs the FCM background handler).
- [ ] Repeat with an **encrypted** push (server's `encryptComs` setting on): the encrypted
      payload is decrypted on-device (AEAD_GCM_V1) and the notification arrives with real
      content. If decryption ever fails, the message still shows up on the next foreground
      sync — that's the intended fallback, not a silent drop.

---

## (f) Dev boot-log proofs

Run a **dev** build (`npx expo run:android`, dev client) and watch the Metro/logcat output at
startup. These two lines prove the native crypto and the SQLCipher key-rotation both work
on-device (they can't be tested in Jest):

- [ ] `[crypto] self-test { ok: true, detail: 'round-trip + tamper-reject OK' }`
- [ ] `[db] rekey self-test { ok: true }`

If either logs `ok: false`, stop and investigate — the native crypto backend is broken.

---

## (g) App lock (cold boot)

- [ ] Enable app-lock (requires an enrolled fingerprint/face — a bare emulator has none, so do
      this on a real phone).
- [ ] Fully kill the app, then cold-launch it. The **lock screen appears first**, before the
      database is opened — the encrypted DB key is withheld until you authenticate.
- [ ] Authenticate: the app opens the database and routes you into the app normally.

---

## (h) Share intent (share INTO the app)

- [ ] From another app, **share some text** to Gator — it lands in the app ready to send.
- [ ] From the gallery, **share an image** to Gator — it lands staged as an attachment.

---

## (i) Background sync + FCM token

- [ ] After you connect to a server, confirm the **background sync task registered**: the dev
      log shows `[bg] background sync registered` (this is the ~15-minute catch-up sync).
- [ ] Confirm **FCM token registration** succeeds after connecting — the device token is
      fetched (`getToken`, Firebase v25 API) and sent to the server. On failure you'd see
      `[fcm] device token registration failed` in the log; a clean connect should not log
      that.

---

## (j) SDK 57 general smoke test

A quick pass over the screens most likely to be disturbed by the RN 0.86 upgrade:

- [ ] Open a chat and scroll — messages scroll smoothly and, when you tap the composer, the
      keyboard pushes the input up instead of hiding it behind the keyboard.
- [ ] Open a chat that has a **wallpaper/background** — the header and composer bars are the
      frosted/translucent style and the message list runs under them without a smoky fringe.
- [ ] Open an **image/video in the media viewer** — it opens and plays.
- [ ] Send a message with a **send effect** (slam / confetti / balloons, etc.) — the effect
      animates once and cleans up (no leftover animation bleeding onto other rows).
- [ ] In Settings → Downloads, change the **parallel-downloads** stepper, then open a chat with
      many attachments — no more than that many download at once (the cap lives in
      `featureSettingsStore` as `maxConcurrentDownloads`, applied in the download service).

---

_When every box is ticked, the SDK 57 / notify-kit upgrade is verified on-device._
