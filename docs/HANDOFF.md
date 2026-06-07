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
| Consumer agent (dev harness, on-device Gemini Nano) | ✅ `src/agent/dev-agent.user.js` **v0.9.20** — **manual JSON tool loop**; verified end-to-end (tool call → page navigation observed) |
| v0.9.20 — model-free greeting + freeze instrumentation | 🟡 "Freezes even on home" root cause (workflow + adversarial review): the **greeting was a model call**. `activate()` ran `destroySession()` then `ask("[Session start…]")`; bracketed text bypasses `handleCommand`, so it always hit Nano — with a cold ~20-29s `LM.create` (outside the 12s budget) + a multi-hop turn. Fires from Alt+Shift+A / popup Activate / `start()`, so invoking the agent on home guaranteed a freeze. Fix: `activate()` now composes the greeting **deterministically** (direct `get_account`/`list_categories`/`feed`), no `destroySession`, no model; bracketed text returns "" (never reaches the model). ⚠️ **Open, must be MEASURED:** does the 12s `AbortController` actually end the beachball, or is it cosmetic (spec only mandates promise rejection; a Chromium thread shows aborted Nano inference keeps running)? v0.9.20 adds a **main-thread `requestAnimationFrame` liveness probe** in `geminiEngine` (`max main-thread freeze …ms`) + logs how long after `abort()` the promise settles — the next repro on the affected machine settles it. Durable answer regardless: **prevention** — never let the greeting or a command reach the model. Reliability tuning (warm-base+clone, output-language, pause-video) and an opt-in MV3-background cloud-Gemini fallback are scoped but not yet built (see `docs/research/voice-audio-anti-freeze.md`). |
| v0.9.19 — FREEZE ROOT CAUSE CONFIRMED: unbounded Nano inference | ✅ Pinned by isolation: `ytAgent.ask("pause")` (no audio) did NOT freeze; saying "pause" with earcons OFF DID, with `session.prompt() hop 0 = 200828ms` (3+ min) == the beachball. NOT mic/audio/TTS/voice — those were disproven by reproduction (3 clean `coreaudiod` logs; a 12 s muted TTS run with **0** main-thread stalls; 64 GB/58% free RAM; Chrome exposes only compact voices). Two distinct bugs: (a) "pause" was gated behind `onWatch`, so on the home page it fell through to Nano; (b) `session.prompt()` had no time cap. Fixes: **`MODEL_TURN_BUDGET_MS` (12 s)** AbortController cap on every model turn (abort + `destroySession` + fallback) so Nano can't freeze the page for minutes; **playback verbs (pause/play/skip/captions/next) now deterministic on EVERY surface** (provider tool on `/watch`, raw `<video>` elsewhere). Earlier v0.9.16-0.9.18 (short replies, earcon ctx suspend, compact-voice) are harmless hardening but were **not** the cause. ⚠️ Caveat: even healthy Nano here was sometimes 200s — the on-device model is unreliable on this machine; deterministic-first must cover as much as possible. |
| v0.9.16–0.9.18 — FREEZE ACTUALLY SOLVED: heavy TTS voice | 🟡 With the model freeze gone (v0.9.15), the remaining beachball was isolated — via the user picking **"Beachball, cursor froze"** during the `speak()` window + **THREE clean `coreaudiod` captures** — to the **TTS synthesis engine**, not the audio device and not the mic/model (both earlier diagnoses were wrong). `pickVoice()` was *selecting* a macOS **Enhanced/Premium/Siri** voice (the regex matched "Samantha (Enhanced)" / "Aaron"); those heavy neural voices stall the whole machine for the utterance duration (6s reply → 6s freeze; 2s → 2s; short arrow titles → unnoticed). Fixes: **v0.9.18** `pickVoice()` excludes `enhanced/premium/siri/eloquence` and forces a light **compact** voice (+ one-time `TTS voice:` log); **v0.9.16** shortened spoken list replies (3 cleaned titles, emoji stripped) to cut utterance length; **v0.9.17** suspends the earcon `AudioContext` after each tone so it never shares the output with TTS. Needs user re-verify that the beachball is gone. |
| v0.9.15 — FREEZE ROOT CAUSE FOUND (it was the model, not audio) | 🟡 **The captured `coreaudiod` log came back CLEAN** — none of the predicted deadlock signatures (`sample rate was changed` / `Mach message timeout` / `HALS_OverloadMessage`); mic + speaker opened as separate clean 48 kHz devices even on the **bare** Web Speech path behind the v0.9.14 gate. The freeze the user "just saw" lines up instead with **on-device Gemini Nano model load**: `LM.create()=22.8s`, `ensureSession()=29s`, + a model download — which pegs the machine. Worse, `ensureSession` rebuilt the session (another ~22s `LM.create`) on **every surface change** because the per-surface tool catalog was baked into `initialPrompts`. Fix: (a) **persistent session** — catalog moved out of `initialPrompts` into the per-turn prompt, so `LM.create()` runs **once per tab**, not per route; (b) **broadened the deterministic layer** so "what's on my home feed" / "what's playing" / "show me my feed" answer instantly and never touch the model (it had fallen through to the 29s model, which then misrouted to `select_category Music` → "Sorry, I couldn't complete that"). The v0.9.14 audio gate stays as hygiene. Residual: one ~20s model load on the FIRST conversational (non-command) query. |
| v0.9.14 freeze fix — the output-quiescence gate + capture-path cures | 🟡 **Researched (9-agent workflow + 2 adversarial reviews) → implemented.** Root cause (most-supported, still *inferred not captured*): opening a mic **while audio renders on the output device** makes macOS CoreAudio reconfigure the output device session → deadlocks the single `coreaudiod` daemon → whole-machine beachball; bare `webkitSpeechRecognition` uses the processed/VPIO capture that hooks the output device (Meet/FaceTime use `getUserMedia`, so they're immune). Fix: **`beginListen()` freeze gate** on *every* capture path (cancel TTS, **await real media `pause`**, `audio.suspend()` earcon ctx, settle) + **EC-off `getUserMedia`** everywhere + **nano mode = guaranteed freeze-proof path** + opt-in EC-off `start(track)`. Emits a `beginListen: gate open …` canary. **Needs the user to capture a real `coreaudiod` log to confirm** (see `docs/research/voice-audio-anti-freeze.md`). |
| v0.9.13 arrow-browse | ✅ Escape no longer a keyboard dead end: the keydown listener stays attached (inert) after `stopBrowse`, so once `everArmed` an arrow re-arms browsing. |
| v0.9.11–0.9.12 mic/TTS | ✅ v0.9.11 `pickVoice()` local-only + `speak()` watchdog resolves-without-cancel (was cutting slow local voices → "not reading responses"). v0.9.12 **`listenOnce` resolves on `onend`** (mic fully released) not `onresult` — so TTS never starts while the mic is still open. (Supersedes the v0.9.7 abort-on-`onresult` note below.) |
| v0.9.9–0.9.10 the REAL machine-hang cause | ✅ Timestamped logs (v0.9.9) pinned it: `tool 0ms`, `ask() 1ms`, **`speak() 25510ms`** — the freeze was **TTS**, not mic/model. `pickVoice()` preferred **online "Google" voices** that fetch audio per utterance; when that network call stalls, `speechSynthesis.speak()` takes ~25 s for one word. v0.9.10: prefer **local voices only** (`localService`), plus a length-scaled `speak()` **watchdog** that cancels+resolves so an utterance can never block a turn. |
| v0.9.8 whole-machine-hang mitigation | 🟡 Reported: macOS fully beachballs whenever the mic opens — **even on simple commands** (so not the LLM) and on **tap-to-talk** (so not the continuous loop). Isolated to the Web Speech mic path itself: opening `webkitSpeechRecognition` while the YouTube `<video>` plays audio → `coreaudiod` contention (Meet/FaceTime don't hit this — they use WebRTC, not Web Speech). Mitigation: **pause page media during the capture window** (`duckMedia`/`restoreMedia`). Needs user re-verify; if it still hangs on a silent page, the fallback is to move STT off `webkitSpeechRecognition` onto `getUserMedia`+Nano. |
| v0.9.7 mic-release fix | ✅ The mic indicator stayed on through the LLM + TTS reply ("held hostage while the browser is talking"). Cause: `listenOnce` resolved on `onresult` but never told the recognizer to stop, so Chrome kept the session open (and the live mic could hear our own TTS and refuse to end) until the 10 s watchdog. Now `onresult` calls `rec.abort()` immediately — mic frees the moment your words are captured, before thinking/speaking. |
| v0.9.6 voice-search fix | ✅ "search for X" did nothing off `/results`: the deterministic command called `run_search`, which is only registered on the search surface, so `callText` no-op'd. Now it navigates directly to `results?search_query=…` (works from home/watch/anywhere) with a `pend()` continuation read on the results page. |
| v0.9.5 browse-past-20 fix | ✅ Arrow-browse hardcoded `feed(20)` and never re-read after "load more", so it capped at 20. Now reads up to `BROWSE_LIMIT` (100) and **auto-extends at the end** via `growFeed()` (`load_more_home` → re-read); "more" refreshes the cached browse list too. |
| v0.9.2 bug fixes | ✅ (1) **`consumer.call` was missing** — every `feed()`/`callText` threw and was swallowed, so home arrows said "no videos" and play/pause silently failed; added `consumer.call`/`has`. (2) **`/shorts` → "other"** (no playback tools); now resolves to the **watch** surface. (3) **Stale arrow-browse feed** replayed the home list on `/watch` (looked like "thinks I'm on home"); `browseMove` now self-disarms off list surfaces and `stopBrowse`/re-arm clear the cached list. Needs interactive re-verify. |
| v0.9.4 route-churn / duplicate-tool fix | ✅ Provider now re-registers **only when the surface changes**, not on every path tweak — scrolling between Shorts (`/shorts/A→B`) or switching videos (`/watch?v=A→B`) no longer churns the registry (tools read the DOM live). **Verified Chrome behavior:** under `#enable-webmcp-testing`, `ModelContext` does **not** unregister tools when their `AbortSignal` fires, so re-registers throw `Duplicate tool name`; the provider now treats that as "already registered" (the consumer captures the tool before the throw, so the agent still works) instead of spamming `console.error` + logging `registered 0 tool(s)`. |
| v0.9.3 intuitiveness + mic-hang fixes | ✅ (1) **`speak()` is now a single interrupt-driven channel** — it cancels the previous line instead of queueing, so rapid arrow presses / barge-in never stack up and read a backlog (race-safe cancel→speak; superseded promises resolved via `flushSpeak` so `await speak()` can't hang). (2) **Universal barge-in** — every talk-key press cancels speech, aborts the in-flight listen, and bumps `talk.gen` so a slow LLM reply can't speak over the new turn; previously barge-in only worked while already "speaking". (3) **Mic-hang killed at the source** — removed the dead **continuous** `holdStart`/`holdStop` recognizer (the thing that held the mic / blocked video calls), and added a **10s watchdog** to `listenOnce` that force-`abort()`s if Chrome never fires `onend`. Needs interactive re-verify on the user's machine. |
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
| (agent, list surfaces) | home + search | arrow-key browse mode (`startBrowse`): Down/Up move, Enter plays, Escape exits (an arrow re-arms — never a keyboard dead end); + personalized welcome (`get_account`) | new — verify interactively |
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
