const path = require("path");
const { app, BrowserWindow, WebContentsView, globalShortcut, screen } = require("electron");
const {
  getSettings,
  updateSettings,
  getProMode,
  getProTabs,
  getProTabDescriptors,
  getActiveProTabIndex,
  getCurrentLoadUrl,
  getDefaultProTabUrl,
  store,
  DEFAULT_URL,
} = require("./store");
const {
  PANEL_PARTITION,
  TAB_BAR_HEIGHT,
  DEFAULT_PRO_TAB_INDEX,
  NEW_CHAT_URLS,
} = require("./constants");
const { applyChromeLikeUserAgent } = require("./chrome-user-agent");

const DEBUG = process.env.SLIDEPANEL_DEBUG === "1";

function dbg(...args) {
  if (DEBUG) {
    console.error("[SlidePanel]", ...args);
  }
}

let rebuildTrayMenuFn = () => {};

function setTrayMenuRebuilder(fn) {
  rebuildTrayMenuFn = typeof fn === "function" ? fn : () => {};
}

let panelWindow = null;
let webviewContents = null;
let panelView = null;
let isPanelVisible = false;
let isAnimating = false;
let lowPowerUnloadTimer = null;
/** When true, the site WebContentsView is destroyed so the shell shows the dual-search launcher. */
let launcherViewActive = false;
/**
 * True when the embedded page's most recent load failed with a network error.
 * We hide the WebContentsView in that case so the renderer's offline overlay shows through.
 */
let networkErrorActive = false;
/**
 * False until the current WebContentsView has finished its first load. While false we hide
 * the view so the user sees the renderer's loading spinner instead of a blank white panel
 * during the (often slow) first paint of the embedded site.
 */
let viewReady = false;
let viewReadyFallbackTimer = null;
let viewReadyIdleTimer = null;

/**
 * In-memory per-host last-known URL. Lets Pro tabs remember where the user (or
 * the dual-search hidden window) ended up — so clicking the Claude tab after a
 * dual-search opens the just-created conversation instead of claude.ai/home.
 * Keyed by URL host (e.g. "claude.ai"). Resets on app restart by design.
 */
const lastTabUrlsByHost = new Map();

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function rememberTabUrl(url) {
  if (!url || typeof url !== "string") return;
  if (!/^https?:\/\//i.test(url)) return;
  if (url.startsWith("chrome-error:") || url.includes("chrome-error")) return;
  const host = hostOf(url);
  if (!host) return;
  if (lastTabUrlsByHost.get(host) === url) return;
  lastTabUrlsByHost.set(host, url);
  dbg("rememberTabUrl", { host, url });
}

function resolveTabUrl(baseUrl) {
  const host = hostOf(baseUrl);
  if (!host) return baseUrl;
  return lastTabUrlsByHost.get(host) || baseUrl;
}

/** URL for the default Pro tab (Claude), including any remembered conversation. */
function getDefaultProTabLoadUrl() {
  return resolveTabUrl(getDefaultProTabUrl());
}

function clearViewReadyIdleTimer() {
  if (viewReadyIdleTimer) {
    clearTimeout(viewReadyIdleTimer);
    viewReadyIdleTimer = null;
  }
}

// Chromium network error codes that we treat as "no network" (vs. e.g. cert errors, 404s, aborts).
// See https://source.chromium.org/chromium/chromium/src/+/main:net/base/net_error_list.h
const NETWORK_ERROR_CODES = new Set([
  -7, // ERR_TIMED_OUT
  -21, // ERR_NETWORK_CHANGED
  -105, // ERR_NAME_NOT_RESOLVED
  -106, // ERR_INTERNET_DISCONNECTED
  -109, // ERR_ADDRESS_UNREACHABLE
  -118, // ERR_CONNECTION_TIMED_OUT
  -130, // ERR_PROXY_CONNECTION_FAILED
]);

function getPanelStatePayload() {
  const payload = {
    proMode: getProMode(),
    tabs: getProTabs(),
    tabLabels: getProTabDescriptors().map((t) => t.label),
    activeIndex: getActiveProTabIndex(),
    launcherActive: launcherViewActive,
    networkError: networkErrorActive,
    viewReady,
  };
  if (DEBUG && webviewContents && !webviewContents.isDestroyed()) {
    try {
      payload.debug = {
        viewReady,
        networkErrorActive,
        launcherViewActive,
        isLoading: webviewContents.isLoading(),
        url: webviewContents.getURL(),
      };
    } catch {
      payload.debug = { viewReady, networkErrorActive, launcherViewActive };
    }
  }
  return payload;
}

function notifyPanelState() {
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.webContents.send("slidepanel:panel-state", getPanelStatePayload());
  }
}

