# Dev consumer agent + voice harness

`dev-agent.user.js` is the **development** consumer (the MCP client side) for the YouTube
A11y Agent. It consumes the WebMCP tools registered by the provider
(`../youtube-a11y-agent.user.js`) and drives them with Claude + Web Speech.

This is **not** the production client. The production consumer is an MV3 extension whose
background service worker makes the LLM call off-page (dodging YouTube's CSP) and whose
MAIN-world content script bridges to `navigator.modelContext`. See `docs/HANDOFF.md`.

## What it does

- **Consumer bridge** — wraps `navigator.modelContext.registerTool` to capture tools as
  the provider registers them (and drops them on `AbortSignal` when routes change). The
  provider exposes only `registerTool`, so wrapping is how a same-page consumer gets a
  live tool registry.
- **Agent loop** — Claude Messages API with tool use + prompt caching. Listens, picks
  tools, calls them via the bridge, loops up to 6 hops, returns spoken-friendly text.
- **Voice** — Web Speech `speechSynthesis` (TTS) + `SpeechRecognition` (STT). Out-of-band
  from the tools, which stay text-only.
- **`activate()`** — simulates the browser/AT opt-in handoff: a proactive, tool-driven
  greeting that orients the user and offers a branching menu.

Headless by design — it adds **no DOM** to YouTube (AT-safe). Drive it from the console.

## Usage

1. Chrome with `chrome://flags/#enable-webmcp-testing` (restart).
2. **Load this harness first**, then the provider (so the `registerTool` wrapper catches
   the provider's initial registrations). If you load it after, just navigate once — route
   changes re-register and the wrapper catches them. Paste as a DevTools snippet and Run,
   or install both in Tampermonkey (`@grant none`).
3. In the console:
   ```js
   ytAgent.listTools();                 // no key needed — confirms the bridge sees tools
   ytAgent.setKey("sk-ant-...");         // dev only; stored in sessionStorage
   await ytAgent.activate();             // proactive greeting (orient + menu)
   await ytAgent.ask("what's on my home feed?");
   await ytAgent.converse();             // listen -> ask -> speak (one voice turn)
   ```

## CSP caveat (important)

YouTube's Content-Security-Policy may block `fetch` to `api.anthropic.com` from the page,
so the default Claude transport can fail on youtube.com. To still exercise the agent loop:

```js
ytAgent.useTransport(async ({ system, messages, tools }) => {
  // return an Anthropic-shaped response, e.g. force a tool call:
  return { stop_reason: "tool_use", content: [
    { type: "tool_use", id: "t1", name: "describe_home", input: {} },
  ]};
});
```

The real fix is the extension (LLM call off-page). Tracked in `docs/HANDOFF.md`.

## API

| Call | Purpose |
|------|---------|
| `ytAgent.setKey(k)` / `setModel(m)` | Anthropic key (sessionStorage) / model id |
| `ytAgent.ask(text)` | One request; runs the tool loop; returns reply text |
| `ytAgent.activate()` | Proactive greeting (simulated opt-in handoff) |
| `ytAgent.converse()` | STT → ask → TTS (one turn) |
| `ytAgent.useTransport(fn)` | Swap the LLM transport (mock / extension bridge) |
| `ytAgent.listTools()` | Tools currently captured from the provider |
| `ytAgent.speak(t)` / `listen()` | Direct voice access |
| `ytAgent.reset()` | Clear conversation history |
