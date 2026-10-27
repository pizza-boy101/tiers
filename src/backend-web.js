// The backend for the web / home-screen version. Same `window.api` as the
// desktop app (src/backend.js), but data lives in the browser's storage and
// Google sign-in uses Firebase's popup.

import { GoogleAuthProvider, getAuth, signInWithPopup } from "firebase/auth";
import { connectFirestoreEmulator, doc, initializeFirestore, onSnapshot, runTransaction, serverTimestamp } from "firebase/firestore";
import { CloudSync } from "./cloud-sync.js";
import { initFirebase } from "./firebase.js";
import { Store, isValidDb } from "./store.js";
import { FREE_DAILY_LIMIT, PROVIDERS, createSuggester, freeUsesLeft, providerFor } from "./suggestions.js";

const DEFAULT_MODEL = "claude-opus-5-5";
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];
const PREFIX = "tiers:";

const io = {
  read: async (name) => localStorage.getItem(PREFIX + name),
  write: async (name, contents) => localStorage.setItem(PREFIX + name, contents),
};
const secrets = {
  get: (name) => localStorage.getItem(`${PREFIX}secret:${name}`),
  set: (name, value) => localStorage.setItem(`${PREFIX}secret:${name}`, value),
  delete: (name) => localStorage.removeItem(`${PREFIX}secret:${name}`),
};

// Offline support (see web/sw.js).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// Ask the browser not to clear our data when space runs low.
navigator.storage?.persist?.().catch(() => {});

const listeners = { state: new Set(), sync: new Set(), notice: new Set() };
// Notices raised during startup wait until the window is listening.
const pendingNotices = [];
const emit = (kind, payload) => {
  if (kind === "notice" && listeners.notice.size === 0) pendingNotices.push(payload);
  listeners[kind].forEach((fn) => fn(payload));
};

let settings = {};
const saveSettings = () => io.write("settings.json", JSON.stringify(settings));
const apiKey = () => secrets.get("anthropic-api-key") || "";

function publicSettings() {
  const key = apiKey();
  return {
    hasApiKey: Boolean(key),
    apiKeySource: key ? "app" : null,
    apiKeyHint: key ? `…${key.slice(-4)}` : null,
    model: settings.model || DEFAULT_MODEL,
    models: MODELS,
    provider: providerFor(settings, Boolean(key)),
    freeLeft: freeUsesLeft(settings),
    freeDailyLimit: FREE_DAILY_LIMIT,
    dataDir: "",
  };
}

const store = new Store(io);

// Served from this computer (development): use the local Firebase emulators.
const emulator = ["localhost", "127.0.0.1"].includes(location.hostname);
const firestore = { initializeFirestore, connectFirestoreEmulator, doc, runTransaction, serverTimestamp, onSnapshot };
const { app, auth, db } = initFirebase({ emulator, firestore, makeAuth: (a) => getAuth(a) });
const sync = new CloudSync({
  store, auth, db, firestore, client: "web",
  signIn: (a) => signInWithPopup(a, new GoogleAuthProvider()),
  onStatus: (status) => emit("sync", status),
  onNotice: (message) => emit("notice", message),
  // Which Google account this device's tasks belong to.
  linkedAccount: {
    get: () => settings.syncAccount || null,
    set: async (uid) => {
      if (uid) settings.syncAccount = uid;
      else delete settings.syncAccount;
      await saveSettings();
    },
  },
});

store.onChange((source) => {
  if (source === "remote") emit("state", store.view());
});

const ready = (async () => {
  const text = await io.read("settings.json");
  settings = text ? JSON.parse(text) : {};
  await store.load();
  await sync.init();
})();

const suggest = createSuggester({
  settings: () => settings,
  saveSettings,
  getApiKey: apiKey,
  getApp: () => app,
  isSignedIn: () => sync.status().signedIn,
  fetch: (...args) => fetch(...args),
  defaultModel: DEFAULT_MODEL,
});

// Pull changes from other devices whenever the app comes back to the front.
let lastWakeSync = 0;
const wake = () => {
  if (document.visibilityState === "visible" && Date.now() - lastWakeSync > 30_000) {
    lastWakeSync = Date.now();
    sync.syncSoon(0);
  }
};
document.addEventListener("visibilitychange", wake);
window.addEventListener("focus", wake);

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

window.api = {
  platform: "web",
  features: { revealData: false },

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
      if (key) secrets.set("anthropic-api-key", key);
      else secrets.delete("anthropic-api-key");
    }
    if (MODELS.includes(patch?.model)) settings.model = patch.model;
    if (PROVIDERS.includes(patch?.provider)) settings.provider = patch.provider;
    await saveSettings();
    sync.emit();
    return publicSettings();
  },

  suggest: (req) => suggest({ ...req, db: store.db }),

  confirm: async (message) => window.confirm(message),

  async exportData() {
    const stamp = new Date().toISOString().slice(0, 10);
    const blob = new Blob([JSON.stringify(store.db, null, 2)], { type: "application/json" });
    const link = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `tiers-backup-${stamp}.json`,
    });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    return true;
  },

  async importData() {
    const file = await pickFile();
    if (!file) return null;
    let db;
    try {
      db = JSON.parse(await file.text());
    } catch {
      db = null;
    }
    if (!isValidDb(db)) throw new Error("That file doesn't look like a Tiers backup.");
    const view = await store.replace(db);
    sync.syncSoon(0);
    return view;
  },

  revealData: async () => {},
  openUrl: async (url) => window.open(url, "_blank", "noopener"),

  sync: {
    login: () => sync.startLogin(),
    cancel: () => sync.cancelLogin(),
    resolveOtherAccount: (choice) => sync.resolveOtherAccount(choice),
    onNotice: (fn) => {
      listeners.notice.add(fn);
      pendingNotices.splice(0).forEach(fn);
    },
    signOut: () => sync.signOut(),
    now: () => sync.sync(),
    onStatus: (fn) => listeners.sync.add(fn),
  },
};
