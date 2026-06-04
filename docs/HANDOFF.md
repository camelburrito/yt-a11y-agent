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
 │  Chrome built-in Gemini Nano (Prompt API, ON-DEVICE) with the     │
 │  page's tools. Listens, calls tools (native function calling),    │
 │  speaks the result. No API key, no network, no CSP issue.         │
 │  Dev harness: src/agent/dev-agent.user.js (in-page).              │
 │  Production: MV3 extension (for persistence + out-of-page UI).     │
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
| Consumer agent (dev harness, on-device Gemini Nano) | ✅ `src/agent/dev-agent.user.js` |
| Voice layer (Web Speech STT/TTS) | ✅ in the harness |
| Proactive `activate()` greeting | ✅ |
| Search / Watch / Watch-Next / Comments / PiP journeys | ✅ **implemented + selectors verified live** (headless harness) |
| Architecture doc with diagrams | ✅ `docs/architecture/yt-a11y-agent.md` |
| Headless selector verification | ✅ `scripts/verify-selectors.mjs` (`npm run verify:selectors`) |
| PiP gesture path (open q. c) + transcript-open path | 🟡 partial — need a flagged interactive run |
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

- **Engine is on-device Gemini Nano (Prompt API) — by user decision, no external LLM.**
  This removes the API key and the CSP problem entirely (the page never fetches a model
  endpoint). Requires Chrome flags `#prompt-api-for-gemini-nano` and
  `#optimization-guide-on-device-model`; the model downloads on first use. Check with
  `await ytAgent.availability()`. Caveat: Nano is small — native multi-tool function
  calling may be less reliable than a frontier model; if it misbehaves, the fallback is a
  manual JSON tool-selection loop using the Prompt API's `responseConstraint` (structured
  output) — documented option, not yet built. Engine is pluggable: `ytAgent.useEngine(fn)`.
- **In-page agent doesn't survive full navigations.** `open_video` sets
  `location.href` → cross-document load → the harness (living in the page) resets. SPA
  nav within YouTube survives; cross-document nav doesn't. A real extension consumer lives
  outside the page and persists. This — plus out-of-page UI — is now the main reason the
  production consumer is an extension (CSP no longer is, since the model is on-device).
- **No DOM injection by design.** The harness is headless (console + voice); it does NOT
  add visible/AT-visible UI to YouTube, to honor the AT-safe principle. Real client UI
  lives in the extension popup/side panel, outside the page's a11y tree.

## Journey → tool map

| Surface | Detect | Tools | Status |
|---------|--------|-------|--------|
| home | `/` or `/feed*` | `list_home_feed`, `describe_home`, `open_video`, `load_more_home` | ✅ verified live |
| search | `/results` | `run_search`, `list_results`, `refine_search`, `open_result` | ✅ verified live |
| watch | `/watch` | `get_video_info`, `get_transcript`, `summarize_video`, `plain_language_summary`, `jump_to`, `playback_control`, `set_captions` | ✅ verified live (transcript-open best-effort) |
| watch-next | `/watch` | `list_up_next`, `play_next`, `set_autoplay` | ✅ verified live |
| comments | `/watch` | `get_comments`, `summarize_comments`, `get_pinned_comment` | ✅ verified live |
| pip | `/watch` | `enter_pip`, `exit_pip` | 🟡 button+fallback present; gesture path (q. c) needs flagged run |
| (every route) | — | `where_am_i` | ✅ |
| home (planned) | | `list_categories`, `open_category` (filter chip bar) | ⬜ |

Shared extraction: home/search/up-next all use `readVideoCards(scope, containerSel, limit)`
over `SEL.card`. Watch tools read the `<video>` element (stable) and actuate native
controls (`set_captions`, `set_autoplay`, PiP fallback) rather than scraping where possible.

## NEXT STEPS

All journeys are implemented and their **selectors are verified live** (headless harness,
`scripts/verify-selectors.mjs`). What remains needs flags or a user gesture, or is the
extension.

### Re-running selector verification
`npm run verify:selectors` launches the installed Chrome headless, hits live YouTube
(`/results` → a real `/watch`), and runs the provider's actual extraction logic
(`readVideoCards`/`SEL.card`, watch/`<video>`, comments). Use it whenever YouTube might have
drifted — it's the automated version of the manual probe loop. Findings so far:
- Search / Watch-Next / Comments: all fields populate. (Watch-Next channel needed a
  first-metadata-line fallback — fixed in `readVideoCards`.)
- Watch: title/channel/info/`<video>`/CC+PiP+autoplay buttons all found.
- Caveat: during a preroll **ad**, `<video>.duration` is the ad's — `get_video_info` now
  reports `adPlaying` and suppresses ad timing.

### Still needs a flagged, interactive (gesture) run
- **PiP — open question (c).** `enter_pip` measures `navigator.userActivation.isActive` and
  falls back to clicking `SEL.watch.pipButton`. Run it from a real tool call and **record
  here** whether the direct API succeeds or the button fallback is what fires.
- **Transcript open.** `get_transcript` *reads* segments fine; opening a *closed* transcript
  (expand description → "Show transcript") is best-effort. Verify `SEL.watch.transcriptOpenButton`
  interactively (headless starts with it closed and 0 segments).

### Then: production MV3 extension
Provider → `world:"MAIN"` content script; consumer → background worker (persists across
the `open_video` full-nav reset) + popup/side-panel UI. Resolves open question (d).

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
   Also enable `#prompt-api-for-gemini-nano` and `#optimization-guide-on-device-model`
   for the agent's on-device model.
3. Consumer/voice: paste `src/agent/dev-agent.user.js` (load it **first** so its
   registerTool wrapper captures the provider's tools — or navigate once after, since
   route changes re-register). See `src/agent/README.md`.
4. No API key needed. `await ytAgent.availability()` (expect "available"; first run may
   download the model), then `await ytAgent.activate()` for the greeting, or
   `await ytAgent.ask("what's on my home feed?")`, or `ytAgent.converse()` for voice.
   Tool-only smoke test: `ytAgent.listTools()`. Wiring/voice check without the model:
   `ytAgent.useEngine(mockFn)`.
