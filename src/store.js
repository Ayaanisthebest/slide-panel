const Store = require("electron-store").default;
const {
  DEFAULT_URL,
  DEFAULT_SETTINGS,
  PRO_TABS,
  DEFAULT_PRO_TAB_INDEX,
} = require("./constants");

const store = new Store({
  defaults: {
    url: DEFAULT_URL,
    proMode: false,
    activeProTabIndex: 0,
    settings: DEFAULT_SETTINGS,
  },
});

function getSettings() {
  return {
    ...DEFAULT_SETTINGS,
    ...store.get("settings", {}),
  };
}

function updateSettings(patch) {
  const next = { ...getSettings(), ...patch };
  store.set("settings", next);
  return next;
}

function getProMode() {
  return store.get("proMode", false);
}

/** Tabs are hardcoded — see PRO_TABS in constants.js. */
function getProTabDescriptors() {
  return PRO_TABS;
}

function getProTabs() {
  return PRO_TABS.map((t) => t.url);
}

function getActiveProTabIndex() {
  const tabs = getProTabs();
  let i = store.get("activeProTabIndex", 0);
  if (i < 0 || i >= tabs.length) {
    i = 0;
  }
  return i;
}

function getCurrentLoadUrl() {
  if (getProMode()) {
    const tabs = getProTabs();
    const idx = getActiveProTabIndex();
    return tabs[idx] || DEFAULT_URL;
  }
  return store.get("url", DEFAULT_URL);
}

function getDefaultProTabIndex() {
  return DEFAULT_PRO_TAB_INDEX;
}

function getDefaultProTabUrl() {
  const tab = PRO_TABS[DEFAULT_PRO_TAB_INDEX];
  return tab ? tab.url : DEFAULT_URL;
}

module.exports = {
  store,
  getSettings,
  updateSettings,
  getProMode,
  getProTabs,
  getProTabDescriptors,
  getActiveProTabIndex,
  getCurrentLoadUrl,
  getDefaultProTabIndex,
  getDefaultProTabUrl,
  DEFAULT_URL,
};
