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

## Files

- `index.html` — app shell
- `styles.css` — styling
- `db.js` — IndexedDB wrapper
- `app.js` — app logic (capture, recording, tasks, export/import, reminders)
- `sw.js` — service worker (offline caching, periodic sync, notification click handling)
- `manifest.json` — PWA manifest
- `icons/` — app icons
