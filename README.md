# Tiers

A desktop todo app for Mac and Windows, inspired by Todomate.

- Make your own tiers (name, color, and rank them by importance)
- Plan days on a calendar, keep everything else in a backlog
- Hit **Suggest from backlog** and Claude picks what to pull onto the day (needs an Anthropic API key)
- Sign in with Google to sync between your computers and phone

Your data is saved locally first, so the app works offline. Sync is optional.

## Install

Grab the installer for your system from the [Releases](../../releases) page:

- **Mac:** `Tiers_x.x.x_universal.dmg` (works on Apple Silicon and Intel)
- **Windows:** `Tiers_x.x.x_x64-setup.exe`

The builds aren't code-signed, so the first launch needs one extra click:

- **Mac:** right-click the app, choose **Open**, then **Open** again.
- **Windows:** on the SmartScreen warning, click **More info**, then **Run anyway**.

### Updates

The desktop app updates itself. It checks GitHub at launch and every few hours, downloads new versions in the background, and checks they're signed by this project before installing.

- **Mac:** installs right away; you get the new version the next time you open the app (or click **Restart to update**).
- **Windows:** installs when you close the app (or click **Restart to update**).

Settings shows your version and has a **Check for updates** button.

## iPhone (and any phone)

Tiers also runs as a web app you can add to your home screen: **https://pizza-boy101.github.io/tiers/**

1. Open that link in **Safari** on your iPhone.
2. Tap the **Share** button, then **Add to Home Screen**.

It opens full screen like a normal app and works offline. On a phone the calendar shows one week at a time (tap **Show month** for the full month), and you can swipe left or right on the day to change days. To sync with your computers, see [Sync](#sync).

## Suggestions

Open Settings (gear icon), paste an Anthropic API key, and save. You can get a key at [console.anthropic.com](https://console.anthropic.com). The key is stored in your system keychain and is only sent to the Anthropic API.

## Sync

Click **Sign in with Google** in Settings on each device (desktop and phone) with the same Google account, and your tasks stay in sync. Everything still works offline; changes sync when you're back online.

- On the phone/web version, sign-in opens a Google window.
- On the desktop app, sign-in opens your browser (Google doesn't allow signing in inside app windows); sign in there and come back to the app.

Your data is stored in Firebase (Firestore) under your Google account, and only your account can read it. Your API key stays on each device and is never synced. On the web version, it's kept in the browser's storage on that device.

### Firebase setup (for whoever runs the project)

The app uses the Firebase project in `src/firebase.js`. In the [Firebase console](https://console.firebase.google.com):

1. **Authentication → Sign-in method:** enable **Google**.
2. **Authentication → Settings → Authorized domains:** include `pizza-boy101.github.io`.
3. **Firestore Database → Rules:** paste the contents of [`firestore.rules`](firestore.rules) and click **Publish**.

`npm run test:cloud` runs the sync tests against local Firebase emulators (needs Java).

## Build from source

Needs [Node.js](https://nodejs.org) 20+ and [Rust](https://rustup.rs).

```bash
npm install
npm start            # run the app
npm test             # run the tests
npm run test:cloud   # sync tests against the Firebase emulators
npm run dist:mac     # build the .dmg
npm run build:web    # build the web app into dist-web/
```

The web app deploys to GitHub Pages on every push to `main` (`.github/workflows/pages.yml`).

### Releases

Every push to `main` that changes the app (`public/`, `src/`, `src-tauri/`, or the package files) builds a new version on GitHub Actions and publishes it as a release (`.github/workflows/release.yml`). Versions are `major.minor` from `src-tauri/tauri.conf.json` plus the workflow's run number, so each release is newer than the last. To start a new minor version, change `major.minor` there.

Updates are signed. The signing key is stored in the repo's Actions secrets (`TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), and the matching public key is in `tauri.conf.json`. Keep a copy of the private key safe: without it, installed apps can't accept new updates.

## Shortcuts

- `←` / `→` previous / next day
- `T` jump to today
- `N` open the backlog

## Where your data lives

- Mac: `~/Library/Application Support/com.nick.tiers`
- Windows: `%APPDATA%\com.nick.tiers`

Settings also has export and import for JSON backups.
