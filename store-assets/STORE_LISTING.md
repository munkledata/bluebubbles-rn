# Gator — Google Play listing draft

This is the repository-side store pack, not proof that the listing is release-ready. It removes
known-false claims and records source-backed draft answers. Before promotion beyond Internal
Testing, complete the owner/license decision, privacy policy, Play declarations, exact-candidate
screenshots, and the hashed-AAB checks in [`RELEASE_CHECKLIST.md`](../RELEASE_CHECKLIST.md). Do not
reuse screenshots or answers from an older build.

**Current distribution boundary (owner decision 2026-08-21):** Gator is currently intended only for
private testers through Google Play Internal Testing. The only explicit submission track configured
in `eas.json` is `internal`. The local release build phase stops after building; the separate submit
phase previews by default and requires `--execute`, interactive candidate confirmation, and reviewed
operator approval before it can upload. This document is retained as preparation for any later
Closed, Open, or Production promotion. A `Blocked` label below means blocked before that promotion
unless the row explicitly says it also blocks Internal Testing. Internal tests may not receive
standard policy/security review and are Data Safety-exempt while exclusively internal, but no
UGC-policy exemption is claimed. Confirm in Play Console that no other track is active before relying
on this boundary.

Recheck these requirements when the candidate is frozen:

- [Google Play Internal Testing guidance](https://support.google.com/googleplay/android-developer/answer/9845334?hl=en)
- [Google Play preview-asset requirements](https://support.google.com/googleplay/android-developer/answer/9866151?hl=en)
- [Google Play App content and review fields](https://support.google.com/googleplay/android-developer/answer/9859455?hl=en)
- [Google Play Data safety requirements](https://support.google.com/googleplay/android-developer/answer/10787469?hl=en)
- [Google Play user-generated-content policy](https://support.google.com/googleplay/android-developer/answer/9876937?hl=en)

## Readiness snapshot

| Input                     | Current state                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| App name                  | Draft: `Gator` — 5/30 characters                                                                                                 |
| Short description         | Draft below — 63/80 characters                                                                                                   |
| Full description          | Draft below — 2,284/4,000 characters; recount after any edit                                                                     |
| App icon                  | Technical checks pass: `play-icon-512.png` is a 512×512, 8-bit RGBA PNG; candidate visual approval remains                       |
| Feature graphic           | Technical checks pass: `play-feature-1024x500.png` is a 1024×500, 8-bit RGB PNG with no alpha; candidate visual approval remains |
| Phone screenshots         | **Blocked:** capture from the exact candidate with staged data; none are stored here yet                                         |
| Privacy-policy URL        | **Blocked:** no owner-approved policy URL is recorded in this repository                                                         |
| License/notices           | **Blocked:** `DEC-02`/`LEGAL-01` require the owner's decision and notice inventory                                               |
| Data safety               | **Blocked:** reconcile the candidate, third-party SDKs, active non-internal Play artifacts, and approved privacy policy          |
| App access                | **Blocked:** provide a stable non-production Mac server, reviewer credentials or setup QR, and step-by-step instructions         |
| UGC safeguards            | **Deferred for Internal Testing; blocked before promotion:** required safety work is not implemented                             |
| Developer contact/support | **Blocked:** enter owner-approved support contact details in Play Console and the app                                            |

The two image files meet their current technical size/encoding requirements, but they are still
draft artwork. `STORE-01` must compare them with the exact candidate launcher icon and approved
brand before upload.

## Screenshot shot list

Google Play requires at least two screenshots. Target four portrait screenshots at 1080×1920 or
higher so the listing can also qualify for screenshot-led promotional surfaces. Each image must be
an actual exact-candidate screen, not a mockup, and needs accurate alt text.

| Order        | Exact-candidate shot     | What it demonstrates                                                            | Privacy/capture notes                                                | Draft alt text                                                   |
| ------------ | ------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| 1            | Conversation list        | Core inbox, unread state, avatars, and navigation                               | Use staged names/messages; clear unrelated status-bar notifications  | `Gator conversation list in its dark interface`                  |
| 2            | Open conversation        | Message bubbles, reply/reaction state, composer, and one safe staged attachment | No real names, messages, handles, phone numbers, or server details   | `A staged Gator conversation with reply and attachment controls` |
| 3            | Search                   | Search entry and representative staged results                                  | Use harmless synthetic terms and results; show no production content | `Searching staged conversations in Gator`                        |
| 4            | Scheduled messages       | The scheduled-message list and its ordinary status controls                     | Do not imply exact-time, offline, or killed-app delivery guarantees  | `Scheduled messages and their status controls in Gator`          |
| 5 (optional) | Settings → Privacy/theme | Dark-only theme controls, Storage & File Privacy, and Share Error Reports       | Keep reporting visibly off unless the caption explains consent       | `Gator privacy and dark-theme settings`                          |

Before upload, review every image for Recents/status/navigation bars, permission dialogs, large
text, accidental notifications, third-party marks, and unsupported device or delivery claims.

## Draft listing text

**App name** (30 characters maximum)

```text
Gator
```

**Short description** (80 characters maximum)

```text
An Android messaging client for your own compatible Mac server.
```

**Full description** (4,000 characters maximum)

```text
Gator is an Android messaging client that connects to a compatible, self-hosted Gator server running on a Mac. It is not a standalone messaging service.

Features include:
• Send and receive messages, photos, videos, files, and voice messages
• Reactions, replies, group conversations, search, and scheduled messages
• Rich Android notifications
• Outbound-only sharing of message text, downloaded attachments, and encrypted backups
• An encrypted on-device message database
• Dark-only themes with custom colors

Gator requires a separately installed and configured companion server. Some features require a compatible server version or private server APIs. Gator is not affiliated with, endorsed by, or sponsored by Apple.

Messages and other app records are stored in a SQLCipher-encrypted database on this device. Downloaded or staged attachments, caches, wallpapers and backgrounds, and structured diagnostic logs are ordinary unencrypted files in Gator's app-private storage. Copies saved—or images automatically exported—to Photos or the Gator album are separate plaintext copies in shared media storage and remain until you delete them there.

App Lock is a foreground screen gate. It does not make the database key biometric-bound, encrypt files, or block screenshots, screen recording, or every task-switcher snapshot.

Error reports are sent only while Share Error Reports is enabled, and only to your connected server when it supports uploads. While reporting is off, Gator does not queue or send new reports and deletes queued reports. Reports contain bounded technical fields rather than the original error message or stack trace.

Gator uses Google Firebase Cloud Messaging for push delivery when configured. The app registers an FCM token with your connected server, and push event data passes through Google; payload encryption depends on the server's push settings.

Viewing a message or Find My screen does not fetch third-party link previews or map tiles. If you open a web link or location, Android hands it to your selected browser or maps app. That provider may receive the URL or precise coordinates and, for Find My, the displayed location label.

Gator can share content outward through Android's share sheet. It does not accept text or files shared into it.
```

Do not add claims such as “no third-party cloud,” “fully private,” certificate-pinned, light or
system theme support, guaranteed background delivery, or broad device support unless the exact
candidate and approved policy evidence prove them. Avoid Apple trademarks such as “iMessage” in
public listing text and screenshots unless the owner's legal review explicitly approves them.

## Draft Play answers and evidence gaps

These are preparation notes, not submitted declarations. Final answers must describe the exact
candidate and, for Data safety, the relevant behavior of every version still distributed on
closed, open, or production tracks.

| Play field                 | Draft/source-backed position                                                                                                                                                                                                        | Required before promotion                                                                                                                                          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App access                 | **Restricted functionality:** core use needs a compatible self-hosted Mac server and credentials                                                                                                                                    | Stable non-production reviewer server/account or QR/manual setup, exact steps, and expiry/maintenance owner                                                        |
| Ads                        | **Draft answer: No.** No ad UI or directly installed ad SDK was found in the current source/dependency review                                                                                                                       | Recheck the exact AAB, merged SDK inventory, and Play SDK disclosures                                                                                              |
| Data safety                | **Do not answer “no collection.”** Core data goes to the user's selected server; FCM token/event data may pass through Google; optional diagnostics go to the connected server; media/contacts are used only for requested features | Candidate network/storage inspection, all active non-internal artifacts, SDK disclosures, retention/deletion behavior, approved privacy policy, and owner sign-off |
| Encryption in transit      | **Do not make a universal claim.** HTTPS is recommended, but the app permits an explicitly approved HTTP server connection                                                                                                          | Reconcile the exact connection modes and every off-device flow in Data safety/privacy answers                                                                      |
| Privacy policy             | **Blocked**                                                                                                                                                                                                                         | Publish an active owner-approved URL that matches in-app disclosure and actual behavior                                                                            |
| User-generated content     | **Deferred for the current exclusive Internal Testing scope:** direct messages are UGC; no terms acceptance, in-app blocking/reporting, or moderation workflow was found                                                            | Complete `STORE-01A-UGC-SAFETY` before Closed/Open/Production promotion, or earlier if Play flags the internal app; retain policy/behavior evidence                |
| Target audience/content    | **Pending; do not guess**                                                                                                                                                                                                           | Owner selects intended audience, answers the content-rating questionnaire, and reconciles UGC/minor safeguards                                                     |
| Account deletion/retention | **Pending:** Disconnect wipes local app state, but does not prove deletion of server-side accounts or retained server data                                                                                                          | Decide whether Play's account-deletion rule applies and document the companion server's deletion/retention route                                                   |
| Full-screen intent         | **Blocked on `PLAY-02`:** the generated release manifest declares `USE_FULL_SCREEN_INTENT` for incoming-call notifications                                                                                                          | Obtain the Play eligibility/declaration decision and prove the exact candidate behavior or disable that path                                                       |
| Foreground service         | **Blocked:** the generated release manifest declares media-playback foreground-service access                                                                                                                                       | Complete the prompted declaration and demonstration evidence against the exact candidate                                                                           |
| Photo/video access         | **Blocked:** the generated release manifest includes broad `READ_MEDIA_IMAGES`/`READ_MEDIA_VIDEO` access for gallery browsing                                                                                                       | Prove the core-use justification and declaration, or narrow the candidate to a policy-supported picker                                                             |
| Contacts                   | **Pending:** the candidate can request `READ_CONTACTS` for explicit contact features                                                                                                                                                | Recheck current target-level policy, declaration prompts, Data safety, and the manual no-contacts journey                                                          |
| Other permission prompts   | Camera, microphone, and notification access support QR/photo capture, voice messages, and notifications                                                                                                                             | Compare every runtime explanation with the exact merged manifest and candidate behavior                                                                            |
| Financial features         | **Draft answer: No financial features**                                                                                                                                                                                             | Reconfirm the exact candidate and owner response                                                                                                                   |
| Health apps                | **Draft answer: No health features**                                                                                                                                                                                                | Reconfirm the exact candidate and owner response                                                                                                                   |
| Government app             | **Draft answer: No**                                                                                                                                                                                                                | Reconfirm developer identity and owner response                                                                                                                    |
| News or magazine           | **Draft answer: No**                                                                                                                                                                                                                | Reconfirm category/content and owner response                                                                                                                      |
| COVID-19 functionality     | **Draft answer: No**                                                                                                                                                                                                                | Reconfirm the exact candidate and owner response                                                                                                                   |
| Category                   | **Draft recommendation: Communication**                                                                                                                                                                                             | Owner confirms the category; choosing Social may add separate child-safety declarations                                                                            |
| Device/distribution claims | **Pending**                                                                                                                                                                                                                         | Use Play device-catalog data and exact-candidate checks; do not infer support from the arm64 emulator proof                                                        |
| Developer contact/support  | **Blocked**                                                                                                                                                                                                                         | Enter verified owner-approved support email/site and make the same destinations available in-app                                                                   |

Source facts that informed these notes:

- `app.config.ts` forces dark appearance and configures FCM plus candidate permissions.
- `src/services/notifications/fcmMessaging.ts` registers the FCM token with the connected server.
- `app/(app)/settings.tsx` gates structured error-report upload on explicit consent.
- `app/(app)/storage-privacy.tsx` distinguishes the encrypted database from ordinary private files
  and shared-media copies.
- `src/features/conversations/useUrlPreview.ts` performs cache-only preview reads, while
  `src/ui/findmy/FindMyMap.tsx` disables embedded map/tile loading.
- `app.config.ts` disables inbound `ACTION_SEND`/Direct Share even though outbound sharing remains.

## Closed/Open/Production promotion checklist

1. Freeze the release AAB, commit, version, version code, signing identity, and supported device set.
2. Inspect the AAB's merged manifest, SDK inventory, network behavior, storage behavior, and all
   Play-distributed non-internal versions that affect Data safety.
3. Before promotion beyond Internal Testing, resolve `PRIV-01`, `LEGAL-01`,
   `STORE-01A-UGC-SAFETY`, and owner-approved support/contact
   destinations; publish the privacy policy and terms/user policy.
4. Provide and test a stable non-production reviewer server/account or QR/manual setup with no
   production-user data.
5. Capture at least two—and preferably the four planned—portrait screenshots from that exact
   candidate, add accurate alt text, and recheck the icon/feature graphic against it.
6. Complete App access, Ads, Data safety, content rating, target audience, account deletion,
   sensitive-permission/special-access, UGC, pricing, and distribution fields from observed facts.
7. Walk every public listing claim on the candidate; remove anything unavailable, conditional, or
   dependent on an unsupported server version.
8. Save the Play Console work as a draft. Do not publish until the exact AAB passes the release and
   device checklists.

Play Developer API automation can follow later, but it must upload the same reviewed metadata and
artifact. Never put `play-service-account.json` in Git or the EAS upload context.