function layoutSiteWebContentsView() {
  if (!panelView || !panelWindow || panelWindow.isDestroyed()) {
    return;
  }
  const b = panelWindow.getBounds();
  const tabOffset = getProMode() ? TAB_BAR_HEIGHT : 0;
  const fullHeight = Math.max(0, b.height - tabOffset);
  // The shell HTML (spinner / offline UI) lives in panelWindow.webContents, which sits
  // *under* the WebContentsView. setVisible(false) is unreliable here, so we collapse
  // the embedded view to height 0 until ready — the shell then paints through.
  const showEmbedded = !networkErrorActive && viewReady;
  panelView.setBounds({
    x: 0,
    y: tabOffset,
    width: b.width,
    height: showEmbedded ? fullHeight : 0,
  });
  dbg("layout", {
    showEmbedded,
    viewReady,
    networkErrorActive,
    w: b.width,
    h: showEmbedded ? fullHeight : 0,
  });
}

function getPanelBoundsForDisplay() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const { x, y, width, height } = display.bounds;
  const panelWidth = Math.floor(width / 2);

  return {
    shown: {
      x: x + width - panelWidth,
      y,
      width: panelWidth,
      height,
    },
    hidden: {
      x: x + width,
      y,
      width: panelWidth,
      height,
    },
  };
}

