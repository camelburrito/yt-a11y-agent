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
   await ytAgent.activate();              // proactive greeting (orient + menu)
   await ytAgent.ask("what's on my home feed?");
   await ytAgent.converse();              // listen -> ask -> speak (one voice turn)
   ```

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
| `ytAgent.availability()` | Gemini Nano readiness |
| `ytAgent.ask(text)` | One request; Prompt API runs the tool loop; returns reply text |
| `ytAgent.activate()` | Proactive greeting (simulated opt-in handoff) |
| `ytAgent.converse()` | STT → ask → TTS (one turn) |
| `ytAgent.useEngine(fn)` | Swap the engine (mock / future bridge) |
| `ytAgent.listTools()` | Tools currently captured from the provider |
| `ytAgent.speak(t)` / `listen()` | Direct voice access |
| `ytAgent.reset()` | Destroy the session (fresh conversation) |
