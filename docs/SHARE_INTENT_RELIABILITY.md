# Sharing INTO Gator — why a shared PDF vanished, and the fix

*2026-07-24. Reported symptom: "I tried to share a PDF and Gator showed in the intent menu but
failed after that" — and, when pressed for detail, **nothing happened at all**: no attachment, no
error, no toast, no screen change. Shared from the T-Mobile T-Life app. Photos, meanwhile, had
always worked.*

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

| # | What breaks | Where | Symptom | Fixable from JS? |
|---|---|---|---|---|
| A | `getAbsolutePath` returns an **unreadable** path | `ExpoShareIntentModule.kt:219-274` | stages, then fails at send | **yes** |
| B | `getFileInfo` non-null assertions throw | `ExpoShareIntentModule.kt:59-112` | **nothing happens** | no |
| C | file arrives via `ClipData`, not `EXTRA_STREAM` | `ExpoShareIntentModule.kt:148` | **nothing happens** | no (but now *visible*) |
| D | `!isTaskRoot` re-broadcast loses the uri grant | `ExpoShareIntentModule.kt:115-123` | **nothing happens** | no |

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
path: file.path || (file.filePath ? `file://${file.filePath}` : null) || file.contentUri || null
```

The bad `filePath` **wins the `||` chain**, and `contentUri` — the one source that always works —
is then dropped from the parsed output entirely. Note the corollary: `getAbsolutePath` returning
`null` is the *benign* case, because the fallback then reaches `contentUri`. A non-null-but-wrong
value is the fatal one.

Two further upstream defects worth knowing:

- **Bracket bug**, `ExpoShareIntentModule.kt:145`:
  `mapOf("files" to arrayOf(getFileInfo(uri), "type" to "file"))` — the closing bracket is
  misplaced, so a serialized Kotlin `Pair` lands *inside* the files array on **every** single-file
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

## What changed

### 1. Read the RAW native payload (`src/services/share/`)

We now subscribe directly to `ShareIntentModule`'s `onChange`/`onError` rather than reading
`useShareIntentContext()`. The module *is* exported from the package, and Expo emitters accept
multiple listeners — so `<ShareIntentProvider>` stays mounted for its cold-start/AppState pumping
while nothing reads its parsed state. `getShareIntent` nulls the native singleton once handled, so
the two coexist without double-capturing.

| File | Role | Node-testable |
|---|---|---|
| `shareIntentPayload.ts` | Pure parser. Prefers `contentUri`; rejects SAF-junk paths; derives a safe filename + extension; defaults mime to `application/octet-stream`. | yes |
| `materializeShare.ts` | Copies each file into app-private cache, then **re-stats** it. IO injected. | yes |
| `shareFileIo.ts` | The only expo-touching file. | no |
| `captureShare.ts` | parse → copy → stage → clear, with toasts. | yes |
| `index.ts` | Production binding. | — |

Three rules that are easy to get wrong:

- **Copy at CAPTURE time, never at send time.** `FLAG_GRANT_READ_URI_PERMISSION` is transient and
  task-scoped. A staged attachment can sit in the composer for minutes, and
  `sendAttachmentService` persists the path into `attachments.localPath`, which
  `runOutgoingQueue` re-reads on later drains — including after an app restart. A `content://`
  uri parked there is permanently unreadable.
- **Never trust a resolved copy.** `expo-file-system`'s SAF branch
  (`FileSystemLegacyModule.kt:850-880`) resolves *without writing anything* when the provider
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

## Direct Share (the share sheet's contact row)

Already built, but under-performing for four confirmed reasons — worth reading as a set, because
only the first is specific to documents.

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
   *available* avatar rather than the first slot.
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
  People Service ranking. This is the *only* affinity signal available: notifications cannot carry
  a matching `shortcutId`, because `react-native-notify-kit` builds its Android notification object
  from scratch and strips unknown keys (`grep -ri shortcut node_modules/react-native-notify-kit/dist`
  → zero hits).

## Tests

Five new suites plus three extended. All in the **node** project unless noted.

