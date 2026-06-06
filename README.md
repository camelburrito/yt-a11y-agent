# YouTube A11y Agent (WebMCP)

An in-browser accessibility assistant for YouTube, built on **WebMCP**. It registers a
set of [WebMCP](https://github.com/webmachinelearning/webmcp) tools on YouTube pages so
an in-browser AI agent can help people with accessibility needs find, understand, and
control YouTube videos — by voice, in plain language, hands-free.

## Why tools, not an overlay

Most "accessibility add-ons" inject overlays or rewrite the page's accessibility tree.
That fights the assistive technology a user already trusts and often makes things worse.

This project takes the opposite stance: **the agent is an intermediary, never a mutator.**
We expose *tools* — `list the home feed`, `open video 3`, `load more` — that **read**
page state and **act** on the user's behalf (navigate, scroll, actuate native controls).
We never inject overlays, rewrite the DOM, or touch ARIA. Your screen reader, your
magnifier, your switch control keep seeing the real YouTube, unchanged. The AI just
drives it for you.

## Status

All journeys are **implemented**, and their selectors are **verified against live YouTube**
via a headless harness (`npm run verify:selectors`). Two paths remain partially verified
(noted below) because they need flags or a user gesture.

| Journey      | Tools | State |
|--------------|-------|-------|
| **Home**     | `list_home_feed`, `describe_home`, `open_video`, `load_more_home` | ✅ verified live |
| Search       | `run_search`, `list_results`, `refine_search`, `open_result` | ✅ verified live |
| Watch        | `get_video_info`, `get_transcript`, `summarize_video`, `plain_language_summary`, `jump_to`, `playback_control`, `set_captions` | ✅ verified live¹ |
| Watch Next   | `list_up_next`, `play_next`, `set_autoplay` | ✅ verified live |
| Comments     | `get_comments`, `summarize_comments`, `get_pinned_comment` | ✅ verified live |
| Picture-in-Picture | `enter_pip`, `exit_pip` | ✅ button + fallback verified² |

¹ Info/playback/captions/native controls verified. `get_transcript` *reads* a transcript
fine; programmatically *opening* a closed transcript panel is best-effort.
² The PiP button and fallback are present; the direct-API vs. user-gesture path (open
question c) needs a flagged interactive run. `get_video_info` now flags `adPlaying` so the
agent doesn't read a preroll ad's timing as the video's.

`where_am_i` works everywhere and tells the agent which surface you're on. The AI agent
itself runs on **Chrome's on-device Gemini Nano** (no API key) — see
[`src/agent/`](src/agent/).

## Getting started

New here? This is a research/preview project that rides on experimental Chrome features,
so setup is a few manual steps. Follow them in order — it takes about 10 minutes (plus a
one-time model download).

### What you need

- **Google Chrome** (a recent version — Dev/Canary works best for the experimental APIs).
- About **2–4 GB free disk** for the on-device model (downloaded once, on first use).
- A few minutes. No accounts, no API keys, no paid services.

### Step 1 — Turn on three Chrome flags

Flags are Chrome's experimental on/off switches. For each link below: paste it into Chrome's
address bar, press Enter, set the dropdown as noted, then click **Relaunch** at the bottom
when prompted (do all three first, then relaunch once).

| Paste into the address bar | Set to |
|---|---|
| `chrome://flags/#enable-webmcp-testing` | **Enabled** — turns on the WebMCP tool API |
| `chrome://flags/#prompt-api-for-gemini-nano` | **Enabled** — the on-device AI model |
| `chrome://flags/#optimization-guide-on-device-model` | **Enabled BypassPerfRequirement** — lets the model download |

> If a flag isn't found, your Chrome is likely too old — update it, or install
> [Chrome Canary](https://www.google.com/chrome/canary/).

### Step 2 — Load the agent

The project runs two scripts on YouTube: the **provider** (registers the tools) and the
**agent** (the AI that uses them). Three ways to load them, easiest first:

**Option 0 — Chrome extension (recommended).** Auto-injects on every YouTube page (no
re-pasting) and is **hands-free**: it speaks when you first interact, welcomes you by name
when signed in, and lets you **browse the feed with the arrow keys** (Down/Up to move + hear
each video, Enter to play, Escape to exit — an arrow steps you back in). **Tap the `` ` ``
(backtick) key once and speak** — it sends automatically when you pause (the mic is never
held open), and tapping again interrupts; earcons + spoken cues tell you what's happening.
`Alt+Shift+A`
gives a full overview (a popup is the visual fallback). Open `chrome://extensions` → enable **Developer mode** → **Load
unpacked** → select the **`extension/`** folder. Full steps in
[`extension/README.md`](extension/README.md). The two manual options below are for quick
experiments without installing anything.

**Option A — DevTools snippets (quickest, nothing to install).**
1. Open <https://www.youtube.com>, then open DevTools: **⌥⌘J** (Mac) / **Ctrl+Shift+J**
   (Windows/Linux).
2. Go to the **Sources** tab → **Snippets** pane (click `»` if hidden) → **+ New snippet**.
3. Make one snippet per file: copy the contents of
   [`src/agent/dev-agent.user.js`](src/agent/dev-agent.user.js) into the first and
   [`src/youtube-a11y-agent.user.js`](src/youtube-a11y-agent.user.js) into the second
   (save each with **⌘S** / **Ctrl+S**).
4. **Run the agent snippet first, then the provider snippet** (right-click → Run). Order
   matters so the agent captures the provider's tools.
5. You'll re-run them after a full page reload (they survive in-app navigation).

**Option B — Tampermonkey (persists automatically).**
1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension.
2. Open each `src/…user.js` file's raw URL in Chrome; Tampermonkey offers an **Install**
   page — install both. (Keep the `@grant none` header — it's what lets the scripts see the
   WebMCP API.) They now load on every YouTube page automatically.

### Step 3 — Confirm it loaded

On <https://www.youtube.com>, open the DevTools **Console**. You should see lines like:

```
[yt-a11y] surface="home" path="/" registered 5 tool(s): where_am_i, list_home_feed, ...
[yt-a11y-agent] ready. Gemini Nano: available. voice: tts=true stt=true
```

If Gemini shows `downloadable`/`downloading`, the model is fetching — give it a few minutes
(it only happens once).

### Step 4 — Use it

In the Console:

```js
await ytAgent.availability();   // "available" when the model is ready
ytAgent.start();                // hands-free: it greets you, then you just TALK back
```

`start()` is the real mode: the agent speaks a greeting, then listens for your answer,
responds, and listens again — so you simply talk. Say **"stop"** (or run `ytAgent.stop()`)
to end. If the mic doesn't pick you up, click the page once first, or use a hotkey:
`ytAgent.enablePushToTalk()` (press **Ctrl+Shift+Space** to speak one turn).

Prefer typing? `await ytAgent.ask("search for lo-fi music")`, then
`await ytAgent.ask("open the second result")` — watch the Console show the tool set change
as the page navigates.

**Vision** (describe what a thumbnail looks like, for a non-sighted user): ask
`await ytAgent.ask("describe the thumbnail of the second video")`, or directly
`await ytAgent.describeThumbnail(1)`. It uses on-device Nano image understanding and returns
a concrete spoken description (subjects, setting, on-screen text, mood).

### Troubleshooting

| Symptom | Fix |
|---|---|
| No `[yt-a11y]` line in the console | The provider didn't load. Re-run the snippet, or check Tampermonkey is enabled for youtube.com. Hard-reload and re-run (snippets reset on reload). |
| `WebMCP API not found` | `#enable-webmcp-testing` isn't on, Chrome wasn't relaunched, or a script lost `@grant none`. |
| `ytAgent.availability()` says `unavailable` | Gemini Nano flags aren't both on, or your device/Chrome can't run it. Try Chrome Canary. |
| Tools return blank/empty lists | YouTube changed its page structure (it does, often). Run `npm run verify:selectors` to see what's drifting — see [Development](#development). |
| Nothing is spoken | Click anywhere on the YouTube page once, then run the command — console calls don't count as a user gesture, which can mute speech. (The agent already waits for voices and calls `resume()` to dodge Chrome's silence bugs.) `ytAgent.ask(...)` still returns text in the console regardless. |
| Agent says "I'm calling a tool…" but nothing happens | You're on an older build of the script — update to the current `dev-agent.user.js` (v0.3.0+), which drives tools with a manual JSON loop instead of Nano's unreliable native tool-calling. |

To call tools by hand instead of through the agent, use a WebMCP inspector such as the
**Model Context Tool Inspector** extension.

## How it works

- Runs in the page's **main world** (so `document.modelContext` /
  `navigator.modelContext` is visible) — a userscript today, a `world: "MAIN"` MV3
  extension later.
- **Route-scoped registration:** each YouTube surface (home, search, watch, …) registers
  its own tools, torn down via `AbortController` on navigation so the agent only ever sees
  tools relevant to where you are.
- **Read-and-act, AT-safe:** tools return plain text and perform navigation/native
  actions; nothing mutates the page or its accessibility tree.
- **Media out-of-band:** speech and vision are handled in the script layer; tools
  themselves pass text only (WebMCP has no standard multimodal tool I/O yet).

See [`docs/architecture/yt-a11y-agent.md`](docs/architecture/yt-a11y-agent.md) for the
full architecture (with diagrams), and [`CLAUDE.md`](CLAUDE.md) for conventions and open
questions.

## Development

The userscripts in `src/` have **no build step** — edit and reload. The only tooling is
headless selector verification:

```bash
npm install            # installs puppeteer-core (drives your installed Chrome)
npm run verify:selectors
```

This runs the provider's actual extraction logic against live YouTube (`/results` → a real
`/watch`) and prints what each journey scrapes — the automated version of "open DevTools and
check the selectors still work." Run it whenever YouTube's DOM might have drifted. It checks
the DOM layer only (no WebMCP/Gemini flags needed).

## License

[MIT](LICENSE)
