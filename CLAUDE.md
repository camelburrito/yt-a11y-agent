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
  model is on-device so CSP is a non-issue). Tools are driven by a **manual JSON loop** —
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
| watch-next | `/watch` (same surface)   | `list_up_next`, `play_next`, `set_autoplay` ✅ verified live |
| comments | `/watch` (same surface)    | `get_comments`, `summarize_comments`, `get_pinned_comment` ✅ verified live |
| pip     | `/watch` (same surface)      | `enter_pip`, `exit_pip` 🟡 button+fallback present; gesture path needs flagged run |
| channel | `/@*`, `/channel/*`, `/c/*`  | (cross-cutting only for now) |
| other   | anything else                | (cross-cutting only) |

`where_am_i` and `get_account` are **cross-cutting** — registered on every route.
`where_am_i` returns surface + pathname; `get_account` returns `{signedIn, name}`.
**`signedIn` is reliable; `name` is usually `null`** — YouTube only renders the account name
after the account menu is opened, and we won't open it (AT-safe). So greet signed-in users
warmly *without* a name ("Welcome back!"); use the name only if present.

**Arrow-key browsing** (agent-side, `ytAgent.startBrowse`): on the home feed and search
results the extension arms arrow keys so the user steps through videos hearing each
described (Down/Up move, Enter plays, Escape exits). It captures arrows only while armed and
not in a text field. Off on `/watch` and `/shorts` (arrows seek the player) — `browseMove`
self-disarms if invoked off a list surface, and `stopBrowse` clears the cached list so a
stale feed is never replayed after navigating. **Browse reads up to `BROWSE_LIMIT` (100)
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
- **TTS voice**: `pickVoice()` prefers natural voices (Chrome's Google voices / good Mac
  voices) over the robotic default first-English voice; `ytAgent.setVoice("name")` overrides.
- **⚠️ NEVER hold the mic when the user isn't actively talking.** The extension auto-injects on
  every YouTube tab and persists; a stuck-open mic blocks other apps (video calls) and a
  runaway recognizer can hang the machine. Safeguards (do not regress): tap-to-talk uses
  **non-continuous** recognition, and **`listenOnce` calls `rec.abort()` the instant
  `onresult` fires** — do NOT wait for Chrome's natural `onend`, which leaves the session (and
  the mic indicator) open through the LLM + TTS reply, and the live mic can even hear our own
  TTS over the speakers and refuse to end. `listenOnce` also has a **10 s watchdog**
  (`LISTEN_WATCHDOG_MS`) that force-`abort()`s if `onend`/`onresult` never fire. **Page media
  is paused for the mic window** (`duckMedia`/`restoreMedia` around `listenOnce`): opening Web
  Speech while the `<video>` blasts audio is the macOS `coreaudiod`-contention trigger that
  beachballed the whole machine (reported repeatedly; only this site, since Meet/FaceTime use
  WebRTC not `webkitSpeechRecognition`). We pause only media we find playing and resume only
  those — also on `releaseAll`, so a video is never stranded paused.
  and `releaseAll()` (mic abort + stop recording + cancel speech + bump `talk.gen` + end loop)
  fires on **`visibilitychange` (hidden) / `blur` / `pagehide` / `beforeunload`**, plus
  `ytAgent.release()`. Any new mic / `getUserMedia` path must be covered by these and always
  stop its stream in a `finally`. **Never reintroduce a continuous recognizer** — that was the
  root of the machine-hang / blocked-video-call incidents.
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
4. **Headless selector verification:** `npm run verify:selectors` (uses `puppeteer-core`
   against the installed Chrome) runs the provider's real extraction logic against live
   YouTube and prints what each journey scrapes. Run it after any `SEL`/`readVideoCards`
   change; no flags needed (it checks the DOM layer, not WebMCP/Gemini).

## Status

All journeys **implemented**; selectors **verified live** (home interactively, others via
the headless harness). PiP gesture path + transcript-open are partial (need a flagged
interactive run). Agent engine: on-device Gemini Nano. See `docs/HANDOFF.md` for details.
