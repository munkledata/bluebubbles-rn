# Attachment upload progress, cancel, and concurrency

How an outgoing attachment reports itself while it is being sent, why each piece is built the way it
is, and what can only be checked on a device.

Companion to the download side (`downloadStore` + `ProgressRing`), which this deliberately mirrors
where it can and deliberately diverges where it must.

---

## The problem this solved

Before this, an attachment send was **blind**. `expoAttachmentUploader` called
`FileSystem.uploadAsync` — a fire-and-forget promise with no progress callback and no cancel
handle. The only feedback in the whole app was `MessageBubble` dimming the bubble to 60% opacity
while `sendState === 'sending'`. No percentage, no size, no ETA, and "Cancel Sending" was a pure DB
write: the bubble vanished while the phone carried on streaming the entire file to the server.

## The pieces

| File                                                                                              | Role                                                     | Testable in Node? |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------- |
| [`src/utils/uploadProgress.ts`](../src/utils/uploadProgress.ts)                                   | Ratio, byte labels, rollup, stall predicate, bar wording | yes               |
| [`src/state/uploadStore.ts`](../src/state/uploadStore.ts)                                         | Presentation-only byte state, keyed by attachment guid   | yes               |
| [`src/services/send/trackedUpload.ts`](../src/services/send/trackedUpload.ts)                     | Opens/forwards/settles a progress entry for one attempt  | yes               |
| [`src/services/send/uploadControl.ts`](../src/services/send/uploadControl.ts)                     | Concurrency gate + cancel registry                       | yes               |
| [`src/services/send/attachmentUpload.ts`](../src/services/send/attachmentUpload.ts)               | The expo wiring that binds all of the above              | with a mock       |
| [`src/ui/attachments/UploadProgressOverlay.tsx`](../src/ui/attachments/UploadProgressOverlay.tsx) | Ring + byte pill on the bubble                           | component project |
| [`src/ui/conversations/UploadStatusBar.tsx`](../src/ui/conversations/UploadStatusBar.tsx)         | Per-chat summary bar above the composer                  | component project |

**Why so many small files.** `attachmentUpload.ts` imports `expo-file-system`, so a node jest test
can load it only with that module mocked (`test/services/attachmentUploadTransport.test.ts` does, to
prove the transport and cancel wiring). The logic worth proving still lives outside it, with the
native bits injected, so most of it is tested directly without any mock: the same split
`uploadErrors.ts` already used.

## Routes and the multipart filename

- **RCS** (the original path): `POST /message/attachment/upload` with `chatGuid`, `tempGuid`,
  `name` and, on capable servers, `clientAttemptGeneration`.
- **iMessage** (narrow and capability-fenced): only when the server advertises
  `supports_imessage_attachment_upload` (voice notes `supports_imessage_voice_upload`, captions
  `supports_imessage_attachment_caption_upload`), only in a one-to-one chat (`iMessage;-;…` or
  `any;-;…`), and only one JPEG, PNG or PDF up to 10 MiB, or one M4A voice note (sent with
  `uploadKind: 'imessage_voice'`). A caption must be non-blank and at most 64 KiB. The form stays
  minimal: no `name` field and no attempt generation. A stale queue row can never infer this mode.
- **Filename (`gatorFileName`):** the picker often caches a file under a random UUID. The patched
  `createUploadTask` (`patches/expo-file-system+57.0.7.patch`) takes `gatorFileName` and sends it as
  the multipart filename, so the server sees the original name on both routes.

---

## `createUploadTask`, not `uploadAsync`

Both build the identical request; they differ in one argument. Reading the native Kotlin
(`FileSystemLegacyModule.kt`) settles it:

- `uploadAsync` → `createUploadRequest(url, uri, options) { requestBody -> requestBody }` — a no-op
  body decorator.
- `uploadTaskStartAsync` → the same call with `CountingRequestBody(requestBody, progressListener)`.

So the task form is the **only** variant that emits byte progress, and the only one with a cancel
handle (`networkTaskCancelAsync` → `call.cancel()`).

Two details that matter:

- **Multipart progress is accurate.** `createRequestBody`'s `MULTIPART` branch applies the decorator
  to `file.asRequestBody(...)` specifically, not to the assembled `MultipartBody` — so
  `totalBytesExpectedToSend` is the file's exact length, not the envelope.
- **Events are throttled natively** to one per 100 ms (`MIN_EVENT_DT_MS`), plus a guaranteed final
  event at 100%.

### Do not "modernize" this to SDK 57's `File.createUploadTask`

