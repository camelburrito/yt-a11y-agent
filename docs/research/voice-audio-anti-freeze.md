# Voice/Audio Anti-Freeze — Diagnosis & Ranked Plan

Status: research/spec. Drives changes to `src/agent/dev-agent.user.js` (voice layer) and the
generated `extension/agent.js`. Read alongside `docs/HANDOFF.md` and `CLAUDE.md` (the
"NEVER hold the mic" / "prefer LOCAL voices" / on-device-only rules this doc must respect).

## The bug

On macOS Chrome, opening `webkitSpeechRecognition` (the mic) while the YouTube `<video>` is
playing audio and/or `speechSynthesis` TTS is speaking **freezes the whole machine** (beachball),
not just the tab. It reproduces only on this site / this API path. Google Meet and FaceTime —
which use `getUserMedia`/WebRTC — never freeze, even with audio playing.

## Diagnosis (most-supported root cause)

The freeze is a **macOS CoreAudio (`coreaudiod`) device-reconfiguration deadlock**, not a
Chrome-app bug and not a network problem. Reconciling the code map with all five research
angles, the causal chain is:

1. The page is already producing OUTPUT on the built-in/default device at 44.1/48 kHz (the
   `<video>`, plus possibly `speechSynthesis` TTS, plus our never-suspended earcon `AudioContext`).
2. Tap-to-talk opens **bare `webkitSpeechRecognition`**, which has **no constraint surface** —
   it always uses Chrome's *default processed* capture path (`echoCancellation:true`,
   voice-processing). On macOS that engages **Voice Processing I/O (VPIO)**, which by design
   *hooks the OUTPUT device* (it cancels system playout) and forces **both** the input and
   output nodes into voice-processing mode at a common ~16 kHz speech clock.
3. To satisfy simultaneous input + output at mismatched rates, CoreAudio must **renegotiate /
   reconfigure the OUTPUT device's session (aggregate device + sample-rate change) while it is
   actively rendering**. A format/rate reset on a busy *internal* device is the documented
   trigger for CoreAudio's **`callbackLock` vs `AudioDeviceStart()` real-time-thread deadlock**
   ("Start: Mach message timeout. Apparently deadlocked.") and/or **`HALS_OverloadMessage`**.
4. `coreaudiod` is the single system-wide audio daemon, so when its real-time thread wedges,
   **every process that touches audio blocks on it** → whole-machine beachball.

**Why Meet/FaceTime are immune:** WebRTC opens **one long-lived `getUserMedia` session at call
start** with `echoCancellation:true`, settling input+output together in **one** VPIO duplex
unit, and **holds it warm** for the whole call. It never does the per-utterance "open a fresh,
separate capture device against already-playing output" dance. The freeze is about
**open/close churn of a separate capture path against live output**, not mic capture per se.

**Why this site only:** we uniquely combine loud page output already running with
`webkitSpeechRecognition`'s separate, short-lived, low-rate, uncontrollable-EC input open
**every tap**.

**The decisive variable:** *concurrency of audio OUTPUT at the instant the mic opens.* If
nothing is rendering on the output device when capture starts (and capture does not engage the
output-hooking VPIO path), there is nothing to renegotiate against and the deadlock cannot fire.

### Where the current code already helps — and where it still loses the race

- `duckMedia()` (`dev-agent.user.js:1274`) pauses the `<video>` right before the mic opens —
  mechanistically correct (removes an output render client) and is the primary current
  mitigation. **But:**
  - **Not atomic with mic open.** `m.pause()` returns immediately; the media pipeline /
    CoreAudio output stream tears down *asynchronously*. `voice.listenOnce()` → `rec.start()`
    fires on the very next line (`onTalkDown` `:1347` → `:1350`), so the mic can open while the
    output device is still active. No "await output actually idle" gate.
  - **Only wired into `onTalkDown`.** `converse()` (`:960`) and `start()` (`:975`) call
    `captureUtterance()` → `voice.listenOnce()` with **no ducking at all**, so those paths open
    the mic with the `<video>` still playing — the exact freeze condition.
  - **Pausing the `<video>` does not stop VPIO from hooking the output device.** Even with the
    element paused, bare `webkitSpeechRecognition`'s EC still attaches to / reconfigures the
    output device session; ducking lowers the load but does not remove the coupling.
