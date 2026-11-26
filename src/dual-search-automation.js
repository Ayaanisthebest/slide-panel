/**
 * Browser-side submit logic: find composer → focus → fill query → Enter (or Send).
 * ChatGPT / Gemini align with chatgpt-search/cli.js and gemini-search/cli.js;
 * Claude mirrors the same pattern for claude.ai.
 */

function wrapPageRunner(query, findBlockBody) {
  const q = JSON.stringify(query);
  return `(async () => {
    const query = ${q};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function setReactValue(el, val) {
      try {
        const proto = el.constructor.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) {
          desc.set.call(el, val);
        } else {
          el.value = val;
        }
      } catch {
        el.value = val;
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }

    function visible(el) {
      if (!el) return false;
      if (el.offsetParent !== null) return true;
      const r = el.getClientRects();
      return r && r.length > 0;
    }

    async function trySubmit(findFn) {
      let lastErr;
      const pollMs = 220;
      const maxAttempts = 90;
      const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const el = findFn();
          if (visible(el)) {
            el.focus();
            el.click();
            await sleep(80);
            const tag = el.tagName && el.tagName.toUpperCase();
            if (tag === "TEXTAREA" || (tag === "INPUT" && el.type === "text")) {
              setReactValue(el, query);
            } else if (el.isContentEditable) {
              el.textContent = "";
              el.appendChild(document.createTextNode(query));
              el.dispatchEvent(
                new InputEvent("input", { bubbles: true, data: query, inputType: "insertText" })
              );
            } else {
              throw new Error("Unsupported composer element");
            }
            await sleep(100);
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Enter",
                code: "Enter",
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true,
              })
            );
            await sleep(40);
            el.dispatchEvent(
              new KeyboardEvent("keyup", {
                key: "Enter",
                code: "Enter",
                bubbles: true,
                cancelable: true,
              })
            );
            const end =
              typeof performance !== "undefined" ? performance.now() : Date.now();
            return {
              ok: true,
              attempts: attempt + 1,
              composerMs: Math.round(end - t0),
            };
          }
        } catch (e) {
          lastErr = e;
        }
        await sleep(pollMs);
      }
      const end = typeof performance !== "undefined" ? performance.now() : Date.now();
      const base = lastErr instanceof Error ? lastErr.message : String(lastErr || "Composer not found");
      throw new Error(
        base + " (polled " + maxAttempts + " times, " + Math.round(end - t0) + "ms)"
      );
    }

    ${findBlockBody}
  })()`;
}

