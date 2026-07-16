# BlueBubbles GitHub Feature-Request Audit → Gator RN (2026-07-15)

_What this is: a sweep of the **open GitHub issues** on `BlueBubblesApp/bluebubbles-app` (the feature-request / enhancement side, not the source code), filtered to what applies to the Android-only Gator RN fork, grep-verified against `src/`+`app/`, and cross-referenced against `OLD_APP_PARITY_AUDIT_2026-07-15.md` so **new** ideas (🆕) are separated from gaps that audit already lists._

## Method
- 217 open issues pulled via `gh`. 54 Desktop/Windows/Linux/Web-only dropped → 163 candidates.
- 14 agents classified each (feature vs bug, applicability, does-Gator-have-it) grepping the real codebase; a verify pass adversarially re-checked every high/medium 'missing' item (caught 3 false gaps + downgraded 13 to *partial*).
- 60 agents, 0 errors, ~2.3M tokens.

## The numbers
- **69** of the 163 are Flutter-app **bugs**, not features (mostly don't apply to us).
- **13** requested features Gator RN **already has**.
- **41** are out-of-scope for the fork (na-fork 25, desktop 10, server-side 6).
- **66 are genuine 'could-add' candidates** — **41 are NEW ideas** not in the parity audit, 25 overlap it.

## Recommended shortlist (best value-per-effort)

| Issue | Title | Val/Effort | Interest | Tags | The ask |
|---|---|---|---|---|---|
| [#2551](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2551) | Attach text captions to attachment replies | high/M | — |  | When replying to a message with a photo plus a caption, both the caption text and the reply threading should be preserved. |
| [#21](https://github.com/BlueBubblesApp/bluebubbles-app/issues/21) | SMS integration | medium/L | 9💬 6👍 | 🆕 new · partial | See SMS conversations alongside iMessage in one unified list, each marked SMS (green) vs iMessage (blue). |
| [#672](https://github.com/BlueBubblesApp/bluebubbles-app/issues/672) | Request to have the system wide copy/paste menu in BlueBubbl | medium/S | 5💬 0👍 | 🆕 new · partial | Let the user select part of a message's text and use the OS copy/paste context menu, not just whole-message copy. |
| [#2967](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2967) | Unread filter or force unread chats to top of list | medium/M | — | 🆕 new | A way to filter/surface unread conversations so they aren't buried. |
| [#2477](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2477) | [FR] In-Conversation Search | medium/M | — | 🆕 new · partial | Add search within a single conversation, and show the sender's name (not just the chat/contact name) in global search results. |
| [#2870](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2870) | Multi Select chat - Delete Option | medium/M | 1💬 0👍 | 🆕 new | Select multiple conversations at once and delete them in bulk. |
| [#2631](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2631) | [Android] add option to use longer text-message vibration | medium/S | 4💬 0👍 | 🆕 new | Let users choose a longer SMS-style vibration for message notifications to distinguish them from other apps. |
| [#2548](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2548) | Feature Request: Display Scheduled Messages | medium/S | 0💬 1👍 | 🆕 new · partial | Show an in-chat banner (e.g. 'x scheduled messages') below the recipient name that opens the scheduled list, so you don't accidentally double-text. |
| [#1156](https://github.com/BlueBubblesApp/bluebubbles-app/issues/1156) | [Feature Request] In-App PDF viewer, with an option to open  | medium/M | 4💬 0👍 | 🆕 new · partial | View PDF attachments inside the app, with a fallback to open in the external PDF viewer. |
| [#2646](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2646) | Pull contact number tags/labels (mobile/work/home) | medium/M | 1💬 0👍 | 🆕 new | Show the label (mobile/work/home) for each of a contact's numbers instead of listing the contact multiple times undifferentiated. |
| [#2690](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2690) | Add more specific error notification channels | medium/M | — | 🆕 new | Split error notifications into more Android channels so users can block e.g. deregistration alerts while keeping message-failure alerts. |
| [#945](https://github.com/BlueBubblesApp/bluebubbles-app/issues/945) | [GetX Migration] Support for other languages | medium/L | 2💬 0👍 | 🆕 new | Internationalization / translated UI for non-English languages. |
| [#2833](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2833) | Perform incremental sync on reconnect for foreground service | medium/M | 1💬 0👍 | 🆕 new · partial | On reconnect, track last sync time, run an incremental sync, and notify for messages missed while offline. |
| [#3053](https://github.com/BlueBubblesApp/bluebubbles-app/issues/3053) | SMS Messages Show an Unread Count but are Difficult to find  | medium/M | 1💬 0👍 | 🆕 new | Let users float unread chats to the top or filter the conversation list to show only unread. |
| [#2865](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2865) | Add support for android SENDTO intent | low/M | — | 🆕 new | Make the app appear as a target when another app fires an ACTION_SENDTO to text a contact. |


## Reading the shortlist — themes worth a coordinated pass

A few asks cluster, so one piece of plumbing unlocks several rows:

- **List organization (unread + grouping).** #3053, #2967, #2981, #2715 all want the same thing:
  stop burying important chats. Cheapest first step = an **unread-only filter / unread-first toggle**
  on the conversation list (#3053 / #2967, medium/M). Tags/custom lists (#2715 / #2981) are the larger
  version of the same idea.
- **Send fidelity for attachments.** #2551 (caption + reply threading), #2812 / #2605 (multi-photo as
  one gallery bubble), #2679 (chunked upload for big files) overlap the parity audit's "text+attachment
  sent as separate messages" gap — one multipart-send refactor addresses all.
- **Notification granularity.** #2690 (more error channels), #2706 / #2493 (starred contacts break
  through DND), #2631 (longer SMS vibration). Android channels are cheap and high-perceived-value.
- **Accessibility / low-end phones.** #2326 (disable animations), #3013 (reduce motion), #1855 / #2950 /
  #2772 (font scaling), #2949 (shrink avatars). A single "reduce motion + text scale" settings block
  covers most.
- **Contacts depth.** #2646 (number labels), #2658 (nicknames), #2705 (manage contacts), #2752 / #2906
  (view/import VCF). The contacts service today only *syncs* — this is the parity audit's "contact card"
  theme, corroborated by real user demand.

## Genuinely quick wins (low effort, self-contained)

- **#2631** longer SMS-style vibration option — a notification-channel vibration pattern setting.
- **#2548** "N scheduled messages" banner in-chat — you already store scheduled messages; surface a count.
- **#3056** hide the battery-opt button once it's already disabled — one `isIgnoringBatteryOptimizations` read.
- **#2900** persist last Find My map position — avoids opening on 0,0.
- **#2964** debounce the connection indicator so brief drops don't flash it.
- **#569** edge-swipe-to-go-back gesture.
- **#3051** show the handle/phone number on a 1-on-1 chat's details page (data's already queried).

## The single biggest community ask

**#21 "SMS integration" (9 comments, 6 👍 — the most-engaged open issue)** and its cousin **#2756**
(merge same-contact iMessage + SMS into one thread). Partially present — Gator has an RCS/SMS concept
and service badges — but there's no unified inbox folding SMS threads in alongside iMessage with
green/blue distinction. Large effort, depends on what the Gator server forwards → roadmap item, not a
quick win, but the clearest signal of what users want most.

## All addable candidates — NEW ideas (not in the parity audit)

| Issue | Title | Val/Effort | Interest | Tags | The ask |
|---|---|---|---|---|---|
| [#672](https://github.com/BlueBubblesApp/bluebubbles-app/issues/672) | Request to have the system wide copy/paste menu in BlueBubbl | medium/S | 5💬 0👍 | 🆕 new · partial | Let the user select part of a message's text and use the OS copy/paste context menu, not just whole-message copy. |
| [#2631](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2631) | [Android] add option to use longer text-message vibration | medium/S | 4💬 0👍 | 🆕 new | Let users choose a longer SMS-style vibration for message notifications to distinguish them from other apps. |
| [#2548](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2548) | Feature Request: Display Scheduled Messages | medium/S | 0💬 1👍 | 🆕 new · partial | Show an in-chat banner (e.g. 'x scheduled messages') below the recipient name that opens the scheduled list, so you don't accidentally double-text. |
| [#1156](https://github.com/BlueBubblesApp/bluebubbles-app/issues/1156) | [Feature Request] In-App PDF viewer, with an option to open  | medium/M | 4💬 0👍 | 🆕 new · partial | View PDF attachments inside the app, with a fallback to open in the external PDF viewer. |
| [#3053](https://github.com/BlueBubblesApp/bluebubbles-app/issues/3053) | SMS Messages Show an Unread Count but are Difficult to find  | medium/M | 1💬 0👍 | 🆕 new | Let users float unread chats to the top or filter the conversation list to show only unread. |
| [#2870](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2870) | Multi Select chat - Delete Option | medium/M | 1💬 0👍 | 🆕 new | Select multiple conversations at once and delete them in bulk. |
| [#2833](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2833) | Perform incremental sync on reconnect for foreground service | medium/M | 1💬 0👍 | 🆕 new · partial | On reconnect, track last sync time, run an incremental sync, and notify for messages missed while offline. |
| [#2760](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2760) | Handle unsent messages properly (specifically for attachment | medium/M | 1💬 0👍 | 🆕 new · partial | Hide individually retracted message parts (esp. attachments) and show an 'unsent a message' divider. |
| [#2646](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2646) | Pull contact number tags/labels (mobile/work/home) | medium/M | 1💬 0👍 | 🆕 new | Show the label (mobile/work/home) for each of a contact's numbers instead of listing the contact multiple times undifferentiated. |
| [#2967](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2967) | Unread filter or force unread chats to top of list | medium/M | — | 🆕 new | A way to filter/surface unread conversations so they aren't buried. |
| [#2706](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2706) | Adding "new messages from starred contacts" as a notificatio | medium/M | — | 🆕 new | Let notifications from starred/priority contacts bypass Android Do Not Disturb, like Google Voice does. |
| [#2690](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2690) | Add more specific error notification channels | medium/M | — | 🆕 new | Split error notifications into more Android channels so users can block e.g. deregistration alerts while keeping message-failure alerts. |
| [#2477](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2477) | [FR] In-Conversation Search | medium/M | — | 🆕 new · partial | Add search within a single conversation, and show the sender's name (not just the chat/contact name) in global search results. |
| [#2326](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2326) | Ability to completely disable animations | medium/M | — | 🆕 new | Add a setting to fully turn off animations for accessibility and low-end phones |
| [#21](https://github.com/BlueBubblesApp/bluebubbles-app/issues/21) | SMS integration | medium/L | 9💬 6👍 | 🆕 new · partial | See SMS conversations alongside iMessage in one unified list, each marked SMS (green) vs iMessage (blue). |
| [#2756](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2756) | Show chats to same address but different service under a sin | medium/L | 2💬 0👍 | 🆕 new | Merge iMessage and SMS/email conversations with the same contact into one thread. |
| [#2679](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2679) | Add support for multipart/chunked file uploads | medium/L | 2💬 0👍 | 🆕 new | Support chunked multipart uploads (and respect a server-dictated max file size) to get past proxy request-size limits like Cloudflare's 100MB. |
| [#945](https://github.com/BlueBubblesApp/bluebubbles-app/issues/945) | [GetX Migration] Support for other languages | medium/L | 2💬 0👍 | 🆕 new | Internationalization / translated UI for non-English languages. |
| [#2981](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2981) | [Feature Request] Custom Lists, Views, Sorts | medium/L | 1💬 0👍 | 🆕 new | User-definable chat lists/views (e.g. 'family', 'close friends') plus native sorts (known/unknown/transactions/promotions/spam/2FA). |
| [#2715](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2715) | [FR] Put chats into specific groups | medium/L | — | 🆕 new | Let users tag/group chats (work, 2FA, friends) and filter the list by tag. |
| [#569](https://github.com/BlueBubblesApp/bluebubbles-app/issues/569) | Swipe to go back | low/S | 1💬 0👍 | 🆕 new | Enable an edge-swipe gesture to navigate back to the previous screen. |
| [#3056](https://github.com/BlueBubblesApp/bluebubbles-app/issues/3056) | show feedback/hide button if battery optimization is already | low/S | — | 🆕 new · partial | Detect when battery optimization is already disabled and hide the prompt / show a confirmation instead of always offering the button. |
| [#2964](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2964) | Connection indicator improvements (debounce flicker, grey in | low/S | — | 🆕 new · partial | Debounce the connection indicator so brief drops don't flash it, and grey the input box when disconnected. |
| [#2900](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2900) | Save last coordinates in FindMy | low/S | — | 🆕 new · partial | Persist the last map position in Find My so it doesn't open centered on 0,0. |
| [#2852](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2852) | Confirmation popup on back button before exiting app | low/S | — | 🆕 new | Optionally show a confirm dialog when the hardware back button on the chat list would exit the app. |
| [#2805](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2805) | Voice note fails when phone storage is full. Doesn't notify  | low/S | — | 🆕 new · partial | When a voice recording fails (e.g. storage full), tell the user why instead of silently failing. |
| [#2438](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2438) | Can't see digital touch in Android app like I can in desktop | low/M | 5💬 0👍 | 🆕 new | Render received Digital Touch messages inside the conversation view (they already show in the chat list). |
| [#1660](https://github.com/BlueBubblesApp/bluebubbles-app/issues/1660) | Add text field to reply threads | low/M | 2💬 0👍 | 🆕 new | A text field within a reply thread to send multiple replies to one message in a batch (like macOS/iOS). |
| [#3013](https://github.com/BlueBubblesApp/bluebubbles-app/issues/3013) | [FEATURE REQUEST] Reduce motion | low/M | 1💬 0👍 | 🆕 new | A reduce-motion setting so animations/GIFs don't auto-play unless focused/interacted. |
| [#2787](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2787) | Zooming into Videos | low/M | 1💬 0👍 | 🆕 new | Let the user pinch-zoom into videos in the media viewer. |
| [#2658](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2658) | Prefer Nicknames for contacts | low/M | 0💬 1👍 | 🆕 new | Add an option to display iOS-style per-contact nicknames instead of full names. |
| [#514](https://github.com/BlueBubblesApp/bluebubbles-app/issues/514) | Add debug option to get devices from the server (and clear t | low/M | 1💬 0👍 | 🆕 new | A debug screen to list the FCM devices registered on the server and delete stale ones. |
| [#2898](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2898) | Feature Request: Android - Quick Edit | low/M | — | 🆕 new · partial | Add a fast gesture (double-tap/swipe/hold) to edit a recently sent message. |
| [#2865](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2865) | Add support for android SENDTO intent | low/M | — | 🆕 new | Make the app appear as a target when another app fires an ACTION_SENDTO to text a contact. |
| [#2418](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2418) | Compatibility with GBoard Voice Diction 'Send' command | low/M | — | 🆕 new | Recognize Gboard's spoken 'Send' voice-dictation command as a send action |
| [#1763](https://github.com/BlueBubblesApp/bluebubbles-app/issues/1763) | Support GIF stickers | low/M | — | 🆕 new · partial | Let users send/use animated GIF stickers, not just static images. |
| [#1509](https://github.com/BlueBubblesApp/bluebubbles-app/issues/1509) | option to delete chats after a certain amount of days (local | low/M | — | 🆕 new | Auto-delete/purge local chats older than a configurable number of days. |
| [#2891](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2891) | D-Pad Support for Non-Touch device navigation | low/L | 1💬 3👍 | 🆕 new | Support D-pad / non-touch navigation (focus movement) through the app. |
| [#2202](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2202) | Make more emoji fonts available to download | low/L | — | 🆕 new | Let users download and switch alternate emoji fonts (Google/Samsung/Twitter/Facebook) |
| [#1854](https://github.com/BlueBubblesApp/bluebubbles-app/issues/1854) | note taking view, messaging style. Make new service, but jus | low/L | — | 🆕 new | A separate notes-to-self feature that looks like a chat/messaging thread but is just for personal notes. |
| [#241](https://github.com/BlueBubblesApp/bluebubbles-app/issues/241) | Google assistant integration | low/L | — | 🆕 new | Send/read messages hands-free via Google Assistant voice commands. |

## Addable candidates that ALSO appear in the parity audit (corroborating user demand)

| Issue | Title | Val/Effort | Interest | Tags | The ask |
|---|---|---|---|---|---|
| [#2551](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2551) | Attach text captions to attachment replies | high/M | — |  | When replying to a message with a photo plus a caption, both the caption text and the reply threading should be preserved. |
| [#3051](https://github.com/BlueBubblesApp/bluebubbles-app/issues/3051) | Show handle in DM chat details page | medium/S | 1💬 0👍 |  | Show the other participant's resolved phone number/handle in a 1-on-1 chat's details page. |
| [#2935](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2935) | Hide link previews in high-performance mode | medium/S | 1💬 0👍 |  | Disable embedded web/link previews (a high-performance mode) to stop them slowing low-end phones. |
| [#3023](https://github.com/BlueBubblesApp/bluebubbles-app/issues/3023) | [BETA] Voice memos are deleted once recorded | medium/M | 8💬 0👍 | partial | After stopping a voice recording it vanishes instead of being staged in the composer to review/send. |
| [#2705](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2705) | Simplify and enhance Contact management | medium/M | 5💬 0👍 | partial | Add contact syncing (iCloud/Google) and the ability to add/tag/manage contacts from within the client. |
| [#347](https://github.com/BlueBubblesApp/bluebubbles-app/issues/347) | Fallback URLs | medium/M | 5💬 0👍 |  | Try connecting to the server over the local network IP first and fall back to the remote/tunnel URL only if that fails. |
| [#2752](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2752) | [Android] If a contact is sharing their contact info, prompt | medium/M | 3💬 0👍 |  | Export a shared contact card straight into the phone's contacts book. |
| [#2945](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2945) | Allow importing custom fonts (ttf/otf) into the client | medium/M | 0💬 2👍 |  | Let users load their own font files to use as the app font. |
| [#2950](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2950) | Decouple text-input font size from bubble font size | medium/M | 1💬 0👍 |  | Keep composer input text small while enlarging conversation bubble text. |
| [#2906](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2906) | Add VCF / Contact Card Viewer | medium/M | 1💬 0👍 | partial | Let users view a received contact card (.vcf) before importing it. |
| [#2605](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2605) | Feature request: Add a "stacked" layout when sending multipl | medium/M | 1💬 0👍 |  | Render multiple images/videos sent together in a collapsed stacked/grid bubble instead of separate stacked tiles. |
| [#2996](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2996) | [Feature Request] Some general UI enhancements | medium/L | 4💬 0👍 | partial | Grab-bag: nicer attachments menu, stack multi-photos like iOS, per-theme default color schemes, better/theme-matched video player, show contact/group  |
| [#1855](https://github.com/BlueBubblesApp/bluebubbles-app/issues/1855) | Adjustable font size via gesture | medium/L | 2💬 0👍 |  | Pinch/gesture to quickly scale up the UI/font size |
| [#2812](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2812) | FR: Send images as a gallery (multi-attachment message) | medium/L | 1💬 0👍 |  | Sending multiple photos should send them as one gallery/multipart message, not one message per image. |
| [#2976](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2976) | Display Do Not Disturb / Focus status for iMessage contacts | medium/L | — |  | Show an indicator when a contact has Focus/DND enabled (silenced notifications). |
| [#2683](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2683) | Display mentions correctly when editing a message | medium/L | — |  | When editing a message, show existing @mentions correctly and let the user add/change mentions. |
| [#1215](https://github.com/BlueBubblesApp/bluebubbles-app/issues/1215) | [Feature Request] Search Settings | low/S | 2💬 0👍 | partial | A search box in Settings to find a specific setting quickly. |
| [#2949](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2949) | Reduce or remove conversation avatars (small-screen devices) | low/S | 1💬 0👍 |  | Shrink further or eliminate the chat avatar so it doesn't block messages on tiny screens. |
| [#2926](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2926) | FR: Properly handle 'Chatbot' interactive (balloon) messages | low/M | 6💬 0👍 |  | Render com.apple.messages.chatbot / interactive balloon messages instead of an 'Unsupported Interactive Message' placeholder. |
| [#2583](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2583) | Notify anyway effect | low/M | 2💬 0👍 |  | Recreate the iMessage 'Notify Anyway' behavior where a quietly-delivered message becomes a loud notification when the sender overrides the recipient's |
| [#2772](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2772) | Font control in advanced theming - add Chat List specific sl | low/M | 1💬 0👍 |  | Add an independent font-size scale control for the chat list. |
| [#2493](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2493) | Honor the DnD started contacts to send notifications during  | low/M | — |  | Let notifications from chosen contacts break through Android Do-Not-Disturb. |
| [#1508](https://github.com/BlueBubblesApp/bluebubbles-app/issues/1508) | option to sync chats only up to a certain date | low/M | — |  | Limit initial sync to a chosen time window (last 5 days / 24h / 1 month, etc.). |
| [#2675](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2675) | Support for interactive messages | low/L | 1💬 0👍 |  | Let the app respond to Apple interactive iMessages (e.g. Screen Time approval balloons) without an iDevice. |
| [#2971](https://github.com/BlueBubblesApp/bluebubbles-app/issues/2971) | Automatic conversion of live photos both ways | low/L | — | partial | Auto-convert Live Photos when sending/receiving between devices. |

## What I checked and set aside (so you know it was looked at)

- **69 issues are Flutter-app bugs**, not features — most are Desktop/Windows/Linux or don't reproduce
  in our architecture (e.g. #3088 typing-indicator/tail grouping doesn't occur because Gator renders the
  typing bubble outside the list data).
- **13 requested features Gator RN already has** — verified in code — including notification-tap
  navigation + mark-read (#3073), invisible-ink reveal (#3044 / #2413), custom wallpaper (#1461), emoji
  tapbacks (#2829), pull-to-refresh (#2893). The verify pass caught 3 items the first pass wrongly
  flagged as missing.
- **41 are out of scope for the fork** — 25 na-fork (Firebase/OAuth/Tasker/UnifiedPush/desktop-keybinds),
  10 desktop-only, 6 server-side macOS-binary concerns.

## Caveats

- **Value/effort are the agents' estimates**, calibrated to the Gator codebase but not a substitute for
  your judgment — a first sort, not gospel.
- **"partial" means some of it exists in code** (per-issue evidence was captured during the run); the
  delta is usually a UI surface or settings toggle, not net-new plumbing.
- Engagement counts (💬 / 👍) are open-issue signals only; a 0/0 issue can still be a good idea.