The new object API exists and looks tidier next to `expoFetcher`'s `File.createDownloadTask`. It is
the wrong choice here:

1. It round-trips the source uri through `new URL()`, which mangles a non-special scheme — the trap
   already documented for shared-in `content://` uris. The legacy task hands the string to native
   untouched.
2. Its own type docs warn: _"For multipart uploads, the reported bytes may include multipart framing
   overhead."_ The legacy Android path does not have that problem (see above).

---

## Traps

**A cancelled task resolves `null`, it does not reject.** The native side does
`if (call.isCanceled()) promise.resolve(null)`. Dereferencing that crashes on `result.status`, so it
is named: `ApiErrorKind 'cancelled'` → `ClientErrorCode.userCanceled` ("Manually Canceled").
Without the named kind it fell through to `sendErrorCode(null)` and reported **"Connection
Refused"** — blaming the network for the user's own tap.

**`UploadTask.uploadAsync()` leaks its progress listener on failure.** It calls
`removeSubscription()` only on the success path. `removeSubscription` is `protected` in the types
but present at runtime and self-guards on an already-removed subscription, so
`releaseProgressSubscription()` calls it in a `finally`. Bounded (one per failed attempt) but real.

**The settle must be unconditional.** `runTrackedUpload` settles in a `finally`. A started-but-never-
settled entry is not cosmetic: it draws the bubble spinner _and_ keeps the composer bar on screen,
so it is a permanent phantom "sending" for a message that failed minutes ago, with nothing left
running to clear it.

**A late progress event must not resurrect a settled entry.** Events come from native and can land
after the promise resolves. A resurrected entry has nothing left to settle it — the phantom would be
forever. `uploadStore.progress` returns early when the key is absent.

---

## Two divergences from `downloadStore`

1. **Settling REMOVES the entry** rather than parking it at `status: 'idle'`. The entry set _is_ the
   answer to "is anything uploading right now", which the composer bar reads directly, and a
   retained entry would leave a stale 100% ring on a recycled FlashList row. A failure needs no
   entry either — the message row's own `send_state = 'error'` already draws the red badge.
2. **It stores raw bytes**, not just a ratio, because the size is a thing the user explicitly wants
   to see.

**Unknown totals are normal, not an error.** A voice memo is staged with `size: 0`, and the native
uploader only reports the real content length on its _first_ progress event. So every upload is
briefly indeterminate — `transferRatio` returns `null` and the UI shows a spinner rather than a bar
sitting dead at 0% and then jumping. For a multi-file rollup, _any_ unknown total makes the combined
ratio null: a denominator that grows as each file reports in makes the bar march **backwards**,
which reads as a broken upload.

---

## Concurrency and cancel

**The gate** (`createConcurrencyGate`, default 2) mirrors `downloadService`'s: same acquire/release
shape, same FIFO. Two is the compromise that side already settled on — one at a time makes a
multi-file send feel dead before the first byte moves, while unbounded saturates a phone's much
narrower uplink so every file's percentage crawls at once and the readout stops meaning anything.
Slots release in a `finally`; a leaked slot permanently shrinks the gate and leaking `max` of them
wedges every later upload silently.

`sendImages` deliberately still fires all N sends concurrently — the optimistic rows insert
immediately so every bubble appears at once, and only the network transfers queue.

**RCS uploads ride out the server's busy refusals** (`rcsUploadPacing.ts`, from the 2026-10-21
owner phone session). The server hands one RCS media file to Google at a time and refuses any other
upload in that window with a retryable 503 `rcs_dispatch_busy`, so a four-file share into an RCS
chat showed three "Code 503" failures. For RCS uploads (every upload without `service: 'iMessage'`):

