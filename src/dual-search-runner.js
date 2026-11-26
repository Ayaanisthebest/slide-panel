const { BrowserWindow } = require("electron");
const { applyChromeLikeUserAgent } = require("./chrome-user-agent");
const { buildChatgptScript, buildGeminiScript, buildClaudeScript } = require("./dual-search-automation");
const { PANEL_PARTITION } = require("./constants");

function dualSearchDebugEnabled() {
  const v = process.env.SLIDEPANEL_DUAL_SEARCH_DEBUG;
  return v === "1" || v === "true";
}

function logDualSearch(label, phase, ms, detail) {
  if (!dualSearchDebugEnabled()) {
    return;
  }
  const d =
    detail !== undefined && detail !== null
      ? typeof detail === "string"
        ? ` ${detail}`
        : ` ${JSON.stringify(detail)}`
      : "";
  console.log(`[dual-search] ${label} ${phase} +${ms}ms${d}`);
}

/**
 * URL-pattern detection for "the conversation has been created". This is the
 * earliest reliable signal we can give the user that submission succeeded —
 * before the LLM finishes streaming its (potentially 60s+) response.
 */
function isConversationUrl(startUrl, currentUrl) {
  if (!currentUrl || typeof currentUrl !== "string") return false;
  let cur;
  let start;
  try {
    cur = new URL(currentUrl);
    start = new URL(startUrl);
  } catch {
    return false;
  }
  // Reject cross-host (sign-in redirects, etc).
  if (
    cur.host !== start.host &&
    !cur.host.endsWith("." + start.host) &&
    !start.host.endsWith("." + cur.host)
  ) {
    return false;
  }
  if (start.host.includes("claude")) return /\/chat\/[^/]+/.test(cur.pathname);
  // ChatGPT: matches both /c/<uuid> and /g/<gpt-id>/c/<uuid> (custom GPTs).
  if (start.host.includes("chatgpt")) return /\/c\/[^/]+/.test(cur.pathname);
  if (start.host.includes("gemini")) return /\/app\/[^/]+/.test(cur.pathname);
  return false;
}

/**
 * Runs automation in a hidden window (shared session). Returns two promises:
 *   - submittedPromise: resolves quickly when the conversation URL appears (or
 *     the submission times out). The user-facing IPC awaits this.
 *   - donePromise: resolves when the full streaming response has settled and
 *     the hidden window has been closed. Runs in the background.
 */
