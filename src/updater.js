// Automatic updates from GitHub releases (desktop only).
//
// The app checks latest.json on the newest release at launch and every few
// hours. A newer version is downloaded in the background and its signature
// checked against the public key in tauri.conf.json.
//   macOS:   installed right away; the new version runs from the next launch.
//   Windows: the installer needs the app closed, so it runs when the window
//            is closed (or when you click Restart).

import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

const FIRST_CHECK_DELAY = 5_000;
const CHECK_EVERY = 4 * 60 * 60_000;
const installsInPlace = navigator.userAgent.includes("Mac");

// state: disabled | idle | checking | downloading | ready | installed | error
let status = { state: "idle", current: "", available: null, error: null };
let pending = null; // downloaded Update not yet installed (Windows)
const listeners = new Set();

function set(patch) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn(status));
}

async function checkNow() {
  if (["disabled", "checking", "downloading", "installed"].includes(status.state)) return status;
  if (status.state === "ready") return status;
  set({ state: "checking", error: null });
  try {
    const update = await check();
    if (!update) {
      set({ state: "idle", checkedAt: Date.now() });
      return status;
    }
    set({ state: "downloading", available: update.version });
    await update.download();
    if (installsInPlace) {
      await update.install();
      set({ state: "installed", checkedAt: Date.now() });
    } else {
      pending = update;
      set({ state: "ready", checkedAt: Date.now() });
    }
  } catch (err) {
    console.error("Update check failed:", err);
    set({ state: "error", error: typeof err === "string" ? err : err?.message || String(err) });
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
  status.current = await getVersion().catch(() => "");
  if (await invoke("is_debug_build").catch(() => false)) {
    set({ state: "disabled" });
    return;
  }
  setTimeout(checkNow, FIRST_CHECK_DELAY);
  setInterval(checkNow, CHECK_EVERY);

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
  check: checkNow,
  restart,
};
