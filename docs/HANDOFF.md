# Handoff — YouTube A11y Agent

> Context anchor for resuming work across sessions. Read this + `CLAUDE.md` first.
> Last updated: 2026-06-04.

## What this project is

A WebMCP tool provider for YouTube plus an AI agent that consumes those tools, so a
screen-reader user can use YouTube hands-free by voice. **The agent is an intermediary —
it never mutates the page or its accessibility tree.** Tools *read* the page and *act*
(navigate, scroll, actuate native controls); the user's own assistive tech (VoiceOver,
NVDA, etc.) stays authoritative for the page itself.

## The three layers (mental model)

```
 ┌── 1. DISCOVERY / OPT-IN ─────────────────────────────────────────┐
 │  Browser/AT notices a WebMCP a11y agent is available on the page  │
 │  and offers it to the screen-reader user; the user opts in.       │
 │  (Browser/platform-owned. We make ourselves discoverable by       │
 │   registering tools. In the dev harness this is ytAgent.activate())│
 └───────────────────────────────────────────────────────────────────┘
 ┌── 2. CONSUMER AGENT (MCP client) ────────────────────────────────┐
 │  LLM (Claude) with the page's tools. Listens, decides which tool  │
 │  to call, calls it, loops, speaks the result.                     │
 │  Dev harness: src/agent/dev-agent.user.js (in-page).              │
 │  Production: MV3 extension (background worker + MAIN-world bridge).│
 └───────────────────────────────────────────────────────────────────┘
 ┌── 3. PROVIDER (MCP server) ──────────────────────────────────────┐
 │  Our userscript on YouTube registers tools on                     │
 │  navigator.modelContext. Read-and-act only. Verified working.     │
 │  src/youtube-a11y-agent.user.js                                   │
 └───────────────────────────────────────────────────────────────────┘
        Voice (Web Speech STT/TTS) wraps layer 2, out-of-band from tools.
```

## Intended UX flow (the experience we're building toward)

1. User is browsing with VoiceOver. Browser surfaces: "A YouTube accessibility agent is
   available — switch to it?" User opts in. *(layer 1)*
2. Agent greets proactively, tool-driven: *"You're on the YouTube home page. There are
   recommended videos and category filters. Would you like to explore your feed or search
   for something?"* — orient first, then offer branching choices, end on a question.
3. User: *"explore my feed."* → agent calls `describe_home` / `list_home_feed`, reads the
   top picks aloud, offers "open one, or load more?"
4. User: *"open the second one."* → `open_video({index:1})` → watch surface loads →
   route-scoped registration swaps in watch tools → agent offers "summarize, transcript,
   or just play?"

