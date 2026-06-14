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
  content-script world, so our code MUST run in the page's MAIN world. Two forms of the
  SAME code (synced by `npm run build:extension`):
  - **Userscript form (dev/spike):** a Tampermonkey userscript with `@grant none` (that
    grant is what keeps it in MAIN — see header comment in the script).
  - **Extension form (production):** an MV3 content script declared `world: "MAIN"`
    (`extension/manifest.json`), packaged for the Web Store (icons, popup with BYOK key
    entry, privacy/permission docs in `docs/store/`). Same runtime contract.
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
  (2) *Consumer agent* — the MCP client (on-device Gemini Nano via the Prompt API, or the
  opt-in BYOK cloud Gemini engine, + Web Speech) that lists/calls our tools; dev harness at
  `src/agent/dev-agent.user.js`, production = MV3 extension (for persistence across
  navigations + out-of-page UI; cloud fetches run in the service worker, so page CSP is a
  non-issue either way). Tools are driven by a **manual JSON loop** —
  Nano's native tool-calling narrates instead of executing, so don't rely on it; TTS needs
  the voices/cancel/resume care in `speak()`. **Interaction model (v0.9.3):** primary input is
  **tap-to-talk** (`enableTalk`, default the backtick `` ` `` key) — press once and speak;
  non-continuous recognition auto-ends on a pause (so the mic is never held open). **Every
  press is universal barge-in**: it cancels speech, aborts any in-flight listen, and bumps
  `talk.gen` so a pending LLM reply can't speak over the new turn. **`speak()` is a single
  interrupt-driven channel** — it cancels the previous line instead of queueing (rapid arrow
  presses / barge-in never stack up); the cancel→speak Chrome race is dodged with a one-tick
  delay, and a superseded `speak()` promise is still resolved (`flushSpeak`) so `await
  speak()` never hangs. **Earcons** (Web Audio tones) give
  instant feedback (listening / captured / ready / error) so there's never silent waiting;
  the loop speaks **crisp progress cues** ("Searching.", "Opening.") for slow tools.
  **Continuity across navigation:** navigating provider tools stash a message in
  `sessionStorage` (`pend()`); the consumer speaks it on the next page (`consumePending`) — so
  search/open flows continue after the full-page load. Listening defaults to Web Speech STT;
  Nano audio ASR is opt-in (`setListenMode("nano")`, slow). (3) *Provider* — this userscript.
  UX is **orient →
  offer a short spoken menu → act on confirmation → don't autoplay**. Full flow + gotchas
  (CSP, in-page nav reset) in `docs/HANDOFF.md`.

## Surfaces → tools

| Surface | Detect (pathname)            | Tools |
|---------|------------------------------|-------|
| home    | `/` or `/feed*`              | `list_home_feed`, `describe_home`, `open_video`, `load_more_home`, `list_categories`, `select_category` ✅ verified live (chips: `ytd-feed-filter-chip-bar-renderer yt-chip-cloud-chip-renderer`) |
| search  | `/results`                   | `run_search`, `list_results`, `refine_search`, `open_result` ✅ verified live |
| watch   | `/watch` **or `/shorts`**    | `get_video_info`, `get_transcript`, `summarize_video`, `plain_language_summary`, `jump_to`, `playback_control`, `set_captions` ✅ verified live (transcript-open best-effort). Shorts resolves here so play/pause/seek (generic `video` selector) work; sidebar/transcript tools no-op on Shorts. |
| shorts  | `/shorts` (same surface)     | `next_short`, `prev_short` — actuate YouTube's native up/down feed-nav arrows (`SEL.shorts`); registered on every watch route but **no-op off `/shorts`** (like transcript tools). ✅ buttons verified live 2026-06-13 (`npm run verify:selectors`); ids are volatile so re-verify if next/prev short stops moving. Agent: "watch shorts" navigates to `/shorts/`; on `/shorts`, "next"/"previous" route here (not `play_next`). |
| watch-next | `/watch` (same surface)   | `list_up_next`, `play_next`, `set_autoplay` ✅ verified live |
| comments | `/watch` (same surface)    | `get_comments`, `summarize_comments`, `get_pinned_comment` ✅ verified live |
| pip     | `/watch` (same surface)      | `enter_pip`, `exit_pip` ✅ gesture path measured live (2026-06-07): needs ≤5s-fresh activation, button fallback equally gated → agent's **gesture relay** ("picture in picture" → press Enter) is the working path |
| channel | `/@*`, `/channel/*`, `/c/*`  | (cross-cutting only for now) |
| other   | anything else                | (cross-cutting only) |

`where_am_i`, `get_account`, and the sidebar/guide tools (`list_sidebar`, `open_sidebar_item`)
are **cross-cutting** — registered on every route.
`where_am_i` returns surface + pathname; `get_account` returns `{signedIn, name}`.
**`signedIn` is reliable; `name` is usually `null`** — YouTube only renders the account name
after the account menu is opened, and we won't open it (AT-safe). So greet signed-in users
warmly *without* a name ("Welcome back!"); use the name only if present.

**Sidebar / guide (`SEL.guide`) ✅ verified live 2026-06-13 (`npm run verify:selectors`).**
`list_sidebar` reads YouTube's left navigation drawer (`ytd-guide-renderer` →
`ytd-guide-entry-renderer`) as a spoken sentence; `open_sidebar_item({name})` navigates to a
menu item by lenient name match (`pend()` + `location.href`). The full guide is hydrated inline
on home/feed but **absent on `/watch` until its button is clicked** — so `readGuideEntries`
actuates the native Guide button (`SEL.guide.button`) and waits ~900ms when `SEL.guide.menu` is
missing (read-and-act safe; YouTube's own drawer, not an injected overlay; this leaves the drawer
open, which usefully moves AT focus into the menu the user asked for). Href-less "Shorts" routes
to `/shorts/`; href-less "Show more"/"Show less" toggles are skipped. Agent commands: "menu" /
"sidebar" → `list_sidebar`; "go to subscriptions" / "open history" → `open_sidebar_item`
(matched **before** open-by-number so "open subscriptions" isn't read as "open N").

**Arrow-key browsing** (agent-side, `ytAgent.startBrowse`): on the home feed and search
results the extension arms arrow keys so the user steps through videos hearing each
described (Down/Up move, Enter plays, Escape exits). It captures arrows only while armed and
not in a text field. **Escape is never a keyboard dead end:** once the user has browsed at
least once this session (`browseState.everArmed`), the keydown listener stays attached after
`stopBrowse`, so a single arrow press on a list surface **re-arms** browsing and steps —
Escape hands arrows back to the page/AT for the moment, an arrow takes them back. Off on
`/watch` and `/shorts` (arrows seek the player) — while disarmed the listener is inert and
passes keys through, `browseMove` self-disarms if invoked off a list surface, and `stopBrowse`
clears the cached list so a stale feed is never replayed after navigating. **Browse reads up to `BROWSE_LIMIT` (100)
cards, not 20, and auto-extends at the end** — pressing Down on the last item calls
`growFeed()` (which invokes `load_more_home` then re-reads) so the user can page past the
initial batch; saying "more" while browsing also refreshes the cached list. Voice/loop and
tools are unchanged; this is guided navigation layered on top.

**Consumer↔provider invocation.** The provider's `ModelContext` exposes only `registerTool`
(no `callTool`), so the agent wraps `registerTool` to capture every tool into a live registry
and invokes them via `consumer.call(name, args)` / `consumer.has(name)` — returning the raw
WebMCP `{content:[{text}]}` envelope. The deterministic command layer and arrow-browse both
go through this; if `consumer.call` is missing, `feed()` silently returns `[]` ("no videos")
and `playback_control` no-ops — keep it defined.

Video lists and `get_video_info` include a `thumb` URL (`i.ytimg.com/vi/<id>/hqdefault.jpg`).
The agent's **consumer-local** `describe_image` tool (not a provider tool) fetches it and
uses on-device Nano image input to describe it for a non-sighted user — keeping the tool
boundary text-only (provider passes a URL; the consumer does the vision).

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
- **Video lists are 1-based** (`index` starts at 1) so spoken numbers match ("open video 5" =
  the 5th). Tools read args **leniently** (`argIndex`/`argName`) because the small on-device
  model often mislabels them (e.g. omits `index`); the system prompt also gives a concrete
  `{"args":{"index":5}}` example.
- **⚠️ THE whole-machine-freeze: on-device Nano inference saturates the GPU → compositor freeze
  (mechanism corrected 2026-06-07; the 200s correlation holds, the "main-thread" framing did not).**
  A single `session.prompt()` ran 200829ms and the whole machine (incl. the dev terminal)
  beachballed for that duration — pinned to the model, not audio (typing `ytAgent.ask("pause")`
  didn't freeze; the same words by voice, hitting Nano because "pause" was mis-gated behind
  `onWatch` at the time, DID; 3 clean `coreaudiod` captures; 64 GB/58%-free RAM). **BUT** verified
  research corrected the mechanism: Nano inference runs **out-of-process** (the `on_device_model`
  utility service; `session.prompt()` is an async mojo round-trip), so it does **not** block this
  renderer's main thread — a main-thread block would freeze only the tab, not a separate Terminal.
  The whole-machine freeze is **GPU/Metal → WindowServer compositor starvation** (Nano's Metal
  backend saturates the GPU the window server shares) — **most-likely but UNCERTAIN until captured**
  (`scripts/capture-freeze.sh`; mechanism proof = GPU ≈100% / CPU-not-pegged / memory-green +
  `kIOGPUCommandBufferCallbackErrorImpactingInteractivity` in the log). Defenses, in order of
  load-bearing-ness: (1) **deterministic-first** — common verbs (`pause`/`play`/`skip`/`captions`/
  `next`/search) never reach any model, handled on **every** surface; (2) **kill switch + cloud
  default** — `modelChoice()` "auto" routes to the **off-device cloud engine** (zero local GPU →
  cannot freeze) or a coaching reply, **never** on-device Nano; (3) **`MODEL_TURN_BUDGET_MS` (12s)
  `AbortController`** — a REAL wired cancel that frees the JS await, but **best-effort, not a hard
  kill** (the native cancel lands only at a token boundary; an in-flight prefill/load runs on), so
  it's a *secondary* guard; (4) **one-strike circuit breaker** (`state.nanoTripped`) — a
  budget-blowing Nano turn trips it off for the session so a freeze happens **at most once**.
  **Rule: never let a common command reach the model; never let "auto" reach on-device Nano; the
  on-device model is an explicit `setEngine("nano")` measurement-only opt-in.**
- **⚠️ Model kill switch (v0.9.21) — ALL model paths are OFF by default.** Every model call — Nano
  text (`geminiEngine`), cloud text (`cloudEngine`), and vision (`describeImage` /
  `cloudDescribeImage`) — is gated behind `state.modelEnabled` (persisted in
  `localStorage.ytA11yModelEnabled`, default OFF). With the model off, an unrecognized utterance
  gets a short deterministic coaching reply; greeting, commands, and arrow-browse all work
  normally. Opt in with `ytAgent.setModel(true)`; `setModel(false)` also drops any live session.
  Do not add any model call outside this gate.
- **Engine routing (v0.10.1) — "auto" never reaches on-device Nano.** `modelChoice()` returns
  `cloud` | `nano` | `none`: turning the model on uses the **off-device cloud engine** when a key
  is configured, else returns a coaching reply (`none`). On-device Nano is reachable **only** via
  an explicit, session-only `ytAgent.setEngine("nano")` (never persisted; a stale persisted
  `"nano"` is coerced to `auto` on load) — it's a deliberate, freeze-risky **measurement-only**
  opt-in. A budget-blowing Nano turn trips the **circuit breaker** (`state.nanoTripped`) so the
  on-device path is dropped for the rest of the session (a freeze can occur at most once);
  `setEngine("nano")` re-arms it. Vision follows the same routing.
- **Cloud engine (v0.10.0) — opt-in BYOK Gemini API fallback; the safe way to turn the model on.**
  `cloudEngine` mirrors the Nano JSON tool loop but runs OFF-DEVICE (zero local GPU → cannot
  whole-machine-freeze; fetch abort actually ends the request). Model pinned to
  `gemini-3.1-flash-lite` (**never** the `gemini-flash-latest` alias — parked on a preview since
  2026-01-21). **The key is never in this public repo**: dev harness = `ytAgent.setCloudKey()` →
  localStorage (page-visible, dev only); extension = popup → `chrome.storage.local`, read ONLY by
  the service worker which does the fetch — the key never enters MAIN-world/page context and never
  crosses the bridge (only request text + correlation ids do), and the SW refuses inference when
  the kill switch is off. Free-tier prompts may be used by Google for product improvement
  (disclosed in popup + privacy policy). Conversation history (`convo`, sessionStorage, last ~12
  turns) survives full navigations and feeds both engines.
- **TTS voice (safeguard, not the freeze cause).** `pickVoice()` still prefers **LOCAL, COMPACT**
  voices and excludes `Enhanced/Premium/Siri/Eloquence` (`HEAVY_VOICE`) — a reasonable safeguard,
  though on the dev Mac no heavy voices were installed (compact "Samantha" was already used, so
  this was **not** the freeze here). **Do NOT prefer "Google"/online voices** (per-utterance fetch;
  a stall = ~25 s — v0.9.10). `pickVoice()` returns a light local voice as last resort rather than
  `null`. `speak()` has a length-scaled **watchdog**. One-time `TTS voice: <name>` log; override
  with `ytAgent.setVoice("name")`, list with `ytAgent.listVoices()`.
- **⚠️ NEVER hold the mic when the user isn't actively talking.** The extension auto-injects on
  every YouTube tab and persists; a stuck-open mic blocks other apps (video calls) and a
  runaway recognizer can hang the machine. Safeguards (do not regress): tap-to-talk uses
  **non-continuous** recognition; **`listenOnce` captures the transcript on `onresult`, calls
  `rec.stop()`, and resolves only on `onend`** — i.e. once Chrome has actually *released* the
  mic — so the caller's TTS reply never starts while the mic is still open. (Do NOT "resolve on
  `onresult`" / start TTS early: mic-input + speaker-output simultaneously is the macOS
  contention that freezes the machine.) `listenOnce` also has a **10 s watchdog**
  (`LISTEN_WATCHDOG_MS`) that force-`abort()`s if `onend`/`onresult` never fire.
- **⚠️ THE FREEZE GATE — `beginListen()` (the macOS coreaudiod whole-machine freeze fix).** Root
  cause (full diagnosis: `docs/research/voice-audio-anti-freeze.md`): opening a mic capture while
  audio is *rendering on the output device* forces macOS CoreAudio to reconfigure the output
  device session, which deadlocks the single system-wide `coreaudiod` daemon → beachball. Bare
  `webkitSpeechRecognition` uses the processed (echo-cancellation / Voice-Processing-I/O) capture
  path, which hooks the output device; `getUserMedia`/WebRTC (Meet, FaceTime) coexist fine, which
  is why only this site froze. **Every capture path (`onTalkDown`, `converse()`/`start()`, nano)
  goes through `captureUtterance` → `await beginListen()` FIRST.** `beginListen` (1) cancels our
  TTS, (2) **awaits the real `pause` event** of every page `<video>`/`<audio>` (`duckMedia` is
  awaitable — `m.pause()` returns before the output stream tears down, so we wait for it), (3)
  **`audio.suspend()`s the earcon `AudioContext`** (an always-on Web Audio render thread), (4)
  waits for `speechSynthesis` to go silent, (5) waits `OUTPUT_SETTLE_MS` for CoreAudio teardown,
  then logs `beginListen: gate open — synth.speaking=… unpausedMedia=…` (a regression shows here).
  Do NOT open a mic outside this gate, and do NOT duck without an awaited pause.
- **Capture path / the deeper cures.** The mic can use one of: **webspeech** (default — cloud Web
  Speech, freeze-guarded by the gate); **nano** (`setListenMode("nano")` — on-device audio ASR via
  plain `getUserMedia`, **the guaranteed freeze-proof path**: no `webkitSpeechRecognition`, no VPIO;
  slower, needs `#prompt-api-for-gemini-nano-multimodal-input`); and an **opt-in constrained-track**
  leg (`setConstrainedSTT(true)`) that feeds Web Speech an **echo-cancellation-OFF `getUserMedia`
  track** via `rec.start(track)` to skip VPIO. Constrained is **OFF by default** because
  `SpeechRecognition.start(track)` is flag-gated (~M135 dev-trial) and not reliably
  feature-detectable — a silent-ignore would open a second capture. **All `getUserMedia` paths use
  `echoCancellation/noiseSuppression/autoGainControl:false`** (EC is what engages VPIO). Any new
  mic path must (a) run through `beginListen`, (b) use EC-off constraints, (c) stop its stream/track
  in a `finally`.
- **Page media is restored** (`restoreMedia`) after every mic window — by `onTalkDown`, by
  `converse()`/`start()`/`ytAgent.listen`, and by `releaseAll()` — so a video is never stranded
  paused. **`releaseAll()`** (mic abort + stop recording + cancel speech + restore media +
  `audio.suspend()` + bump `talk.gen` + end loop) fires on **`visibilitychange` (hidden) / `blur`
  / `pagehide` / `beforeunload`**, plus `ytAgent.release()`. **Never reintroduce a continuous
  recognizer** — that was the root of the machine-hang / blocked-video-call incidents.
- **Model components**: text / audio / image are **separate** on-device downloads — each
  fetches the first time its modality is used. So the audio adapter is only pulled if `nano`
  listen mode is on (default Web Speech avoids it), and the image adapter only on vision.
  Multimodal sessions are **cached + `clone()`d per call** (`imageBase`, `nanoAsr._audioBase`)
  so we don't re-create — and risk re-fetching — them every time. `availability()` of
  `downloadable`/`downloading` triggers a one-time "Setting up the model…" announcement.
- **Deterministic command layer** (`handleCommand` in the agent, runs first in `ask()`):
  common intents — `open/play N`, `next`/`previous`, `play`/`pause`, `skip forward/back`,
  `search X`, `filter by X`, `captions on/off`, `list`, `more`, `go home/back`, plus
  ergonomics (`repeat`, `slower`/`faster`, `louder`/`quieter`, `stop`, `help`) — are matched
  by regex and run **instantly, no model round-trip** (fixes Nano misrouting + latency +
  apology loops). Only non-matching/conversational text falls through to `geminiEngine`.
  Numbers are 1-based; word-numbers + ordinals parsed (`parseNum`). Open/search/home speak a
  confirmation then navigate (with `sessionStorage` continuity).
- **Route registration is surface-scoped, not path-scoped.** Re-register tools only when the
  resolved **surface** changes (`onMaybeRouteChange` compares `lastSurface` only) — NOT on every
  pathname change. Scrolling Shorts (`/shorts/A→B`) and switching videos (`/watch?v=A→B`) stay on
  the same surface and the tools read the DOM live, so re-registering just churns. **Verified
  Chrome behavior (`#enable-webmcp-testing`):** `ModelContext` does **not** unregister tools when
  their `AbortSignal` fires — there is no `unregisterTool`, and abort is a no-op for the native
  registry. So a re-register throws `InvalidStateError: Duplicate tool name`; the provider treats
  that as "already registered" (the consumer's `registerTool` wrapper captures the tool into its
  Map *before* the native call throws, so the agent still works). Never rely on abort to clear
  the page's registry; rely on surface-scoped re-registration to avoid duplicates in the first place.
- **`[yt-a11y]` log prefix** for all console output.
- **Docs stay current with code.** Update `README.md`, `docs/HANDOFF.md`, and
  `docs/architecture/yt-a11y-agent.md` (diagrams included) in the *same change* that
  alters tools, `SEL`, the engine, or the architecture. Treat stale docs as a bug.
- **One source of truth for provider/agent.** `extension/provider.js` + `extension/agent.js`
  are **generated** from `src/` by `npm run build:extension` — never edit them directly;
  edit `src/…` then re-run the build (and reload the unpacked extension). The `extension/`
  dir is the MV3 packaging; the `src/…user.js` files are the userscript form. Same code.

## Open questions — resolve empirically, not by reading specs

1. ~~**API namespace: `document.modelContext` vs `navigator.modelContext`.**~~
   **RESOLVED (2026-06-04; updated 2026-06-07):** Chrome 149 populates
   **`navigator.modelContext`**, but the SPEC moved the getter to **`document.modelContext`**
   (webmcp PR #184, 2026-05-27) and Chrome 150 is expected to follow — both scripts now probe
   document-first with the navigator fallback. The provider object is a `ModelContext` whose
   only method is **`registerTool(tool, { signal })`** — invocation is the MCP consumer's job.
   Re-probe each Chrome release.
2. ~~**Permissions Policy for `tools` on youtube.com.**~~
   **RESOLVED (2026-06-04):** A main-world-injected script registers fine on youtube.com
   under the default `tools` policy — `registered 5 tool(s)` on home, no throw. The
   day-one spike passed.
3. ~~**PiP transient user activation.**~~
   **RESOLVED (2026-06-07, `npm run verify:gestures` — trusted CDP input, clean controls):**
   `requestPictureInPicture()` needs transient activation (~5 s window): fails cold
   (`NotAllowedError`), succeeds right after a trusted keypress, fails 6 s later, and the
   native-button `el.click()` fallback is **equally gated** (no PiP without activation; Shift
   grants none). The working path is the agent's **gesture relay** (`armGestureRelay`): the
   deterministic "picture in picture" command runs `enter_pip` inside the user's next trusted
   keydown. Reuse this relay pattern for any other gesture-gated API.
4. ~~**Multimodal media handling.**~~
   **RESOLVED (2026-06-07, by decision — documented in `docs/architecture/yt-a11y-agent.md`
   "Media contract"):** consumer owns TTS/STT/vision; tools stay text-only. WebMCP defines no
   tool-result content model (multimodal = open issues #41/#86/#81); MCP's content blocks are
   the likely future and our shapes map onto them; Prompt API output is text-only anyway.
   Revisit if webmcp#86/#41 merge.

## Run / test

1. **Chrome** with WebMCP testing enabled: `chrome://flags/#enable-webmcp-testing`
   (restart Chrome after toggling).
2. **Tampermonkey**: install `src/youtube-a11y-agent.user.js`. Confirm the header still
   says `@grant none` — that is what keeps us in the MAIN world where `modelContext` is
   visible.
3. **Model Context Tool Inspector** extension: use it to see which tools are registered on
   the current page and to invoke them by hand. Navigate home → watch → back and watch the
   registered set change (route-scoped registration) and the `[yt-a11y]` console lines.
4. **Headless selector verification:** `npm run verify:selectors` (uses `puppeteer-core`
   against the installed Chrome) runs the provider's real extraction logic against live
   YouTube and prints what each journey scrapes. Run it after any `SEL`/`readVideoCards`
   change; no flags needed (it checks the DOM layer, not WebMCP/Gemini).
   **Gesture verification:** `npm run verify:gestures` (headful) measures the
   user-activation-gated paths (PiP, transcript-open) with trusted CDP input. ⚠️ When
   measuring activation, never use `page.evaluate` (puppeteer passes `userGesture:true`,
   silently granting activation) — use raw `Runtime.evaluate` with `userGesture:false`,
   as the script does.
5. **Freeze diagnosis (macOS).** The whole-machine-freeze mechanism is *most-likely* GPU/Metal →
   WindowServer **compositor starvation** from on-device Nano, but still **UNCERTAIN until
   captured** — confirm before trusting any fix (we've misattributed this ~5× by inference).
   The local Terminal beachballs too, so capture from a sampler that survives the freeze:
   **`sudo ./scripts/capture-freeze.sh`** (pre-starts in-kernel `powermetrics` + `log stream`,
   summarizes after recovery), or hold an SSH session from a second machine running
   `sudo powermetrics --samplers gpu_power,cpu_power,ane_power -i 500`. Repro: `setModel(true)` →
   `setEngine("nano")` → a conversational (non-command) utterance so a real `session.prompt()`
   runs. **Mechanism proof =** GPU active residency ≈100% for the whole freeze window WHILE CPU is
   not pegged on all cores AND `memory_pressure` green, plus `log show --last 5m --predicate
   'eventMessage CONTAINS "Impacting Interactivity"'` showing
   `kIOGPUCommandBufferCallbackErrorImpactingInteractivity`. ⚠️ Do NOT grep for
   `GPURestartSignaled`/`HALS_OverloadMessage` (stale/off-platform). In-page corroboration: the
   `geminiEngine` dual probe logs `display-stall …ms / main-thread-stall …ms` — a large
   display-stall with a small main-thread-stall is the GPU/compositor signature. The earlier
   coreaudiod recipe (ruled out — 3 clean captures) and the mic A/B for the **separate** audio
   class live in `docs/research/voice-audio-anti-freeze.md`.

## Status

All journeys **implemented**; selectors **verified live** (home interactively, others via
the headless harness). PiP gesture path **resolved** (gesture relay); transcript-open
verified to automation's limit (hydration needs one interactive check). Agent engines:
on-device Gemini Nano + opt-in BYOK cloud Gemini, both behind the kill switch (default
OFF; deterministic commands always work). See `docs/HANDOFF.md` for details.
