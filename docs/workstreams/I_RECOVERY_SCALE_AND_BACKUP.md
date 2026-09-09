# Workstream I — recovery, scale, and portable backup

> **Document role:** This file owns stable implementation design and sequencing for Workstream I.
> It never owns task status, dates, owners, blockers, or completion evidence. Those remain only in
> [`WORK_PLAN_2026-08-03.md`](../WORK_PLAN_2026-08-03.md), the authoritative tracker.

<a id="perf-01"></a>

## `PERF-01` — measured inbox baseline

Build reproducible 1,000- and 10,000-chat/message fixtures before changing query shape. Record cold
and warm inbox query time, query plans, reactive publication during sustained writes, render latency,
memory growth, and debounce starvation on both the host substitute and target Android driver.

<a id="perf-02"></a>

## `PERF-02` — bounded inbox work

Add only indexes justified by the measured plan. Page and bound SQL before decorating rows, cap the
reactive debounce with a maximum wait, and retain prior data without producing a false list re-land.
Preserve the shared tombstone, read-floor, preview, archive, known-sender, and search semantics; do not
denormalize previews speculatively.

<a id="recovery-01"></a>

## `RECOVERY-01` — cancellable full repair

A full repair resets only safe server-derived markers, reports progress, supports cancellation and
restart, and is bound to the captured account generation. Server reconciliation must preserve local
pins, names, wallpapers, themes, reminders, drafts, send state, and deletion tombstones. Destructive
absence reconciliation requires a stable server view or an equivalent atomic snapshot contract.
For the modern server, bind every chat, message, and deleted-message page to one owner/process-local
lease and require an exact response acknowledgement before consuming its final unchanged-source
proof. Fence all participating local DB owners against interleaving through the marker commit. RCS
cache absence is never destructive authority until that bounded source has a complete mutation
stamp; an older server may perform only an additive refresh without replacing the marker.

<a id="recovery-02"></a>

## `RECOVERY-02` — bounded target repair and restore

Repair one chat and a bounded message range without scanning or rewriting unrelated chats and without
moving the global sync marker. Restore a deleted chat only after history is safely refreshed; retire
the expected tombstone and hand its unread floor to the read marker in the same guarded write. Never
purge first and repage into an empty visible state.

<a id="backup-01"></a>

## `BACKUP-01` — portable chat customization identity

Identify a chat using a versioned combination of normalized service, direct/group kind, participants,
and a stable server identity when available. Apply a restore only for one unambiguous target, preserve
backward compatibility where safe, and visibly skip ambiguous or unsafe legacy identities instead of
guessing.

<a id="backup-02"></a>

## `BACKUP-02` — bounded import

Stat-cap ciphertext before reading, validate canonical header/version and allowed KDF cost before
expensive work, bound decoding and authenticated decryption, cap plaintext before parsing, and enforce
collection and string limits. Fully validate first, then apply once transactionally with rollback and
guaranteed temporary-file cleanup.

<a id="backup-03"></a>

## `BACKUP-03` — export passphrase policy

Reject weak, common, predictable, or app-specific passphrases for new exports while continuing to
import valid older backups. Normalize length consistently, discourage reuse, and add a generated
recovery phrase only if the selected generator supplies at least 128 bits of entropy.

<a id="pin-01"></a>

## `PIN-01` — stable manual pin order

Persist an explicit device-local pin rank with deterministic pin, unpin, and adjacent-reorder rules.
The inbox query, growing-prefix paging, reactive replacement, accessible reorder controls, backup,
sync, and tombstone logic must share that order without duplicating or omitting chats.

<a id="backup-slots-01"></a>

## `BACKUP-SLOTS-01` — named encrypted server slots

List, save, name, explicitly overwrite, delete, and restore slots by transmitting the existing
encrypted backup ciphertext as-is. Capability-gate older servers; passphrases and plaintext settings
never leave the device. A complete cross-device contract requires server-owned per-slot/count bounds,
an aggregate quota, a bounded read shape, and a revision fence so concurrent devices cannot overwrite
or delete a newer same-name slot silently. The selected implementation is a quota-capped complete
list. It preserves datasets already beyond the slot-count, per-slot-data, aggregate-data, or response
ceilings and fails their complete-list reads closed. An exact-name overwrite may shrink an oversized
target only when the complete post-write kind satisfies every bound; count overages or remaining
oversized rows require exact deletion or manual cleanup. The 80-character new-name cap is not
retroactive. Paginated metadata with per-slot ciphertext fetch is required only if future broader
self-service recovery of that storage becomes a product requirement.
