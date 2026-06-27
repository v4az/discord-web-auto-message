/* Discord Web Auto Message - content script
 *
 * Runs inside the Discord web tab. Two features:
 *   1. Interval send  - posts a configured message every N seconds.
 *   2. Auto reply     - watches incoming messages; when one contains a
 *                       trigger substring, posts the matching reply.
 *
 * Both keep working while the tab is open but unfocused/in the background.
 * (Background tabs only throttle timers to ~1s minimum, which is fine here,
 * and the MutationObserver fires regardless of focus.)
 */

(() => {
  "use strict";

  const DEFAULT_CONFIG = {
    enabled: false,
    interval: {
      enabled: false,
      seconds: 60,
      message: "",
    },
    reply: {
      enabled: false,
      cooldownSeconds: 3,
      // each rule: { contains, reply, caseSensitive }
      rules: [],
    },
  };

  let config = DEFAULT_CONFIG;
  let intervalTimer = null;
  let observer = null;
  let nextSendAt = null; // timestamp of the next interval send
  let heartbeatTimer = null;
  let lastDiscordOpen = null;

  // ---- activity log (shown in the terminal UI popup) ----------------------
  function logEvent(level, text) {
    const entry = { t: Date.now(), level, text };
    chrome.storage.local.get("logs", (data) => {
      const logs = Array.isArray(data.logs) ? data.logs : [];
      logs.push(entry);
      while (logs.length > 80) logs.shift();
      chrome.storage.local.set({ logs });
    });
    console.log(`[AutoMessage] ${text}`);
  }

  // ---- de-dupe / loop protection -----------------------------------------
  const processedMessageIds = new Set();
  let lastReplyAt = 0;
  // remember text we sent ourselves so we never reply to our own messages
  const recentlySent = []; // { text, time }

  function rememberSent(text) {
    const now = Date.now();
    recentlySent.push({ text: text.trim(), time: now });
    // keep only the last 30s worth
    while (recentlySent.length && now - recentlySent[0].time > 30000) {
      recentlySent.shift();
    }
  }

  function wasRecentlySentByUs(text) {
    const now = Date.now();
    const t = text.trim();
    return recentlySent.some((e) => e.text === t && now - e.time < 30000);
  }

  // ---- finding the editor -------------------------------------------------
  function findEditor() {
    return (
      document.querySelector('div[role="textbox"][contenteditable="true"]') ||
      document.querySelector('[data-slate-editor="true"]') ||
      document.querySelector('div[contenteditable="true"]')
    );
  }

  // ---- runtime heartbeat (so the popup can show status + countdown) -------
  function writeRuntime() {
    const editor = findEditor();
    const discordOpen = !!editor;

    // log only when the open/closed state changes, so it's a useful signal
    if (discordOpen !== lastDiscordOpen) {
      if (discordOpen) logEvent("ok", "discord channel detected — message box ready");
      else logEvent("err", "no message box — open a Discord channel in this tab");
      lastDiscordOpen = discordOpen;
    }

    chrome.storage.local.set({
      runtime: {
        heartbeat: Date.now(),
        discordOpen,
        url: location.pathname,
        intervalActive: !!intervalTimer,
        nextSendAt: intervalTimer ? nextSendAt : null,
      },
    });
  }

  function startHeartbeat() {
    if (heartbeatTimer) return;
    writeRuntime();
    heartbeatTimer = setInterval(writeRuntime, 1000);
  }

  // ---- sending a message --------------------------------------------------
  // Discord uses a Slate.js editor, so we can't just set textContent.
  // Insert text via execCommand/paste so Slate's onChange fires, then Enter.
  function setEditorText(editor, text) {
    editor.focus();

    // Try execCommand insertText first (fires beforeinput -> Slate handles it)
    let ok = false;
    try {
      ok = document.execCommand("insertText", false, text);
    } catch (e) {
      ok = false;
    }

    if (!ok) {
      // Fallback: simulate a paste event with the text
      try {
        const dt = new DataTransfer();
        dt.setData("text/plain", text);
        const pasteEvent = new ClipboardEvent("paste", {
          clipboardData: dt,
          bubbles: true,
          cancelable: true,
        });
        editor.dispatchEvent(pasteEvent);
      } catch (e) {
        console.warn("[AutoMessage] paste fallback failed", e);
      }
    }
  }

  function pressEnter(editor) {
    const opts = {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    };
    editor.dispatchEvent(new KeyboardEvent("keydown", opts));
    editor.dispatchEvent(new KeyboardEvent("keypress", opts));
    editor.dispatchEvent(new KeyboardEvent("keyup", opts));
  }

  function sendMessage(text) {
    if (!text || !text.trim()) return false;
    const editor = findEditor();
    if (!editor) {
      logEvent("err", "message box not found — open a channel first");
      return false;
    }
    setEditorText(editor, text);
    // small delay so Slate commits the text before we hit Enter
    setTimeout(() => pressEnter(editor), 60);
    rememberSent(text);
    logEvent("send", "sent: " + text);
    return true;
  }

  // ---- interval sending ---------------------------------------------------
  function startInterval() {
    stopInterval();
    if (!config.enabled || !config.interval.enabled) return;
    const seconds = Math.max(5, Number(config.interval.seconds) || 60);
    if (!config.interval.message.trim()) return;
    nextSendAt = Date.now() + seconds * 1000;
    intervalTimer = setInterval(() => {
      sendMessage(config.interval.message);
      nextSendAt = Date.now() + seconds * 1000;
      writeRuntime();
    }, seconds * 1000);
    logEvent("info", `interval send armed: every ${seconds}s`);
    writeRuntime();
  }

  function stopInterval() {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
    nextSendAt = null;
  }

  // ---- auto reply ---------------------------------------------------------
  function getMessageText(node) {
    const contentEl = node.querySelector('[id^="message-content-"]');
    return (contentEl ? contentEl.textContent : node.textContent) || "";
  }

  function matchRule(text) {
    for (const rule of config.reply.rules) {
      if (!rule || !rule.contains || !rule.reply) continue;
      const hay = rule.caseSensitive ? text : text.toLowerCase();
      const needle = rule.caseSensitive
        ? rule.contains
        : rule.contains.toLowerCase();
      if (needle && hay.includes(needle)) return rule;
    }
    return null;
  }

  function handleMessageNode(node) {
    if (!node || node.nodeType !== 1) return;
    const id = node.id || "";
    if (!id.startsWith("chat-messages-")) return;
    if (processedMessageIds.has(id)) return;
    processedMessageIds.add(id);

    if (!config.enabled || !config.reply.enabled) return;

    const text = getMessageText(node);
    if (!text.trim()) return;
    if (wasRecentlySentByUs(text)) return; // don't reply to ourselves

    const rule = matchRule(text);
    if (!rule) return;

    const now = Date.now();
    const cooldown = Math.max(0, Number(config.reply.cooldownSeconds) || 0) * 1000;
    if (now - lastReplyAt < cooldown) return;
    lastReplyAt = now;

    logEvent("reply", `trigger "${rule.contains}" matched -> reply "${rule.reply}"`);
    sendMessage(rule.reply);
  }

  function startObserver() {
    stopObserver();
    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (added.nodeType !== 1) continue;
          if (added.id && added.id.startsWith("chat-messages-")) {
            handleMessageNode(added);
          }
          // sometimes messages are added nested
          if (added.querySelectorAll) {
            added
              .querySelectorAll('[id^="chat-messages-"]')
              .forEach(handleMessageNode);
          }
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Seed processed ids with whatever is already on screen so we only
    // react to genuinely new messages.
    document
      .querySelectorAll('[id^="chat-messages-"]')
      .forEach((n) => processedMessageIds.add(n.id));

    logEvent("info", "watching for incoming messages");
  }

  function stopObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
  }

  // ---- config wiring ------------------------------------------------------
  function applyConfig() {
    startInterval();
    if (config.enabled && config.reply.enabled) {
      startObserver();
    } else {
      stopObserver();
    }
  }

  function loadConfig() {
    chrome.storage.local.get("config", (data) => {
      config = Object.assign({}, DEFAULT_CONFIG, data.config || {});
      config.interval = Object.assign({}, DEFAULT_CONFIG.interval, config.interval);
      config.reply = Object.assign({}, DEFAULT_CONFIG.reply, config.reply);
      if (!Array.isArray(config.reply.rules)) config.reply.rules = [];
      applyConfig();
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.config) {
      config = Object.assign({}, DEFAULT_CONFIG, changes.config.newValue || {});
      config.interval = Object.assign({}, DEFAULT_CONFIG.interval, config.interval);
      config.reply = Object.assign({}, DEFAULT_CONFIG.reply, config.reply);
      if (!Array.isArray(config.reply.rules)) config.reply.rules = [];
      applyConfig();
    }
  });

  // Manual "send now" trigger from the popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "SEND_NOW") {
      const ok = sendMessage(msg.text);
      sendResponse({ ok });
    }
    return true;
  });

  loadConfig();
  startHeartbeat();
  logEvent("info", "content script loaded on " + location.host);
})();