function buildChatgptScript(query) {
  // ChatGPT's composer is a ProseMirror-based contenteditable (#prompt-textarea).
  // Same constraints as Claude: synthetic Enter doesn't fire the send keymap,
  // direct DOM writes aren't reflected in the editor model. Use execCommand to
  // insert, click the actual Send button, then wait for the URL to flip to a
  // conversation URL so the runner can remember it for the Pro tab click.
  const q = JSON.stringify(query);
  return `(async () => {
    const query = ${q};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

    function visible(el) {
      if (!el) return false;
      if (el.offsetParent !== null) return true;
      const r = el.getClientRects ? el.getClientRects() : [];
      return r && r.length > 0;
    }

    function findComposer() {
      let el = document.querySelector("#prompt-textarea");
      if (visible(el)) return el;
      for (const tb of document.querySelectorAll('[role="textbox"]')) {
        if (!visible(tb)) continue;
        const lab = (tb.getAttribute("aria-label") || "").toLowerCase();
        if (lab.includes("message") || lab.includes("send")) return tb;
      }
      for (const t of document.querySelectorAll("textarea")) {
        if (!visible(t)) continue;
        const ph = (t.placeholder || "").toLowerCase();
        if (ph.includes("ask") || ph.includes("message")) return t;
      }
      const tas = [...document.querySelectorAll("textarea")].filter(visible);
      if (tas.length) return tas[tas.length - 1];
      const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
      return eds[eds.length - 1] || null;
    }

    function findSendButton(composer) {
      const all = [...document.querySelectorAll("button")].filter(
        (b) => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true"
      );
      const looksLikeSend = (b) => {
        const lab = (b.getAttribute("aria-label") || "").toLowerCase();
        if (lab.includes("send") && !lab.includes("feedback")) return true;
        const testid = (b.getAttribute("data-testid") || "").toLowerCase();
        if (testid.includes("send")) return true;
        const txt = (b.textContent || "").trim().toLowerCase();
        if (txt === "send" || txt === "send message") return true;
        return false;
      };
      const candidates = all.filter(looksLikeSend);
      if (!candidates.length) return null;
      if (composer) {
        const root =
          composer.closest("form") ||
          composer.closest("[class*='composer']") ||
          composer.parentElement;
        if (root) {
          const local = candidates.find((b) => root.contains(b));
          if (local) return local;
        }
      }
      return candidates[candidates.length - 1];
    }

    function insertIntoComposer(composer) {
      composer.focus();
      composer.click();
      try {
        document.execCommand("selectAll", false);
        document.execCommand("delete", false);
      } catch {}

      const tag = composer.tagName && composer.tagName.toUpperCase();
      if (tag === "TEXTAREA" || tag === "INPUT") {
        const proto = composer.constructor.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(composer, query);
        else composer.value = query;
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: query, inputType: "insertText" }));
        return;
      }

      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, query);
      } catch {}

      const preview = (composer.textContent || composer.innerText || "").trim();
      if (!inserted || (query.length > 8 && !preview.includes(query.slice(0, 8)))) {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", query);
          composer.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
          );
        } catch {}
      }
    }

    // Wait (up to 15s) for the URL to flip to a conversation URL. Matches both
    // /c/<uuid> (standard chat) and /g/<gpt-id>/c/<uuid> (custom GPT chat).
    async function waitForConversationUrl() {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (/\\/c\\/[^/]+/.test(location.pathname)) return location.href;
        await sleep(200);
      }
      return location.href;
    }

    let composer = null;
    for (let i = 0; i < 90; i += 1) {
      composer = findComposer();
      if (composer) break;
      await sleep(220);
    }
    if (!composer) {
      throw new Error(
        "ChatGPT composer not found (polled 90 times, " +
          Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0) +
          "ms)"
      );
    }

    insertIntoComposer(composer);
    await sleep(250);

    let sendBtn = null;
    for (let i = 0; i < 50; i += 1) {
      sendBtn = findSendButton(composer);
      if (sendBtn) break;
      await sleep(120);
    }

    if (sendBtn) {
      sendBtn.click();
    } else {
      // Fallback to Enter; usually doesn't trigger ProseMirror's send keymap but
      // harmless on plain textareas.
      composer.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
      composer.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true })
      );
    }

    const finalUrl = await waitForConversationUrl();
    const end = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      ok: true,
      method: sendBtn ? "send-button" : "enter-fallback",
      composerMs: Math.round(end - t0),
      finalUrl,
    };
  })()`;
}

