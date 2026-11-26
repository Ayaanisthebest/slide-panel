const path = require("path");
const { app, globalShortcut, systemPreferences, session } = require("electron");

app.setName("SlidePanel");
app.setPath("userData", path.join(app.getPath("appData"), "SlidePanel"));

const { HOTKEY, PANEL_PARTITION } = require("./constants");
const { getChromeLikeUserAgent } = require("./chrome-user-agent");
const { getSettings } = require("./store");
const panel = require("./panel");
const tray = require("./tray");
const { registerIpcHandlers } = require("./ipc-handlers");

// Keep stderr available when debugging panel load / visibility (see SLIDEPANEL_DEBUG).
if (process.env.SLIDEPANEL_DEBUG !== "1") {
  app.commandLine.appendSwitch("disable-logging");
  app.commandLine.appendSwitch("log-level", "3");
}
// Keep embedded sites (Claude, etc.) running timers/streams while the slide-out window is hidden.
app.commandLine.appendSwitch("disable-renderer-backgrounding");

registerIpcHandlers();
panel.setTrayMenuRebuilder(tray.rebuildTrayMenu);

function applyStartupPreferences() {
  const settings = getSettings();
  if (process.platform === "darwin") {
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
    });
  }
}

function checkAccessibilityPermissions() {
  if (process.platform !== "darwin") {
    return;
  }
  // Pass `false` so we only *query* trust status without ever forcing the macOS
  // "grant accessibility" prompt. The global hotkey (globalShortcut) does not
  // require accessibility on macOS, and forcing the prompt with `true` re-nagged
  // on every launch — especially for unsigned dev builds, whose permission macOS
  // does not persist reliably.
  systemPreferences.isTrustedAccessibilityClient(false);
}

function registerShortcuts() {
  const registered = globalShortcut.register(HOTKEY, () => {
    void panel.togglePanel();
  });

  if (!registered) {
    console.error(`Failed to register global shortcut: ${HOTKEY}`);
  }
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }

  session.fromPartition(PANEL_PARTITION).setUserAgent(getChromeLikeUserAgent());

  checkAccessibilityPermissions();
  applyStartupPreferences();
  panel.createPanelWindow();
  panel.warmPanelViewIfMaxPerformance();
  tray.createTray();
  registerShortcuts();
  panel.scheduleHiddenUnload();
});

app.on("window-all-closed", () => {
  // Keep app alive as a background menu bar app.
});

app.on("will-quit", () => {
  panel.clearLowPowerUnloadTimer();
  globalShortcut.unregisterAll();
});
