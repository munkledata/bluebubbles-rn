# UGC Safety Contract and Milestone Decomposition

> **Status (2026-08-23): DESIGN/AUDIT ONLY — NO UGC SAFETY IMPLEMENTATION OR COMPLIANCE CLAIM.**
> This document records the current app/server gap, required owner decisions, trust boundaries, and
> independently verifiable children for `STORE-01A-UGC-SAFETY`. It does not supply legal terms,
> create a report destination, authorize moderation, change app/server behavior, or prove Google
> Play compliance.

## 1. Distribution and policy boundary

Gator's current approved distribution target remains private Google Play Internal Testing. Google's
current Internal Testing guidance says internal tests might not receive the standard policy/security
review and are exempt from the Data safety section while exclusively internal; it does **not** say
that Internal Testing is exempt from the Developer Program Policies. `DEC-11` therefore defers this
gate for the current private test without waiving it. `STORE-01A` becomes P0 before any Closed, Open,
or Production track, or earlier if Play raises a UGC issue.

Google's current User Generated Content policy expressly covers clients that provide access to UGC.
It requires acceptance of terms/user policy before users create or upload UGC, objectionable-content
rules, ongoing moderation appropriate to the experience, in-app reporting/blocking, and an in-app
user-blocking function for 1:1 interactions such as direct messaging. The full policy controls over
this summary:

