# Sharing INTO Gator — failure history and the owned replacement

> **Current status (2026-09-28): `SHARE-02` is DONE for its owned acceptance boundary.** Current
> source re-enables `ACTION_SEND`, `ACTION_SEND_MULTIPLE`, and Direct
> Share through product-owned native modules with bounded streaming and durable batch ownership.
> It does not restore `expo-share-intent` or its unsafe pre-handler. The exact SHARE certificate,
> SHARE-owned current-AAB inspection, real code-1-to-code-2 no-wipe upgrade, all ten conservative
> route/payload pairs, connected embedded-release lifecycle, fresh-install replay, and
> owner-authenticated App Lock cycle are green in the
> [current proof record](./SHARE_02_DEVICE_PROOF_2026-09-28.md). The separately deferred Maps
> metadata and native-symbol path findings still keep the full Android release guard red; this
> task-local completion does not claim otherwise. Sections explicitly labelled
> **Historical** below describe the retired July implementation or the completed `IPC-01` /
> `SHARE-01` disabled baseline, not current source behavior.

_2026-07-24. Reported symptom: "I tried to share a PDF and Gator showed in the intent menu but
failed after that" — and, when pressed for detail, **nothing happened at all**: no attachment, no
error, no toast, no screen change. Shared from the T-Mobile T-Life app. Photos, meanwhile, had
always worked._

## Current owned architecture (`SHARE-02`)

The replacement handles the Android intent before JavaScript through local
`gator-share-intake` code. It rejects item count before provider reads; accepts only `content://`
sources; enforces actual per-file, batch-byte, text, cache, concurrency, and one absolute deadline;
streams into a pending app-private directory; and publishes only a complete, re-statted, atomic
manifest. Exact native acknowledge/release/discard operations make a claimed batch replayable after
process or React-context restart without exposing a partial copy.

Only an explicit user discard or an account reset may delete a complete batch before it is sent,
with two exceptions. First, a batch that no running app holds is deleted once it is more than 24
hours old, counted from when the share was received. From app 0.1.64 that includes a claim an
earlier app process left behind (owner decision 2026-10-27): a claim belongs to the app run that
took it, so at the first share-storage use in each new process `EarlierClaimRelease` returns every
earlier claim it can to ready, where it replays oldest first. A claim the running app holds is never
deleted under it, and an entry the release cannot return stays as it was. Second (M169,
2026-10-18): a claimed batch whose manifest this build cannot read would otherwise stay first in
line and block every later share. The drain shows "Gator could not import that shared item",
discards that exact batch by id, and pulls the next one; if the discard fails it stops instead of
retrying. A claim whose own id is invalid cannot be discarded and still blocks, but the user sees
the message on each attempt.

The companion `gator-share-shortcuts` module publishes at most ten current-account rows with opaque
HMAC identifiers. Publication and resolution use the same bounded canonical active-chat universe;
generation fencing rejects stale account work, and operational key/token failures surface as a
redacted failure rather than an ordinary no-match. App Lock clears personalized rows and keeps
capture above the protected tree while routing remains below it.

The same rows also appear in the launcher icon's long-press menu, where a tap opens Gator's inbox.
That is deliberate (owner decision on review M175, 2026-10-19): do not add
`setExcludedFromSurfaces(SURFACE_LAUNCHER)`. androidx core's `ShortcutManagerCompat` drops launcher-
excluded shortcuts before calling Android, and Android keeps them only when AppSearch shortcut
integration is on (off by default), so the rows would vanish from the share sheet too. The names
shown are the ones the share sheet already shows, and App Lock publishes none.

### Release diagnostics: the `share.intake` event (from app 0.1.64)

Release builds keep errors only, so before 0.1.64 a share that went nowhere left no trace. Each step
of share intake now records a finite `share.intake` event (`src/core/secure/errorDiagnostic.ts`),
one of the two INFO events release builds keep, with `fcm.push_received`. It appears in Settings →
App Logs and in Share diagnostics; it never reaches logcat or the error-report upload. Fields, all
optional except the first two, and nothing else:

- `stage`: `signal` (native says a share is waiting), `pickup`, `route`, `settle`, `reject`, or
  `held` (the app came to the foreground with a share still held);
- `outcome`: a fixed label for that stage, or a native rejection reason (`count`, `file_size`,
  `busy`, …); anything else reads `unknown`;
- `files` (a count), `text` (yes or no), `target` (`none`, `resolved` or `unresolved` Direct Share
  target), and `held` (how long ago the share was made: under 1 minute, 10 minutes, 1 hour or 24
  hours, or over 24 hours).