function runHiddenPartitionSearch(pageUrl, executeScript, options = {}) {
  const settleBeforeScriptMs = options.settleBeforeScriptMs ?? 400;
  const settleAfterScriptMs = options.settleAfterScriptMs ?? 800;
  // If the conversation URL never appears within this window, resolve submitted
  // anyway so the user isn't stuck on "Sending…" forever. The background
  // donePromise still finishes work.
  const submissionTimeoutMs = options.submissionTimeoutMs ?? 25000;
  // Hard cap on a hidden window's total lifetime. Past this, we force-close.
  const maxLifetimeMs = options.maxLifetimeMs ?? 180000;

  let label = "page";
  try {
    label = new URL(pageUrl).hostname || label;
  } catch {
    // ignore
  }

  const runT0 = Date.now();
  const win = new BrowserWindow({
    show: false,
    width: 1100,
    height: 800,
    webPreferences: {
      partition: PANEL_PARTITION,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  applyChromeLikeUserAgent(win.webContents);

  let submittedSettled = false;
  let submittedResolveFn;
  let submittedRejectFn;
  const submittedPromise = new Promise((res, rej) => {
    submittedResolveFn = res;
    submittedRejectFn = rej;
  });

  let doneSettled = false;
  let doneResolveFn;
  let doneRejectFn;
  const donePromise = new Promise((res, rej) => {
    doneResolveFn = res;
    doneRejectFn = rej;
  });

  function resolveSubmitted(url) {
    if (submittedSettled) return;
    submittedSettled = true;
    logDualSearch(label, "submitted (user-facing)", Date.now() - runT0, url);
    submittedResolveFn(url || "");
  }

  function rejectSubmitted(err) {
    if (submittedSettled) return;
    submittedSettled = true;
    submittedRejectFn(err);
  }

  function resolveDone(url) {
    if (doneSettled) return;
    doneSettled = true;
    logDualSearch(label, "TOTAL hidden window", Date.now() - runT0, url);
    doneResolveFn(url || "");
  }

  function rejectDone(err) {
    if (doneSettled) return;
    doneSettled = true;
    doneRejectFn(err);
  }

  function fail(err) {
    if (dualSearchDebugEnabled()) {
      console.log(
        `[dual-search] ${label} FAILED after ${Date.now() - runT0}ms:`,
        err instanceof Error ? err.message : err
      );
    }
    rejectSubmitted(err);
    rejectDone(err);
    if (!win.isDestroyed()) {
      try {
        win.close();
      } catch {
        // ignore
      }
    }
  }

  // Safety nets ---------------------------------------------------------------

  const submissionTimer = setTimeout(() => {
    if (!submittedSettled) {
      let cur = "";
      try {
        cur = win.isDestroyed() ? "" : win.webContents.getURL() || "";
      } catch {
        cur = "";
      }
      logDualSearch(label, "submissionTimeout fallback", Date.now() - runT0, cur);
      resolveSubmitted(cur);
    }
  }, submissionTimeoutMs);

  const lifetimeTimer = setTimeout(() => {
    if (!doneSettled) {
      let cur = "";
      try {
        cur = win.isDestroyed() ? "" : win.webContents.getURL() || "";
      } catch {
        cur = "";
      }
      logDualSearch(label, "lifetimeTimeout force-close", Date.now() - runT0, cur);
      resolveSubmitted(cur);
      if (!win.isDestroyed()) {
        try {
          win.close();
        } catch {
          // ignore
        }
      }
      resolveDone(cur);
    }
  }, maxLifetimeMs);

  // Navigation events: earliest possible submission signal ---------------------

  function maybeFireSubmittedFromUrl(url) {
    if (submittedSettled) return;
    if (!isConversationUrl(pageUrl, url)) return;
    // Brief settle so any in-flight redirects within the SPA stabilize.
    setTimeout(() => {
      let cur = url;
      try {
        if (!win.isDestroyed()) cur = win.webContents.getURL() || url;
      } catch {
        // ignore
      }
      resolveSubmitted(cur);
    }, 250);
  }

  win.webContents.on("did-navigate", (_e, url) => maybeFireSubmittedFromUrl(url));
  win.webContents.on("did-navigate-in-page", (_e, url) => maybeFireSubmittedFromUrl(url));

  win.webContents.once("did-fail-load", (_e, _code, desc) => {
    clearTimeout(submissionTimer);
    clearTimeout(lifetimeTimer);
    fail(new Error(desc || "Load failed"));
  });

  // Main loop -----------------------------------------------------------------

  const loadT0 = Date.now();
  win.loadURL(pageUrl);
  win.webContents.once("did-finish-load", () => {
    logDualSearch(label, "loadURL→did-finish-load", Date.now() - loadT0);

    void (async () => {
      try {
        const settleBeforeT0 = Date.now();
        await new Promise((r) => setTimeout(r, settleBeforeScriptMs));
        logDualSearch(label, "settleBeforeScript (sleep)", Date.now() - settleBeforeT0);

        const scriptT0 = Date.now();
        const pageResult = await win.webContents.executeJavaScript(executeScript, true);
        logDualSearch(label, "executeJavaScript", Date.now() - scriptT0, pageResult);

        // Backup submission signal: if no nav event ever fired, use the URL
        // we ended up at after the script.
        let scriptEndUrl = "";
        try {
          scriptEndUrl = win.webContents.getURL() || "";
        } catch {
          scriptEndUrl = "";
        }
        if (!submittedSettled && scriptEndUrl) {
          resolveSubmitted(scriptEndUrl);
        }

        const settleAfterT0 = Date.now();
        await new Promise((r) => setTimeout(r, settleAfterScriptMs));
        logDualSearch(label, "settleAfterScript (sleep)", Date.now() - settleAfterT0);

        let finalUrl = "";
        try {
          finalUrl = win.webContents.getURL() || "";
        } catch {
          finalUrl = "";
        }

        clearTimeout(submissionTimer);
        clearTimeout(lifetimeTimer);
        if (!win.isDestroyed()) {
          try {
            win.close();
          } catch {
            // ignore
          }
        }
        if (!submittedSettled) resolveSubmitted(finalUrl);
        resolveDone(finalUrl);
      } catch (err) {
        clearTimeout(submissionTimer);
        clearTimeout(lifetimeTimer);
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });

  return { submittedPromise, donePromise };
}

function normalizeLlmTargets(targets) {
  if (!targets || typeof targets !== "object") {
    return { chatgpt: true, gemini: true, claude: true };
  }
  return {
    chatgpt: Boolean(targets.chatgpt),
    gemini: Boolean(targets.gemini),
    claude: Boolean(targets.claude),
  };
}

async function submitDualSearchToBothLlm(query, targets, callbacks = {}) {
  const notifyPanelState =
    typeof callbacks === "function" ? callbacks : callbacks.notifyPanelState;
  const rememberTabUrl =
    typeof callbacks === "object" && callbacks ? callbacks.rememberTabUrl : null;

  const raw = (query || "").trim();
  if (!raw) {
    return { ok: false, error: "Enter a question first." };
  }

  const t = normalizeLlmTargets(targets);
  if (!t.chatgpt && !t.gemini && !t.claude) {
    return { ok: false, error: "Select at least one model." };
  }

  const chatgptUrl = "https://chatgpt.com";
  /** Direct app URL avoids an extra redirect from the marketing root; same session as / . */
  const geminiUrl = "https://gemini.google.com/app";
  const claudeUrl = "https://claude.ai";

  const chatgptScript = buildChatgptScript(raw);
  const geminiScript = buildGeminiScript(raw);
  const claudeScript = buildClaudeScript(raw);

  const standardOpts = {
    settleBeforeScriptMs: 400,
    settleAfterScriptMs: 800,
    submissionTimeoutMs: 25000,
    maxLifetimeMs: 180000,
  };
  // Gemini's SPA is slow to hydrate in a hidden background window.
  const geminiOpts = {
    settleBeforeScriptMs: 1500,
    settleAfterScriptMs: 800,
    submissionTimeoutMs: 30000,
    maxLifetimeMs: 180000,
  };

  const submitT0 = Date.now();
  const jobs = [];
  if (t.chatgpt) {
    const job = runHiddenPartitionSearch(chatgptUrl, chatgptScript, standardOpts);
    jobs.push({ service: "chatgpt", ...job });
  }
  if (t.gemini) {
    const job = runHiddenPartitionSearch(geminiUrl, geminiScript, geminiOpts);
    jobs.push({ service: "gemini", ...job });
  }
  if (t.claude) {
    const job = runHiddenPartitionSearch(claudeUrl, claudeScript, standardOpts);
    jobs.push({ service: "claude", ...job });
  }

  // Don't let background donePromises crash on unhandled rejection. The window
  // will close itself / time out regardless.
  jobs.forEach((j) => {
    j.donePromise
      .then((url) => {
        if (typeof rememberTabUrl === "function" && url) {
          // Refresh the cached URL once the response has fully streamed, in case
          // the URL changed (rare).
          rememberTabUrl(url);
        }
        if (typeof notifyPanelState === "function") {
          notifyPanelState();
        }
      })
      .catch(() => {
        // Already reported via submittedPromise rejection (if applicable).
      });
  });

  // User-facing wait: only the *fast* submitted signal.
  const submittedResults = await Promise.allSettled(
    jobs.map((j) =>
      j.submittedPromise.then((url) => ({ service: j.service, url }))
    )
  );

  if (dualSearchDebugEnabled()) {
    console.log(
      `[dual-search] user-facing wall time ${Date.now() - submitT0}ms (slowest submitted signal)`
    );
  }

  // Stash conversation URLs so clicking each Pro tab opens the new chat.
  if (typeof rememberTabUrl === "function") {
    for (const r of submittedResults) {
      if (r.status === "fulfilled" && r.value && r.value.url) {
        rememberTabUrl(r.value.url);
      }
    }
  }

  if (typeof notifyPanelState === "function") {
    notifyPanelState();
  }

  // Build the per-service "actually sent" map for the launcher status text.
  const sent = { chatgpt: false, gemini: false, claude: false };
  let anyOk = false;
  for (const r of submittedResults) {
    if (r.status === "fulfilled" && r.value) {
      sent[r.value.service] = true;
      anyOk = true;
    }
  }

  if (!anyOk) {
    const firstErr = submittedResults.find((r) => r.status === "rejected");
    const msg =
      firstErr && firstErr.reason
        ? firstErr.reason.message || String(firstErr.reason)
        : "All submissions failed.";
    return { ok: false, error: msg };
  }

  return { ok: true, sent };
}

module.exports = {
  submitDualSearchToBothLlm,
};
