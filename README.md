# Discord Web Auto Message

A Chrome extension (Manifest V3) for **Discord Web** that:

- ⏱️ **Interval send** — posts a message every N seconds.
- 🤖 **Auto reply** — watches incoming messages and replies on keyword triggers
  (e.g. *if a message contains `A`, send `B`*).
- 🌙 **Keeps running in the background** — as long as the Discord tab stays open,
  it works even when you're not looking at the tab / it's unfocused.
- 🖥️ **Terminal-style UI** — a retro green-on-black console popup with a live
  activity log.

> ⚠️ **Use responsibly.** Automating a user account ("self-botting") and
> spamming may violate Discord's Terms of Service and can get your account
> actioned. This project is for educational/personal-automation purposes — you
> are responsible for how you use it.

## Install (load unpacked)

1. Clone or download this folder.
2. Open `chrome://extensions` in Chrome (or any Chromium browser).
3. Toggle **Developer mode** (top-right).
4. Click **Load unpacked** and select the `discord-web-auto-message` folder.
5. Open <https://discord.com/app>, log in, and open a channel.
6. Click the extension icon to open the terminal UI.

## Usage

Open the popup (terminal UI):

### Master
- **run daemon** — master on/off switch. Nothing runs unless this is on.

### Send engine
- **method** — how a message is entered before Enter is pressed:
  - `paste then enter` (default) — pastes the whole message in one shot via a
    synthetic `paste` event carrying a `DataTransfer`, just like a macro tool,
    then presses Enter. Fast.
  - `auto-type then enter` — types the message one character at a time. Slower
    but more "human"; useful if paste ever doesn't register.
- **type-speed** — ms per character for auto-type mode.
- If paste lands but the box stays empty, it automatically falls back to typing.

### Interval send
- Enable it, type a **message**, and set the interval in **seconds** (min 5).
- The message is sent into whatever channel is currently open in the tab.

### Auto reply
- Enable it and add one or more rules. Each rule is:
  - **if contains** → a substring to look for in incoming messages (e.g. `A`)
  - **reply** → what to send back (e.g. `B`)
  - **case-sensitive** → optional exact-case matching
- **cooldown** throttles how often replies fire (anti-spam).

Click **`:w save`** to apply. **`>_ send now`** sends the interval message
immediately. The **live activity** console streams every send/reply/error.

### Status & countdown
- The top line **`detect discord →`** shows whether the extension currently sees
  an open Discord tab with a channel ready (`OPEN — channel ready`), a Discord
  tab with no channel open, or `no discord tab open`.
- Next to **`--message`** a **countdown** (`next send in MM:SS`) ticks down to the
  next interval send while the daemon is running.
- The activity log records a line each time Discord is detected or lost, so you
  can confirm the extension found Discord open.

## How it works

- A content script runs on `discord.com`. It locates Discord's Slate.js message
  box and inserts text via `execCommand("insertText")` (with a synthetic paste
  event as a fallback), then dispatches an `Enter` keydown to send.
- Auto-reply uses a `MutationObserver` on the message list, so new messages are
  detected whether or not the tab is focused. Already-on-screen messages are
  seeded as "processed" so it only reacts to genuinely new ones, and messages it
  sent itself are ignored to avoid reply loops.
- Background tabs throttle JS timers to ~1s minimum, which is well within the
  interval range here, so interval-send and auto-reply keep working while the
  tab is open in the background.

## Files

| File | Purpose |
|------|---------|
| `manifest.json` | MV3 manifest, permissions, content-script registration |
| `content.js` | Core: sending, interval timer, auto-reply observer, logging |
| `popup.html` / `popup.js` | Terminal-style configuration UI + live log |

## Limitations / notes

- The tab must stay **open**. If you close the Discord tab, nothing runs (Chrome
  has no way to drive the page without it being loaded).
- Discord's DOM/class names change over time; selectors are kept resilient but
  may need updating if Discord ships a major redesign.
- Sends go to the **currently open channel**.
