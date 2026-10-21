// The backend for the web / home-screen version. Same `window.api` as the
// desktop app (src/backend.js), but data lives in the browser's storage and
// sync signs in with a pasted GitHub token.

import { Store, isValidDb } from "./store.js";
import { suggestFromBacklog } from "./suggest.js";
import { GitHubSync } from "./sync.js";

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

const listeners = { state: new Set(), sync: new Set() };
const emit = (kind, payload) => listeners[kind].forEach((fn) => fn(payload));

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
    dataDir: "",
    builtInClientId: true,
    githubClientId: "",
  };
}

const store = new Store(io);
const sync = new GitHubSync({
  store,
  fetch: (...args) => fetch(...args),
  getClientId: () => "",
  loadAuth: async () => {
    const token = settings.github && secrets.get("github-token");
    return token ? { ...settings.github, token } : null;
  },
  saveAuth: async (auth) => {
    if (auth) {
      secrets.set("github-token", auth.token);
      settings.github = { login: auth.login, gistId: auth.gistId };
    } else {
      secrets.delete("github-token");
      delete settings.github;
    }
    await saveSettings();
  },
  onStatus: (status) => emit("sync", status),
  openUrl: (url) => window.open(url, "_blank", "noopener"),
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
  features: { deviceLogin: false, tokenLogin: true, revealData: false },

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
    await saveSettings();
    sync.emit();
    return publicSettings();
  },

  async suggest(req) {
    const key = apiKey();
    if (!key) return { error: "Add an Anthropic API key in Settings first." };
    try {
      return await suggestFromBacklog({
        apiKey: key,
        fetch: (...args) => fetch(...args),
        model: settings.model || DEFAULT_MODEL,
        db: store.db,
        date: req?.date,
        note: typeof req?.note === "string" ? req.note.slice(0, 1000) : "",
        count: Math.min(Math.max(Number(req?.count) || 3, 1), 8),
      });
    } catch (err) {
      console.error("Suggest failed:", err);
      return { error: err.userMessage || err.message || "Suggestion request failed" };
    }
  },

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
    loginWithToken: (token) => sync.signInWithToken(token),
    cancel: () => sync.cancelLogin(),
    signOut: () => sync.signOut(),
    now: () => sync.sync(),
    onStatus: (fn) => listeners.sync.add(fn),
  },
};