Principle: **orient → offer a short spoken menu → act on confirmation → keep the user in
control (offer, don't autoplay).**

## Current status

| Piece | State |
|-------|-------|
| Provider backbone (route-scoped registration via AbortController) | ✅ done, pushed |
| Home journey tools (`list_home_feed`, `describe_home`, `open_video`, `load_more_home`) | ✅ verified live |
| Cross-cutting `where_am_i` | ✅ done |
| Consumer agent (dev harness) | ✅ built this session — `src/agent/dev-agent.user.js` |
| Voice layer (Web Speech STT/TTS) | ✅ built this session (in the harness) |
| Proactive `activate()` greeting | ✅ built this session |
| Search / Watch / Watch-Next / Comments journeys | ⬜ **NEXT (item 3)** — stubs only |
| PiP journey | ⬜ **NEXT (item 4)** |
| Production extension (MV3, world:"MAIN") | ⬜ later |

## Verified facts (don't re-litigate)

- **API namespace:** Chrome populates `navigator.modelContext`. `document.modelContext` is
  `undefined`. (We keep the `??` probe anyway.)
- **Provider API surface:** `ModelContext` has only `registerTool(tool, {signal})`. No
  `listTools`/`callTool` on the provider — invocation is the consumer's job. The consumer
  bridge captures tools by **wrapping `registerTool`** (and honoring the AbortSignal to
  drop them on unregister).
- **Permissions policy:** a MAIN-world-injected script registers fine on youtube.com under
  the default `tools` policy. (Open question (b) — passed.)
- **Home DOM (2026-06-04):** rich-grid tiles are still `ytd-rich-item-renderer`, but their
  *contents* moved to the `yt-lockup-view-model` component with **camelCase** classes
  (no hyphens): title+link `a.ytLockupMetadataViewModelTitle`, metadata
  `.ytContentMetadataViewModelMetadataText`, channel via `a[href^="/@"]`, duration via a
  `[class*="Badge" i]` filtered to `mm:ss` (empty for live streams). **Expect `/results`
  and watch to have migrated to lockup-style markup too** — verify live before trusting
  any placeholder selector in `SEL`.

## Known limitations / gotchas

- **CSP blocks the in-page LLM call.** YouTube's Content-Security-Policy (`connect-src`)
  will likely block `fetch` to `api.anthropic.com` from the MAIN world. The dev harness's
  Claude transport therefore may fail on youtube.com. Mitigations: (a) test the agent loop
  with `ytAgent.useTransport(mockFn)`; (b) the real fix is the **MV3 extension** — the LLM
  call runs in the background service worker (not subject to page CSP), while a
  MAIN-world content script bridges to `navigator.modelContext`. This is the strongest
  argument for the extension being the production consumer.
- **In-page agent doesn't survive full navigations.** `open_video` sets
  `location.href` → cross-document load → the harness (living in the page) resets. SPA
  nav within YouTube survives; cross-document nav doesn't. A real extension consumer lives
  outside the page and persists. Acceptable for the harness; note it.
- **Browser key exposure.** The harness puts the Anthropic key in `sessionStorage` — dev
  only. Production: key lives in the extension background / a backend proxy, never the page.
- **No DOM injection by design.** The harness is headless (console + voice); it does NOT
  add visible/AT-visible UI to YouTube, to honor the AT-safe principle. Real client UI
  lives in the extension popup/side panel, outside the page's a11y tree.

## Journey → tool map

| Surface | Detect | Tools | Status |
|---------|--------|-------|--------|
| home | `/` or `/feed*` | `list_home_feed`, `describe_home`, `open_video`, `load_more_home` | ✅ |
| home (planned) | | `list_categories`, `open_category` (the filter chip bar) | ⬜ |
| search | `/results` | `run_search`, `list_results`, `refine_search`, `open_result` | ⬜ |
| watch | `/watch` | `get_video_info`, `get_transcript`, `summarize_video`, `plain_language_summary`, `jump_to`, `playback_control`, `set_captions` | ⬜ |
| watch-next | `/watch` | `list_up_next`, `play_next`, `set_autoplay` | ⬜ |
| comments | `/watch` | `get_comments`, `summarize_comments`, `get_pinned_comment` | ⬜ |
| pip | `/watch` | `enter_pip`, `exit_pip` | ⬜ |
| (every route) | — | `where_am_i` | ✅ |

## NEXT STEPS

### Item 3 — build the remaining journeys (start with Search)
Per-journey recipe (this is exactly how Home was verified):
1. Navigate to the surface live. Run a selector probe in the console (structure/attribute-
   based, case-insensitive `[class*="..." i]`) to find the real lockup classes — **do not
   trust the placeholder selectors in `SEL`**, they're old-style guesses.
2. Add the surface's selectors to the `SEL` block (camelCase lockup classes expected).
3. Implement the tools in the corresponding `*Tools()` function (currently returns `[]`).
   Keep them small/composable; write descriptions as model-facing instructions; return
   `{ content: [{ type:"text", text }] }`; read-and-act only.
4. Verify with the capture-shim (see CLAUDE.md run/test) calling `.execute()` directly,
   then via `ytAgent.ask(...)`.
5. Commit per journey; verify selectors live each time.

Order suggestion: **Search → Watch (info/transcript/summary) → Watch-Next → Comments →
PiP**. Search is the natural pair to Home (both are list-and-open).

### Item 4 — PiP journey
- `enter_pip`/`exit_pip`. **Open question (c):** `video.requestPictureInPicture()` needs
  transient user activation. Inside `enter_pip`, measure
  `navigator.userActivation.isActive`; if false, fall back to actuating
  `SEL.watch.pipButton`. Measure empirically and record the answer here.

## Open questions still live
- **(c) PiP transient user activation** — measure in `enter_pip` (item 4).
- **(d) Multimodal media handling** — the voice layer currently lives in the harness and
  tools pass text only. Settle the contract (who speaks, who listens) when the consumer
  becomes the extension. Web Speech is the current stack.
- **Discovery/opt-in (layer 1)** — how the browser/AT actually surfaces and hands off to
  our agent. Largely platform-owned; track what makes us discoverable (registered tools,
  any agent manifest/labeling). Harness simulates with `activate()`.

## Run / test (full stack)
1. Chrome + `chrome://flags/#enable-webmcp-testing` (restart).
2. Provider: paste `src/youtube-a11y-agent.user.js` as a DevTools snippet (or install in
   Tampermonkey with `@grant none`) and Run on youtube.com. Expect
   `[yt-a11y] ... registered N tool(s)`.
3. Consumer/voice: paste `src/agent/dev-agent.user.js` (load it **first** so its
   registerTool wrapper captures the provider's tools — or navigate once after, since
   route changes re-register). See `src/agent/README.md`.
4. `ytAgent.setKey("sk-ant-...")`, then `await ytAgent.activate()` for the greeting, or
   `await ytAgent.ask("what's on my home feed?")`, or `ytAgent.converse()` for voice.
   If the Anthropic fetch is CSP-blocked, use `ytAgent.useTransport(mockFn)` to exercise
   the loop. Tool-only smoke test needs no key: `await ytAgent.listTools()` /
   the capture-shim from CLAUDE.md.
