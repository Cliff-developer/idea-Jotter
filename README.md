# Idea Jotter

A local-first PWA for capturing ideas and voice memos, with the option to turn any entry into a task with a priority and deadline.

## Deploying to GitHub Pages

1. Create a new repo (e.g. `idea-jotter`) and push these files to it.
2. In the repo settings, go to **Pages** → set source to the `main` branch, root folder.
3. Visit `https://<your-username>.github.io/idea-jotter/` — on Android, open it in Chrome and use **"Add to Home screen"** to install it as an app.

No build step, no server, no dependencies to install — it's plain HTML/CSS/JS plus one Google Fonts link.

## How data works

- Everything (text, task fields, voice memo audio) is stored in **IndexedDB, on your device only**. Nothing is sent anywhere.
- **Export** (menu → "Export all data") downloads a single `.json` file with every entry, audio included as embedded base64.
- **Restore** (menu → "Restore from file") reads that file back in. You'll be asked whether to merge it with what's currently on the device or replace everything.
- Clearing your browser's site data for this app will delete everything — export regularly if you care about the entries.

## Notifications — what to expect

Reminders fire 1 hour before, 15 minutes before, and at the deadline for any task that has one set, using local (not push) notifications.

Being honest about the constraint: **a static, backend-free app cannot guarantee a notification fires while the app is fully closed for a long stretch.** That would need a push server. What this app does instead:

- While the app is open (or recently backgrounded), reminders fire reliably via scheduled timers.
- On Android/Chrome, once installed to your home screen, the service worker can also use **Periodic Background Sync** to wake up every ~15+ minutes and check for due reminders — this is opportunistic and Chrome/Android can throttle or skip it, but it meaningfully improves coverage without a server.
- Every time you open the app, it immediately catches up on any reminder that should have fired in the last 24 hours, so you won't silently miss one — you'll just see it a bit late if the phone kept the browser fully asleep.

In practice: keep the app installed (not just a bookmark) and open it at least occasionally, and reminders will be dependable for same-day deadlines.

## Syncing between PC and phone (GitHub Gist)

The app stays local-first, but you can bridge two devices using a **private GitHub Gist** as the shared file:

1. Go to `github.com/settings/tokens` → generate a token scoped to **only "gist"** (don't use a broader token). Classic tokens work fine; a fine-grained token needs the "Gists" permission.
2. On each device, open the app menu (⋯) → paste the token into "Sync across devices" → **Save token**. The first save creates a private gist and does an initial sync.
3. On the second device, paste the *same* token and hit **Sync now** — it looks up your existing gists for one already holding Idea Jotter data and attaches to it automatically, rather than creating a second one.
4. From then on, the app syncs automatically a few seconds after every change, and again whenever you reopen or foreground the app.

**If both devices ever end up pointed at different gists** (shows as "synced" on both but entries don't appear on the other side): open the menu → under "Gist ID (advanced)" you'll see the ID this device is using. Copy the ID from whichever device has the data you want to keep, paste it into the other device's Gist ID field, and hit **Use this ID**.

How conflicts are handled: each entry carries its own "last updated" time. If you edit the same entry on both devices before syncing, whichever edit happened later wins for that entry as a whole (not merged field-by-field). Deletions sync too, using a small internal tombstone so a deleted item doesn't reappear from the other device's older copy.

**Things to know:**
- The token is stored only in that device's browser (`localStorage`) — it's never sent anywhere except directly to `api.github.com`. Treat it like a password; if a device is compromised, revoke the token on GitHub.
- The gist is created as **secret**, not public — but "secret" on GitHub means unlisted, not access-controlled. Anyone with the exact gist URL could view it. Don't share the link.
- Voice memos are included in the sync payload as embedded audio, so a lot of long recordings will make each sync slower and the gist larger. Fine for normal use; not ideal for hours of audio.
- This is separate from the manual "Export all data" / "Restore from file" feature, which still works fully offline and doesn't need a token.

## Updating the app later

This is an installed PWA, so it caches its own files aggressively for offline use. Whenever you (or I) push new code, the cache's version name in `sw.js` — the `CACHE` constant at the top — needs to change (e.g. `idea-jotter-v2` → `idea-jotter-v3`). Without that, an already-installed device can keep running the old cached JavaScript indefinitely even after the files on GitHub have changed, and it'll look like nothing happened.

After pushing an update with a bumped cache version, give it one full close-and-reopen (or a hard refresh) on each device to pick it up.

## Files

- `index.html` — app shell
- `styles.css` — styling
- `db.js` — IndexedDB wrapper
- `app.js` — app logic (capture, recording, tasks, export/import, reminders)
- `sw.js` — service worker (offline caching, periodic sync, notification click handling)
- `manifest.json` — PWA manifest
- `icons/` — app icons
