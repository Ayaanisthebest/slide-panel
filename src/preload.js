const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("slidePanel", {
  getUrl: () => ipcRenderer.invoke("slidepanel:get-url"),
  setUrl: (url) => ipcRenderer.invoke("slidepanel:set-url", url),
  hidePanel: () => ipcRenderer.send("slidepanel:hide-panel"),
  onUrlChanged: (callback) =>
    ipcRenderer.on("slidepanel:url-changed", (_event, url) => callback(url)),
  onReloadRequested: (callback) =>
    ipcRenderer.on("slidepanel:reload-requested", () => callback()),
});
