// Automatic updates from GitHub releases (desktop only).
//
// The app checks latest.json on the newest release at launch, every few
// hours, and when you come back to it (at most hourly). A newer version is
// downloaded in the background and its signature checked against the public
// key in tauri.conf.json.
//
// Found right after launch: installed and restarted automatically, before
// you've started working. Found later, while the app is open: the top bar
// shows an indicator and you choose when to update.
//   macOS:   installed right away; the new version runs from the next launch.
//   Windows: the installer needs the app closed, so it runs when the window
//            is closed (or when you click Restart).

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

const FIRST_CHECK_DELAY = 1_000;
const AUTO_APPLY_WINDOW = 30_000; // after launch
const SAVE_GRACE = 800; // lets pending edits save before restarting
const CHECK_EVERY = 4 * 60 * 60_000;
const FOCUS_CHECK_AFTER = 60 * 60_000;
const installsInPlace = navigator.userAgent.includes("Mac");

// state: disabled | idle | checking | downloading | ready | installed | applying | error
// available / notes: the new version and its release note, once found.
let status = { state: "idle", current: "", available: null, notes: "", error: null };
let pending = null; // downloaded Update not yet installed (Windows)
let launchedAt = Date.now();
const listeners = new Set();

function set(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

// manual: from "Check for updates"; background failures (e.g. offline) stay quiet.
async function checkNow({ manual = false } = {}) {
  if (["disabled", "checking", "downloading", "ready", "installed", "applying"].includes(status.state)) return status;
  set({ state: "checking", error: null });
  try {
    const update = await check();
    if (!update) {
      set({ state: "idle", checkedAt: Date.now() });
      return status;
    }
    set({ state: "downloading", available: update.version, notes: (update.body || "").trim() });
    await update.download();
    if (!manual && Date.now() - launchedAt < AUTO_APPLY_WINDOW) {
      // Just opened: update now rather than asking.
      set({ state: "applying" });
      await new Promise((r) => setTimeout(r, SAVE_GRACE));
      await update.install(); // on Windows this closes the app and runs the installer
      await relaunch();
      return status;
    }
    if (installsInPlace) {
      await update.install();
      set({ state: "installed", checkedAt: Date.now() });
    } else {
      pending = update;
      set({ state: "ready", checkedAt: Date.now() });
    }
  } catch (err) {
    console.error("Update check failed:", err);
    const error = typeof err === "string" ? err : err?.message || String(err);
    const midUpdate = ["downloading", "applying"].includes(status.state);
    set(manual || midUpdate ? { state: "error", error } : { state: "idle", error: null });
  }
  return status;
}

async function restart() {
  if (pending) {
    await pending.install(); // on Windows this closes the app and runs the installer
    pending = null;
  }
  await relaunch();
}

export async function startUpdater() {
  launchedAt = Date.now();
  status.current = await getVersion().catch(() => "");
  if (await invoke("is_debug_build").catch(() => false)) {
    set({ state: "disabled" });
    return;
  }
  setTimeout(checkNow, FIRST_CHECK_DELAY);
  setInterval(checkNow, CHECK_EVERY);
  window.addEventListener("focus", () => {
    if (Date.now() - (status.checkedAt || 0) > FOCUS_CHECK_AFTER) checkNow();
  });

  // Windows: a downloaded update installs when the window is closed.
  await getCurrentWindow().onCloseRequested(async (event) => {
    if (!pending) return;
    event.preventDefault();
    try {
      await pending.install();
    } finally {
      await exit(0);
    }
  });
}

export const updates = {
  getStatus: () => status,
  onStatus: (fn) => listeners.add(fn),
  check: () => checkNow({ manual: true }),
  restart,
};
