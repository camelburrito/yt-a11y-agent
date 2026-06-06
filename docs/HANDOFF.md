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
| Consumer agent (dev harness, on-device Gemini Nano) | ✅ `src/agent/dev-agent.user.js` **v0.9.2** — **manual JSON tool loop**; verified end-to-end (tool call → page navigation observed) |
| v0.9.2 bug fixes | ✅ (1) **`consumer.call` was missing** — every `feed()`/`callText` threw and was swallowed, so home arrows said "no videos" and play/pause silently failed; added `consumer.call`/`has`. (2) **`/shorts` → "other"** (no playback tools); now resolves to the **watch** surface. (3) **Stale arrow-browse feed** replayed the home list on `/watch` (looked like "thinks I'm on home"); `browseMove` now self-disarms off list surfaces and `stopBrowse`/re-arm clear the cached list. Needs interactive re-verify. |
| Voice layer (Web Speech STT/TTS) | ✅ in the harness — TTS silence bugs fixed (voices/cancel/resume), confirmed speaking |
| Proactive `activate()` greeting | ✅ verified speaking interactively |
| Hands-free conversation loop | ✅ `ytAgent.start()`/`stop()` + push-to-talk (v0.4.0) — greet→listen→respond→listen; stop word / silence / `stop()` ends it |
| Optional Nano audio ASR listen mode | ✅ v0.5.0 — `setListenMode("nano")`, experimental (slow); Web Speech default |
| Vision: describe thumbnails (Nano image input) | ✅ v0.6.0 — provider gives `thumb` URLs; consumer `describe_image` tool + `ytAgent.describeImage/describeThumbnail`. **Verified end-to-end** (interactive): Nano returns rich, accurate thumbnail descriptions |
| Search / Watch / Watch-Next / Comments / PiP journeys | ✅ **implemented + selectors verified live** (headless harness) |
| Architecture doc with diagrams | ✅ `docs/architecture/yt-a11y-agent.md` |
| Headless selector verification | ✅ `scripts/verify-selectors.mjs` (`npm run verify:selectors`) |
| PiP gesture path (open q. c) + transcript-open path | 🟡 partial — need a flagged interactive run |
| Production extension (MV3) | ✅ **scaffolded** — `extension/` (MAIN-world content scripts reuse `src/` via `npm run build:extension`; ISOLATED `bridge.js`; service worker for the global hotkey; popup as visual fallback). **Talk-first**: speaks on the user's first interaction + `Ctrl+Shift+Space` talk-back + `Alt+Shift+A` overview — no sighted click. Next: conversation **state** in the service worker (survive full-nav); icons; Web Store packaging |

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
  `await ytAgent.availability()`. **Nano's native tool-calling is confirmed unreliable** —
  it narrates "I'm calling a tool…" instead of emitting a real call, so nothing executes.
  The agent therefore uses a **manual JSON tool loop** (`geminiEngine`): the system prompt
  asks for one strict-JSON action per turn, which we parse, run, and feed back. This is
  what actually works on-device (verified interactively in the linked session). Engine is
  pluggable: `ytAgent.useEngine(fn)`.
- **TTS can be silent without care.** Chrome drops `speechSynthesis` utterances if you call
  `cancel()` right before `speak()`, if voices haven't loaded yet (async `voiceschanged`),
  or if the queue gets stuck paused. `speak()` handles all three (wait for voices, set one,
  no pre-cancel, `resume()`). Console calls also aren't a user gesture — clicking the page
  once before a voice session makes it bulletproof.
- **Listening: Web Speech is the default; Nano audio ASR is experimental.** Verified live
  (2026-06): this Chrome build exposes on-device **audio AND image** input to the Prompt API
  (`expectedInputs:[{type:"audio"}]` / `[{type:"image"}]`) behind
  `#prompt-api-for-gemini-nano-multimodal-input`, and Nano transcribes a `webm/opus` mic clip
  accurately with **no format conversion**. BUT on-device audio inference is **slow and
  briefly janks the page** per utterance — too heavy for a real-time turn-by-turn loop. So
  `listenMode` defaults to **Web Speech** (fast, streaming); Nano ASR is opt-in via
  `ytAgent.setListenMode("nano")` (VAD-based capture in `nanoAsr`, auto-falls back to Web
  Speech on error). Image input is now used for **vision** (below).