- The earcon `AudioContext` (`:388-418`) is created once and **never suspended/closed**. An
  un-suspended context keeps a CoreAudio real-time output render thread alive continuously
  (documented `coreaudiod`-busy cause), shrinking headroom at the exact moment the mic open
  demands a device reconfigure. Worse, `audio.listening()` plays *immediately before*
  `duckMedia()`/`rec.start()` (`:1346`), so a tone is rendering at the instant of contention.
- `nanoAsr.recordUtterance()` (`:434`) opens **bare `getUserMedia({audio:true})`** — no
  constraints, so it also engages the default processed/EC path — plus a **second**
  `AudioContext` analyser (`:446`) on top of the page graph, and **also has no ducking**.

## Comparison of approaches (with sources)

| Approach | Attacks root cause? | On-device / privacy | Honors "never hold mic" | Effort |
|---|---|---|---|---|
| **A. Constrained `getUserMedia` track → `SpeechRecognition.start(track)`** with `{echoCancellation:false,noiseSuppression:false,autoGainControl:false}` | **Yes** — non-EC capture never engages VPIO, so the output-device coupling step never happens | STT stays cloud Web Speech (same as today) | Yes (track stopped per turn) | small |
| **B. Strict output-quiescence gate before `rec.start()`** (await `pause` event + `speechSynthesis.speaking===false` + settle delay; never play earcon/TTS during mic window) | **Yes** — removes concurrent output to renegotiate against; makes the existing mitigation airtight | n/a | Yes | small |
| **C. Suspend/close earcon `AudioContext` when idle; same for nano's analyser** | Partial — removes an always-on output client (`coreaudiod`-busy cause) | n/a | n/a | small |
| **D. On-device Web Speech (`processLocally=true`, SODA, Chrome 139+)** | **No** by itself (same capture path) — privacy/latency win only; **must** pair with A or B | **Yes** (audio never leaves device) | Yes | small–medium |
| **E. Default to on-device Gemini Nano audio ASR (`getUserMedia`+MediaRecorder, already in repo)** with the A constraints | **Yes** (getUserMedia, no EC coupling) | **Yes** (Nano, already mandated) | Yes | medium |
| **F. `getUserMedia` capture + dedicated on-device WASM STT (Moonshine/whisper.cpp/vosk)** | **Yes** | **Yes** | Yes (record-once, free recognizer) | large |
| **G. Mic capture in an MV3 offscreen document** | **No** by itself (shares the same `coreaudiod`; no supported `SpeechRecognition` reason — Chrome team declined) | n/a | needs care | large |
| **H. Persistent/warm `getUserMedia` track (the Meet pattern)** | Yes (no per-tap reconfigure) | n/a | **Violates** the hard rule (holds the device); `track.enabled=false` is NOT enough | medium |
| **I. Cloud streaming STT (Deepgram/AssemblyAI/Google)** | Yes (getUserMedia path) | **No** (audio leaves device) — reject | Yes | medium |

