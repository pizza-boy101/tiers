// The web version's update notice. Each deploy changes the offline cache's
// service worker (web/sw.js); when the new one takes over, the page offers a
// reload. Same shape as the desktop `updates` (src/updater.js).

const CHECK_EVERY = 60 * 60_000;

export function createWebUpdates({ serviceWorker, reload, now = () => Date.now() }) {
  let status = { state: "idle", current: "", available: null, notes: "", error: null, web: true };
  const listeners = new Set();
  const set = (patch) => {
    status = { ...status, ...patch };
    listeners.forEach((fn) => fn(status));
  };

  let registration = null;
  let lastCheck = 0;
  async function check() {
    lastCheck = now();
    try {
      await registration?.update();
    } catch {
      // offline: try again later
    }
    return status;
  }

  if (serviceWorker) {
    // The first install also "takes over" the page; only later ones are updates.
    const hadController = Boolean(serviceWorker.controller);
    serviceWorker.addEventListener("controllerchange", () => {
      if (hadController) set({ state: "ready" });
    });
    serviceWorker.register("sw.js").then((reg) => {
      registration = reg;
      lastCheck = now();
    }).catch(() => {});
  }

  return {
    getStatus: () => status,
    onStatus: (fn) => listeners.add(fn),
    check,
    restart: async () => reload(),
    // Called when the page comes back to the front.
    wake: () => {
      if (now() - lastCheck > CHECK_EVERY) check();
    },
    startTimer: () => setInterval(check, CHECK_EVERY),
  };
}