- The files of one multi-file share take turns (`createRcsShareUploader`, one per `sendImages`
  call), normally in share order (each file's own preflight can reorder a burst slightly), so they
  are not uploaded at once. The server answers each file as soon as it is staged but stays busy until
  it has relayed that file to Google, so the next file usually still meets one busy refusal, which the
  retry below absorbs. Separate sends do not wait for each other at this layer (the app-wide upload
  gate and the logical send queue may still order them), so a slow upload in one chat cannot hold
  another.
- A busy refusal is retried after 2, 4, 8 and 15 seconds (±20% jitter), counted from the file's
  turn. The server reads the whole file before it says busy, so each retry re-sends it: a file is
  not retried in place once the re-sent data would pass 20 MB. After that, after the fourth retry,
  or at the caller's `timeoutMs`, the busy error is reported as before and the ordinary retry path
  takes over. Files over about 7 MB get too few retries to cover a long relay, so a share of
  mid-size files can still show 503 failures that the ordinary retry then delivers; the planned
  server-side queue removes that. The server drops a refused upload's idempotency entry, so retrying
  under the same temp guid cannot duplicate it.
- The temp guid stays registered in the upload registry while the file waits, so the retry drain
  cannot start a second attempt of it, and Cancel Sending or an account teardown stops it without
  opening a new socket. The upload store's progress entry only exists during an attempt, so the
  status bar can disappear while a file waits and the ring restarts on each retry.

Single foreground sends (`sendImage`, `sendTextAttachment`) and queue retries use the shared paced
uploader; `sendVoice` is iMessage-only. Headless background retries keep the plain uploader.
iMessage uploads are unchanged.

**The cancel registry is keyed by TEMP GUID**, because that is what "Cancel Sending"
(`discardMessage`) knows. Two non-obvious rules:

- **Registered BEFORE entering the gate.** With a batch, only two files are transferring; a handle
  that existed only for a running task would leave every _waiting_ file uncancellable — exactly the
  big-batch case where the user most wants out. Cancelling while queued means no socket is ever
  opened.
- **Releases are identity-checked.** A retry re-registers the _same_ temp guid with a _new_ task. A
  late release from the previous attempt deleting by key alone would silently make the running
  upload uncancellable, and the button would report success while nothing stopped.

Every registered handle also supplies the exact terminal promise for its native attempt. Removing
the temp-guid key makes another Cancel tap a no-op, but the account teardown registry retains that
promise until Expo's real `uploadAsync()` tail settles. Disconnect cancels once at synchronous
boundary closure, cancels again after admitted send work drains (catching a late registration), and
waits up to 5 seconds for the retained tails. A timeout rejects cleanup and keeps account B blocked;
the cancelled handle and unresolved promise remain registered so the next complete cleanup retry
reissues native cancellation before joining the same exact tail.

`discardMessage` cancels **first**, then tombstones. The late error path cannot undo it:
`reconcileOutgoingError` is UPDATE-only and returns early when the queue row is gone, so it can
never resurrect a cancelled send.

### Long uploads and the retry drain

`listRetryableOutgoing` treats a queue row older than `OUTGOING_GRACE_MS` (60 s) as no longer owned
by its live UI send, but uploads are bandwidth-bound and routinely run longer (a 10 MiB photo on a
weak link, or the tail of a 20-file batch sharing the link). The drain used to claim such a row
mid-upload: a one-shot iMessage attachment was retired as "Delivery may have occurred" while its
progress ring was still moving, and an RCS attachment started a second upload of the same file.

The drain now skips any temp guid still registered in `uploadRegistry` (`uploadRegistry.has`). The
registry holds every attempt from before its first await until it settles, so the skip covers the
file pre-flight, the gate wait, and the transfer. It is in-memory on purpose: an upload can only be
in flight in a live process, and a killed process leaves the registry empty, so the drain takes the
row over exactly as before.

---

## Stall detection

A stall is the **absence** of progress events, so nothing in the store will ever wake the UI to
notice one — it takes a clock. `UploadStatusBar` owns the single 1 s ticker, running only while
something is uploading. One timer for the screen, not one per row in a recycling list.

Threshold is 20 s of true silence (`UPLOAD_STALL_MS`) — generous because a phone handing off between
cells or waking from doze can go quiet for several seconds with the transfer still alive. A slow
link still moves bytes.

An entry that has never reported (`updatedAt === 0`) is **not** stalled; every upload passes through
that state and flagging it would make each send flash a warning. The bar does not re-seed its clock
when it becomes active, deliberately: a stale clock is always _earlier_ than a fresh upload's
`updatedAt`, so the difference goes negative and can never read as a false stall.

---

## Device-only verification

Jest mocks `expo-file-system` wholesale, so a green suite says **nothing** about any of these:

- [ ] the byte counter actually ticks during a real multipart upload (and the total matches the
      file's real size, not the envelope);
- [ ] "Cancel Sending" stops the transfer — watch the server log / the device's network usage, not
      just the bubble disappearing;
- [ ] cancelling a file still **queued** behind the gate never opens a socket;
- [ ] the status bar sits correctly above the composer with the keyboard open, and its
      appearing/disappearing re-lands the message list (it is inside the measured bottom bar, so it
      should ride the existing `onLayout` → scroll-pin convergence);
- [ ] the bar is legible over a chat wallpaper (frosted, matching the composer chips);
- [ ] TalkBack announces the bar as one progress bar with both lines.
