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

## Suggestions

Open Settings (gear icon), paste an Anthropic API key, and save. You can get a key at [console.anthropic.com](https://console.anthropic.com). The key is stored in your system keychain and is only sent to the Anthropic API.

## Sync

Sync stores your tasks in a private Gist on your GitHub account. To turn it on, you need a GitHub OAuth app (one time, free):

1. Go to [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) and click **New OAuth App**.
2. Name it `Tiers`. For both URLs, put this repo's URL (the callback isn't used).
3. Click **Register application**, then tick **Enable Device Flow** and save.
4. Copy the **Client ID** into `src/config.js` and rebuild, or paste it into the app's Settings.

Then click **Sign in with GitHub** in Settings on each computer.

## Build from source

Needs [Node.js](https://nodejs.org) 20+ and [Rust](https://rustup.rs).

```bash
npm install
npm start            # run the app
npm test             # run the tests
npm run dist:mac     # build the .dmg
```

The Windows installer is built by GitHub Actions (`.github/workflows/build.yml`). Run it from the Actions tab, or push a `v*` tag, and download the installers from the run.

## Shortcuts

- `←` / `→` previous / next day
- `T` jump to today
- `N` open the backlog

## Where your data lives

- Mac: `~/Library/Application Support/com.nick.tiers`
- Windows: `%APPDATA%\com.nick.tiers`

Settings also has export and import for JSON backups.