- [Google Play User Generated Content policy](https://support.google.com/googleplay/android-developer/answer/9876937?hl=en)
- [Google Play testing-track guidance](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en)
- [Google Play Data safety guidance](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)

## 2. Audited source boundary

The offline audit used these boundaries:

| Surface                | Read-only baseline                                                            | Important limitation                                                                                                               |
| ---------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Android app            | `/Users/munkle/github/bluebubbles-rn` at `0de805c` before this docs milestone | No later commit is treated as reviewed automatically                                                                               |
| Canonical Gator server | `/Users/munkle/github/BB/bluebubbles-server` at HEAD `bbee62fa`               | The server tree already had **659** default short-status records (**680** with untracked files expanded); HEAD alone is incomplete |
| Legacy server clone    | `/Users/munkle/github/bluebubbles-server`                                     | Read-only corroboration only; not the canonical implementation target                                                              |

The app worktree was clean before this milestone. The canonical server's existing dirty records are
owned by the user and must be preserved. The baseline is **659** NUL-delimited
`git status --porcelain=v1 -z` records, or **680** file-level records with
`--untracked-files=all`; its NUL-delimited status digest before this milestone is
`4c123e8ca35de77e3f58281c3915812e4522afe819275896eba876c0e86fa145`. Later review must
compare the exact status list, not only the counts. No server edit may begin until a separately
approved, exact-file cross-repository slice establishes its safe baseline and overlap strategy.

## 3. Current capability audit

| Required capability            | Current app evidence                                                                        | Current server evidence                                                                                                               | Disposition                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Versioned terms acceptance     | No terms model, accepted-version persistence, route, gate, or reaccept flow was found       | No terms/version/acceptance operation or advertised capability was found                                                              | **ABSENT**                                                      |
| In-app user/content blocking   | No block-specific record, API, action, or send/sync/notification enforcement was found      | No block-list operation, enforcement check, or capability was found                                                                   | **ABSENT**                                                      |
| In-app abuse reporting         | No report-user/message/chat UI, moderation DTO, queue, or endpoint was found                | No moderation intake, acknowledgement, or case store was found                                                                        | **ABSENT**                                                      |
| Technical error reporting      | Opt-in, privacy-projected diagnostic errors can be sent to the connected server             | `/api/v1/error-reports` fingerprints technical failures when the operator enables it                                                  | **NOT MODERATION**; never relabel or reuse this as abuse intake |
| Authoritative send enforcement | App sends through several text/media/contact/reaction/edit/retry/scheduled/background paths | `send-message` and `new-chat` require `auth: true`, then dispatch without terms/block checks                                          | **ABSENT**                                                      |
| Stable actor identity          | App has an installation and connected-server session, but no UGC safety principal           | Operation context exposes a shared credential, network rate-limit key, and trusted-local flag—not a defined person/device identity    | **UNDECIDED**                                                   |
| Moderation operations          | No owner-facing report status, appeal, or safety disclosure was found                       | No moderation queue/dashboard/runbook, response owner, escalation, or retention rule was found in the audited server/release evidence | **ABSENT**                                                      |
| Exact-candidate proof          | No terms/block/report reviewer journey was found in current release evidence                | No staged moderation environment is named or evidenced in the audited repositories/current release evidence                           | **OPEN / EXTERNAL**                                             |

`ServerInfo` currently advertises no UGC-safety capability. App chat/message endpoints expose no
safety operations. The server's shared password can authenticate a request, but all clients using
that password appear as the same credential; an IP-derived rate-limit key is not a durable person or
device identity. An FCM device record is delivery state, not automatically an authenticated safety
principal.

The app does have per-chat mute and unknown-sender notification filtering. Those controls do not
create a block record, identify a blocked person, stop outgoing contact, or enforce the chosen block
semantics across sync and delivery, so they are useful adjacent features but not equivalent to the
required user-blocking capability.

## 4. Actors, identities, and trust boundaries

The design must not collapse these distinct actors:

| Actor                      | What it can own                                                                 | What must not be assumed                                                        |
| -------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Product/legal owner        | Terms text/version, prohibited-content rules, privacy disclosures               | Code authors cannot invent or approve legal policy                              |
| App user/tester            | Acceptance action, local block/report action, optional evidence consent         | A shared server password does not identify this human                           |
| App installation/device    | Local durable state and a possible generated installation identifier            | A reinstall/device id is not automatically a legal person or account            |
| Connected server operator  | Self-hosted server configuration, server-side intake/enforcement where approved | The operator is not automatically the product moderation team                   |
| Remote correspondent       | Sends iMessage/RCS content visible through Gator                                | They may never install Gator or accept Gator's terms                            |
| Moderator/safety responder | Reviews reports and applies documented actions                                  | None is named or evidenced in the audited repositories/current release evidence |
| Release reviewer           | Exercises the staged safety journey                                             | Host tests cannot substitute for installed candidate/server evidence            |

The owner must choose the authoritative acceptance and reporting principal before persistence or API
code. A device-local acknowledgement can gate the UI, but it cannot by itself prove server-side
enforcement. A server-password-scoped acknowledgement applies to every client sharing that password
unless the protocol first introduces a stronger principal.

## 5. Required behavior contracts

### 5.1 Terms acceptance

Owner-approved inputs must include an immutable policy version, content or stable owned URL, digest,
effective date, issuer, objectionable-content rules, and the event that requires reacceptance. The
eventual implementation must:

- show the exact current policy before acceptance and make decline/cancel behavior explicit;
- record only the approved principal, policy version/digest, and bounded timestamp/audit metadata;
- fail closed before every path that creates or uploads UGC when the required version is unknown,
  stale, rejected, or unreadable;
- define what happens to drafts and already queued, scheduled, retried, notification-originated, or
  background work when a policy version changes;
- keep reading/export/deletion behavior available as approved so a policy gate does not trap user
  data; and
- never infer acceptance from app use, setup completion, an existing server password, or a prior
  version's acknowledgement.

### 5.2 Blocking

The owner must choose whether blocking is Gator-local filtering, authoritative server filtering,
upstream Messages/RCS blocking, or a clearly labelled combination. Until then, the UI must not
promise that a Gator block prevents the Mac or another client from receiving a correspondent's
messages.

The approved contract must define:

- stable target identity and alias/canonicalization rules across phone/email handles, iMessage, RCS,
  one-to-one chats, and groups;
- whether a block prevents outgoing sends, suppresses incoming content, notifications, searches,
  previews, attachments, reactions, typing/read state, and future sync/backfill;
- treatment of existing history, shared group messages, new aliases, unblock, Disconnect, backup,
  and account replacement;
- behavior when an older server cannot enforce the block or when local/server state disagrees; and
- privacy-safe acknowledgement and error states without revealing hidden content.

Add-then-prune set replacement and account-generation fencing remain mandatory for any durable block
set. Local hiding alone cannot be marketed as upstream delivery prevention.

### 5.3 Abuse report intake

The reporting destination must be chosen before an endpoint or UI exists: the connected self-hosted
server operator, an owner-controlled product moderation service, or another approved destination have
different identity, privacy, availability, and operational consequences.

A reviewed report contract must define a versioned schema with, at minimum:

- a client-generated idempotency key and policy/schema version;
- the approved reporter principal and account/server scope;
- a target type (`user`, `message`, or `chat`) plus validated stable reference;
- a finite reason category and optional bounded user note;
- explicit consent flags for any message text, attachment, or surrounding context included;
- client/server versions and safe created/received timestamps; and
- a non-sensitive acknowledgement/case reference and retry disposition.

Credentials, endpoints, raw logs, full databases, unrelated conversation history, private file paths,
and attachments without explicit consent are forbidden. Reports need size/count/time limits,
idempotency, rate limiting, authentication/authorization, safe retry, account revocation, and
retention-aware deletion. The diagnostic `/error-reports` pipeline remains separate in storage,
consent, schema, role authorization/queue, and purpose; `UGC-DEC-04` still decides the actual report
destination and operator.

### 5.4 Server enforcement

UI-only controls do not satisfy authoritative behavior. The versioned server contract must advertise
capabilities and apply the approved principal, acceptance version, and block state consistently to:

- new chat creation and text, attachment, contact, reaction, edit, retry, and scheduled sends, while
  preserving approved delete/unsend paths that remove content without creating replacement UGC;
- notification/background replies and queued work that can execute without a visible screen;
- realtime, FCM, REST sync, history/backfill, search/index, attachment download, and notification
  presentation paths covered by the selected block semantics; and
- account replacement, credential rotation, reconnect, stale clients, and partial server upgrade.

Rejections need stable typed error codes that the app can explain without exposing private data.
Older servers must be capability-gated; the promotion candidate must fail closed or disable UGC
creation when required enforcement is unavailable. A request accepted before a policy/block change
needs an explicit in-flight disposition—neither silent double-send nor false cancellation claims are
allowed.

### 5.5 Moderation operations

Software intake is incomplete until named owners approve and dry-run an operating procedure that
covers:

- monitored intake and acknowledgement ownership;
- severity categories, response targets, duplicate/spam handling, and safe reporter communication;
- urgent safety, child-safety, credible-threat, legal-request, and account-compromise escalation;
- available actions in a self-hosted messaging architecture and who is authorized to take them;
- appeal/correction, conflict of interest, and abuse-of-reporting handling;
- least-privilege access, audit history, evidence integrity, incident review, and responder training;
- retention/deletion periods for rejected, substantiated, appealed, and legal-hold cases; and
- outage/abandonment behavior so reports do not disappear into an unmonitored endpoint.

Do not promise message removal, correspondent suspension, Apple/Google account action, or upstream
delivery blocking unless the approved system can actually perform and prove it.

## 6. Decision register — implementation stop gates

| ID           | Required owner decision                                                                                                                                                 | Direct and downstream children blocked | Status   |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------- |
| `UGC-DEC-01` | Terms issuer, approved text/URL, prohibited-content rules, version/digest, effective date, and reaccept trigger                                                         | A1, A4, A6                             | **OPEN** |
| `UGC-DEC-02` | Separately named acceptance actor, block-list owner, and reporter principal/binding; whether they may be the same; and how each request proves the applicable principal | A1–A4, A6                              | **OPEN** |
| `UGC-DEC-03` | Exact block-target identity/canonicalization and local/server/upstream semantics for iMessage, RCS, aliases, groups, history, notifications, and unblock                | A2, A4, A6                             | **OPEN** |
| `UGC-DEC-04` | Report destination, controller/operator, categories, evidence consent, acknowledgement, and availability                                                                | A3–A6                                  | **OPEN** |
| `UGC-DEC-05` | Report and block retention/deletion, backup, Disconnect, account replacement, and privacy-policy treatment                                                              | A2–A6                                  | **OPEN** |
| `UGC-DEC-06` | Named moderation owner, response targets, escalation, enforcement authority, appeal, and audit process                                                                  | A5, A6                                 | **OPEN** |
| `UGC-DEC-07` | Older-server rollout, capability minimum, fail-closed behavior, and current Internal Testing notice                                                                     | A1–A4, A6                              | **OPEN** |
| `UGC-DEC-08` | Safe canonical-server baseline/overlap plan for the existing 659 default short-status records                                                                           | A4, A6                                 | **OPEN** |

No implementation milestone may choose one of these on the owner's behalf. An approval must identify
the decision ID and selected behavior; approval of a child milestone is not approval of every open
decision.

## 7. Independently verifiable child milestones

| Child                                   | Purpose                                                                                 | Entry gate                                                    | Exit proof                                                                                      |
| --------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `STORE-01A0-UGC-CONTRACT-DECOMPOSITION` | Freeze this audit, decisions, contracts, and safe sequencing                            | Existing read-only approval                                   | Two-doc diff, exact assertions, host gates, independent app/server review                       |
| `STORE-01A1-TERMS-ACCEPTANCE`           | Versioned acceptance state and fail-closed app UX/send boundary                         | `UGC-DEC-01`, `02`, and applicable `07` approved              | Pure contract/persistence tests, every app send-front-door test, route/accessibility tests      |
| `STORE-01A2-BLOCKING`                   | Discoverable block/unblock UX and truthful app-visible behavior                         | `UGC-DEC-02`, `03`, `05`, `07` approved                       | Identity/alias/group matrices, local DB/event/notification tests, UI/accessibility tests        |
| `STORE-01A3-REPORT-INTAKE`              | Consentful, bounded, idempotent report creation and acknowledgement                     | `UGC-DEC-02`, `04`, `05`, `07` approved                       | Schema/hostile-input/privacy/retry/account-fence tests plus accessible UI tests                 |
| `STORE-01A4-SERVER-ENFORCEMENT`         | Cross-repository capability, identity, and authoritative terms/block/report enforcement | A1–A3 contracts frozen; `UGC-DEC-01..05`, `07`, `08` approved | Exact app/server fixtures, all send/receive/background paths, adversarial and upgrade tests     |
| `STORE-01A5-MODERATION-OPS`             | Owned moderation, escalation, action, appeal, audit, and retention procedure            | `UGC-DEC-04..06` approved; intake staging exists              | Versioned runbook, access/retention evidence, tabletop and outage dry runs                      |
| `STORE-01A6-REVIEWER-EVIDENCE`          | Prove the complete journey on an eligible candidate and isolated server                 | A1–A5 complete; separate distribution/device approval         | Current terms, block/report/enforcement/intake/response journey with sanitized private evidence |

Each behavior child must be split into focused **two- or three-file implementation batches** before
editing. A typical sequence is contract plus direct tests, persistence/transport plus direct tests,
then one UI/entry-point plus its component test. Cross-repository batches may not mix unrelated app
and server cleanup. Database, account-lifecycle, notification, or concurrency work gets an independent
review before freeze.

Recommended dependency order:

```text
A0 contract/decomposition
  └─ owner decisions 01–08
       ├─ A1 terms acceptance ─┐
       ├─ A2 blocking ─────────┼─ A4 server enforcement ─ A5 moderation operations ─ A6 evidence
       └─ A3 report intake ────┘
```

A1–A3 may refine their pure contracts in parallel only after their listed decisions are approved.
The A4-to-A5 arrow is recommended sequencing, not a hard A5 entry gate: moderation runbook work may
start once A5's listed decisions are approved and staged intake exists. A4 must still be complete
before A6.
No UI-only child closes authoritative server enforcement, moderation operations, or reviewer proof.

## 8. Verification and evidence boundary

For this A0 docs milestone:

- assert the exact two-file diff and every A0–A6/`UGC-DEC-01..08` identifier;
- assert the explicit absence/non-equivalence findings, especially that diagnostic error reporting
  is not moderation intake;
- run Markdown formatting and `git diff --check`;
- run pinned local typecheck, architecture, migrations, DB report/reconciliation/fast tests, secret
  hygiene, and full Jest once after the candidate is frozen; and
- obtain independent read-only app/server review.

For later app/server behavior, add focused hostile-input, stale-account, retry/idempotency,
notification/background, old-server, and upgrade tests before the same milestone gates. Host tests
cannot prove native UI, Play delivery, a live moderation responder, or server deployment.

Any later app build must be **local only**, separately approved, source-identified, and stopped before
upload. This decomposition authorizes no build, EAS/cloud action, network mutation, Play action,
server edit/deployment, tester invitation, device action, or compliance declaration.
