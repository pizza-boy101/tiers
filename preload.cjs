const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (fn) => ipcRenderer.on(channel, (_e, payload) => fn(payload));

contextBridge.exposeInMainWorld("api", {
  platform: process.platform,
  getState: () => ipcRenderer.invoke("state:get"),
  saveState: (data) => ipcRenderer.invoke("state:save", data),
  onStateChanged: listen("state:changed"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:save", patch),
  suggest: (req) => ipcRenderer.invoke("suggest", req),
  exportData: () => ipcRenderer.invoke("data:export"),
  importData: () => ipcRenderer.invoke("data:import"),
  revealData: () => ipcRenderer.invoke("data:reveal"),
  sync: {
    login: () => ipcRenderer.invoke("sync:login"),
    cancel: () => ipcRenderer.invoke("sync:cancel"),
    signOut: () => ipcRenderer.invoke("sync:signout"),
    now: () => ipcRenderer.invoke("sync:now"),
    onStatus: listen("sync:status"),
  },
});