Key sources: CoreAudio deadlock on rate-change/restart of a busy internal device
(forum.juce.com/t/coreaudio-deadlock-when-stopping-and-restarting-device/51882); VPIO forces
input+output into voice-processing and hooks output
(developer.apple.com/forums/thread/733733; developer.chrome.com/blog/more-native-echo-cancellation);
`SpeechRecognition.start(audioTrack)` accepts a constrained track
(developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start; WICG/speech-api#66);
un-suspended `AudioContext` pins `coreaudiod` (bugzilla.mozilla.org/show_bug.cgi?id=1560632);
on-device Web Speech `processLocally` (developer.mozilla.org/.../SpeechRecognition/processLocally,
developer.chrome.com/blog/new-in-chrome-139); no `SpeechRecognition` offscreen reason
(developer.chrome.com/docs/extensions/reference/api/offscreen,
chrome-extensions-samples#821); `speechSynthesis` has no `setSinkId`, `chrome.tts` is
SW-callable (developer.chrome.com/docs/extensions/reference/api/tts); idle-mic cold start /
warm-track immunity (github.com/drewburchfield/macos-mic-keepwarm,
medium.com/@fippo/goodbye-macos-webrtc-audio-bug-25a780222a5c); Whisper/Moonshine/vosk on-device
(whisper.ggerganov.com, github.com/moonshine-ai/moonshine, npmjs.com/package/vosk-browser).

## Ranked plan (immediate → durable)

1. **Output-quiescence gate (B) + suspend earcon context (C).** Smallest, no API risk, covers
   *all* listen paths. Add an `await`able `quiesceOutput()` that: `speechSynthesis.cancel()`,
   poll until `!speechSynthesis.speaking`, await each ducked element's `pause` event (or
   `paused===true`), suspend the earcon `AudioContext`, then a ~150–250 ms settle delay — and
   call it at the top of **both** `listenOnce()` and `nanoAsr.recordUtterance()` (or wrap a
   shared `beginListen()`), so `converse()`/`start()` are covered too. Play the `listening`
   earcon **before** the gate and let it finish; never during the mic window.
   - Code: `voice.listenOnce` `:299`, `audio.tone` `:391-406`, `duckMedia/restoreMedia`
     `:1274-1293`, `onTalkDown` `:1346-1350`, `captureUtterance` `:946`.

2. **Constrained `getUserMedia` track → `SpeechRecognition.start(track)` (A).** Root-cause fix
   that keeps Web Speech. Feature-detect `start(track)`; `getUserMedia({audio:{echoCancellation:false,
   noiseSuppression:false,autoGainControl:false}})`, pass `getAudioTracks()[0]` to `rec.start(track)`,
   stop the track in `finally`. Fall back to bare `rec.start()` where unsupported. Same EC-off
   constraints on nano's `getUserMedia({audio:true})` (`:434`).

3. **On-device Web Speech `processLocally=true` (D), gated on `available()`/`install()`.**
   Stack on #1/#2. Privacy win + shorter session; reuses the existing
   "Setting up the model…" download UX. Not a freeze fix alone — keep #1/#2.

4. **Default STT to on-device Nano audio ASR (E), constrained + ducked.** Eliminates
   `webkitSpeechRecognition` from the default flow entirely; on-device. Gated on Nano-audio
   latency being acceptable. Code already exists (`nanoAsr`); needs the A constraints +
   the #1 gate + closing its analyser context in a `finally`.

5. **Durable: `getUserMedia` + dedicated on-device WASM STT (Moonshine) for MV3 (F),
   optionally in an offscreen document (G) for navigation persistence.** Largest, but gives a
   freeze-free capture path, best short-utterance accuracy, and survives SPA nav. Reject warm
   persistent mic (H) and cloud STT (I).

## Smallest change to try FIRST

**#1 (B+C):** make output quiescence airtight and suspend the earcon context, applied to a
single shared `beginListen()` used by every capture path. It directly removes the concurrent
output the freeze needs, fixes the un-ducked `converse()/start()` and nano paths, and removes
the always-on earcon render thread — with no new API dependency and no UX change beyond a sub-
quarter-second gap covered by the listening earcon.

## Durable end-state

All mic capture goes through **constrained `getUserMedia` (EC/NS/AGC off) → on-device
recognizer** (Web Speech `start(track)` + `processLocally`, or Nano/Moonshine), behind a single
`beginListen()` that **guarantees zero output is rendering at the instant the device opens** and
that earcons/TTS never overlap the mic window — i.e. permanently off the bare-
`webkitSpeechRecognition`-against-live-output path that deadlocks `coreaudiod`. Tap-to-talk,
record-once, full `releaseAll()` coverage, never a held mic.

## Verification plan (prove the freeze is gone)

Repro rig: macOS Chrome 139+ (`#enable-webmcp-testing`), YouTube `<video>` playing, tap-to-talk.
**Test built-in speakers+mic AND AirPods** (the 48→16 kHz aggregate path is the worst case).

1. **Instrument the listen path.** Log timestamps for: `quiesceOutput start/end`,
   `speechSynthesis.speaking` at gate exit, each ducked element's `pause` event, `rec.start`,
   `onresult`, `rec.stop`, `onend`, track `stop`. Assert (dev build) at `rec.start`:
   `!speechSynthesis.speaking` && no `<video>/<audio>` with `!paused` && earcon ctx suspended.
   A failed assertion = freeze risk reintroduced.
2. **A/B with Activity Monitor / `sample coreaudiod`.** Compare: (a) current bare Web Speech,
   (b) +B+C gate, (c) +A constrained track, (d) +D processLocally, (e) Nano default. Watch the
   macOS console for `default output device's sample rate was changed` / `Mach message timeout
   ... deadlocked` / `HALS_OverloadMessage` and `coreaudiod` CPU. Expectation: (c)/(d)/(e) and a
   correctly-awaited (b) show no rate-change log and no `coreaudiod` spike at mic-open.
3. **Stress.** Rapid tap-to-talk presses (barge-in), tab hide/blur mid-listen (`releaseAll`),
   AirPods connect/disconnect during a turn, `converse()`/`start()` loop with video playing.
   Each must not freeze.
4. **Add to `docs/HANDOFF.md` run/test checklist** once green.

## Implemented in v0.9.14 (`src/agent/dev-agent.user.js`)

Shipped after two adversarial reviews. Both reviewers' key caveat is honored: **the CoreAudio
chain is still inference — capture a real `coreaudiod` artifact before declaring the freeze
cured.** What landed:

- **The gate (#1, B+C) — the universal floor, on by default.** `beginListen()` runs before every
  capture path (`onTalkDown` now routes through `captureUtterance`, so tap-to-talk, `converse()`,
  `start()`, `ytAgent.listen`, and nano all gate). It cancels TTS, **awaits each media element's
  real `pause` event** (`duckMedia` is now awaitable — closes the non-atomic `pause()`→`rec.start`
  race), **`audio.suspend()`s the earcon `AudioContext`** (also on `releaseAll`), waits for
  `speechSynthesis` silence, settles `OUTPUT_SETTLE_MS` (200 ms), then logs `beginListen: gate
  open — synth.speaking=… unpausedMedia=… constrainedSTT=…` as the regression canary. `restoreMedia`
  now runs on the previously **un-ducked** `converse()`/`start()`/`listen` paths too.
- **EC-off everywhere (A).** Both `getUserMedia` calls (nano, and the optional Web Speech track)
  use `echoCancellation/noiseSuppression/autoGainControl:false` + `channelCount:1` — EC is what
  engages macOS VPIO / the output-device hook.
- **Nano = the guaranteed freeze-proof path (E), available not default.** `setListenMode("nano")`
  records via plain `getUserMedia` → on-device Nano, no `webkitSpeechRecognition`. Not forced as
  default (needs the multimodal flag; slower) — but it's one call away and the only path that
  *cannot* hit VPIO.
- **Constrained Web Speech track (A via `start(track)`) — opt-in, OFF by default.**
  `setConstrainedSTT(true)` feeds Web Speech an EC-off track. Off by default because
  `SpeechRecognition.start(track)` is **flag-gated (~M135 dev-trial) and not reliably
  feature-detectable** (WebAudio/web-speech-api#126); a silent-ignore would open a *second*
  capture and could worsen contention. Falls back to the bare (gated) path if `start(track)`
  throws. Use it only with the instrumentation to A/B whether it removes the rate-change.

**Not done (deliberately): `processLocally` (D)** and **WASM Moonshine / offscreen (F/G)** — and
the durable-end-state language is downgraded to a roadmap item until an instrumented `coreaudiod`
artifact confirms the diagnosis (per both reviewers). `start(track)` is **not** treated as the
load-bearing cure for the same reason.

### Capture the artifact (do this before trusting any fix)

```sh
# live, while reproducing:
log stream --predicate 'process == "coreaudiod"' --info
# or after the machine recovers:
log show --last 5m --predicate 'process == "coreaudiod"'
```
Reproduce on the **unpatched** build with a `<video>` playing; the diagnosis is confirmed iff you
see `default output device's sample rate was changed` / `Start: Mach message timeout. Apparently
deadlocked` / `HALS_OverloadMessage` at the instant the mic opens — and they disappear with the
gate + EC-off / nano. Test **AirPods/Bluetooth** output (forces the 48→16 kHz aggregate path).
