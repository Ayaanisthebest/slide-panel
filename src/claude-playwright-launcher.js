/**
 * Headed Playwright Chromium with common "stealth" mitigations (automation flags, webdriver).
 * Separate from Electron — Claude often works here when embedded WebContents do not.
 *
 * Profile: ~/.cache/slidepanel/claude-playwright-profile (sign in once).
 *
 * Run: node src/claude-playwright-launcher.js
 * Or: tray → "Open Claude in Playwright (stealth)"
 *
 * First time: npx playwright install chromium   (and optionally use Google Chrome via channel below)
 */

const path = require("path");
const os = require("os");
const { chromium } = require("playwright");

const PROFILE_DIR = path.join(os.homedir(), ".cache", "slidepanel", "claude-playwright-profile");
const CLAUDE_URL = "https://claude.ai/";

async function openClaudeStealth() {
  const baseOptions = {
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
      "--no-default-browser-check",
    ],
    viewport: { width: 1280, height: 840 },
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...baseOptions,
      channel: "chrome",
    });
  } catch {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      ...baseOptions,
    });
  }

  await context.addInitScript(() => {
    try {
      Object.defineProperty(navigator, "webdriver", {
        get: () => undefined,
        configurable: true,
      });
    } catch {
      // ignore
    }
    try {
      if (!window.chrome) {
        window.chrome = { runtime: {} };
      }
    } catch {
      // ignore
    }
  });

  const page = context.pages()[0] || (await context.newPage());
  await page.goto(CLAUDE_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
}

openClaudeStealth().catch((err) => {
  console.error("[claude-playwright]", err.message || err);
  process.exit(1);
});
