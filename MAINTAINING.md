# Maintaining Tiers

Notes for whoever runs the project. For using the app, see the [README](README.md).

## Build and test

Needs [Node.js](https://nodejs.org) 20+ and [Rust](https://rustup.rs).

```bash
npm install
npm start            # run the app (as "Tiers Dev", separate from an installed copy)
npm test             # unit tests
npm run test:cloud   # sync tests against local Firebase emulators (needs Java)
npm run dist:mac     # build the .dmg
npm run build:web    # build the web app into dist-web/
```

## Releases and updates

- Every push to `main` that changes the app (`public/`, `src/`, `src-tauri/`, or the package files) builds a new version on GitHub Actions and publishes it as a release (`.github/workflows/release.yml`). Versions are `major.minor` from `src-tauri/tauri.conf.json` plus the workflow's run number. To start a new minor version, change `major.minor` there.
- Installed desktop apps check `latest.json` on the newest release at launch and every few hours. macOS installs in place; Windows installs when the app closes.
- Updates are signed. The private key is in the repo's Actions secrets (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`); the public key is in `tauri.conf.json`. Keep a copy of the private key safe: without it, installed apps can't accept new updates.
- The web app deploys to GitHub Pages on every push to `main` (`.github/workflows/pages.yml`).

## Firebase (sign-in and sync)

The app uses the Firebase project in `src/firebase.js`. In the [Firebase console](https://console.firebase.google.com):

1. **Authentication → Sign-in method:** enable **Google**.
2. **Authentication → Settings → Authorized domains:** include `pizza-boy101.github.io`.
3. **Firestore Database → Rules:** paste [`firestore.rules`](firestore.rules) and click **Publish**.
4. If you restrict the web API key in Google Cloud, allow: Identity Toolkit API, Token Service API, Cloud Firestore API, and Firebase Installations API.

Each account's tasks are one Firestore document, `users/{uid}`. Desktop sign-in opens the website's `connect.html` in the browser, which hands the Google sign-in back to the app on `127.0.0.1`.

## Suggestion server (Cloudflare Worker)

Free Gemini suggestions come from `worker/`, deployed to `https://tiers-ai.tiers-ai.workers.dev` (the app's copy of the address is in `src/ai-config.js`). It accepts only signed-in users of the Firebase project, limits each person to 25 a day (counted in Cloudflare KV), and calls Gemini with a key stored as a Worker secret. It isn't redeployed on push.

```bash
cd worker
npm install
npm test                                   # Worker tests
npx wrangler login                         # once
npx wrangler secret put GEMINI_API_KEY     # type the name exactly; paste the key at the prompt
npm run deploy                             # after changing the Worker
```

`POST /selftest` with the header `x-admin-token` (the `ADMIN_TOKEN` secret) checks the Gemini key without signing in.