Never a batch id, chat, file name or shared text: the projector rebuilds every event from these
fields on capture, restore and export. `pickup` with outcome `held` means a new share is waiting in
native storage behind one the app still holds, which is the "sharing does nothing" case.

### Recovery from a stuck share (from app 0.1.64)

The app holds one share at a time, and a screen that shows it registers as its owner
(`useShareBatchOwnership`). Each time the app comes to the foreground:

- with no share held, it pulls from native storage again, so a missed signal or a failed pickup
  does not strand later shares (this quiet re-check records nothing when it finds nothing);
- with a share held that no screen shows, it opens that share again (`route` `reopened`). A route
  still being worked out, or one sent less than 3 seconds ago, is left to land first.

When native signals a new share while one is held, the app says "Finish or discard your earlier
shared item; your new share is waiting." and opens the held share again if nothing shows it. Native
signals every committed share as new (`ShareIntakeSignal`, `newShare: true`), not only once until a
share settles, so the message appears for each newer share. Its other signals are reminders that a
share is waiting (`newShare: false`): one found at start-up, a single replay to a listener added
later, and the next share after one settles. Settling signals the next share before the app has
cleared the settled one, so a reminder never shows the message. A failed pickup shows "Gator could
not open a shared item. It will try again the next time you open Gator." A share capture or
navigator that failed is remounted the next time the app comes to the foreground
(`boundary-reset`), instead of staying blank until a restart. A remounted navigator leaves a share
that a screen still shows on that screen, rather than opening it twice.

### Dead ends that say what to do (from app 0.1.64)

- A one-to-one iMessage chat sends one JPEG or PNG (or PDF, when the server offers it) of at most
  10 MiB. The composer now names the reason a share cannot go there: several files, a HEIC photo
  ("can’t send HEIC photos yet"), another file type, or the size (`imessageAttachmentRefusal`).
- RCS media is limited to 100 MiB per file (Google's limit; the server's `RCS_MEDIA_MAX_BYTES`
  refused a larger file only after receiving all of it). The send now refuses such a file before
  any bubble, queue row or upload (`RcsAttachmentTooLargeError`, admission reason `too-large`), and
  New Message keeps Start off and names the file until it is removed.
- A file shared from Gator back into Gator is still refused, because Gator must not read its own
  provider's files on another app's behalf, but native now reports it as `own_file` instead of
  `permission`. The app says "Gator can’t share a file to itself. Long-press the message and use
  Forward or Save instead." Forward is offered in RCS chats; Save works in every chat.

## Summary

Two independent problems, and the second is why the first stayed invisible for so long.

1. **The app was blind to share failures.** `expo-share-intent` reports problems on an `onError`
   event that Gator never subscribed to. `ShareIntentCapture` read only
   `{ hasShareIntent, shareIntent, resetShareIntent }` from the provider context and discarded the
   `error` field. Nothing was written to App Logs either. So every failure below produced silence.
2. **The library's Android file resolution is broken for non-media files** — and the working photo
   path masked it, because photos take a completely different branch inside the library.

`expo-share-intent@8.0.1` is the latest published version, so there was no upstream fix to adopt.

## Root cause detail

The chain, and where a document dies:

```
sending app → Android SEND intent (content:// uri + a TRANSIENT read grant)
   → ExpoShareIntentModule.handleShareIntent  (native)
   → getFileInfo → getAbsolutePath            ← the damage happens here
   → parseShareIntent                          (JS)  ← and here
   → shareIntentStore → new-chat / chat composer → attachmentUpload
```

### The four traps

| #   | What breaks                                      | Where                              | Symptom                    | Fixable from JS?       |
| --- | ------------------------------------------------ | ---------------------------------- | -------------------------- | ---------------------- |
| A   | `getAbsolutePath` returns an **unreadable** path | `ExpoShareIntentModule.kt:219-274` | stages, then fails at send | **yes**                |
| B   | `getFileInfo` non-null assertions throw          | `ExpoShareIntentModule.kt:59-112`  | **nothing happens**        | no                     |
| C   | file arrives via `ClipData`, not `EXTRA_STREAM`  | `ExpoShareIntentModule.kt:148`     | **nothing happens**        | no (but now _visible_) |
| D   | `!isTaskRoot` re-broadcast loses the uri grant   | `ExpoShareIntentModule.kt:115-123` | **nothing happens**        | no                     |