function movePanelToActiveDesktop() {
  if (process.platform !== "darwin" || !panelWindow || panelWindow.isDestroyed()) {
    return () => {};
  }

  // macOS keeps windows bound to Spaces. Temporarily pinning to all workspaces
  // before show prevents Space-switching back to the original desktop.
  const wasVisibleOnAllWorkspaces = panelWindow.isVisibleOnAllWorkspaces();
  panelWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });

  return () => panelWindow.setVisibleOnAllWorkspaces(wasVisibleOnAllWorkspaces, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t) {
  if (t < 0.5) {
    return 4 * t * t * t;
  }
  return 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function easeOutExpo(t) {
  if (t === 1) {
    return 1;
  }
  return 1 - Math.pow(2, -10 * t);
}

function getEasedProgress(t) {
  const { animationStyle } = getSettings();
  if (animationStyle === "linear") {
    return t;
  }
  if (animationStyle === "easeInOutCubic") {
    return easeInOutCubic(t);
  }
  if (animationStyle === "easeOutExpo") {
    return easeOutExpo(t);
  }
  return easeOutCubic(t);
}

/** Horizontal overlap between two axis-aligned rects (used to detect the visible strip width while sliding off-screen). */
function horizontalOverlapWidth(a, b) {
  const aRight = a.x + a.width;
  const bRight = b.x + b.width;
  const left = Math.max(a.x, b.x);
  const right = Math.min(aRight, bRight);
  return Math.max(0, right - left);
}

/**
 * Hide as soon as only a narrow strip would still be visible. The last few pixels are where the shell
 * and the window often composite out of sync (looks like a glitch); skipping those frames fixes it.
 */
const HIDE_WHEN_VISIBLE_WIDTH_PX = 18;

function animatePanelPosition(showing) {
  return new Promise((resolve) => {
    const { shown, hidden } = getPanelBoundsForDisplay();
    const fromX = showing ? hidden.x : shown.x;
    const toX = showing ? shown.x : hidden.x;
    const start = performance.now();
    const FRAME_MS = 1000 / 60;
    const { animationMs } = getSettings();
    let hidEarly = false;

    const tick = () => {
      const elapsed = performance.now() - start;
      const t = Math.min(elapsed / animationMs, 1);
      const eased = getEasedProgress(t);
      const currentX = Math.round(fromX + (toX - fromX) * eased);

      const winBounds = {
        x: currentX,
        y: shown.y,
        width: shown.width,
        height: shown.height,
      };
      panelWindow.setBounds(winBounds);

      if (
        !showing &&
        !hidEarly &&
        panelWindow.isVisible()
      ) {
        const display = screen.getDisplayMatching(winBounds);
        const visibleW = horizontalOverlapWidth(winBounds, display.bounds);
        if (visibleW <= HIDE_WHEN_VISIBLE_WIDTH_PX) {
          panelWindow.hide();
          hidEarly = true;
        }
      }

      if (t < 1) {
        setTimeout(tick, FRAME_MS);
      } else {
        panelWindow.setBounds(showing ? shown : hidden);
        resolve();
      }
    };

    tick();
  });
}

function clearLowPowerUnloadTimer() {
  if (lowPowerUnloadTimer) {
    clearTimeout(lowPowerUnloadTimer);
    lowPowerUnloadTimer = null;
  }
}

function getHiddenUnloadDelayMs() {
  // Never tear down the embedded page when the slide-out hides — keeps streams/timers running like a foreground tab.
  return null;
}

function setWebviewBackgroundThrottling(enabled) {
  if (!webviewContents || webviewContents.isDestroyed()) {
    return;
  }
  try {
    webviewContents.setBackgroundThrottling(enabled);
  } catch {
    // API may be unavailable on some Electron builds
  }
}

function clearViewReadyFallback() {
  if (viewReadyFallbackTimer) {
    clearTimeout(viewReadyFallbackTimer);
    viewReadyFallbackTimer = null;
  }
}

/**
 * Expand the embedded view only after loading has fully stopped AND the SPA has had
 * a moment to paint. did-finish-load fires too early on sites like Claude (HTML is
 * in but React hasn't rendered), which leaves a blank dark panel if we expand then.
 */
function scheduleViewReadyWhenIdle(contents, onExpand, source) {
  clearViewReadyIdleTimer();
  const PAINT_MS = 400;
  const POLL_MS = 80;

  const attempt = () => {
    if (!contents || contents.isDestroyed()) {
      return;
    }
    if (contents.isLoading()) {
      viewReadyIdleTimer = setTimeout(attempt, POLL_MS);
      return;
    }
    viewReadyIdleTimer = setTimeout(() => {
      viewReadyIdleTimer = null;
      if (!contents || contents.isDestroyed()) {
        return;
      }
      if (contents.isLoading()) {
        scheduleViewReadyWhenIdle(contents, onExpand, `${source}-recheck`);
        return;
      }
      dbg("scheduleViewReadyWhenIdle expand", source);
      setViewReady(true, source);
      if (typeof onExpand === "function") {
        onExpand();
      }
    }, PAINT_MS);
  };
  attempt();
}

function scheduleViewReadyFallback() {
  clearViewReadyFallback();
  viewReadyFallbackTimer = setTimeout(() => {
    viewReadyFallbackTimer = null;
    if (!viewReady) {
      dbg("viewReady fallback timeout — expanding embedded view");
      setViewReady(true, "fallback-timeout");
    }
  }, 12000);
}

function setNetworkErrorActive(active) {
  const next = Boolean(active);
  if (networkErrorActive === next) {
    return;
  }
  networkErrorActive = next;
  layoutSiteWebContentsView();
  notifyPanelState();
}

function setViewReady(ready, source = "unknown") {
  const next = Boolean(ready);
  if (viewReady === next) {
    return;
  }
  viewReady = next;
  dbg("setViewReady", next, "via", source);
  if (next) {
    clearViewReadyFallback();
  }
  layoutSiteWebContentsView();
  notifyPanelState();
}

function syncViewReadyFromWebContents() {
  if (!webviewContents || webviewContents.isDestroyed()) {
    return;
  }
  try {
    const url = webviewContents.getURL();
    const loading = webviewContents.isLoading();
    dbg("syncViewReadyFromWebContents", { url, loading, viewReady });
    if (!loading && url && url !== "about:blank") {
      setViewReady(true, "sync-already-loaded");
    }
  } catch (err) {
    dbg("syncViewReadyFromWebContents error", err);
  }
}

function attachPanelViewNetworkHandler(contents) {
  // When the main resource fails, Chromium loads its own internal error page next,
  // which would otherwise fire did-stop-loading and look like a successful load.
  // Track per-navigation failure so we don't clear the overlay on that follow-up.
  let pendingErrorPageLoad = false;

  contents.on("did-start-loading", () => {
    dbg("embedded did-start-loading");
    pendingErrorPageLoad = false;
    clearViewReadyIdleTimer();
  });
  contents.on("did-fail-load", (_event, errorCode, errorDesc, url, isMainFrame) => {
    dbg("embedded did-fail-load", { errorCode, errorDesc, url, isMainFrame });
    if (!isMainFrame) {
      return;
    }
    if (NETWORK_ERROR_CODES.has(errorCode)) {
      setNetworkErrorActive(true);
      pendingErrorPageLoad = true;
    }
  });
  contents.on("did-stop-loading", () => {
    dbg("embedded did-stop-loading");
    scheduleViewReadyWhenIdle(
      contents,
      () => {
        if (pendingErrorPageLoad) {
          pendingErrorPageLoad = false;
          return;
        }
        setNetworkErrorActive(false);
      },
      "did-stop-loading"
    );
  });
}

function destroyPanelView() {
  clearViewReadyFallback();
  clearViewReadyIdleTimer();
  // The embedded site is going away, so any pending offline / loading state is no
  // longer meaningful. The caller follows up with notifyPanelState(), so we reset
  // these silently here to avoid an extra IPC roundtrip.
  setNetworkErrorActive(false);
  viewReady = false;

  if (!panelView || !panelWindow || panelWindow.isDestroyed()) {
    panelView = null;
    webviewContents = null;
    return;
  }

  try {
    panelWindow.contentView.removeChildView(panelView);
  } catch {
    // ignore
  }
  if (panelView.webContents && !panelView.webContents.isDestroyed()) {
    panelView.webContents.destroy();
  }
  panelView = null;
  webviewContents = null;
}

function isReloadShortcut(input) {
  if (input.type !== "keyDown" || !input.key) {
    return false;
  }
  if (input.key.toLowerCase() !== "r") {
    return false;
  }
  // Cmd+R on macOS, Ctrl+R elsewhere. Reject if other modifiers are held so we
  // don't swallow things like Cmd+Shift+R (which Chromium uses for hard reload).
  const primary = process.platform === "darwin" ? input.meta : input.control;
  const conflicting =
    input.shift || input.alt || (process.platform === "darwin" ? input.control : input.meta);
  return Boolean(primary) && !conflicting;
}

function isNewChatShortcut(input) {
  if (input.type !== "keyDown" || !input.key) {
    return false;
  }
  if (input.key.toLowerCase() !== "n") {
    return false;
  }
  // Cmd+N on macOS, Ctrl+N elsewhere. Reject if other modifiers are held so we
  // don't swallow things like Cmd+Shift+N.
  const primary = process.platform === "darwin" ? input.meta : input.control;
  const conflicting =
    input.shift || input.alt || (process.platform === "darwin" ? input.control : input.meta);
  return Boolean(primary) && !conflicting;
}

function attachPanelViewInputHandler(contents) {
  contents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault();
      void hidePanel();
      return;
    }
    if (isReloadShortcut(input)) {
      event.preventDefault();
      reloadWebview();
      return;
    }
    if (isNewChatShortcut(input)) {
      event.preventDefault();
      startNewChat();
    }
  });
}

