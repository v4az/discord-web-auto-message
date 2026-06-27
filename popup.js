/* Terminal-style popup: loads config, renders reply rules, streams the log. */

const DEFAULT_CONFIG = {
  enabled: false,
  sendMethod: "paste",
  typingDelayMs: 25,
  reply: { enabled: false, cooldownSeconds: 3, rules: [] },
};

const $ = (id) => document.getElementById(id);
let rules = [];

/* ---------- rules ---------- */
function renderRules() {
  const wrap = $("rules");
  wrap.innerHTML = "";
  rules.forEach((rule, i) => {
    const div = document.createElement("div");
    div.className = "rule";
    div.innerHTML = `
      <div class="row">
        <span style="color:var(--fg-dim)">if&nbsp;~</span>
        <input type="text" data-i="${i}" data-k="contains" placeholder="contains (e.g. A)" value="${esc(rule.contains)}" />
      </div>
      <div class="row">
        <span style="color:var(--fg-dim)">&gt;&gt;&nbsp;</span>
        <input type="text" data-i="${i}" data-k="reply" placeholder="reply (e.g. B)" value="${esc(rule.reply)}" />
      </div>
      <div class="row" style="margin-bottom:0;">
        <label class="chk" style="flex:1;margin:0;">
          <input type="checkbox" data-i="${i}" data-k="caseSensitive" ${rule.caseSensitive ? "checked" : ""} /> case-sensitive
        </label>
        <button class="danger" data-del="${i}">rm</button>
      </div>`;
    wrap.appendChild(div);
  });

  wrap.querySelectorAll("input[data-k]").forEach((el) => {
    el.addEventListener("input", (e) => {
      const i = +e.target.dataset.i;
      const k = e.target.dataset.k;
      rules[i][k] = e.target.type === "checkbox" ? e.target.checked : e.target.value;
    });
  });
  wrap.querySelectorAll("button[data-del]").forEach((el) => {
    el.addEventListener("click", (e) => {
      rules.splice(+e.target.dataset.del, 1);
      renderRules();
    });
  });
}

function esc(s) {
  return String(s || "").replace(/"/g, "&quot;");
}

/* ---------- status ---------- */
function updateStatus() {
  const on = $("enabled").checked;
  const el = $("masterStatus");
  el.textContent = on ? "[ ACTIVE ]" : "[ DISABLED ]";
  el.className = "status " + (on ? "on" : "off");
}

/* ---------- load / save ---------- */
function load() {
  chrome.storage.local.get("config", (data) => {
    const c = Object.assign({}, DEFAULT_CONFIG, data.config || {});
    c.reply = Object.assign({}, DEFAULT_CONFIG.reply, c.reply);

    $("enabled").checked = !!c.enabled;
    $("sendMethod").value = c.sendMethod === "type" ? "type" : "paste";
    $("typingDelay").value = c.typingDelayMs ?? 25;
    $("replyEnabled").checked = !!c.reply.enabled;
    $("cooldown").value = c.reply.cooldownSeconds ?? 3;

    rules = Array.isArray(c.reply.rules) ? c.reply.rules.slice() : [];
    if (rules.length === 0) rules.push({ contains: "A", reply: "B", caseSensitive: false });
    renderRules();
    updateStatus();
  });
}

function save() {
  const config = {
    enabled: $("enabled").checked,
    sendMethod: $("sendMethod").value === "type" ? "type" : "paste",
    typingDelayMs: Math.max(0, Math.min(500, +$("typingDelay").value || 25)),
    reply: {
      enabled: $("replyEnabled").checked,
      cooldownSeconds: Math.max(0, +$("cooldown").value || 0),
      rules: rules.filter((r) => r.contains && r.reply),
    },
  };
  chrome.storage.local.set({ config }, () => pushLine("ok", "config saved :w"));
}

/* ---------- console / log stream ---------- */
function fmtTime(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderLogs(logs) {
  const con = $("console");
  con.innerHTML = "";
  if (!logs || !logs.length) {
    con.innerHTML = '<div class="l comment cursor">awaiting events</div>';
    return;
  }
  logs.slice(-80).forEach((e) => {
    const div = document.createElement("div");
    div.className = "l";
    // monochrome: emphasise sends/errors in bright white, dim the rest
    const bright = e.level === "send" || e.level === "reply" || e.level === "err" || e.level === "ok";
    const color = bright ? "var(--fg-bright)" : "var(--fg-dim)";
    div.innerHTML =
      `<span style="color:var(--fg-dim)">[${fmtTime(e.t)}]</span> ` +
      `<span style="color:${color}">${e.level.toUpperCase().padEnd(5)}</span> ` +
      `<span style="color:${bright ? "var(--fg)" : "var(--fg-dim)"}">${escHtml(e.text)}</span>`;
    con.appendChild(div);
  });
  con.scrollTop = con.scrollHeight;
}

function escHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function pushLine(level, text) {
  chrome.storage.local.get("logs", (data) => {
    const logs = Array.isArray(data.logs) ? data.logs : [];
    logs.push({ t: Date.now(), level, text });
    while (logs.length > 80) logs.shift();
    chrome.storage.local.set({ logs });
  });
}

function refreshLogs() {
  chrome.storage.local.get("logs", (data) => renderLogs(data.logs));
}

/* ---------- discord detection ---------- */
let runtimeCache = null;

function tick() {
  const now = Date.now();
  const rt = runtimeCache;
  const statusEl = $("discordStatus");
  const alive = rt && now - rt.heartbeat < 4000;

  if (!rt || !alive) {
    statusEl.textContent = "no discord tab open";
    statusEl.className = "bad";
  } else if (rt.discordOpen) {
    statusEl.textContent = "OPEN — channel ready";
    statusEl.className = "ok";
  } else {
    statusEl.textContent = "tab open, no channel";
    statusEl.className = "bad";
  }
}

function refreshRuntime() {
  chrome.storage.local.get("runtime", (data) => {
    runtimeCache = data.runtime || null;
    tick();
  });
}

/* ---------- events ---------- */
$("addRule").addEventListener("click", () => {
  rules.push({ contains: "", reply: "", caseSensitive: false });
  renderRules();
});
$("enabled").addEventListener("change", updateStatus);
$("save").addEventListener("click", save);
$("clearLog").addEventListener("click", () => chrome.storage.local.set({ logs: [] }));

$("sendNow").addEventListener("click", () => {
  const text = $("testText").value;
  if (!text.trim()) {
    pushLine("err", "test box is empty — type something to send");
    return;
  }
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (!tabs[0]) return;
    chrome.tabs.sendMessage(tabs[0].id, { type: "SEND_NOW", text }, () => {
      if (chrome.runtime.lastError) {
        pushLine("err", "no discord tab active — open discord.com and a channel");
      }
    });
  });
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.logs) renderLogs(changes.logs.newValue);
  if (changes.runtime) {
    runtimeCache = changes.runtime.newValue || null;
    tick();
  }
});

load();
refreshLogs();
refreshRuntime();
setInterval(tick, 1000);
