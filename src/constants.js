const DEFAULT_URL = "https://claude.ai";
const HOTKEY = "Alt+Space";
const PANEL_PARTITION = "persist:slidepanel";
const TAB_BAR_HEIGHT = 40;

/**
 * Pro mode is fixed to these three tabs. Order here is the order they appear in the
 * tab bar. To add/remove an option, edit this list.
 */
const PRO_TABS = [
  { label: "Claude", url: "https://claude.ai" },
  { label: "ChatGPT", url: "https://chatgpt.com" },
  { label: "Gemini", url: "https://gemini.google.com/app" },
];

/** Which PRO_TABS entry opens by default (0 = Claude). */
const DEFAULT_PRO_TAB_INDEX = 0;

/**
 * Per-host "start a new chat" URLs. Cmd+N navigates the embedded view to the
 * matching entry based on the page's current host. Each site has its own native
 * new-chat shortcut; we normalize them all onto Cmd+N by just loading these URLs.
 */
const NEW_CHAT_URLS = {
  "claude.ai": "https://claude.ai/new",
  "chatgpt.com": "https://chatgpt.com/",
  "chat.openai.com": "https://chat.openai.com/",
  "gemini.google.com": "https://gemini.google.com/app",
};

const DEFAULT_SETTINGS = {
  performanceMode: "max",
  animationStyle: "easeOutCubic",
  animationMs: 300,
  hideOnBlur: false,
  alwaysOnTop: true,
  launchAtLogin: false,
};

module.exports = {
  DEFAULT_URL,
  HOTKEY,
  PANEL_PARTITION,
  TAB_BAR_HEIGHT,
  PRO_TABS,
  DEFAULT_PRO_TAB_INDEX,
  NEW_CHAT_URLS,
  DEFAULT_SETTINGS,
};
