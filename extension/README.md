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
| `agent-control.js` | MAIN | maps extension commands → `window.ytAgent`; **talk-first** announce on first interaction |
| `bridge.js` | ISOLATED | relays messages between the popup and the MAIN-world agent (MAIN can't use `chrome.*`) |
| `service-worker.js` | — | dispatches the global `Alt+Shift+A` shortcut to the active tab |
| `popup.html` / `popup.js` | — | toolbar control panel — a **visual fallback**, not the primary entry |

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

## Use — it talks first (no clicking required)

This is an accessibility supplement, so the primary flow is **hands-free, no sighted
interaction**:

1. Open <https://www.youtube.com>. The agent auto-loads on every page (re-injects on
   navigation — no re-pasting).
2. **On your first interaction with the page** (a keypress — e.g. Tab/arrows from a screen
   reader — or a click), the agent **speaks**: *"YouTube accessibility agent ready. Hold
   Control-Shift-Space and speak to ask me anything, or press Alt-Shift-A for an overview."*
   (Browsers forbid audio on bare page-load, so the first interaction is the earliest it can
   legally speak.) It greets once per tab session.
3. **Hold the backtick key `` ` `` and speak** to ask something — **release to send**, and
   **press it again while the agent is replying to interrupt** and speak. You'll hear short
   tones: a rising beep when it starts listening, a higher beep when your voice is captured,
   and a soft beep when it's your turn again — so you're never waiting in silence. The agent
   also says what it's doing ("Searching.", "Opening."). Press **`Alt+Shift+A`** anytime for
   the full spoken overview of the page.
4. **Arrow keys browse the feed** (on the home page and search results): **Down/Up** move to
   the next/previous video and describe it ("Item 3 of 20: <title>, by <channel>, 10:26"),
   **Enter** plays it, **Escape** stops browsing. Arrows are ignored while you're typing in
   the search box, and on `/watch` (where they seek the player). The agent welcomes you by
   name when you're signed in, and on the home page reads out the available categories.

The **popup is a visual fallback** for sighted users / debugging — ▶ Start (continuous
loop), ■ Stop, 🔊 Greeting, and a Nano-transcription toggle. You can also drive everything
from the page console via `window.ytAgent` (e.g. `ytAgent.describeThumbnail(1)` for vision).

> Why a keypress and not autoplay on load: the browser's autoplay/gesture policy blocks
> speech and mic until the user interacts. Talking on first interaction is the accessible,
> policy-compliant version of "talk first."

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