function buildGeminiScript(query) {
  // Gemini's composer is a rich contenteditable (often Quill / custom). Synthetic Enter
  // and direct DOM writes don't enable Send. Use insertText + click Send, then wait for
  // the response stream to finish before the hidden window closes.
  const q = JSON.stringify(query);
  return `(async () => {
    const query = ${q};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

    function visible(el) {
      if (!el) return false;
      if (el.offsetParent !== null) return true;
      const r = el.getClientRects ? el.getClientRects() : [];
      return r && r.length > 0;
    }

    function composerLooksLikeGemini(el) {
      if (!el || !visible(el)) return false;
      const lab = (el.getAttribute("aria-label") || "").toLowerCase();
      const ph = (el.getAttribute("placeholder") || "").toLowerCase();
      const name = (el.getAttribute("name") || "").toLowerCase();
      const combined = lab + " " + ph + " " + name;
      return (
        combined.includes("prompt") ||
        combined.includes("message") ||
        combined.includes("ask gemini") ||
        combined.includes("enter a prompt") ||
        combined.includes("type something")
      );
    }

    function findComposer() {
      const rich = document.querySelector("rich-textarea");
      if (rich) {
        const inner =
          rich.querySelector('[contenteditable="true"]') ||
          rich.querySelector('[role="textbox"]') ||
          rich.querySelector("textarea");
        if (visible(inner)) return inner;
      }
      for (const tb of document.querySelectorAll('[role="textbox"]')) {
        if (composerLooksLikeGemini(tb)) return tb;
      }
      for (const t of document.querySelectorAll("textarea")) {
        if (composerLooksLikeGemini(t)) return t;
      }
      for (const el of document.querySelectorAll('[contenteditable="true"]')) {
        if (composerLooksLikeGemini(el)) return el;
      }
      const ql = document.querySelector(".ql-editor[contenteditable='true']");
      if (visible(ql)) return ql;
      const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
      return eds[eds.length - 1] || null;
    }

    function findSendButton(composer) {
      const all = [...document.querySelectorAll("button, [role='button']")].filter((b) => {
        if (!visible(b)) return false;
        if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
        return true;
      });

      const looksLikeSend = (b) => {
        const lab = (b.getAttribute("aria-label") || "").toLowerCase();
        if (lab.includes("send") && !lab.includes("feedback")) return true;
        const title = (b.getAttribute("title") || "").toLowerCase();
        if (title.includes("send")) return true;
        const testid = (b.getAttribute("data-testid") || "").toLowerCase();
        if (testid.includes("send")) return true;
        const txt = (b.textContent || "").trim().toLowerCase();
        if (txt === "send" || txt === "send message") return true;
        const icon = (b.textContent || "").trim();
        if (icon === "send" || icon === "arrow_upward") return true;
        return false;
      };

      const candidates = all.filter(looksLikeSend);
      if (!candidates.length) return null;

      if (composer) {
        const root =
          composer.closest("form") ||
          composer.closest("rich-textarea") ||
          composer.closest("[class*='input']") ||
          composer.parentElement;
        if (root) {
          const local = candidates.find((b) => root.contains(b));
          if (local) return local;
        }
      }
      return candidates[candidates.length - 1];
    }

    function insertIntoComposer(composer) {
      composer.focus();
      composer.click();
      try {
        document.execCommand("selectAll", false);
        document.execCommand("delete", false);
      } catch {}

      const tag = composer.tagName && composer.tagName.toUpperCase();
      if (tag === "TEXTAREA" || tag === "INPUT") {
        const proto = composer.constructor.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(composer, query);
        else composer.value = query;
        composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: query, inputType: "insertText" }));
        return true;
      }

      let inserted = false;
      try {
        inserted = document.execCommand("insertText", false, query);
      } catch {}
      const preview = (composer.textContent || composer.innerText || "").trim();
      if (!inserted || (query.length > 8 && !preview.includes(query.slice(0, 8)))) {
        try {
          const dt = new DataTransfer();
          dt.setData("text/plain", query);
          composer.dispatchEvent(
            new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
          );
        } catch {}
      }
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, data: query, inputType: "insertText" }));
      return true;
    }

    async function waitForGeminiReply() {
      const startedAt = Date.now();
      const HARD_TIMEOUT_MS = 90000;
      const POLL_MS = 250;

      function hasStopButton() {
        for (const b of document.querySelectorAll("button, [role='button']")) {
          if (!visible(b) || b.disabled) continue;
          const lab = (b.getAttribute("aria-label") || "").toLowerCase();
          const title = (b.getAttribute("title") || "").toLowerCase();
          const combined = lab + " " + title;
          if (
            combined.includes("stop") &&
            (combined.includes("response") ||
              combined.includes("generat") ||
              combined.includes("stream") ||
              combined.includes("cancel"))
          ) {
            return true;
          }
        }
        return false;
      }

      function hasModelResponseText() {
        const nodes = document.querySelectorAll(
          "[data-message-author-role='model'], .model-response, message-content, .response-container"
        );
        for (const n of nodes) {
          const t = (n.textContent || "").trim();
          if (t.length > 12) return true;
        }
        return false;
      }

      let sawStreamingSignal = false;
      while (Date.now() - startedAt < 25000) {
        if (hasStopButton()) {
          sawStreamingSignal = true;
          break;
        }
        if (hasModelResponseText()) {
          sawStreamingSignal = true;
          break;
        }
        await sleep(POLL_MS);
      }

      const STABLE_MS = 1500;
      let goneSince = sawStreamingSignal ? 0 : Date.now();
      while (Date.now() - startedAt < HARD_TIMEOUT_MS) {
        if (hasStopButton()) {
          goneSince = 0;
        } else if (goneSince === 0) {
          goneSince = Date.now();
        } else if (Date.now() - goneSince >= STABLE_MS) {
          return { sawStreamingSignal, ms: Date.now() - startedAt };
        }
        await sleep(POLL_MS);
      }
      return { sawStreamingSignal, ms: Date.now() - startedAt, timedOut: true };
    }

    let composer = null;
    for (let i = 0; i < 90; i += 1) {
      composer = findComposer();
      if (composer) break;
      await sleep(220);
    }
    if (!composer) {
      throw new Error(
        "Gemini composer not found (polled 90 times, " +
          Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0) +
          "ms)"
      );
    }

    insertIntoComposer(composer);
    await sleep(350);

    let sendBtn = null;
    for (let i = 0; i < 50; i += 1) {
      sendBtn = findSendButton(composer);
      if (sendBtn) break;
      await sleep(120);
    }

    if (!sendBtn) {
      throw new Error("Gemini Send button not found");
    }

    sendBtn.click();
    const replyInfo = await waitForGeminiReply();
    const end = typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      ok: true,
      method: "send-button",
      composerMs: Math.round(end - t0),
      reply: replyInfo,
    };
  })()`;
}