| Suite | Covers |
|---|---|
| `test/services/shareIntentPayload.test.ts` | `contentUri` beats a present `filePath`; a bogus `/document/…` with no `contentUri` is **dropped**, not turned into a fake path; the bracket-bug junk element is skipped; filename traversal sanitized; extension derived from mime; malformed payloads return empty without throwing |
| `test/services/materializeShare.test.ts` | **copy resolves but nothing landed → file dropped**; size comes from the stat, not the provider's claim; one failure doesn't sink the batch; `alreadyLocal` reuse skips the copy; batch pruning |
| `test/services/captureShare.test.ts` | text-only never copies; files staged **before** the native intent is cleared (call-order asserted); all-failed batch toasts and stages nothing; never rejects |
| `test/services/uploadErrors.test.ts` | the exact expo-file-system wordings classify as local-file; network errors do not |
| `test/components/shareIntentHandler.test.tsx` | subscribes to **both** `onChange` and `onError`; drains *after* subscribing; forwards the raw value; removes listeners on unmount; no-ops with the native module absent |
| `test/services/shareShortcuts.test.ts` *(extended)* | `\|\|\|` delimiter; redacted publishes nothing / clears once / clears after a restart; content dedupe republishes on a rename or avatar change |
| `test/services/sendOutcome.test.ts` *(extended)* | a `local_file` error yields 10009, not 10004 |
| `test/utils/messageStatus.test.ts` *(extended)* | 10009 → "Attachment Unavailable" |

Totals after the change: **2083 tests / 285 suites**, tsc clean, lint 0 errors, UI coverage 76.9%
(floor 70%).

## Verification

```bash
npm run typecheck
npm test
npm run coverage:ui        # must stay >= 70%
npx expo-doctor            # 20/20

# The native module CAN be type-checked without a full APK build (~20s warm):
cd android && ./gradlew :gator-share-shortcuts:compileDebugKotlin --no-daemon
```

Kotlin gotcha found while doing this: an `AsyncFunction` block must not **end** on
`runCatching { … }` — the bridge has no converter for a Kotlin `Result`. Finish on a statement
(e.g. an `if` without `else`) so the block's value is `Unit`.

Artifact-level checks (grep the built artifact, never trust `app.config.ts` — `android/` is
gitignored and EAS re-prebuilds):

```bash
unzip -p gator-release.aab base/res/xml/shortcuts.xml | strings | grep -E "mimeType|SHARE_TARGET"
#   expect: mimeType  */*  + …category.SHARE_TARGET

unzip -o -q gator-release.aab 'base/dex/*' -d /tmp/aab
grep -ac "gatorshareshortcuts" /tmp/aab/base/dex/*.dex     # NOTE: -a is required; BSD grep
grep -ac "reportShortcutUsed"  /tmp/aab/base/dex/*.dex     # reports nothing on binary without it
```

### Device-only — adb cannot fake the failing case

The uri that breaks can only be minted by a real sending app; `am start` cannot construct it and
the shell uid cannot grant it. So:

1. Install the release, open **Settings → App Logs**, share the PDF from **T-Life** again.
2. Read the `[share]` lines. This single observation decides whether more work is needed:
   - `[share] captured 1 file(s)` and it sends → **trap A; done.**
   - `[share] native error: …` → trap C or D.
   - **no `[share]` line at all** → trap B (native threw before JS ran).
3. Traps B/C/D are not fixable from JS. The planned response is to drop `expo-share-intent` and
   handle the intent in `modules/gator-share-shortcuts` (renamed), which already owns both hooks
   needed — `OnNewIntent` and a `ReactActivityLifecycleListener` — reading `EXTRA_STREAM`/`ClipData`
   and copying in Kotlin where the grant is unambiguously alive. `patch-package` was considered and
   rejected: it adds build tooling that must also work under EAS, breaks silently on a version bump,
   and a patched Kotlin file is invisible to both `npm run typecheck` and `npm test`.
4. Repeat from the Files app and from Drive — different providers hit different branches.
5. Contact chips for a PDF, and their photos, are a human-eye check on the share sheet. Publication
   itself is inspectable: `adb shell dumpsys shortcut` (expect >4 chips, each with a `Person`, icons
   that are bitmaps rather than the launcher resource, and **zero** chips while redacted mode is on).