**Trap A in detail** — the one that explains "photos work, documents don't". `getAbsolutePath`
only stream-copies into `cacheDir` on the `getDataColumn` path, which is what MediaStore
(`content://media/...`) uris take. Everything else:

- `com.android.externalstorage.documents` + `primary:` (the Files app, Downloads, Documents)
  returns a **raw** `Environment.getExternalStorageDirectory() + "/" + …` path. The app declares
  no `READ_EXTERNAL_STORAGE` above API 32 (`app.config.ts`), and Android 11+ scoped storage blocks
  raw-path reads of non-media files regardless — so that path is unreadable.
- Any DocumentProvider the library doesn't special-case (Drive, Dropbox, Gmail, most carrier apps
  — including T-Life) falls through every branch to a bare `return uri.path`, yielding garbage
  like `/document/acc=1;doc=…`.

Then `parseShareIntent` (`node_modules/expo-share-intent/build/utils.js`) makes it worse:

```js
path: file.path || (file.filePath ? `file://${file.filePath}` : null) || file.contentUri || null;
```

The bad `filePath` **wins the `||` chain**, and `contentUri` — the one source that always works —
is then dropped from the parsed output entirely. Note the corollary: `getAbsolutePath` returning
`null` is the _benign_ case, because the fallback then reaches `contentUri`. A non-null-but-wrong
value is the fatal one.

Two further upstream defects worth knowing:

- **Bracket bug**, `ExpoShareIntentModule.kt:145`:
  `mapOf("files" to arrayOf(getFileInfo(uri), "type" to "file"))` — the closing bracket is
  misplaced, so a serialized Kotlin `Pair` lands _inside_ the files array on **every** single-file
  `ACTION_SEND`. Harmless to the library's own parser (it filters entries lacking both
  `path` and `contentUri`), but any new raw-payload consumer must skip non-object entries.
- The `.d.ts` declares `mimeType: string` and `fileName: string` as non-null. Both are routinely
  `null` at runtime.

### The misleading error label

Separately: `attachmentUpload.ts` wrapped **every** `uploadAsync` throw in
`ApiError('no_connection')`. The native uploader raises a plain `IOException` for both a dead
network and an unreadable local file, so a file problem rendered as a red bubble labelled
**"Connection Refused"** (`ClientErrorCode.connectionRefused`, 10004) — pointing the user at their
server instead of at the file. This had likely masked file failures before.

## Historical JS workaround (not shipped)

The following parser/materializer notes explain the intermediate workaround and preserve useful
provider edge cases. They are **not the current architecture**. The Expo/native binding and
`shareFileIo.ts` were removed; root and connected layouts mount no producer or navigator. The
remaining pure modules are dormant test evidence and cannot satisfy IPC-01 because JavaScript
cannot bound work the removed library performs before its event.

### 1. Read the RAW native payload (`src/services/share/`)

The intermediate workaround subscribed directly to `ShareIntentModule`'s `onChange`/`onError`
rather than reading `useShareIntentContext()`. That still ran too late to contain the library's
native provider work, so this subscription and its package are no longer present.

| File                    | Role                                                                                                                                          | Node-testable |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `shareIntentPayload.ts` | Now only pure mime/extension and safe-file-name helpers (paste intake and downloads use them); the raw-payload parser was deleted in Phase 6. | yes           |
| `materializeShare.ts`   | Former copy step; deleted in Phase 6 (recover it from git history).                                                                           | —             |
| `shareFileIo.ts`        | Former Expo binding; now deleted.                                                                                                             | no            |
| `captureShare.ts`       | Former parse → copy → stage orchestrator; deleted in Phase 6.                                                                                 | —             |
| `index.ts`              | Former barrel for the files above; deleted in Phase 6.                                                                                        | —             |

Three rules that are easy to get wrong:

- **Copy at CAPTURE time, never at send time.** `FLAG_GRANT_READ_URI_PERMISSION` is transient and
  task-scoped. A staged attachment can sit in the composer for minutes, and
  `sendAttachmentService` persists the path into `attachments.localPath`, which
  `runOutgoingQueue` re-reads on later drains — including after an app restart. A `content://`
  uri parked there is permanently unreadable.
- **Never trust a resolved copy.** `expo-file-system`'s SAF branch
  (`FileSystemLegacyModule.kt:850-880`) resolves _without writing anything_ when the provider
  reports no display name. Always stat the destination afterwards; treat missing-or-zero-bytes as
  failure.
- **Use the LEGACY `expo-file-system` API for the copy.** Legacy passes the source string to
  native untouched, so a `content://` uri survives verbatim. The modern `File` API round-trips it
  through `Paths.join` → `new URL()`, which re-encodes a non-special scheme and mangles it.

