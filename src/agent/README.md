# Dev consumer agent + voice harness

`dev-agent.user.js` is the **development** consumer (the MCP client side) for the YouTube
A11y Agent. It consumes the WebMCP tools registered by the provider
(`../youtube-a11y-agent.user.js`) and drives them with **Chrome's built-in Gemini Nano
(Prompt API)** + Web Speech.

On-device by design: **no API key, no network call to a model provider, and no CSP issue**
(the page never fetches an external LLM). This is **not** the production client — that's an
MV3 extension (for persistence across full navigations and out-of-page UI). See
`docs/HANDOFF.md`.

## What it does

- **Consumer bridge** — wraps `navigator.modelContext.registerTool` to capture tools as
  the provider registers them (and drops them on `AbortSignal` when routes change). The
  provider exposes only `registerTool`, so wrapping is how a same-page consumer gets a
  live tool registry.
- **Engine** — Chrome's `LanguageModel` (Gemini Nano) driven by a **manual JSON tool
  loop**. Nano's *native* tool-calling (`create({ tools })` auto-loop) proved unreliable —
  it narrates "I'm calling a tool…" instead of emitting a real call — so instead the system
  prompt asks for one line of strict JSON per turn (`{"action":"call",...}` /
  `{"action":"final",...}`), which `geminiEngine` parses, runs against the captured tool,
  and feeds back (up to `MANUAL_LOOP_HOPS` round-trips). The session rebuilds when the
  route-scoped tool set changes.
- **Voice** — Web Speech `speechSynthesis` (TTS) + `SpeechRecognition` (STT). Out-of-band
  from the tools. `speak()` waits for voices to load, sets one explicitly, avoids the
  racing `synth.cancel()`, and calls `resume()` to dodge Chrome's paused-queue silence bug.
- **Vision** — `describe_image` is a consumer-local tool (merged into the model's tool
  catalog) that fetches a thumbnail URL the provider supplies (`thumb` on list items /
  `get_video_info`) and asks Nano (image input) to describe it for a non-sighted user.
  One-shot/on-demand, so the brief inference pause is acceptable.
- **`activate()`** — simulates the browser/AT opt-in handoff: a proactive, tool-driven
  greeting that orients the user and offers a branching menu.

Headless — adds **no DOM** to YouTube (AT-safe). Drive it from the console.

## Requirements

Chrome flags (restart after enabling):
- `chrome://flags/#enable-webmcp-testing` — for the provider's tools
- `chrome://flags/#prompt-api-for-gemini-nano` — the on-device model
- `chrome://flags/#optimization-guide-on-device-model` → "Enabled BypassPerfRequirement"

Gemini Nano downloads on first use; watch the console for progress. Check readiness with
`await ytAgent.availability()`.

## Usage

1. **Load this harness first**, then the provider (so the `registerTool` wrapper catches
   the provider's initial registrations). If you load it after, just navigate once — route
   changes re-register and the wrapper catches them. Paste as DevTools snippets and Run, or
   install both in Tampermonkey (`@grant none`).
2. In the console:
   ```js
   await ytAgent.availability();          // "available" / "downloadable" / ...
   ytAgent.listTools();                   // confirms the bridge sees the provider's tools

   ytAgent.start();                       // hands-free: greets, then you just TALK back
   // ...converse naturally; say "stop" or call ytAgent.stop() to end.

   ytAgent.enablePushToTalk();            // or: press Ctrl+Shift+Space for one turn each
   await ytAgent.ask("what's on my home feed?");  // or type, no mic needed
   ```

### How the user replies

`ytAgent.start()` is the real conversational mode: it speaks the greeting, then **listens
for the user's spoken answer, responds, and listens again** — a continuous loop, so the
user just talks. It ends when the user says a stop word ("stop", "done", "goodbye"), stays
silent for two turns, or `ytAgent.stop()` is called. Turn-taking is sequential (it listens
only after it finishes speaking, so it never hears its own voice).

If continuous listening picks up nothing, the mic may need a user gesture first — click the
page once, or use **push-to-talk** (`enablePushToTalk()`; the keypress *is* the gesture).

## Testing without the model

Swap the engine for a mock to exercise the bridge/voice without Gemini:
```js
ytAgent.useEngine(async (utterance) => {
  // Call a tool directly and shape a reply:
  const tools = ytAgent.listTools().map(t => t.name);
  return `Mock engine. I can see tools: ${tools.join(", ")}.`;
});
```
(Note: a mock engine bypasses tool calling — it's for wiring/voice checks, not behavior.)

## API

| Call | Purpose |
|------|---------|
| `ytAgent.start()` | **Hands-free conversation loop**: greet → listen → respond → listen … |
| `ytAgent.stop()` / `isRunning()` | End the loop / check if it's running |
| `ytAgent.enablePushToTalk(opts?)` / `disablePushToTalk()` | Hotkey for one turn (default `Ctrl+Shift+Space`) |
| `ytAgent.setListenMode("webspeech"\|"nano")` | STT backend. `webspeech` (default, fast). `nano` = **experimental** on-device audio transcription — accurate but slow and briefly freezes the page per turn; needs `#prompt-api-for-gemini-nano-multimodal-input`. |
| `ytAgent.describeImage(url, question?)` | Describe an image (e.g. a `thumb` URL from a list item) via on-device Nano vision. |
| `ytAgent.describeThumbnail(index, question?)` | Describe the thumbnail of item `index` on the current surface (home/search/up-next). |
| `ytAgent.availability()` | Gemini Nano readiness |
| `ytAgent.ask(text)` | One request (typed); runs the manual tool loop; returns reply text |
| `ytAgent.activate()` | Proactive greeting (simulated opt-in handoff) |
| `ytAgent.converse()` | STT → ask → TTS (one turn) |
| `ytAgent.useEngine(fn)` | Swap the engine (mock / future bridge) |
| `ytAgent.listTools()` | Tools currently captured from the provider |
| `ytAgent.speak(t)` / `listen()` | Direct voice access |
| `ytAgent.reset()` | Destroy the session (fresh conversation) |
