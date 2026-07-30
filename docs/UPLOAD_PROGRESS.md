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

| File | Role | Testable in Node? |
|---|---|---|
| [`src/utils/uploadProgress.ts`](../src/utils/uploadProgress.ts) | Ratio, byte labels, rollup, stall predicate, bar wording | yes |
| [`src/state/uploadStore.ts`](../src/state/uploadStore.ts) | Presentation-only byte state, keyed by attachment guid | yes |
| [`src/services/send/trackedUpload.ts`](../src/services/send/trackedUpload.ts) | Opens/forwards/settles a progress entry for one attempt | yes |
| [`src/services/send/uploadControl.ts`](../src/services/send/uploadControl.ts) | Concurrency gate + cancel registry | yes |
| [`src/services/send/attachmentUpload.ts`](../src/services/send/attachmentUpload.ts) | The expo wiring that binds all of the above | **no** |
| [`src/ui/attachments/UploadProgressOverlay.tsx`](../src/ui/attachments/UploadProgressOverlay.tsx) | Ring + byte pill on the bubble | component project |
| [`src/ui/conversations/UploadStatusBar.tsx`](../src/ui/conversations/UploadStatusBar.tsx) | Per-chat summary bar above the composer | component project |

**Why so many small files.** `attachmentUpload.ts` imports `expo-file-system` and therefore cannot
be loaded in the node jest project *at all*. Anything left inside it is permanently untestable, so
the logic worth proving lives outside it and the native bits are injected — the same split
`uploadErrors.ts` already used.

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
2. Its own type docs warn: *"For multipart uploads, the reported bytes may include multipart framing
   overhead."* The legacy Android path does not have that problem (see above).

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
settled entry is not cosmetic: it draws the bubble spinner *and* keeps the composer bar on screen,
so it is a permanent phantom "sending" for a message that failed minutes ago, with nothing left
running to clear it.

**A late progress event must not resurrect a settled entry.** Events come from native and can land
after the promise resolves. A resurrected entry has nothing left to settle it — the phantom would be
forever. `uploadStore.progress` returns early when the key is absent.

---

## Two divergences from `downloadStore`

1. **Settling REMOVES the entry** rather than parking it at `status: 'idle'`. The entry set *is* the
   answer to "is anything uploading right now", which the composer bar reads directly, and a
   retained entry would leave a stale 100% ring on a recycled FlashList row. A failure needs no
   entry either — the message row's own `send_state = 'error'` already draws the red badge.
2. **It stores raw bytes**, not just a ratio, because the size is a thing the user explicitly wants
   to see.

**Unknown totals are normal, not an error.** A voice memo is staged with `size: 0`, and the native
uploader only reports the real content length on its *first* progress event. So every upload is
briefly indeterminate — `transferRatio` returns `null` and the UI shows a spinner rather than a bar
sitting dead at 0% and then jumping. For a multi-file rollup, *any* unknown total makes the combined
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

**The cancel registry is keyed by TEMP GUID**, because that is what "Cancel Sending"
(`discardMessage`) knows. Two non-obvious rules:

- **Registered BEFORE entering the gate.** With a batch, only two files are transferring; a handle
  that existed only for a running task would leave every *waiting* file uncancellable — exactly the
  big-batch case where the user most wants out. Cancelling while queued means no socket is ever
  opened.
- **Releases are identity-checked.** A retry re-registers the *same* temp guid with a *new* task. A
  late release from the previous attempt deleting by key alone would silently make the running
  upload uncancellable, and the button would report success while nothing stopped.

`discardMessage` cancels **first**, then tombstones. The late error path cannot undo it:
`reconcileOutgoingError` is UPDATE-only and returns early when the queue row is gone, so it can
never resurrect a cancelled send.

### Known interaction (pre-existing, not caused by the gate)

`listRetryableOutgoing` treats a queue row older than `OUTGOING_GRACE_MS` (60 s) as no longer owned
by its live UI send, so a very large batch can have its tail claimed by the retry drain while the
first send is still running. The gate does not create this — uploads are bandwidth-bound, so the
same 20 files run past 60 s unbounded too (all 20 sharing the link); the gate only changes which
finish first. The re-send reuses the original temp guid, so the server's idempotency cache absorbs
it. Worth fixing properly one day by having the drain skip temp guids currently in `uploadRegistry`.

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
when it becomes active, deliberately: a stale clock is always *earlier* than a fresh upload's
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
