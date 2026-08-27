# ADR: Retain the approved application stack

- **Status:** Accepted
- **Decision date:** 2026-08-27
- **Owner:** Gator maintainers
- **Scope:** Android application dependencies named by `PKG-KEEP-01`

## Context

The packages below are established production boundaries, not interchangeable conveniences. They own encrypted
storage, runtime validation, large-list behavior, state lifetimes, realtime delivery, push delivery, or Android media
bridges. Replacing one casually can preserve TypeScript compilation while breaking native behavior, persisted data,
or killed-process delivery.

This decision keeps the current stack because each package has a concrete owner and working integration. It is not a
permanent ban on upgrades or replacements. `package.json` remains the version authority, `PKG-01` owns exact native
pins and upgrade evidence, and `DEPS-02` owns direct-dependency justification. A replacement starts only when a trigger
below is observed and the proposed substitute proves the same owned contract.

## Decision

| Stack boundary | What it owns now | Why it stays | Replacement trigger | Minimum proof before replacement |
| --- | --- | --- | --- | --- |
| `@op-engineering/op-sqlite` with SQLCipher and FTS5 | The single native SQLite connection, encrypted `gator.db`, FTS search, reactive-query notifications, rekey, and the raw driver used by migrations and device contracts. SQLCipher and FTS5 are explicitly enabled in `package.json`. | It already provides the encryption, search, reactive, and React Native bridge combination the offline-first design requires. | Replace only if it cannot support a required Expo/React Native/Android target or ABI, an unresolved security/data-integrity defect affects Gator, upstream becomes unsustainable, or measured device reliability cannot be fixed at the owned adapter. | Preserve existing encrypted files and migration history; prove correct/wrong-key open, FTS5, commit/rollback, reactive delivery, rekey, relaunch/crash recovery, and the one-connection/global-writer contract on Android. |
| `drizzle-orm` | Typed schema/query builders and repository queries over the op-sqlite connection. `src/db/database.ts` owns the compatibility Proxy for op-sqlite v17 result and execution shapes. | It gives repositories one typed schema boundary without taking ownership away from Gator's transaction coordinator and migrations. | Replace if a supported Drizzle version can no longer be adapted safely, an applicable advisory cannot be resolved promptly, or required query behavior is blocked and the workaround is riskier than migration. | Migrate every repository deliberately; prove row/result shapes, raw SQL, builders, `RETURNING`, rollback, migrations, reactive flush, and no new writer or nested-coordinator path. `DB-01` owns this proof. |
| `@shopify/flash-list` v2 API | Virtualized inbox, chat, search, deleted-chat, reminder, schedule, and log lists. | Gator has large, reactive datasets and already owns FlashList-specific bottom anchoring, pagination, recycling, refresh, and reduced-motion behavior. | Replace if SDK/React Native incompatibility, an unfixable accessibility/recycling defect, or measured physical-device performance shows it no longer meets the list contract. | On representative Pixel and Samsung hardware, prove bottom anchoring, pagination, recycled-row privacy/correctness, keyboard and gesture interaction, TalkBack/reduced motion, and equal-or-better frame/memory behavior. |
| `zod` | Runtime schemas for untrusted REST, realtime, model, and backup payloads at the boundary before domain use. | TypeScript types disappear at runtime; Zod supplies the fail-closed validation the server and backup boundaries require. | Replace only for an applicable security/maintenance problem, a required schema feature it cannot express safely, or measured validation cost outside accepted bounds. | Convert schemas without weakening current validation, bounds, coercion, or intentional `.loose()` forward compatibility; use adversarial server/realtime/backup fixtures and show malformed input still fails before DB/native effects. |
| `@tanstack/react-query` | Shared async-query cache, cancellation, invalidation, retry, and status for server/account/backup management plus the bounded chat-search query. It is not the message/chat source of truth. | It removes duplicated request lifecycle state while allowing the encrypted DB to remain authoritative. | Replace if its used surface becomes too small to justify the dependency, React/Expo compatibility breaks, or its cancellation/account-retirement semantics cannot meet Gator's lifecycle contract. | Preserve abort/cancellation and session retirement, prevent stale-account publication, and show the replacement never turns remote cache data into message/chat truth. |
| `zustand` | Small app/session, health, settings, transfer-progress, dialog/toast, typing, lock, and other presentation/control stores with synchronous non-React access where services need it. | Narrow selectors and `getState`/`subscribe` fit both React UI and service composition without moving durable messages or credentials into a general state container. | Replace if maintenance/React compatibility fails, explicit hydration or account scoping cannot be made safe, or a materially simpler state model can remove the package without duplicating stores. | Preserve narrow subscriptions, synchronous service access, guarded hydration, session epochs/revocation, and current persistence boundaries; prove no durable DB truth or credential custody moves into UI state. |
| `socket.io-client` | The authenticated realtime connection, WebSocket transport, bounded reconnect handoff, and raw event delivery into the sole `EventRouter` normalization path. | It matches the current Gator server protocol and reconnection model; changing only the client library would create a cross-repository protocol fork. | Replace only with an accepted server protocol change, an applicable security/maintenance issue, or measured connection/reordering behavior that cannot be corrected within the owned wrapper. | Coordinate app/server changes; preserve authentication modes, event inventory, reconnect limits/escalation, account leases, occurrence ordering/deduplication, and fallback sync behavior under disconnect/reconnect. |
| `@react-native-firebase/app` and `@react-native-firebase/messaging` | Android FCM registration, token refresh, foreground delivery, and the top-level killed-app background callback feeding the durable realtime path. | FCM is the server's Android push contract, and RNFirebase exposes the required native/headless integration. | Replace only if the server adopts another push provider, RNFirebase cannot support the required SDK/Android target, or an applicable security/reliability issue remains unresolved. | Prove token registration/retirement, encrypted and plaintext envelopes, duplicate identity, locked generic notices, foreground/background/killed-process delivery, notification taps, account teardown, and no message-body logging on exact Android builds. |
| Expo media/file modules: `expo-image`, `expo-audio`, `expo-video`, `expo-image-picker`, `expo-media-library`, `expo-camera`, `expo-file-system`, `expo-document-picker`, and `expo-sharing` | Image rendering, voice recording/playback, video playback, user-selected media/files, gallery browse/save, QR scanning, camera capture, owned-file access, and the outbound system share sheet through SDK-matched native modules and config plugins. | They track the project's Expo SDK and centralize Android permission/config integration. Gator already contains lifecycle, path, permission, and recycled-row safeguards around them. | Replace a module independently if the SDK removes a required API, it cannot meet a measured device performance/reliability/accessibility need, or its permission/security model conflicts with Gator's least-privilege contract. | Preserve explicit-action permission prompts, selected/captured URI handling, bounded file ownership, player/recorder cleanup, background/PiP policy, save/browse/share behavior, and physical-device flows. While imperative APIs remain, SDK 57 requires `expo-media-library/legacy` and the upload path requires `expo-file-system/legacy`'s `createUploadTask`. |

