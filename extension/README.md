# YouTube A11y Agent — Chrome extension (MV3)

The installable form of the project. Instead of pasting snippets, it auto-injects the
**provider** (WebMCP tools) and the **agent** (on-device Gemini Nano + voice + vision) on
every YouTube page, and gives you a small popup to start/stop a hands-free conversation.

It reuses the exact same code as the userscripts — `provider.js` and `agent.js` are synced
from `src/` by `npm run build:extension` (don't edit them directly).

## What's inside

| File | World | Role |
|------|-------|------|
| `manifest.json` | — | MV3 manifest; declares the content scripts + popup |
| `agent.js` | MAIN | the consumer agent (synced from `src/agent/dev-agent.user.js`) |
| `provider.js` | MAIN | the WebMCP tool provider (synced from `src/youtube-a11y-agent.user.js`) |
| `agent-control.js` | MAIN | maps extension commands → `window.ytAgent` |
| `bridge.js` | ISOLATED | relays messages between the popup and the MAIN-world agent (MAIN can't use `chrome.*`) |
| `popup.html` / `popup.js` | — | the toolbar control panel (out of the page's a11y tree) |

Why two content-script "worlds": `navigator.modelContext` and the Prompt API only exist in
the page's **MAIN** world, but `chrome.*` messaging only works in the **ISOLATED** world —
so the agent runs in MAIN and `bridge.js` shuttles popup commands across.

## Requirements

Same Chrome flags as the rest of the project (enable, then relaunch):

- `chrome://flags/#enable-webmcp-testing`
- `chrome://flags/#prompt-api-for-gemini-nano`
- `chrome://flags/#optimization-guide-on-device-model` → "Enabled BypassPerfRequirement"
- `chrome://flags/#prompt-api-for-gemini-nano-multimodal-input` (for the vision feature)

## Install (load unpacked)

1. Run `npm run build:extension` once (generates `provider.js` + `agent.js`). They're also
   committed, so you can skip this unless you changed `src/`.
2. Open `chrome://extensions`, toggle **Developer mode** (top-right) on.
3. Click **Load unpacked** and select this `extension/` folder.
4. Pin the extension (puzzle-piece icon → pin) so the popup is one click away.

## Use

1. Open <https://www.youtube.com>. The agent auto-loads (check the console for
   `[yt-a11y]` / `[yt-a11y-agent]` lines). Unlike the snippets, it re-injects itself on
   every navigation — no re-pasting.
2. Click the extension's toolbar icon to open the popup:
   - **▶ Start talking** — hands-free conversation: it greets you, then listens → responds →
     listens. Say "stop" (or click **■ Stop**) to end. *Click the YouTube page once first so
     the mic has a user gesture.*
   - **🔊 Greeting** — just the proactive orientation ("You're on the home page… explore your
     feed or search?").
   - **Nano transcription** checkbox — experimental on-device STT (slower; Web Speech is the
     default).
3. You can still drive it from the page console via `window.ytAgent` (e.g.
   `ytAgent.describeThumbnail(1)` for the vision feature).

## Notes & limitations

- **State still resets on full navigation.** The content scripts re-inject automatically
  (so the agent is always present), but per-page conversation history doesn't carry across a
  full document load yet. Persisting it would move conversation state into a background
  service worker — the natural next enhancement (there's intentionally no service worker in
  this scaffold).
- **No icons yet** — the manifest omits `default_icon`, so Chrome shows a default puzzle
  piece. Drop PNGs in and add an `icons` block when ready.
- **Editing logic:** change `src/…`, then `npm run build:extension`, then reload the
  unpacked extension in `chrome://extensions`.
- Packaging for the Web Store later wants real icons, a privacy policy, and permission
  justifications (host access to youtube.com). This scaffold is for local/dev use.