Performance note: a `filePath` already inside our own cache/document dirs (the library's own copy
— the working photo/video path) is reused as-is rather than re-copied, so sharing a large video
doesn't duplicate hundreds of MB before the composer opens. That's the `alreadyLocal` flag.

Cache layout is `<cache>/shared-in/<batchMs>/<name>`; one batch dir per share keeps names from
colliding and makes pruning a pure numeric comparison on the dir name (no `modificationTime`
round-trip, so it stays node-testable). Batches older than 24h are pruned opportunistically.

### 2. Honest error surfacing

- New `local_file` `ApiErrorKind` (`src/core/api/errors.ts`).
- New `ClientErrorCode.attachmentUnreadable` = 10009, "Attachment Unavailable"
  (`src/utils/messageStatus.ts`).
- `attachmentUpload.ts` pre-flights with the existing `expoFileExists`, and classifies a caught
  throw via the pure `isLocalFileFailure` (`src/services/send/uploadErrors.ts` — kept separate
  because `attachmentUpload.ts` imports expo-file-system and so can't be node-tested). Shows a
  toast on the local-file branch only.
- `sendOutcome.ts` maps the new kind to the new code. No signature changes; the background retry
  queue inherits the fix.

### 3. Crash guards

`new-chat.tsx` and `Composer.tsx` called `f.mimeType.startsWith(...)` unguarded on a value the
library types as non-null but frequently emits as `null` — a render crash into the root
`ErrorBoundary`. Both now use `(f.mimeType ?? '')`, matching `MessageBubble.tsx:205`.

## Historical Direct Share implementation (retired unsafe version)

An earlier build implemented Direct Share but exposed the same unsafe intake. These findings were
retained to design the owned replacement. References in this section to what was “now” fixed describe
that retired implementation; current behavior is owned by `SHARE-02` and the proof linked above.

1. **`<share-target>` declared only `image/*`, `video/*`, `text/*`.** Android offers Direct Share
   targets only for a mime type the target DECLARES, so a shared PDF matched nothing and the
   priority row came back **empty** — even though the shortcuts published correctly. Now `*/*`
   (`plugins/withShareTargets.js`). It must stay a subset of the SEND intent filters in
   `app.config.ts`, which are already `*/*`.
2. **Contact photos never rendered.** `loadIcon` used `BitmapFactory.decodeFile`, but
   `expo-contacts` stores the address book's `content://com.android.contacts/…`
   `PHOTO_THUMBNAIL_URI`, which `decodeFile` cannot open — so nearly every chip fell back to the
   launcher icon. Only server-backfilled avatars (real `file://` paths) ever worked. Now decoded
   through `contentResolver.openInputStream`, two-pass and downsampled, and set on the `Person`
   as well as the shortcut. `IconCompat.createWithContentUri` is **not** a substitute — the
   launcher/share-sheet process has no `READ_CONTACTS` grant of its own.
3. **Group avatars were parsed with the wrong delimiter.** `firstAvatar` split on `','`, but the
   inbox query builds the column with `group_concat(COALESCE(h.avatar, ''), '|||')`
   (`src/db/repositories/chats.ts:409`). Every group chat handed native an unsplit blob. Now uses
   the canonical `participantAvatars()` parser (`src/utils/chat.ts:145`), and picks the first
   _available_ avatar rather than the first slot.
4. **Only 4 chips, and they went stale.** Both sides hardcoded 4; devices commonly allow 10-15.
   Now `getMaxShortcutCountPerActivity()` clamped to 10 — and wrapped in `runCatching`, because
   `setDynamicShortcuts` **throws** when the list exceeds the cap. Publishing also de-dupes on the
   serialized payload instead of the top-4 guids, so a renamed chat or a newly synced contact
   photo republishes (the guid memo ignored both). `refreshShareShortcuts()` covers the paths
   where the inbox screen never mounts (notification tap straight into a chat, background contact
   sync).

Plus two correctness items:

- **Redacted mode** now publishes nothing **and actively clears**. Dynamic shortcuts are
  persistent system state that outlives the process, so "we haven't published this session" is not
  a reason to skip clearing — chips from a pre-redacted session would otherwise stay live on the
  share sheet after a restart.
- **`reportShortcutUsed`** (called from `useChatNavigator`, the single chat-open funnel) feeds the
  People Service ranking. This is the _only_ affinity signal available: notifications cannot carry
  a matching `shortcutId`, because `react-native-notify-kit` builds its Android notification object
  from scratch and strips unknown keys (`grep -ri shortcut node_modules/react-native-notify-kit/dist`
  → zero hits).

## Historical regression tests

The pure suites remain useful evidence, but they do not authorize re-enabling native intake.

| Suite                                            | Covers                                                                                                                                                                   |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/services/shareIntentPayload.test.ts`       | safe file names and mime/extension mapping only; the parser decision-table cases were deleted with the parser in Phase 6                                                 |
| `test/services/materializeShare.test.ts`         | deleted in Phase 6 with the dormant copy step (see git history)                                                                                                          |
| `test/services/captureShare.test.ts`             | deleted in Phase 6 with the dormant orchestrator (see git history)                                                                                                       |
| `test/services/uploadErrors.test.ts`             | the exact expo-file-system wordings classify as local-file; network errors do not                                                                                        |
| `test/components/shareIntentHandler.test.tsx`    | dormant navigator behavior only; production layouts never mount it                                                                                                       |
| `test/services/shareShortcuts.test.ts`           | cleanup-only bridge; no publish/usage/launch API remains                                                                                                                 |
| `LegacyShortcutCleanupTest.kt`                   | eight native tests cover dynamic/cached removal, pinned-row sanitization and disablement, unsafe-update failure, re-query failure, and idempotence                       |
| `test/services/sendOutcome.test.ts` _(extended)_ | a `local_file` error yields 10009, not 10004                                                                                                                             |
| `test/utils/messageStatus.test.ts` _(extended)_  | 10009 → "Attachment Unavailable"                                                                                                                                         |
| `test/config/shareIntakeDisabled.test.ts`        | dependency/lock/config/import/layout/publication absence plus root legacy cleanup and retired-shortcut marker enforcement                                                |
| `scripts/check-android-build.test.mjs`           | allows harmless outbound `<queries>` ACTION_SEND, rejects inbound surfaces, and requires the cleanup/sanitization DEX markers while forbidding the old publisher markers |

## Historical IPC-01 containment verification

```bash
npm ls expo-share-intent --all                 # expect: (empty)
npm run check:android-build                    # after exact candidate APK/AAB build
npm test -- --runInBand \
  test/config/shareIntakeDisabled.test.ts \
  test/services/shareShortcuts.test.ts \
  test/components/shareIntentHandler.test.tsx
npx expo-modules-autolinking search -p android # output must omit expo-share-intent

# Cleanup-only local bridge and its native unit tests:
cd android && ./gradlew \
  :gator-share-shortcuts:compileDebugKotlin \
  :gator-share-shortcuts:testDebugUnitTest \
  --no-daemon
```

`check:android-build` parses both merged manifests and the packaged protobuf manifest. It rejects
`SEND`/`SEND_MULTIPLE` only when nested in an Activity/Activity-alias intent-filter; an ACTION_SEND
inside manifest `<queries>` is expected package visibility for **outbound** `expo-sharing` and does
not make Gator a receiver. The guard also rejects `android.app.shortcuts` metadata, any packaged
`<share-target>`, and old `ExpoShareIntent` markers in DEX. Its packaged-Dex check requires all
seven cleanup and pinned-row sanitization markers and forbids all four old first-party shortcut
publisher markers.

The required device proof completed on 2026-09-18. Two complementary natural Google Play upgrades
started from approved legacy build `0.1.40` / code `53` and ended on exact candidate `0.1.55` / code
`75`, without command-created shortcut state. Pass A captured the same launcher-pinned legacy row
before the first v75 foreground launch and after cleanup. Pass B began with a distinct synthetic
bitmap avatar; Play itself started `MainActivity` during replacement, so this pass truthfully claims
only the attributed post-cleanup observation. Together they prove that removable rows disappear and
the retained pinned ID loses its legacy label, bitmap, deep link, and Direct Share category before
being disabled. A repeat launch left the cleanup timestamp unchanged.

Separate text, single-image, multiple-image, and PDF resolver checks found zero Gator activities or
conversation targets. Sharing a bounded synthetic attachment outward from Gator still opened
Android's chooser through `expo-sharing`; backup export was not separately exercised. The synthetic
pin and public files were removed, the tested app data was erased, and a fresh Play-v75 install now
has Contacts denied and an empty shortcut inventory. Full observations, privacy precautions, exact
candidate identity, and evidence limits are in
[`IPC_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md`](./IPC_01_PLAY_V75_DEVICE_PROOF_2026-09-18.md).