## Guardrails

- A version upgrade is not automatically a replacement, but native-boundary upgrades still follow `PKG-01` and the
  affected package's device matrix.
- Keep the encrypted DB as message/chat truth. TanStack Query and Zustand must not become alternate durable stores.
- Keep op-sqlite behind the owned database/adapter boundary, Socket.IO behind the realtime service, Firebase behind
  the push service, and Expo media calls behind the existing service/UI ownership paths.
- Replace one boundary at a time. Do not combine a database, realtime, push, or media replacement with an unrelated
  feature batch.
- A benchmark or failing contract must identify the concrete problem. Popularity, novelty, or fewer declared
  dependencies alone is not a replacement trigger.

## Consequences

The project accepts the maintenance cost of its op-sqlite/Drizzle adapter and native package matrices because those
costs make compatibility explicit. Package reviews can still recommend upgrades, removal, or replacement, but must
start with the owned behavior above and a migration/proof plan. This ADR records the decision; it does not claim that
outstanding exact-device work in `DB-01`, `PKG-01`, or the release checklist is complete.

## Related evidence

- [`AGENTS.md`](../AGENTS.md) — current architecture and native-module contracts
- [`WORK_PLAN_2026-08-03.md`](./WORK_PLAN_2026-08-03.md) — `DB-01`, `PKG-01`, `DEPS-02`, and task status authority
- [`PHASE-DEPENDENCIES.md`](./PHASE-DEPENDENCIES.md) — phase ownership and intentional direct dependencies
- [`SPIKES.md`](./SPIKES.md) — original encrypted DB, reactive query, and FlashList proof goals
