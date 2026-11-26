const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("slidePanel", {
  getPanelState: () => ipcRenderer.invoke("slidepanel:get-panel-state"),
  setActiveTab: (index) => ipcRenderer.invoke("slidepanel:set-active-tab", index),
  hidePanel: () => ipcRenderer.invoke("slidepanel:hide-panel"),
  openDualSearchLauncher: () => ipcRenderer.invoke("slidepanel:open-dual-search-launcher"),
  submitDualSearch: (query, targets) =>
    ipcRenderer.invoke("slidepanel:submit-dual-search", { query, targets }),
  reloadWebview: () => ipcRenderer.invoke("slidepanel:reload-webview"),
  onPanelState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on("slidepanel:panel-state", handler);
    return () => ipcRenderer.removeListener("slidepanel:panel-state", handler);
  },
});
