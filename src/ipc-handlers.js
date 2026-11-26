const { ipcMain } = require("electron");
const panel = require("./panel");
const { submitDualSearchToBothLlm } = require("./dual-search-runner");

function registerIpcHandlers() {
  ipcMain.handle("slidepanel:get-panel-state", () => panel.getPanelStatePayload());
  ipcMain.handle("slidepanel:set-active-tab", (_event, index) => {
    panel.setActiveProTab(Number(index));
  });
  ipcMain.handle("slidepanel:hide-panel", () => {
    void panel.hidePanel();
  });
  ipcMain.handle("slidepanel:open-dual-search-launcher", () => {
    panel.openDualSearchLauncher();
  });
  ipcMain.handle("slidepanel:reload-webview", () => {
    panel.reloadWebview();
  });
  ipcMain.handle("slidepanel:submit-dual-search", async (_event, payload) => {
    const query = typeof payload === "string" ? payload : payload && payload.query;
    const targets = typeof payload === "object" && payload ? payload.targets : undefined;
    return submitDualSearchToBothLlm(query, targets, {
      notifyPanelState: panel.notifyPanelState,
      rememberTabUrl: panel.rememberTabUrl,
    });
  });
}

module.exports = { registerIpcHandlers };
