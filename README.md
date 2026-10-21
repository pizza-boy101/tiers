# Tiers

A desktop todo app for Mac and Windows, inspired by Todomate.

- Make your own tiers (name, color, and rank them by importance)
- Plan days on a calendar, keep everything else in a backlog
- Drag tasks between days, tiers, and the backlog
- Hit **Suggest** and Claude picks what to pull from your backlog for the day (needs an Anthropic API key)
- Sign in with GitHub to sync between computers

Your data is saved locally first, so the app works offline. Sync is optional.

## Install

Grab the installer for your system from the [Releases](../../releases) page:

- **Mac:** `Tiers-x.x.x-arm64.dmg` (Apple Silicon) or `Tiers-x.x.x.dmg` (Intel)
- **Windows:** `Tiers-Setup-x.x.x.exe`

The builds aren't code-signed, so the first launch needs one extra click:

- **Mac:** right-click the app, choose **Open**, then **Open** again.
- **Windows:** on the SmartScreen warning, click **More info**, then **Run anyway**.

## Suggestions

Open Settings (gear icon), paste an Anthropic API key, and save. You can get a key at [console.anthropic.com](https://console.anthropic.com). The key is encrypted with your system keychain and never leaves your computer except to call the API.

## Sync

Sync stores your tasks in a private Gist on your GitHub account. To turn it on, you need a GitHub OAuth app (one time, free):

1. Go to [GitHub → Settings → Developer settings → OAuth Apps](https://github.com/settings/developers) and click **New OAuth App**.
2. Name it `Tiers`. For both URLs, put this repo's URL (the callback isn't used).
3. Click **Register application**, then tick **Enable Device Flow** and save.
4. Copy the **Client ID** into `config.js` and rebuild, or paste it into the app's Settings.

Then click **Sign in with GitHub** in Settings on each computer.

## Build from source

Requires Node.js 20 or newer.

```bash
npm install
npm start            # run the app
npm run dist:mac     # build .dmg files into dist/
npm run dist:win     # build the Windows installer into dist/
```

## Shortcuts

- `←` / `→` previous / next day
- `T` jump to today
- `N` add to backlog

## Where your data lives

- Mac: `~/Library/Application Support/Tiers`
- Windows: `%APPDATA%\Tiers`

Settings also has export and import for JSON backups.