- **Vision (built, v0.6.0).** On-device image input works well and isn't latency-sensitive
  (one-shot/on-demand), so it's a good fit. The provider derives a `thumb` URL per video
  (`https://i.ytimg.com/vi/<id>/hqdefault.jpg`, fetchable — verified live) on list items and
  `get_video_info`; the consumer's `describe_image` tool (and `ytAgent.describeImage` /
  `describeThumbnail`) fetches it and asks Nano to describe it for a non-sighted user. Tool
  boundary stays text-only (provider passes a URL, consumer does the vision). Capture uses
  thumbnails, not video-frame canvas grabs, which sidesteps cross-origin tainting. Verified
  end-to-end interactively — Nano returns rich, accurate, spoken-friendly descriptions.
  (Note: the on-device model can't be exercised by automation — Chrome gates it to a real
  user profile — so this step needs an interactive run, not the headless harness.)
- **In-page agent doesn't survive full navigations → breaks conversational continuity.**
  `open_video`/`run_search` set `location.href` → cross-document load → the in-page agent
  resets, losing conversation state. This is why **search feels broken**: "search for X"
  navigates to `/results`, but the fresh agent on that page doesn't remember the request, so
  nothing reads the results back. The provider search tools themselves are fine
  (`run_search` builds the right URL; `list_results` verified live — 5 results). Partial
  mitigations in place: arrow-browse is armed on `/results` (press a key → hear results); the
  per-surface greeting can re-orient. **Proper fix:** persist conversation + a "pending
  intent" across navigation — either `sessionStorage` (survives same-tab nav) or the service
  worker. The extension already auto-reinjects (agent always present); only *state* is lost.
  **Mitigated (v0.8.0):** navigating tools stash a continuation message via `pend()`
  (sessionStorage) and the consumer speaks it on the next page (`consumePending`) — so
  "search for X" now announces "Here are the results for X…" after the load, and arrow-browse
  is armed there. Full conversation *history* across navigation still isn't carried (would
  need to serialize the transcript / move it to the service worker) — that's the remaining
  piece, but the common search/open flows now feel continuous.
- **No DOM injection by design.** The harness is headless (console + voice); it does NOT
  add visible/AT-visible UI to YouTube, to honor the AT-safe principle. Real client UI
  lives in the extension popup/side panel, outside the page's a11y tree.

## Journey → tool map

| Surface | Detect | Tools | Status |
|---------|--------|-------|--------|
| home | `/` or `/feed*` | `list_home_feed`, `describe_home`, `open_video`, `load_more_home`, `list_categories`, `select_category` | ✅ verified live (chips confirmed: 12 categories) |
| search | `/results` | `run_search`, `list_results`, `refine_search`, `open_result` | ✅ verified live |
| watch | `/watch` or `/shorts` | `get_video_info`, `get_transcript`, `summarize_video`, `plain_language_summary`, `jump_to`, `playback_control`, `set_captions` | ✅ verified live (transcript-open best-effort). Shorts resolves to this surface (generic `video` selector → play/pause/seek work; sidebar/transcript no-op). |
| watch-next | `/watch` | `list_up_next`, `play_next`, `set_autoplay` | ✅ verified live |
| comments | `/watch` | `get_comments`, `summarize_comments`, `get_pinned_comment` | ✅ verified live |
| pip | `/watch` | `enter_pip`, `exit_pip` | 🟡 button+fallback present; gesture path (q. c) needs flagged run |
| (every route) | — | `where_am_i` ✅; `get_account` ✅ (`signedIn` reliable; `name` is null — only in the account menu, which we don't open) | ✅ |
| (agent, list surfaces) | home + search | arrow-key browse mode (`startBrowse`): Down/Up move, Enter plays, Escape exits; + personalized welcome (`get_account`) | new — verify interactively |
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

### Production MV3 extension — scaffolded (`extension/`)
Provider + agent run as `world:"MAIN"` content scripts (auto-injected on every YouTube page,
reused from `src/` via `npm run build:extension`); an ISOLATED `bridge.js` relays popup
commands (MAIN can't use `chrome.*`); `popup.html` is the Start/Stop UI (out of the page's
a11y tree). See `extension/README.md`.
Remaining for production: (a) move conversation state into a **service worker** so it
survives the `open_video` full-nav reset (currently only auto-reinjection persists, not
history); (b) icons; (c) Web Store packaging (privacy policy, permission justifications).

## Open questions still live
- **(c) PiP transient user activation** — measure in `enter_pip` (item 4).
- **(d) Multimodal media handling** — partly answered: on-device audio input works but is
  too slow for real-time listening (Web Speech stays default; Nano ASR opt-in). Image input
  also works → potential vision path. Still to settle: the speak/listen contract when the
  consumer becomes the extension, and whether/when to use Nano vision for content the DOM
  can't expose.
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