function syncBrowserViewUrlToStore(contents) {
  if (launcherViewActive || !contents || contents.isDestroyed()) {
    return;
  }
  let url;
  try {
    url = contents.getURL();
  } catch {
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    return;
  }

  if (getProMode()) {
    // Pro tab list is fixed, but remember where the user navigated within each tab
    // so re-clicking the tab (after switching away) returns them to where they were.
    rememberTabUrl(url);
    return;
  }

  const current = store.get("url", DEFAULT_URL);
  if (current === url) {
    return;
  }
  store.set("url", url);
  notifyPanelState();
}

function attachPanelViewUrlSync(contents) {
  const onNavigate = () => {
    syncBrowserViewUrlToStore(contents);
  };
  contents.on("did-navigate", onNavigate);
  contents.on("did-navigate-in-page", onNavigate);
}

function ensurePanelView(explicitLoadUrl) {
  if (!panelWindow || panelWindow.isDestroyed()) {
    return;
  }

  if (getProMode() && launcherViewActive) {
    destroyPanelView();
    notifyPanelState();
    return;
  }

  if (panelView && webviewContents && !webviewContents.isDestroyed()) {
    return;
  }

  // Reset per-view lifecycle flags before we create a fresh view. The renderer will
  // show its loading spinner until did-stop-loading flips viewReady true again.
  viewReady = false;
  panelView = new WebContentsView({
    webPreferences: {
      partition: PANEL_PARTITION,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  panelWindow.contentView.addChildView(panelView);
  layoutSiteWebContentsView();

  webviewContents = panelView.webContents;
  applyChromeLikeUserAgent(webviewContents);
  setWebviewBackgroundThrottling(false);
  attachPanelViewInputHandler(webviewContents);
  attachPanelViewUrlSync(webviewContents);
  attachPanelViewNetworkHandler(webviewContents);
  // Honor any per-host memory (e.g. dual-search conversation URL) when first creating
  // the view, so the user lands on their just-created chat instead of the homepage.
  const loadUrl =
    explicitLoadUrl ??
    (getProMode() ? resolveTabUrl(getCurrentLoadUrl()) : getCurrentLoadUrl());
  dbg("ensurePanelView loadURL", { explicitLoadUrl, loadUrl });
  layoutSiteWebContentsView();
  scheduleViewReadyFallback();
  void webviewContents.loadURL(loadUrl);
  notifyPanelState();
}

function scheduleHiddenUnload() {
  clearLowPowerUnloadTimer();
  const delayMs = getHiddenUnloadDelayMs();
  if (!delayMs) {
    return;
  }

  lowPowerUnloadTimer = setTimeout(() => {
    if (!isPanelVisible && !isAnimating) {
      destroyPanelView();
    }
  }, delayMs);
}

async function showPanel() {
  if (!panelWindow || isPanelVisible || isAnimating) {
    return;
  }

  clearLowPowerUnloadTimer();
  // Always start on a real tab. The dual-search launcher is opt-in via the "+" button;
  // we never want it to be the first thing the user sees when the panel slides in.
  launcherViewActive = false;
  // Restore whichever tab the user last had selected (persisted across restarts via
  // the store). On first launch this is Claude (DEFAULT_PRO_TAB_INDEX, set as the
  // store default). The embedded view persists while hidden, so when the active tab
  // is already loaded this is a no-op and won't reload / interrupt a response.
  ensurePanelView();
  if (getProMode()) {
    setActiveProTab(getActiveProTabIndex(), { force: true });
  }
  syncViewReadyFromWebContents();
  layoutSiteWebContentsView();
  notifyPanelState();
  setWebviewBackgroundThrottling(false);
  registerReloadAccelerator();
  isAnimating = true;
  dbg("showPanel start", getPanelStatePayload());
  const { hidden } = getPanelBoundsForDisplay();
  const restoreWorkspaceVisibility = movePanelToActiveDesktop();
  panelWindow.setBounds(hidden);
  panelWindow.showInactive();
  panelWindow.moveTop();

  try {
    await animatePanelPosition(true);
  } finally {
    restoreWorkspaceVisibility();
  }
  layoutSiteWebContentsView();
  syncViewReadyFromWebContents();
  notifyPanelState();
  dbg("showPanel done", getPanelStatePayload());

  isPanelVisible = true;
  isAnimating = false;
}

async function hidePanel() {
  if (!panelWindow || !isPanelVisible || isAnimating) {
    return;
  }

  isAnimating = true;
  unregisterReloadAccelerator();
  await animatePanelPosition(false);

  isPanelVisible = false;
  isAnimating = false;
  panelWindow.hide();
  scheduleHiddenUnload();
}

async function togglePanel() {
  if (isPanelVisible) {
    await hidePanel();
  } else {
    await showPanel();
  }
}

function updateWebviewUrl(url) {
  ensurePanelView();
  if (webviewContents && !webviewContents.isDestroyed()) {
    void webviewContents.loadURL(url);
  }
  notifyPanelState();
}

function setActiveProTab(index, options = {}) {
  const tabs = getProTabs();
  if (!Number.isFinite(index) || index < 0 || index >= tabs.length) {
    return;
  }
  const wasLauncher = launcherViewActive;
  const prevIndex = getActiveProTabIndex();
  launcherViewActive = false;
  store.set("activeProTabIndex", index);
  ensurePanelView();

  // Only navigate when we actually need to: when leaving the launcher (no embedded
  // page loaded yet), when the target tab changed, or when the current URL is on a
  // completely different host than the tab's. Clicking the tab you're already on
  // must NOT reload — that would kill any in-flight LLM response.
  if (webviewContents && !webviewContents.isDestroyed()) {
    const baseUrl = tabs[index];
    // Prefer the last URL we know for this host (e.g. the chat URL returned by a
    // recent dual-search submission). Falls back to the tab's base URL.
    const targetUrl = resolveTabUrl(baseUrl);
    let currentUrl = "";
    try {
      currentUrl = webviewContents.getURL() || "";
    } catch {
      // ignore
    }

    if (options.force && currentUrl !== targetUrl) {
      dbg("setActiveProTab → force loadURL", { index, targetUrl, currentUrl });
      void webviewContents.loadURL(targetUrl);
      notifyPanelState();
      return;
    }

    const sameHost = (() => {
      try {
        return new URL(currentUrl).host === new URL(targetUrl).host;
      } catch {
        return false;
      }
    })();
    const indexChanged = prevIndex !== index;
    const needNav =
      wasLauncher ||
      !sameHost ||
      (!currentUrl && indexChanged) ||
      // Same host but we have a "better" URL to jump to (e.g. dual-search result):
      (sameHost && currentUrl !== targetUrl && indexChanged);
    if (needNav) {
      dbg("setActiveProTab → loadURL", { index, baseUrl, targetUrl, currentUrl });
      void webviewContents.loadURL(targetUrl);
    } else {
      dbg("setActiveProTab no-op", { index, currentUrl });
    }
  }
  notifyPanelState();
}

function openDualSearchLauncher() {
  if (!getProMode()) {
    return;
  }
  launcherViewActive = true;
  destroyPanelView();
  notifyPanelState();
}

function setProMode(enabled) {
  store.set("proMode", enabled);
  if (!enabled) {
    launcherViewActive = false;
  } else {
    store.set("activeProTabIndex", DEFAULT_PRO_TAB_INDEX);
  }
  destroyPanelView();
  ensurePanelView(getProMode() ? getDefaultProTabLoadUrl() : undefined);
  layoutSiteWebContentsView();
  notifyPanelState();
  rebuildTrayMenuFn();
}

function reloadWebview() {
  dbg("reloadWebview()");
  ensurePanelView();
  if (!webviewContents || webviewContents.isDestroyed()) {
    return;
  }
  clearViewReadyIdleTimer();
  setViewReady(false, "reload");
  scheduleViewReadyFallback();

  let url = "";
  try {
    url = webviewContents.getURL();
  } catch {
    // ignore
  }
  if (!/^https?:\/\//i.test(url)) {
    url = getCurrentLoadUrl();
  }
  dbg("reloadWebview loadURL", url);
  void webviewContents.loadURL(url);
}

/**
 * Start a fresh chat on whichever site is currently loaded. Each site has its own
 * native new-chat shortcut; we normalize them all onto Cmd+N by navigating the
 * embedded view to the host's "new chat" URL (see NEW_CHAT_URLS).
 */
function startNewChat() {
  dbg("startNewChat()");
  ensurePanelView();
  if (!webviewContents || webviewContents.isDestroyed()) {
    return;
  }
  let url = "";
  try {
    url = webviewContents.getURL();
  } catch {
    // ignore
  }
  const host = hostOf(url);
  const targetUrl = host ? NEW_CHAT_URLS[host] : null;
  if (!targetUrl) {
    dbg("startNewChat no mapping for host", host);
    return;
  }
  // Forget any remembered conversation for this host so switching away and back
  // doesn't bounce the user out of their brand-new chat.
  if (host) {
    lastTabUrlsByHost.delete(host);
  }
  clearViewReadyIdleTimer();
  setViewReady(false, "new-chat");
  scheduleViewReadyFallback();
  dbg("startNewChat loadURL", targetUrl);
  void webviewContents.loadURL(targetUrl);
}

const RELOAD_ACCELERATOR = "CommandOrControl+R";
const NEW_CHAT_ACCELERATOR = "CommandOrControl+N";

function registerReloadAccelerator() {
  // Register only while the panel is visible. We can't use before-input-event alone
  // because the panel opens via showInactive() — keyboard focus stays on the previous
  // app, so the embedded webContents never sees the keydown.
  if (!globalShortcut.isRegistered(RELOAD_ACCELERATOR)) {
    const ok = globalShortcut.register(RELOAD_ACCELERATOR, () => {
      dbg("global Cmd+R fired");
      reloadWebview();
    });
    dbg("registerReloadAccelerator", { ok });
  }
  if (!globalShortcut.isRegistered(NEW_CHAT_ACCELERATOR)) {
    const ok = globalShortcut.register(NEW_CHAT_ACCELERATOR, () => {
      dbg("global Cmd+N fired");
      startNewChat();
    });
    dbg("registerNewChatAccelerator", { ok });
  }
}

function unregisterReloadAccelerator() {
  if (globalShortcut.isRegistered(RELOAD_ACCELERATOR)) {
    globalShortcut.unregister(RELOAD_ACCELERATOR);
    dbg("unregisterReloadAccelerator");
  }
  if (globalShortcut.isRegistered(NEW_CHAT_ACCELERATOR)) {
    globalShortcut.unregister(NEW_CHAT_ACCELERATOR);
    dbg("unregisterNewChatAccelerator");
  }
}

function setPerformanceMode(mode) {
  updateSettings({ performanceMode: mode });
  if (mode === "max" || mode === "balanced") {
    clearLowPowerUnloadTimer();
  }
  if (mode === "max") {
    ensurePanelView();
  } else if (!isPanelVisible) {
    scheduleHiddenUnload();
  }
  rebuildTrayMenuFn();
}

function setAnimationStyle(animationStyle) {
  updateSettings({ animationStyle });
  rebuildTrayMenuFn();
}

function setAnimationDuration(animationMs) {
  updateSettings({ animationMs });
  rebuildTrayMenuFn();
}

function setHideOnBlur(enabled) {
  updateSettings({ hideOnBlur: enabled });
  rebuildTrayMenuFn();
}

function setAlwaysOnTop(enabled) {
  updateSettings({ alwaysOnTop: enabled });
  if (panelWindow && !panelWindow.isDestroyed()) {
    panelWindow.setAlwaysOnTop(enabled);
  }
  rebuildTrayMenuFn();
}

function setLaunchAtLogin(enabled) {
  updateSettings({ launchAtLogin: enabled });
  if (process.platform === "darwin") {
    app.setLoginItemSettings({
      openAtLogin: enabled,
    });
  }
  rebuildTrayMenuFn();
}

function openPageDevTools() {
  if (webviewContents && !webviewContents.isDestroyed()) {
    webviewContents.openDevTools({ mode: "detach" });
  }
}

function forceRecreateView() {
  destroyPanelView();
  ensurePanelView();
}


function warmPanelViewIfMaxPerformance() {
  // Warm whichever tab the user last had selected (persisted across restarts).
  // On first launch this is Claude (DEFAULT_PRO_TAB_INDEX via the store default).
  if (getProMode()) {
    ensurePanelView(resolveTabUrl(getCurrentLoadUrl()));
    return;
  }
  ensurePanelView();
}

function createPanelWindow() {
  const { hidden } = getPanelBoundsForDisplay();
  const settings = getSettings();

  panelWindow = new BrowserWindow({
    ...hidden,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload-panel.js"),
      backgroundThrottling: false,
    },
  });

  panelWindow.loadFile(path.join(__dirname, "index.html"));
  panelWindow.webContents.on("did-finish-load", () => {
    dbg("shell did-finish-load");
    notifyPanelState();
  });
  panelWindow.webContents.on("before-input-event", (event, input) => {
    if (isReloadShortcut(input)) {
      event.preventDefault();
      reloadWebview();
      return;
    }
    if (isNewChatShortcut(input)) {
      event.preventDefault();
      startNewChat();
    }
  });
  panelWindow.on("resize", () => {
    layoutSiteWebContentsView();
  });
  panelWindow.on("blur", () => {
    if (getSettings().hideOnBlur) {
      void hidePanel();
    }
  });
}

module.exports = {
  setTrayMenuRebuilder,
  createPanelWindow,
  togglePanel,
  hidePanel,
  showPanel,
  reloadWebview,
  updateWebviewUrl,
  setActiveProTab,
  openDualSearchLauncher,
  setProMode,
  setPerformanceMode,
  setAnimationStyle,
  setAnimationDuration,
  setHideOnBlur,
  setAlwaysOnTop,
  setLaunchAtLogin,
  forceRecreateView,
  openPageDevTools,
  notifyPanelState,
  getPanelStatePayload,
  scheduleHiddenUnload,
  clearLowPowerUnloadTimer,
  warmPanelViewIfMaxPerformance,
  rememberTabUrl,
};
