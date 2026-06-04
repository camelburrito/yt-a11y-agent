# YouTube A11y Agent — project notes for Claude

A WebMCP tool provider for YouTube. It registers tools on YouTube pages so an
in-browser AI agent can help users with accessibility needs navigate YouTube.

**The agent is an intermediary. We never mutate the page or its accessibility tree.**
Tools *read* state and *act* on the user's behalf (navigate, scroll, actuate native
controls) — they never inject overlays, rewrite the DOM, or touch ARIA. Whatever the
user's existing assistive tech reports stays authoritative.

## Architecture

- **Main-world injection.** WebMCP exposes `document.modelContext` /
  `navigator.modelContext` as page-context objects. They are invisible from an isolated
  content-script world, so our code MUST run in the page's MAIN world.
  - **Now:** a Tampermonkey userscript with `@grant none` (that grant is what keeps it
    in MAIN — see header comment in the script).
  - **Later:** an MV3 extension content script declared with `world: "MAIN"`. Same
    runtime contract, just a real distributable. The tool code should port unchanged.
- **Route-scoped registration via AbortController.** YouTube is an SPA. Each route
  (surface) gets a fresh `AbortController`; tools are registered with `{ signal }`. On
  navigation we `abort()` the old controller — which unregisters that route's tools for
  free — and register the new surface's set. Route changes are driven off three signals:
  `yt-navigate-finish` (primary), `popstate`, and a 1s URL-poll fallback. We only
  re-register when the resolved *surface* changes, not on every path tweak.
- **Read-and-act, AT-safe.** No DOM mutation, no overlays, no a11y-tree edits.
- **Tool shape:**
  ```js
  { name, description, inputSchema /* JSON Schema */, async execute(args) }
  // returns { content: [{ type: "text", text }] }
  ```
  Descriptions are written as **instructions to the model** — that text is the only thing
  the agent sees about when/how to call the tool.
- **Media is out-of-band.** WebMCP has no standardized multimodal tool I/O yet, so tools
  pass **text only**. Web Speech (TTS/STT) and any vision/OCR are handled inside the
  script/agent layer, not shoved through the tool boundary. Tools return spoken-friendly
  text; the speaking happens elsewhere.
- **Three layers.** (1) *Discovery/opt-in* — browser/AT surfaces the agent to a screen-
  reader user, who opts in (platform-owned; harness simulates via `ytAgent.activate()`).
  (2) *Consumer agent* — the MCP client (on-device Gemini Nano via the Prompt API + Web
  Speech) that lists/calls our tools; dev harness at `src/agent/dev-agent.user.js`,
  production = MV3 extension (for persistence across navigations + out-of-page UI; the
  model is on-device so CSP is a non-issue). (3) *Provider* — this userscript. UX is **orient →
  offer a short spoken menu → act on confirmation → don't autoplay**. Full flow + gotchas
  (CSP, in-page nav reset) in `docs/HANDOFF.md`.

## Surfaces → tools

| Surface | Detect (pathname)            | Tools |
|---------|------------------------------|-------|
| home    | `/` or `/feed*`              | `list_home_feed`, `describe_home`, `open_video`, `load_more_home` ✅ verified live |
| search  | `/results`                   | `run_search`, `list_results`, `refine_search`, `open_result` ✅ impl · verify |
| watch   | `/watch`                     | `get_video_info`, `get_transcript`, `summarize_video`, `plain_language_summary`, `jump_to`, `playback_control`, `set_captions` ✅ impl · verify |
| watch-next | `/watch` (same surface)   | `list_up_next`, `play_next`, `set_autoplay` ✅ impl · verify |
| comments | `/watch` (same surface)    | `get_comments`, `summarize_comments`, `get_pinned_comment` ✅ impl · verify |
| pip     | `/watch` (same surface)      | `enter_pip`, `exit_pip` ✅ impl · verify (measures `userActivation`, falls back to native button) |
| channel | `/@*`, `/channel/*`, `/c/*`  | (cross-cutting only for now) |
| other   | anything else                | (cross-cutting only) |

`where_am_i` is **cross-cutting** — registered on every route. It returns the current
surface + pathname so the agent can orient itself.

## Conventions

- **One SEL block.** Every YouTube selector lives in the `SEL` object at the top of the
  script. YouTube renames these constantly — when a tool returns blanks, SEL is the first
  place to look. Never inline a selector elsewhere.
- **Small, composable tools.** Prefer many narrow tools (list, then open) over one
  do-everything tool. The agent composes them.
- **Descriptions are model-facing instructions**, not user docs. Say when to call it and
  what the args mean.
- **Shared `readVideoCards`** over `SEL.card` backs every video list (home/search/up-next).
  Watch tools read the `<video>` element and actuate native controls rather than scraping.
- **`[yt-a11y]` log prefix** for all console output.
- **Docs stay current with code.** Update `README.md`, `docs/HANDOFF.md`, and
  `docs/architecture/yt-a11y-agent.md` (diagrams included) in the *same change* that
  alters tools, `SEL`, the engine, or the architecture. Treat stale docs as a bug.

## Open questions — resolve empirically, not by reading specs

1. ~~**API namespace: `document.modelContext` vs `navigator.modelContext`.**~~
   **RESOLVED (2026-06-04, Chrome + `#enable-webmcp-testing`):** Chrome populates
   **`navigator.modelContext`**; `document.modelContext` is `undefined`. The provider
   object is a `ModelContext` whose only method is **`registerTool(tool, { signal })`** —
   there is no `listTools`/`callTool` on the provider side; invocation is the MCP
   consumer's job. We keep the `??` probe in case Chrome relocates it.
2. ~~**Permissions Policy for `tools` on youtube.com.**~~
   **RESOLVED (2026-06-04):** A main-world-injected script registers fine on youtube.com
   under the default `tools` policy — `registered 5 tool(s)` on home, no throw. The
   day-one spike passed.
3. **PiP transient user activation.** `requestPictureInPicture()` needs a real gesture. A
   tool call may not carry activation. Measure `navigator.userActivation.isActive` inside
   an `enter_pip` tool; if false, fall back to actuating the real PiP button
   (`SEL.watch.pipButton`). Same pattern likely applies to other gesture-gated APIs.
4. **Multimodal media handling.** Until WebMCP standardizes multimodal tool I/O, settle
   the in-script contract for Web Speech and vision (who speaks, who listens, how results
   feed back to the agent as text).

## Run / test

1. **Chrome** with WebMCP testing enabled: `chrome://flags/#enable-webmcp-testing`
   (restart Chrome after toggling).
2. **Tampermonkey**: install `src/youtube-a11y-agent.user.js`. Confirm the header still
   says `@grant none` — that is what keeps us in the MAIN world where `modelContext` is
   visible.
3. **Model Context Tool Inspector** extension: use it to see which tools are registered on
   the current page and to invoke them by hand. Navigate home → watch → back and watch the
   registered set change (route-scoped registration) and the `[yt-a11y]` console lines.

## Status

- Home journey: **done**. Everything else: **stubbed** (returns no tools; backbone
  already routes to them). Cross-cutting `where_am_i`: done.
