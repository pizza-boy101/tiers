# Tiers

A desktop todo app for Mac and Windows, inspired by Todomate.

- Make your own tiers (name, color, and rank them by importance)
- Plan days on a calendar, keep everything else in a backlog
- Hit **Suggest from backlog** and Claude picks what to pull onto the day (needs an Anthropic API key)
- Sign in with GitHub to sync between computers

Your data is saved locally first, so the app works offline. Sync is optional.

## Install

Grab the installer for your system from the [Releases](../../releases) page:

- **Mac:** `Tiers_x.x.x_universal.dmg` (works on Apple Silicon and Intel)
- **Windows:** `Tiers_x.x.x_x64-setup.exe`

The builds aren't code-signed, so the first launch needs one extra click:

- **Mac:** right-click the app, choose **Open**, then **Open** again.
- **Windows:** on the SmartScreen warning, click **More info**, then **Run anyway**.

## iPhone (and any phone)

Tiers also runs as a web app you can add to your home screen: **https://pizza-boy101.github.io/tiers/**

1. Open that link in **Safari** on your iPhone.
2. Tap the **Share** button, then **Add to Home Screen**.

It opens full screen like a normal app and works offline. On a phone the calendar shows one week at a time (tap **Show month** for the full month), and you can swipe left or right on the day to change days. To sync with your computers, see [Sync](#sync).

## Suggestions

Open Settings (gear icon), paste an Anthropic API key, and save. You can get a key at [console.anthropic.com](https://console.anthropic.com). The key is stored in your system keychain and is only sent to the Anthropic API.

## Sync

Sync stores your tasks in a private Gist on your GitHub account. Every device you connect uses the same Gist.

**Quickest way (works everywhere, including the phone):** in Settings, tap **Create a token**. GitHub opens with the right box (**gist**) already ticked; create the token, copy it, and paste it into the app. Do the same on each device (you can reuse the token).

**Sign in with GitHub (desktop only, optional):** needs a GitHub OAuth app (one time, free):

1. Go to [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) and click **New OAuth App**.
2. Name it `Tiers`. For both URLs, put this repo's URL (the callback isn't used).
3. Click **Register application**, then tick **Enable Device Flow** and save.
4. Copy the **Client ID** into `src/config.js` and rebuild, or paste it into the app's Settings.

Then click **Sign in with GitHub** in Settings on each computer.

On the web version, your API key and GitHub token are kept in the browser's storage on that device.

## Build from source

Needs [Node.js](https://nodejs.org) 20+ and [Rust](https://rustup.rs).

```bash
npm install
npm start            # run the app
npm test             # run the tests
npm run dist:mac     # build the .dmg
npm run build:web    # build the web app into dist-web/
```

The web app deploys to GitHub Pages on every push to `main` (`.github/workflows/pages.yml`).

The Windows installer is built by GitHub Actions (`.github/workflows/build.yml`). Run it from the Actions tab, or push a `v*` tag, and download the installers from the run.

## Shortcuts

- `←` / `→` previous / next day
- `T` jump to today
- `N` open the backlog

## Where your data lives

- Mac: `~/Library/Application Support/com.nick.tiers`
- Windows: `%APPDATA%\com.nick.tiers`

Settings also has export and import for JSON backups.
