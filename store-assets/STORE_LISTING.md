# Gator — Google Play store-listing kit

Everything here fixes the two things you noticed in the Play Store:
1. **It shows the package name (`com.bluegreengatorapps.messages`) instead of "Gator".**
2. **No icon / picture on the listing.**

Both are **Play Console** settings, not app-code — your build is already correct
(`app.config.ts` → `name: 'Gator'`, a 1024² icon, and a full adaptive icon). What was
never filled in is the **Main store listing**, so Play falls back to the package name and a
blank graphic. Fill it in once and both are fixed.

---

## Ready-to-upload graphics (in this folder)

| File | Size | Where it goes in Play Console |
|------|------|-------------------------------|
| `play-icon-512.png` | 512×512 | Main store listing → **App icon** |
| `play-feature-1024x500.png` | 1024×500 | Main store listing → **Feature graphic** |

**Still needed: 2+ phone screenshots** (Play requires at least two). Easiest: open Gator on
your phone, screenshot the conversation list + an open chat (volume-down + power), then upload
those in Main store listing → **Phone screenshots**. (No fixed size — 1080×1920-ish is ideal.)

---

## Text to paste

- **App name** (≤30 chars): `Gator`
- **Short description** (≤80 chars):
  `A private messenger for Android, powered by your own Mac server.`
- **Full description** (≤4000 chars, draft — edit freely):
  ```
  Gator is a fast, private messaging client for Android that connects to your own
  self-hosted Gator server running on a Mac. Your messages stay on your hardware — there's
  no third-party cloud in the middle.

  Features:
  • Send and receive texts, photos, videos, and voice messages
  • Reactions and replies
  • Group chats with names and photos
  • Rich notifications with quick actions
  • Search across your conversations
  • Light and dark themes

  Gator requires a companion Gator server on a Mac. It is not affiliated with Apple.
  ```
  > ⚠️ Trademark caution: avoid using "iMessage" in the public listing text/screenshots —
  > Google Play has rejected apps for using Apple trademarks. "connect to your Mac" is safe.

---

## Steps (Google Play Console, ~5 min)

1. Go to **play.google.com/console** → sign in as **bluegreengatorapps@gmail.com** → open the
   **Gator** app (it's currently listed under its package name).
2. Left menu → **Grow users → Store presence → Main store listing**.
3. Fill in **App name** = `Gator`, **Short description**, **Full description** (paste from above).
4. Under **Graphics**:
   - **App icon** → upload `store-assets/play-icon-512.png`
   - **Feature graphic** → upload `store-assets/play-feature-1024x500.png`
   - **Phone screenshots** → upload your 2+ phone screenshots
5. Click **Save** (top/bottom of the page). The public title + icon update within minutes.

That's it — the store will now show **Gator** with your logo instead of the package name.

---

## Alternative: automate it via the Play Developer API

Instead of the web console, the same fields can be pushed with the `play-service-account.json`
key (the eas-submit robot) via the `androidpublisher` `edits` API:
`edits.insert` → `edits.listings.update` (name + descriptions) + `edits.images.upload`
(icon/feature/screenshots) → `edits.commit`. It's reproducible but finicky (a commit is
rejected until every required field is present, and content-policy checks apply), so the web
console above is the recommended path for a one-time setup. Ask if you'd rather I script it.
