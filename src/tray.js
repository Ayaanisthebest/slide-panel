const path = require("path");
const { fork } = require("child_process");
const { app, Tray, Menu, nativeImage } = require("electron");
const { getSettings, getProMode, store } = require("./store");
const { createInputPromptWindow } = require("./prompts");
const panel = require("./panel");

let tray = null;

function createTrayIcon() {
  // Electron auto-resolves the @2x variant next to this file for Retina displays.
  const iconPath = path.join(__dirname, "assets", "iconTemplate.png");
  const image = nativeImage.createFromPath(iconPath);
  image.setTemplateImage(true);
  return image;
}

function normalizeUrl(input) {
  const raw = (input || "").trim();
  if (!raw) {
    return null;
  }

  if (/^https?:\/\//i.test(raw)) {
    return raw;
  }

  return `https://${raw}`;
}

async function handleChangeUrl() {
  if (getProMode()) {
    return;
  }
  const currentUrl = store.get("url");
  const input = await createInputPromptWindow({
    title: "Change URL",
    heading: "Change URL",
    initialValue: currentUrl,
    placeholder: "https://example.com",
    saveLabel: "Save",
  });
  const normalized = normalizeUrl(input);

  if (!normalized) {
    return;
  }

  store.set("url", normalized);
  panel.updateWebviewUrl(normalized);
}

async function handleSetCustomAnimationDuration() {
  const { animationMs } = getSettings();
  const input = await createInputPromptWindow({
    title: "Animation Duration",
    heading: "Set animation duration (ms)",
    initialValue: String(animationMs),
    placeholder: "e.g. 300",
    saveLabel: "Apply",
  });

  const parsed = Number.parseInt((input || "").trim(), 10);
  if (!Number.isFinite(parsed)) {
    return;
  }

  const clamped = Math.max(120, Math.min(1200, parsed));
  panel.setAnimationDuration(clamped);
}

function openClaudePlaywrightWindow() {
  const scriptPath = path.join(__dirname, "claude-playwright-launcher.js");
  const child = fork(scriptPath, [], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    detached: true,
    stdio: "ignore",
    execPath: process.execPath,
  });
  child.unref();
}

function buildContextMenu() {
  const settings = getSettings();
  const launchAtLogin = app.getLoginItemSettings().openAtLogin;
  const durationOptions = [200, 240, 300, 360, 450, 600];

  return Menu.buildFromTemplate([
    {
      label: "Change URL",
      enabled: !getProMode(),
      click: () => {
        void handleChangeUrl();
      },
    },
    {
      label: "Reload Page",
      accelerator: "CmdOrCtrl+R",
      click: () => panel.reloadWebview(),
    },
    {
      label: "Open Claude in Playwright (stealth)",
      click: () => {
        openClaudePlaywrightWindow();
      },
    },
    {
      label: "Performance Mode",
      submenu: [
        {
          label: "Balanced",
          type: "radio",
          checked: settings.performanceMode === "balanced",
          click: () => panel.setPerformanceMode("balanced"),
        },
        {
          label: "Low Power",
          type: "radio",
          checked: settings.performanceMode === "low-power",
          click: () => panel.setPerformanceMode("low-power"),
        },
        {
          label: "Max Performance",
          type: "radio",
          checked: settings.performanceMode === "max",
          click: () => panel.setPerformanceMode("max"),
        },
      ],
    },
    {
      label: "Animation",
      submenu: [
        {
          label: "Style",
          submenu: [
            {
              label: "Ease Out Cubic",
              type: "radio",
              checked: settings.animationStyle === "easeOutCubic",
              click: () => panel.setAnimationStyle("easeOutCubic"),
            },
            {
              label: "Ease In-Out Cubic",
              type: "radio",
              checked: settings.animationStyle === "easeInOutCubic",
              click: () => panel.setAnimationStyle("easeInOutCubic"),
            },
            {
              label: "Ease Out Expo",
              type: "radio",
              checked: settings.animationStyle === "easeOutExpo",
              click: () => panel.setAnimationStyle("easeOutExpo"),
            },
            {
              label: "Linear",
              type: "radio",
              checked: settings.animationStyle === "linear",
              click: () => panel.setAnimationStyle("linear"),
            },
          ],
        },
        {
          label: "Duration",
          submenu: [
            ...durationOptions.map((ms) => ({
              label: `${ms} ms`,
              type: "radio",
              checked: settings.animationMs === ms,
              click: () => panel.setAnimationDuration(ms),
            })),
            { type: "separator" },
            {
              label: `Custom (${settings.animationMs} ms)`,
              click: () => {
                void handleSetCustomAnimationDuration();
              },
            },
          ],
        },
      ],
    },
    { type: "separator" },
    {
      label: "Pro mode (Claude, ChatGPT, Gemini)",
      type: "checkbox",
      checked: getProMode(),
      click: (item) => panel.setProMode(item.checked),
    },
    { type: "separator" },
    {
      label: "Hide on Click Outside",
      type: "checkbox",
      checked: settings.hideOnBlur,
      click: (item) => panel.setHideOnBlur(item.checked),
    },
    {
      label: "Always on Top",
      type: "checkbox",
      checked: settings.alwaysOnTop,
      click: (item) => panel.setAlwaysOnTop(item.checked),
    },
    {
      label: "Launch at Login",
      type: "checkbox",
      checked: launchAtLogin,
      click: (item) => panel.setLaunchAtLogin(item.checked),
    },
    {
      label: "Open Page DevTools",
      click: () => panel.openPageDevTools(),
    },
    {
      label: "Recreate Web View",
      click: () => panel.forceRecreateView(),
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);
}

function rebuildTrayMenu() {
  if (!tray) {
    return;
  }
  tray.setContextMenu(buildContextMenu());
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip("SlidePanel");
  tray.setContextMenu(buildContextMenu());

  tray.on("click", () => {
    void panel.togglePanel();
  });

  tray.on("right-click", () => {
    tray.popUpContextMenu(buildContextMenu());
  });
}

module.exports = {
  createTray,
  rebuildTrayMenu,
};
