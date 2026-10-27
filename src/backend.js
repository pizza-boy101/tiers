// The app's backend, running inside the window. It exposes `window.api` for
// public/app.js and talks to the Rust side (files, keychain, dialogs) through
// Tauri commands. Network requests go through Tauri's HTTP client.

import { invoke } from "@tauri-apps/api/core";
import { fetch } from "@tauri-apps/plugin-http";
import { GoogleAuthProvider, indexedDBLocalPersistence, initializeAuth, signInWithCredential } from "firebase/auth";
import { connectFirestoreEmulator, doc, initializeFirestore, runTransaction, serverTimestamp } from "firebase/firestore/lite";
import { CloudSync } from "./cloud-sync.js";
import { initFirebase } from "./firebase.js";
import { Store, isValidDb } from "./store.js";
import { suggestFromBacklog } from "./suggest.js";
import { startUpdater, updates } from "./updater.js";

const DEFAULT_MODEL = "claude-opus-5-5";
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const API_KEY_SECRET = "anthropic-api-key";

const io = {
  read: (name) => invoke("read_data", { name }),
  write: (name, contents) => invoke("write_data", { name, contents }),
};
const secrets = {
  get: (name) => invoke("get_secret", { name }).catch(() => null),
  set: (name, value) => invoke("set_secret", { name, value }),
  delete: (name) => invoke("delete_secret", { name }),
};

const listeners = { state: new Set(), sync: new Set() };
const emit = (kind, payload) => listeners[kind].forEach((fn) => fn(payload));

let settings = {};
let apiKey = "";
let dataDir = "";

const saveSettings = () => io.write("settings.json", JSON.stringify(settings, null, 2));

function publicSettings() {
  return {
    hasApiKey: Boolean(apiKey),
    apiKeySource: apiKey ? "app" : null,
    apiKeyHint: apiKey ? `…${apiKey.slice(-4)}` : null,
    model: settings.model || DEFAULT_MODEL,
    models: MODELS,
    dataDir,
  };
}

const store = new Store(io);
let sync;

// Google won't sign in inside an app window, so the Rust side opens the
// website's connect page in the browser and returns the Google ID token.
async function googleSignIn(auth) {
  const idToken = await invoke("google_sign_in").catch((err) => {
    throw err === "cancelled" ? Object.assign(new Error("cancelled"), { code: "cancelled" }) : new Error(String(err));
  });
  await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
}

store.onChange((source) => {
  if (source === "remote") emit("state", store.view());
});

const ready = (async () => {
  const text = await io.read("settings.json");
  settings = text ? JSON.parse(text) : {};
  apiKey = (await secrets.get(API_KEY_SECRET)) || "";
  dataDir = await invoke("data_dir_path");
  await store.load();
  // The request-only Firestore client: no live connection to stall in WebKit.
  const firestore = { initializeFirestore, connectFirestoreEmulator, doc, runTransaction, serverTimestamp };
  const { auth, db } = initFirebase({
    emulator: await invoke("use_firebase_emulator"),
    firestore,
    makeAuth: (app) => initializeAuth(app, { persistence: indexedDBLocalPersistence }),
  });
  sync = new CloudSync({
    store, auth, db, firestore, client: "desktop",
    signIn: googleSignIn,
    cancelSignIn: () => invoke("cancel_google_sign_in"),
    onStatus: (status) => emit("sync", status),
  });
  await sync.init();
})();

startUpdater().catch((err) => console.error("Updater failed to start:", err));

// Pull changes from other devices when you come back to the app.
let lastFocusSync = 0;
window.addEventListener("focus", () => {
  if (Date.now() - lastFocusSync > 30_000) {
    lastFocusSync = Date.now();
    sync?.syncSoon(0);
  }
});

const errorText = (err) => (typeof err === "string" ? err : err?.message || String(err));

window.api = {
  features: { revealData: true },
  platform: navigator.userAgent.includes("Mac") ? "darwin" : navigator.userAgent.includes("Windows") ? "win32" : "linux",

  async getState() {
    await ready;
    return { ...store.view(), settings: publicSettings(), sync: sync.status() };
  },

  async saveState(data) {
    const view = await store.applyEdit(data);
    sync.syncSoon();
    return view;
  },

  onStateChanged: (fn) => listeners.state.add(fn),

  async saveSettings(patch) {
    if (typeof patch?.apiKey === "string") {
      const key = patch.apiKey.trim();
      if (key) await secrets.set(API_KEY_SECRET, key);
      else await secrets.delete(API_KEY_SECRET);
      apiKey = key;
    }
    if (MODELS.includes(patch?.model)) settings.model = patch.model;
    await saveSettings();
    sync.emit();
    return publicSettings();
  },

  async suggest(req) {
    if (!apiKey) return { error: "Add an Anthropic API key in Settings first." };
    try {
      return await suggestFromBacklog({
        apiKey,
        fetch,
        model: settings.model || DEFAULT_MODEL,
        db: store.db,
        date: req?.date,
        note: typeof req?.note === "string" ? req.note.slice(0, 1000) : "",
        count: Math.min(Math.max(Number(req?.count) || 3, 1), 8),
      });
    } catch (err) {
      console.error("Suggest failed:", err);
      return { error: err.userMessage || errorText(err) || "Suggestion request failed" };
    }
  },

  confirm: (message) => invoke("confirm", { message }),

  async exportData() {
    const stamp = new Date().toISOString().slice(0, 10);
    return invoke("export_backup", { contents: JSON.stringify(store.db, null, 2), fileName: `tiers-backup-${stamp}.json` });
  },

  async importData() {
    const text = await invoke("import_backup");
    if (!text) return null;
    let db;
    try {
      db = JSON.parse(text);
    } catch {
      db = null;
    }
    if (!isValidDb(db)) throw new Error("That file doesn't look like a Tiers backup.");
    const view = await store.replace(db);
    sync.syncSoon(0);
    return view;
  },

  revealData: () => invoke("open_data_dir"),
  updates,
  openUrl: (url) => invoke("open_url", { url }),

  sync: {
    login: () => sync.startLogin(),
    cancel: () => sync.cancelLogin(),
    signOut: () => sync.signOut(),
    now: () => sync.sync(),
    onStatus: (fn) => listeners.sync.add(fn),
  },
};
