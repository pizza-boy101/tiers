import { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GITHUB_CLIENT_ID } from "./config.js";
import { Store, isValidDb } from "./store.js";
import { suggestFromBacklog } from "./suggest.js";
import { GitHubSync } from "./sync.js";

const here = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_MODEL = "claude-opus-5-5";
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"];

const dataDir = () => app.getPath("userData");
const settingsFile = () => path.join(dataDir(), "settings.json");

let store;
let sync;
let settings = {};

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback();
    throw err;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2));
  await fs.rename(tmp, file);
}

const saveSettings = () => writeJson(settingsFile(), settings);

// Secrets (API key, GitHub token) are encrypted with the OS keychain:
// Keychain on macOS, DPAPI on Windows.
function encrypt(value) {
  if (!safeStorage.isEncryptionAvailable()) return { plain: value };
  return { enc: safeStorage.encryptString(value).toString("base64") };
}
function decrypt(stored) {
  if (!stored) return "";
  if (stored.plain) return stored.plain;
  try {
    return safeStorage.decryptString(Buffer.from(stored.enc, "base64"));
  } catch {
    return "";
  }
}

// Older versions stored the key as `apiKeyEncrypted`.
const readApiKey = () =>
  decrypt(settings.apiKey || (settings.apiKeyEncrypted && { enc: settings.apiKeyEncrypted })) ||
  process.env.ANTHROPIC_API_KEY || "";

const githubClientId = () => settings.githubClientId || GITHUB_CLIENT_ID || process.env.TIERS_GITHUB_CLIENT_ID || "";

function publicSettings() {
  const key = readApiKey();
  const fromApp = Boolean(settings.apiKey || settings.apiKeyEncrypted);
  return {
    hasApiKey: Boolean(key),
    apiKeySource: fromApp ? "app" : key ? "env" : null,
    apiKeyHint: fromApp && key ? `…${key.slice(-4)}` : null,
    model: settings.model || DEFAULT_MODEL,
    models: MODELS,
    dataDir: dataDir(),
    builtInClientId: Boolean(GITHUB_CLIENT_ID),
    githubClientId: settings.githubClientId || "",
  };
}

const broadcast = (channel, payload) => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload);
};

function registerIpc() {
  ipcMain.handle("state:get", () => ({ ...store.view(), settings: publicSettings(), sync: sync.status() }));

  ipcMain.handle("state:save", async (_e, data) => {
    const view = await store.applyEdit(data);
    sync.syncSoon();
    return view;
  });

  ipcMain.handle("settings:save", async (_e, patch) => {
    if (typeof patch?.apiKey === "string") {
      delete settings.apiKeyEncrypted;
      const key = patch.apiKey.trim();
      if (key) settings.apiKey = encrypt(key);
      else delete settings.apiKey;
    }
    if (MODELS.includes(patch?.model)) settings.model = patch.model;
    if (typeof patch?.githubClientId === "string") settings.githubClientId = patch.githubClientId.trim();
    await saveSettings();
    sync.emit();
    return publicSettings();
  });

  ipcMain.handle("suggest", async (_e, req) => {
    const apiKey = readApiKey();
    if (!apiKey) return { error: "Add an Anthropic API key in Settings first." };
    try {
      return await suggestFromBacklog({
        apiKey,
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
  });

  ipcMain.handle("sync:login", () => sync.startLogin());
  ipcMain.handle("sync:cancel", () => sync.cancelLogin());
  ipcMain.handle("sync:signout", () => sync.signOut());
  ipcMain.handle("sync:now", () => sync.sync());

  ipcMain.handle("data:export", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const stamp = new Date().toISOString().slice(0, 10);
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath("documents"), `tiers-backup-${stamp}.json`),
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePath) return false;
    await writeJson(filePath, store.db);
    return true;
  });

  ipcMain.handle("data:import", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (canceled || !filePaths[0]) return null;
    const db = JSON.parse(await fs.readFile(filePaths[0], "utf8"));
    if (!isValidDb(db)) throw new Error("That file doesn't look like a Tiers backup.");
    const view = await store.replace(db);
    sync.syncSoon(0);
    return view;
  });

  ipcMain.handle("data:reveal", () => shell.openPath(dataDir()));
}

function createWindow() {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: "Tiers",
    show: false,
    backgroundColor: "#f7f7f5",
    titleBarStyle: isMac ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e) => e.preventDefault());

  // Pull changes from other devices when you come back to the app.
  let lastFocusSync = 0;
  win.on("focus", () => {
    if (Date.now() - lastFocusSync > 30_000) {
      lastFocusSync = Date.now();
      sync.syncSoon(0);
    }
  });

  win.loadFile(path.join(here, "public", "index.html"));
}

async function start() {
  settings = await readJson(settingsFile(), () => ({}));
  store = new Store(path.join(dataDir(), "db.json"));
  await store.load();
  store.onChange((source) => {
    if (source === "remote") broadcast("state:changed", store.view());
  });

  sync = new GitHubSync({
    store,
    getClientId: githubClientId,
    loadAuth: async () => {
      const token = decrypt(settings.github?.token);
      return token ? { ...settings.github, token } : null;
    },
    saveAuth: async (auth) => {
      if (auth) settings.github = { login: auth.login, gistId: auth.gistId, token: encrypt(auth.token) };
      else delete settings.github;
      await saveSettings();
    },
    onStatus: (status) => broadcast("sync:status", status),
    openUrl: (url) => url.startsWith("https://") && shell.openExternal(url),
  });

  registerIpc();
  createWindow();
  await sync.init();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(start);
  app.on("activate", () => {
    if (app.isReady() && store && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