function buildClaudeScript(query) {
  // Claude's composer is a ProseMirror editor. ProseMirror manages its own document
  // model and ignores direct DOM mutations (textContent assignment, appendChild, etc.)
  // and ignores synthetic keyboard events (`isTrusted: false`). To actually submit a
  // message we have to (a) insert text via `execCommand('insertText')` so ProseMirror's
  // `beforeinput` listener accepts it, then (b) click the real Send button — dispatching
  // a fake Enter does NOT trigger ProseMirror's send keymap.
  const q = JSON.stringify(query);
  return `(async () => {
    const query = ${q};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

    function visible(el) {
      if (!el) return false;
      if (el.offsetParent !== null) return true;
      const r = el.getClientRects ? el.getClientRects() : [];
      return r && r.length > 0;
    }

    function findComposer() {
      const pm = document.querySelector('.ProseMirror[contenteditable="true"]');
      if (visible(pm)) return pm;
      for (const tb of document.querySelectorAll('[role="textbox"]')) {
        if (!visible(tb)) continue;
        const lab = (tb.getAttribute("aria-label") || "").toLowerCase();
        if (
          lab.includes("claude") ||
          lab.includes("message") ||
          lab.includes("write") ||
          lab.includes("prompt") ||
          lab.includes("reply")
        ) {
          return tb;
        }
      }
      const eds = [...document.querySelectorAll('[contenteditable="true"]')].filter(visible);
      return eds[eds.length - 1] || null;
    }

    function findSendButton(composer) {
      // Find a visible, enabled Send button. Prefer ones near the composer (same form
      // or shared ancestor), then fall back to any matching button on the page.
      const all = [...document.querySelectorAll("button")].filter(
        (b) => visible(b) && !b.disabled && b.getAttribute("aria-disabled") !== "true"
      );

      const looksLikeSend = (b) => {
        const lab = (b.getAttribute("aria-label") || "").toLowerCase();
        if (lab.includes("send") && !lab.includes("feedback")) return true;
        const testid = (b.getAttribute("data-testid") || "").toLowerCase();
        if (testid.includes("send")) return true;
        const txt = (b.textContent || "").trim().toLowerCase();
        if (txt === "send" || txt === "send message") return true;
        return false;
      };

      const candidates = all.filter(looksLikeSend);
      if (!candidates.length) return null;

      // Prefer the one sharing the closest ancestor with the composer.
      if (composer) {
        const composerForm =
          composer.closest("form") ||
          composer.closest("fieldset") ||
          composer.parentElement;
        if (composerForm) {
          const local = candidates.find((b) => composerForm.contains(b));
          if (local) return local;
        }
      }
      return candidates[0];
    }

    // 1. Wait for the composer to mount.
    let composer = null;
    for (let i = 0; i < 90; i += 1) {
      composer = findComposer();
      if (composer) break;
      await sleep(220);
    }
    if (!composer) {
      throw new Error(
        "Claude composer not found (polled 90 times, " +
          Math.round((typeof performance !== "undefined" ? performance.now() : Date.now()) - t0) +
          "ms)"
      );
    }

    // 2. Focus and clear any existing draft.
    composer.focus();
    composer.click();
    await sleep(80);
    try {
      document.execCommand("selectAll", false);
      document.execCommand("delete", false);
    } catch {}

    // 3. Insert the query. execCommand is the only API ProseMirror reliably honors.
    let inserted = false;
    try {
      inserted = document.execCommand("insertText", false, query);
    } catch {}

    // Fallback: simulate a paste with a real DataTransfer. ProseMirror has a paste
    // handler that will accept this even though the event isn't trusted.
    if (!inserted || !(composer.textContent || "").includes(query.slice(0, 16))) {
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", query);
        composer.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
        );
        inserted = true;
      } catch {}
    }

    // Last-ditch fallback: textarea/input fields.
    if (!inserted) {
      const tag = composer.tagName && composer.tagName.toUpperCase();
      if (tag === "TEXTAREA" || tag === "INPUT") {
        const proto = composer.constructor.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, "value");
        if (desc && desc.set) desc.set.call(composer, query);
        else composer.value = query;
        composer.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }

    // Wait for Claude's UI to register the input and enable the Send button.
    await sleep(200);

    // 4. Click the real Send button. Dispatching synthetic Enter does NOT work here
    //    because ProseMirror's send keymap filters on event.isTrusted.
    let sendBtn = null;
    for (let i = 0; i < 40; i += 1) {
      sendBtn = findSendButton(composer);
      if (sendBtn) break;
      await sleep(120);
    }

    // Helper: wait for Claude's response to stream in. Claude (unlike ChatGPT/Gemini)
    // streams via a long-lived connection — if we close the hidden window too early
    // the server cancels the response and the chat is left stuck with our message
    // and no reply. So we wait until either:
    //   (a) the URL changes to /chat/<uuid> AND a "Stop" button appears (response
    //       started), then stays gone for 1.5s (response finished); or
    //   (b) we hit the hard timeout (90s) — fail-safe in case detection is wrong.
    async function waitForClaudeReply() {
      const startedAt = Date.now();
      const HARD_TIMEOUT_MS = 90000;
      const POLL_MS = 250;

      function hasStopButton() {
        for (const b of document.querySelectorAll("button")) {
          if (!visible(b) || b.disabled) continue;
          const lab = (b.getAttribute("aria-label") || "").toLowerCase();
          if (lab.includes("stop") && (lab.includes("response") || lab.includes("generat") || lab.includes("stream"))) {
            return true;
          }
          const testid = (b.getAttribute("data-testid") || "").toLowerCase();
          if (testid.includes("stop")) {
            return true;
          }
        }
        return false;
      }

      // Phase 1: wait for streaming to actually begin (Stop button appears OR URL
      // changes to a chat URL). Max 20s. If neither happens, fall through anyway.
      let sawStreamingSignal = false;
      while (Date.now() - startedAt < 20000) {
        if (hasStopButton()) {
          sawStreamingSignal = true;
          break;
        }
        if (/\\/chat\\//.test(location.pathname)) {
          // URL flipped to a chat — give the Stop button a beat to mount.
          for (let i = 0; i < 8; i += 1) {
            if (hasStopButton()) {
              sawStreamingSignal = true;
              break;
            }
            await sleep(150);
          }
          if (sawStreamingSignal) break;
          // No stop button after URL change is possible for very short responses.
          // Bail out of phase 1 and let phase 2 handle the wait.
          break;
        }
        await sleep(POLL_MS);
      }

      // Phase 2: wait for streaming to finish. The Stop button disappears when
      // Claude is done. We require it to be gone for 1.5 consecutive seconds.
      const STABLE_MS = 1500;
      let goneSince = sawStreamingSignal ? 0 : Date.now();
      while (Date.now() - startedAt < HARD_TIMEOUT_MS) {
        const stopVisible = hasStopButton();
        if (stopVisible) {
          goneSince = 0;
        } else if (goneSince === 0) {
          goneSince = Date.now();
        } else if (Date.now() - goneSince >= STABLE_MS) {
          return { sawStreamingSignal, ms: Date.now() - startedAt };
        }
        await sleep(POLL_MS);
      }
      return { sawStreamingSignal, ms: Date.now() - startedAt, timedOut: true };
    }

    if (sendBtn) {
      sendBtn.click();
      const replyInfo = await waitForClaudeReply();
      const end = typeof performance !== "undefined" ? performance.now() : Date.now();
      return {
        ok: true,
        method: "send-button",
        composerMs: Math.round(end - t0),
        reply: replyInfo,
      };
    }

    // Absolute last resort — try Enter. Usually a no-op on Claude, but harmless.
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      })
    );
    composer.dispatchEvent(
      new KeyboardEvent("keyup", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      })
    );
    const end = typeof performance !== "undefined" ? performance.now() : Date.now();
    return { ok: true, method: "enter-fallback", composerMs: Math.round(end - t0) };
  })()`;
}

module.exports = {
  buildChatgptScript,
  buildGeminiScript,
  buildClaudeScript,
};
