// ==UserScript==
// @name         YouTube A11y Agent — Dev Consumer + Voice (Gemini Nano)
// @namespace    https://github.com/camelburrito/yt-a11y-agent
// @version      0.9.12
// @description  In-page DEV harness that consumes the WebMCP tools registered by the provider userscript and drives them with Chrome's built-in on-device Gemini Nano (Prompt API) + Web Speech. On-device: no API key, no network, no CSP issues. Simulates the browser/AT opt-in handoff via ytAgent.activate(). Not the production client — see docs/HANDOFF.md.
// @author       camelburrito
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// @grant none keeps us in the page's MAIN world, same as the provider — required to see
// navigator.modelContext and to wrap its registerTool.
//
// LOAD ORDER: load this BEFORE the provider so the registerTool wrapper captures the
// provider's initial registrations. If loaded after, just navigate once (route changes
// re-register, and the wrapper catches them then).
//
// ENGINE: Chrome built-in Gemini Nano via the Prompt API (LanguageModel). On-device, so
// there is NO API key and NO external network call — which also means YouTube's CSP is a
// non-issue here. Tools are driven by a MANUAL JSON loop (geminiEngine), not Nano's native
// tool-calling, which proved unreliable (it narrates calls instead of emitting them).
// Requires Chrome flags:
//   chrome://flags/#prompt-api-for-gemini-nano
//   chrome://flags/#optimization-guide-on-device-model   (set to "Enabled BypassPerfRequirement")
// The model may download on first use (watch the console for progress).

(function () {
  "use strict";

  const LOG = "[yt-a11y-agent]";
  // High-res clock for timing. Every log line is stamped with seconds-since-load so the
  // console shows where the time goes (e.g. which session.prompt() hop stalls the machine).
  const nowms = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const T0 = nowms();
  const stamp = () => `+${((nowms() - T0) / 1000).toFixed(2)}s`;
  const log = (...a) => console.log(LOG, stamp(), ...a);
  const MANUAL_LOOP_HOPS = 4; // max tool-call round-trips per ask() in the manual JSON loop

  // Crisp spoken cues so the user knows what we're doing during slow/navigating tools —
  // no endless silent waiting. One or two words; only for tools worth narrating.
  const TOOL_CUE = {
    run_search: "Searching.",
    refine_search: "Searching.",
    list_results: "Reading results.",
    open_result: "Opening.",
    open_video: "Opening.",
    play_next: "Opening.",
    load_more_home: "Loading more.",
    list_home_feed: "Reading your feed.",
    get_transcript: "Getting the transcript.",
    summarize_video: "Summing up.",
    plain_language_summary: "Summing up.",
    get_comments: "Reading comments.",
    summarize_comments: "Reading comments.",
    describe_image: "Looking at it.",
  };

  function getModelContext() {
    return (
      (typeof document !== "undefined" && document.modelContext) ||
      (typeof navigator !== "undefined" && navigator.modelContext) ||
      null
    );
  }

  // Resolve the Prompt API across naming generations: the current `LanguageModel` global,
  // and the older `ai.languageModel` namespaces.
  function getLanguageModel() {
    if (typeof LanguageModel !== "undefined") return LanguageModel;
    if (typeof self !== "undefined" && self.ai && self.ai.languageModel) return self.ai.languageModel;
    if (typeof window !== "undefined" && window.ai && window.ai.languageModel) return window.ai.languageModel;
    return null;
  }

  // Shared download-progress monitor for LanguageModel.create({ monitor }). Text, audio, and
  // image are SEPARATE on-device components — each downloads the first time it's used.
  function dlMonitor(m) {
    if (m && m.addEventListener) {
      m.addEventListener("downloadprogress", (e) =>
        log(`on-device model download: ${Math.round((e.loaded || 0) * 100)}%`)
      );
    }
  }
  let announcedDownload = false;

  // ---------------------------------------------------------------------------
  // System prompt — defines behavior, including the proactive, orient-first greeting
  // and the "offer a short spoken menu, don't autoplay" stance.
  // ---------------------------------------------------------------------------
  const SYSTEM = [
    "You are the YouTube Accessibility Agent. A user who relies on a screen reader (such as VoiceOver) has opted to let you help them use YouTube hands-free. They CANNOT see the screen — every reply is read aloud.",
    "",
    "Rules:",
    "- Be concise and spoken-friendly. One short paragraph. No markdown, no URLs, no emoji.",
    "- Orient before offering choices. When greeting, or when the user seems lost, briefly say what page they're on and what is available, then offer clear next steps as a short spoken menu that ends in a question (e.g. \"Would you like to explore your feed or search for something?\").",
    "- At the START of a session, call get_account; if signed in, welcome them warmly (\"Welcome back!\") — use a name only if get_account returns one (it's usually null, so don't invent one).",
    "- On the HOME page, your greeting should call list_categories AND list_home_feed: briefly name the categories they can pick from, quickly read the first few video titles, and tell them they can press the up/down arrow keys to browse videos one at a time, or name a category to filter.",
    "- Use the provided tools to READ the page and ACT for the user. Never guess what is on screen — call a tool. If unsure where you are, call where_am_i.",
    "- When you have listed videos, refer to them by number (\"the first one\", \"number three\") matching the index the list tool returned.",
    "- Confirm before navigating away from the current page if there is any ambiguity.",
    "- Keep the user in control: offer, don't autoplay.",
    "",
    "You are an intermediary: you never alter the page. You read it and act on the user's behalf while their screen reader stays in charge.",
  ].join("\n");

  // ===========================================================================
  // CONSUMER BRIDGE (MCP client side).
  // The provider's ModelContext only exposes registerTool — no list/call. So we wrap
  // registerTool to capture every tool as it registers, and honor its AbortSignal to drop
  // it on unregister (route changes). That gives us a live tool registry to drive.
  // ===========================================================================
  const consumer = (() => {
    const tools = new Map(); // name -> { name, description, inputSchema, execute }
    let wrapped = false;

    function wrap() {
      const api = getModelContext();
      if (!api || typeof api.registerTool !== "function") return false;
      if (wrapped) return true;
      const orig = api.registerTool.bind(api);
      api.registerTool = (tool, opts = {}) => {
        tools.set(tool.name, tool);
        if (opts && opts.signal) {
          opts.signal.addEventListener("abort", () => tools.delete(tool.name), { once: true });
        }
        log(`captured tool: ${tool.name}`);
        return orig(tool, opts);
      };
      wrapped = true;
      log("registerTool wrapper installed — capturing tool registrations.");
      return true;
    }

    return {
      wrap,
      isReady: () => wrapped,
      list: () => [...tools.values()],
      signature: () => [...tools.keys()].sort().join(","),
      has: (name) => tools.has(name),
      // Invoke a captured provider tool by name and return its raw WebMCP envelope
      // ({ content: [{ type:"text", text }] }) — callers read res.content[0].text. The
      // provider's ModelContext has no callTool, so we drive the captured tool directly.
      // Throws if the tool isn't registered on the current surface, so callers should guard.
      async call(name, args) {
        const t = tools.get(name);
        if (!t) throw new Error(`tool not registered on this surface: ${name}`);
        return await t.execute(args || {});
      },
      // Wrap captured WebMCP tools into Prompt-API tools. The shapes nearly match; we only
      // flatten the WebMCP { content:[{text}] } envelope down to a string for the model.
      asPromptApiTools: () =>
        [...tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema || { type: "object", properties: {} },
          async execute(args) {
            const out = await t.execute(args || {});
            const text = (out && out.content ? out.content : [])
              .map((c) => c.text)
              .filter(Boolean)
              .join("\n");
            return text || "(no textual result)";
          },
        })),
    };
  })();

  // ===========================================================================
  // VOICE (Web Speech). Out-of-band from tools; tools stay text-only.
  // ===========================================================================
  const voice = (() => {
    const synth = typeof window !== "undefined" ? window.speechSynthesis : null;
    const SR =
      (typeof window !== "undefined" && (window.SpeechRecognition || window.webkitSpeechRecognition)) ||
      null;

    // Voice selection. CRITICAL: prefer LOCAL voices (localService === true). The "Google"
    // / online voices (localService === false) fetch audio from a server PER utterance — when
    // that network call stalls, speechSynthesis.speak() takes ~25s to say one word and freezes
    // the turn (measured: speak() 25510ms for "Paused."). Local macOS voices (Samantha/Alex/…)
    // are instant and never touch the network. We only fall back to an online voice if there is
    // no local English voice at all. A user override (setVoice) still wins if it's local.
    let preferredVoiceName = null;
    function pickVoice() {
      const vs = synth ? synth.getVoices() : [];
      if (!vs.length) return null;
      const en = vs.filter((v) => v.lang && v.lang.toLowerCase().startsWith("en"));
      const pool = en.length ? en : vs;
      const local = pool.filter((v) => v.localService);
      const safe = local.length ? local : pool; // only go online if no local voice exists
      if (preferredVoiceName) {
        const m = safe.find((v) => v.name.toLowerCase().includes(preferredVoiceName.toLowerCase()));
        if (m) return m;
      }
      return (
        // Good, natural-sounding LOCAL macOS/Windows voices (no network).
        safe.find((v) => /(samantha|alex|karen|daniel|moira|tessa|fiona|victoria|aaron|allison|ava|susan|zoe)/i.test(v.name)) ||
        safe.find((v) => v.default) || // the system default local voice (reliable)
        null // null = let the browser use its own default rather than force a maybe-broken one
      );
    }
    function setVoice(name) {
      preferredVoiceName = name || null;
      const v = pickVoice();
      return v ? v.name : null;
    }
    function listVoices() {
      return (synth ? synth.getVoices() : []).map((v) => `${v.name} (${v.lang})`);
    }

    // Spoken-rate + volume, adjustable by voice ("slower" / "faster" / "louder" / "quieter").
    let rate = 1.05;
    let volume = 1.0;
    function setRate(delta) {
      rate = Math.max(0.5, Math.min(2, rate + (delta || 0)));
      return rate;
    }
    function setSpeechVolume(delta) {
      volume = Math.max(0.1, Math.min(1, volume + (delta || 0)));
      return volume;
    }

    // Single speech channel. Every speak() INTERRUPTS the previous line instead of queueing
    // behind it — otherwise rapid arrow presses read every old item in order, and a reply
    // keeps talking after the user has barged in. Tricky part: calling synth.speak()
    // immediately after synth.cancel() races on Chrome and silently drops the utterance, so
    // we cancel, then start on the next tick. And when a new line supersedes one that hasn't
    // started speaking yet, we must still resolve the old promise (else `await speak()` hangs).
    let pendingResolve = null;
    let speakTimer = null;
    let resumeTimer = null;
    function flushSpeak() {
      if (speakTimer) {
        clearTimeout(speakTimer);
        speakTimer = null;
      }
      if (pendingResolve) {
        const r = pendingResolve;
        pendingResolve = null;
        r();
      }
    }
    function speak(text) {
      return new Promise((resolve) => {
        if (!synth || !text) return resolve();
        flushSpeak(); // resolve + cancel whatever was speaking/queued
        try {
          synth.cancel();
        } catch (_) {}
        pendingResolve = resolve;
        const start = () => {
          speakTimer = null;
          const u = new SpeechSynthesisUtterance(text);
          u.rate = rate;
          u.volume = volume;
          const v = pickVoice();
          if (v) u.voice = v;
          // Watchdog: if the utterance neither ends nor errors in a reasonable window (a
          // stalled/online voice can take ~25s for one word), cancel and move on so a turn is
          // never blocked. Budget scales with text length but caps generously for long greetings.
          let watchdog = setTimeout(() => {
            // Do NOT synth.cancel() here — local macOS voices often speak fine but fire onend
            // late or never, and cancelling would CUT the audio (the "not reading responses"
            // bug). Just resolve so the turn isn't blocked; the audio keeps playing and the
            // next speak()'s cancel clears anything still going.
            finish();
          }, Math.min(30000, Math.max(8000, text.length * 140)));
          const finish = () => {
            if (watchdog) {
              clearTimeout(watchdog);
              watchdog = null;
            }
            if (pendingResolve === resolve) pendingResolve = null;
            resolve();
          };
          u.onend = finish;
          u.onerror = finish;
          synth.speak(u);
          if (resumeTimer) clearTimeout(resumeTimer);
          resumeTimer = setTimeout(() => {
            try {
              synth.resume(); // unstick Chrome's long-standing paused-queue bug
            } catch (_) {}
          }, 100);
        };
        // Wait for voices on the very first call (getVoices() is async via voiceschanged),
        // then start a tick later to dodge the cancel→speak race.
        const launch = () => {
          speakTimer = setTimeout(start, 70);
        };
        if (synth.getVoices().length) launch();
        else synth.addEventListener("voiceschanged", launch, { once: true });
      });
    }

    let activeRec = null;
    const LISTEN_WATCHDOG_MS = 10000; // a single listen can NEVER hold the mic longer than this
    function listenOnce() {
      return new Promise((resolve, reject) => {
        if (!SR) return reject(new Error("SpeechRecognition not supported in this browser."));
        const rec = new SR();
        activeRec = rec;
        rec.lang = "en-US";
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        let result = null;
        let settled = false;
        // Backstop: if onend/onresult never fire, force-abort so the mic is freed no matter what.
        const watchdog = setTimeout(() => {
          try {
            rec.abort();
          } catch (_) {}
        }, LISTEN_WATCHDOG_MS);
        // Resolve/reject EXACTLY once, and only here — after onend, i.e. once the mic is released.
        const settle = (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(watchdog);
          activeRec = null;
          if (err) reject(err);
          else if (result && result.trim()) resolve(result);
          else reject(new Error("no speech detected"));
        };
        rec.onresult = (e) => {
          result = e.results[0][0].transcript;
          // We have the words — stop capturing. CRITICAL: do NOT resolve here. We resolve in
          // onend, i.e. only once Chrome has actually RELEASED the microphone, so the caller's
          // TTS reply never plays while the mic is still open. That mic-input + speaker-output
          // overlap is the macOS coreaudiod collision that froze the whole machine.
          try {
            rec.stop();
          } catch (_) {}
        };
        rec.onerror = (e) => settle(new Error("speech recognition error: " + e.error));
        rec.onend = () => settle(); // mic fully released at this point
        rec.start();
      });
    }
    // Abort an in-progress listen (used by stop()).
    function abortListen() {
      if (activeRec) {
        try {
          activeRec.abort();
        } catch (_) {}
        activeRec = null;
      }
    }
    function cancelSpeech() {
      flushSpeak(); // resolve any awaited speak() so callers don't hang
      if (synth) {
        try {
          synth.cancel();
        } catch (_) {}
      }
    }

    // NOTE: there is deliberately NO continuous-recognition / hold-to-talk path here. A
    // continuous SpeechRecognition (rec.continuous = true) is what previously held the mic
    // open, blocked video-call apps, and hung the machine — Chrome often keeps the mic after
    // stop() on a continuous recognizer. All listening goes through the non-continuous
    // listenOnce() above (with its 10s watchdog). Do NOT reintroduce a continuous recognizer.

    // Hard release: immediately abort any active recognition and drop the mic. Used on tab
    // hide / window blur / unload so we never hold the microphone away from other apps.
    function releaseMic() {
      abortListen();
    }

    return {
      speak,
      listenOnce,
      releaseMic,
      abortListen,
      cancelSpeech,
      setVoice,
      listVoices,
      setRate,
      setSpeechVolume,
      supported: { tts: !!synth, stt: !!SR },
    };
  })();

  // ===========================================================================
  // EARCONS — short generated tones so the user gets immediate, non-verbal feedback
  // (listening / captured / ready / error) and is never left in silence after speaking.
  // ===========================================================================
  const audio = (() => {
    let ctx = null;
    let vol = 1; // master multiplier (0 = mute), set via ytAgent.setEarconVolume
    function tone(freq, dur, type, gain) {
      if (vol <= 0) return;
      try {
        ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
        if (ctx.state === "suspended") ctx.resume();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = type || "sine";
        o.frequency.value = freq;
        g.gain.value = (gain || 0.05) * vol;
        o.connect(g);
        g.connect(ctx.destination);
        const t = ctx.currentTime;
        o.start(t);
        o.stop(t + (dur || 0.1));
      } catch (_) {}
    }
    return {
      listening: () => tone(680, 0.12, "sine", 0.06), // now listening
      captured: () => tone(900, 0.08, "sine", 0.05), // got your voice
      ready: () => tone(520, 0.1, "sine", 0.04), // done / your turn
      error: () => tone(200, 0.2, "triangle", 0.05), // didn't catch it
      setVolume: (v) => {
        vol = Math.max(0, Math.min(2, Number(v)));
        return vol;
      },
    };
  })();

  // ===========================================================================
  // NANO ASR — optional speech-to-text via on-device Gemini Nano audio input
  // (requires chrome://flags/#prompt-api-for-gemini-nano-multimodal-input). Records the mic
  // with simple energy-based voice-activity detection (stops after trailing silence), then
  // hands the clip to Nano to transcribe. Alternative to Web Speech STT; selected via
  // ytAgent.setListenMode("nano").
  // ===========================================================================
  const nanoAsr = {
    _rec: null,
    _stream: null,

    // Record one utterance: wait for speech, stop after `silenceMs` of trailing quiet, or
    // `maxMs` hard cap. Returns a Blob, or null if nobody spoke. Energy-based VAD.
    async recordUtterance({ maxMs = 12000, silenceMs = 1200, startTimeoutMs = 6000 } = {}) {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this._stream = stream;
      const rec = new MediaRecorder(stream);
      this._rec = rec;
      const chunks = [];
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size) chunks.push(e.data);
      };
      const stopped = new Promise((res) => (rec.onstop = res));
      rec.start();

      const AC = window.AudioContext || window.webkitAudioContext;
      const ac = new AC();
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      ac.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const THRESH = 8; // RMS over the ~128-centered waveform that counts as "speech"
      const t0 = Date.now();
      let speechStarted = false;
      let lastLoud = t0;

      await new Promise((resolve) => {
        const id = setInterval(() => {
          if (rec.state !== "recording") {
            clearInterval(id);
            return resolve();
          }
          analyser.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const d = buf[i] - 128;
            sum += d * d;
          }
          const rms = Math.sqrt(sum / buf.length);
          const now = Date.now();
          if (rms > THRESH) {
            speechStarted = true;
            lastLoud = now;
          }
          const elapsed = now - t0;
          if (
            elapsed > maxMs ||
            (!speechStarted && elapsed > startTimeoutMs) ||
            (speechStarted && now - lastLoud > silenceMs)
          ) {
            clearInterval(id);
            resolve();
          }
        }, 100);
      });

      try {
        if (rec.state === "recording") rec.stop();
      } catch (_) {}
      await stopped;
      try {
        ac.close();
      } catch (_) {}
      stream.getTracks().forEach((t) => t.stop());
      this._stream = null;
      this._rec = null;
      if (!speechStarted || chunks.length === 0) return null;
      return new Blob(chunks, { type: chunks[0].type || "audio/webm" });
    },

    _audioBase: null, // warm audio session, only created when nano listen mode is actually used
    async transcribe(blob) {
      const LM = getLanguageModel();
      if (!LM) throw new Error("Prompt API unavailable for transcription.");
      if (!this._audioBase)
        this._audioBase = await LM.create({ expectedInputs: [{ type: "audio" }], monitor: dlMonitor });
      const s = this._audioBase.clone ? await this._audioBase.clone() : await LM.create({ expectedInputs: [{ type: "audio" }] });
      try {
        const out = await s.prompt([
          {
            role: "user",
            content: [
              { type: "text", value: "Transcribe this audio verbatim. Output only the words spoken, nothing else." },
              { type: "audio", value: blob },
            ],
          },
        ]);
        return (out || "").trim();
      } finally {
        if (s !== this._audioBase) {
          try {
            s.destroy && s.destroy();
          } catch (_) {}
        }
      }
    },

    async listenOnce() {
      const blob = await this.recordUtterance();
      if (!blob) throw new Error("no speech detected");
      const text = await this.transcribe(blob);
      if (!text) throw new Error("no speech detected");
      return text;
    },

    abort() {
      try {
        if (this._rec && this._rec.state === "recording") this._rec.stop();
      } catch (_) {}
      try {
        if (this._stream) this._stream.getTracks().forEach((t) => t.stop());
      } catch (_) {}
      this._rec = null;
      this._stream = null;
    },
  };

  // ===========================================================================
  // VISION — describe an image (e.g. a video thumbnail) via on-device Gemini Nano image
  // input (requires #prompt-api-for-gemini-nano-multimodal-input). One-shot / on-demand, so
  // the brief inference jank is acceptable (unlike real-time listening). The provider hands
  // us thumbnail URLs (the `thumb` field on list items / get_video_info) as plain text; we
  // fetch and describe them here — keeping the tool boundary text-only.
  // ===========================================================================
  async function toJpeg(blob) {
    try {
      const bmp = await createImageBitmap(blob);
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      return await new Promise((res) => c.toBlob((b) => res(b || blob), "image/jpeg", 0.9));
    } catch (_) {
      return blob; // fall back to the original bytes (Nano can usually decode them)
    }
  }

  // Keep one warm image-capable session and clone() it per call. The image model component
  // loads/downloads once and stays warm — we don't re-create (and risk re-fetching) it on
  // every describe. The clone gives a fresh context so descriptions don't bleed together.
  let imageBase = null;
  async function describeImage(url, question) {
    if (!url) throw new Error("describeImage needs a url");
    const LM = getLanguageModel();
    if (!LM) throw new Error("Prompt API unavailable for vision.");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`couldn't fetch image (${r.status})`);
    const blob = await toJpeg(await r.blob());
    if (!imageBase) imageBase = await LM.create({ expectedInputs: [{ type: "image" }], monitor: dlMonitor });
    const s = imageBase.clone ? await imageBase.clone() : await LM.create({ expectedInputs: [{ type: "image" }] });
    try {
      const out = await s.prompt([
        {
          role: "user",
          content: [
            {
              type: "text",
              value:
                question ||
                "Describe this image for someone who cannot see it. Be concise and concrete in 1-2 sentences: main subject, setting, any visible text, and mood.",
            },
            { type: "image", value: blob },
          ],
        },
      ]);
      return (out || "").trim();
    } finally {
      // Dispose only the clone / per-call session; keep imageBase warm.
      if (s !== imageBase) {
        try {
          s.destroy && s.destroy();
        } catch (_) {}
      }
    }
  }

  // Consumer-local tools — run in the agent (not registered on the page). Merged into the
  // model's tool catalog alongside the provider's WebMCP tools so the agent can call them.
  const localTools = [
    {
      name: "describe_image",
      description:
        "Describe an image for a user who cannot see it — typically a video thumbnail. Pass the image `url`: list items (list_home_feed / list_results / list_up_next) include a `thumb` URL, and get_video_info includes `thumb` for the current video. Optionally pass a `question` to ask something specific about it. On-device vision; may pause the page briefly.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" }, question: { type: "string" } },
        required: ["url"],
      },
      execute: async ({ url, question } = {}) => {
        try {
          return await describeImage(url, question);
        } catch (e) {
          return "Couldn't describe the image: " + ((e && e.message) || e);
        }
      },
    },
  ];

  // ===========================================================================
  // ENGINE — Chrome built-in Gemini Nano (Prompt API) with native tool calling.
  // The session is bound to the tools captured at creation time; tools are route-scoped,
  // so we rebuild the session when the captured tool set changes. Pluggable via
  // ytAgent.useEngine(fn) for mock testing.
  // ===========================================================================
  const state = {
    engine: null, // set to geminiEngine below
    session: null,
    sessionSig: null,
    running: false, // continuous conversation loop active?
    // "webspeech" (default, fast, streaming) or "nano" (on-device audio transcription —
    // EXPERIMENTAL: slower and can briefly jank the page during inference).
    listenMode: "webspeech",
  };

  async function availability() {
    const LM = getLanguageModel();
    if (!LM) return "no-api";
    try {
      if (LM.availability) return await LM.availability(); // available|downloadable|downloading|unavailable
      if (LM.capabilities) return (await LM.capabilities()).available; // readily|after-download|no
    } catch (e) {
      return "error: " + e.message;
    }
    return "unknown";
  }

  function destroySession() {
    if (state.session && typeof state.session.destroy === "function") {
      try {
        state.session.destroy();
      } catch (_) {}
    }
    state.session = null;
    state.sessionSig = null;
  }

  // Build the per-route session. We do NOT use Nano's native tool-calling
  // (LanguageModel.create({ tools }) + auto-loop): in practice Nano narrates
  // "I'm calling a tool..." in prose instead of emitting a real call, so nothing
  // executes. Instead we drive tools manually (see geminiEngine): the system prompt
  // instructs the model to emit ONE line of strict JSON per turn, which we parse and run.
  async function ensureSession() {
    const sig = consumer.signature();
    if (state.session && state.sessionSig === sig) return state.session;
    destroySession(); // toolset changed (route change) or first run -> rebuild

    const LM = getLanguageModel();
    if (!LM) {
      throw new Error(
        "Chrome built-in AI (Prompt API) not found. Enable chrome://flags/#prompt-api-for-gemini-nano and #optimization-guide-on-device-model, then restart Chrome."
      );
    }
    const avail = await availability();
    if (avail === "unavailable" || avail === "no" || avail === "no-api") {
      throw new Error(`Gemini Nano unavailable on this device (availability="${avail}").`);
    }
    if ((avail === "downloadable" || avail === "downloading") && !announcedDownload) {
      announcedDownload = true;
      voice.speak("Setting up the on-device model, one moment."); // communicate the one-time fetch
    }

    const catalog = consumer
      .list()
      .concat(localTools) // provider WebMCP tools + consumer-local tools (e.g. describe_image)
      .map(
        (t) =>
          `- ${t.name}: ${t.description || ""} | args: ${JSON.stringify(
            t.inputSchema || { type: "object", properties: {} }
          )}`
      )
      .join("\n");
    const sys =
      SYSTEM +
      "\n\n" +
      "You control the page through tools. On EVERY turn reply with ONE line of strict JSON, nothing else, no markdown fences.\n" +
      'To use a tool, include ALL its required args. Example: {"action":"call","tool":"open_video","args":{"index":3}}\n' +
      'When you can answer the user: {"action":"final","say":"<the reply to speak>"}\n' +
      'Videos are numbered starting at 1; pass the exact number the user says (e.g. "open video 5" -> {"action":"call","tool":"open_video","args":{"index":5}}).\n' +
      "Available tools:\n" +
      catalog;

    const tCreate = nowms();
    state.session = await LM.create({
      initialPrompts: [{ role: "system", content: sys }],
      monitor: dlMonitor,
    });
    state.sessionSig = sig;
    log(`LM.create() took ${Math.round(nowms() - tCreate)}ms (availability="${avail}"); tools: ${sig || "(none)"}`);
    return state.session;
  }

  // Extract the first JSON object from a model reply (tolerates stray prose / code fences).
  function parseAction(raw) {
    if (!raw) return null;
    const m = raw.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (_) {
      return null;
    }
  }

  // Manual tool-call loop: prompt -> parse JSON action -> run tool -> feed result back,
  // up to MANUAL_LOOP_HOPS round-trips, then expect a {"action":"final"}.
  async function geminiEngine(utterance) {
    const tSess = nowms();
    const session = await ensureSession();
    log(`ensureSession() ${Math.round(nowms() - tSess)}ms`);
    const tools = consumer.asPromptApiTools().concat(localTools);
    let turn = `User said: ${utterance}`;
    for (let i = 0; i < MANUAL_LOOP_HOPS; i++) {
      const tP = nowms();
      const raw = await session.prompt(turn);
      log(`session.prompt() hop ${i} ${Math.round(nowms() - tP)}ms`);
      const step = parseAction(raw);
      if (!step) return raw.trim(); // model returned plain prose; just use it
      if (step.action === "final") return step.say || "";
      if (step.action === "call") {
        const tool = tools.find((t) => t.name === step.tool);
        if (!tool) {
          turn = `No tool "${step.tool}". Available: ${tools
            .map((t) => t.name)
            .join(", ")}. Reply with valid JSON.`;
          continue;
        }
        // Crisp progress cue (fire-and-forget) so the user hears we're working.
        if (TOOL_CUE[step.tool]) voice.speak(TOOL_CUE[step.tool]);
        let result;
        const tExec = nowms();
        try {
          result = await tool.execute(step.args || {});
        } catch (e) {
          result = "tool error: " + ((e && e.message) || e);
        }
        log(`tool ${step.tool} ${Math.round(nowms() - tExec)}ms ->`, result);
        turn = `Result of ${step.tool}:\n${result}\n\nNow call another tool or give the final answer as JSON.`;
        continue;
      }
      return raw.trim();
    }
    return "Sorry, I couldn't complete that.";
  }
  state.engine = geminiEngine;

  // ===========================================================================
  // AGENT entry points.
  // ===========================================================================
  // ===========================================================================
  // DETERMINISTIC COMMAND LAYER. Common intents are matched here and run instantly — no
  // model round-trip, no misrouting, no waiting. Only genuinely conversational requests fall
  // through to Nano. Returns: a reply string (spoken), "" (handled silently), or null (not a
  // command -> use the model). Also folds in voice ergonomics and graceful recovery.
  // ===========================================================================
  const NUMWORDS = {
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
    sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, last: -1,
  };
  function parseNum(s) {
    const m = s.match(/\b(\d+)\b/);
    if (m) return parseInt(m[1], 10);
    for (const w in NUMWORDS) if (new RegExp("\\b" + w + "\\b").test(s)) return NUMWORDS[w];
    return null;
  }
  function helpText() {
    if (location.pathname.startsWith("/watch") || location.pathname.startsWith("/shorts"))
      return "On this video you can say: play, pause, skip forward, skip back, captions on, captions off, next video, or go home. Say repeat to hear something again, or slower and faster to change my speed.";
    return "You can say: list videos, open and a number, next, previous, search for something, load more, or go home. Say a category name like Music to filter. Say repeat, slower, or faster anytime.";
  }
  async function listHere() {
    const items = await feed(20);
    if (!items.length) return "There's nothing to list here.";
    const top = items.slice(0, 5).map((v) => `${v.index}, ${v.title}`).join(". ");
    return `${items.length} videos. ${top}. Say open and a number, or next.`;
  }
  async function openByNumber(n) {
    const items = await feed(60);
    let it = n === -1 ? items[items.length - 1] : items.find((v) => v.index === n);
    if (!it) return `There's no number ${n}. There are ${items.length}. Say a number from 1 to ${items.length}.`;
    if (!it.url) return `I found "${it.title}" but couldn't open it.`;
    try {
      sessionStorage.setItem("ytA11yPending", `Now playing ${it.title}.`);
    } catch (_) {}
    await voice.speak(`Opening ${it.title}.`); // finish the confirmation before navigating
    window.location.href = it.url;
    return "";
  }
  const callText = async (tool, args) => {
    if (!consumer.has(tool)) return `That isn't available on this page.`;
    const tExec = nowms();
    try {
      const r = await consumer.call(tool, args || {});
      log(`tool ${tool} ${Math.round(nowms() - tExec)}ms (command path)`);
      return r && r.content && r.content[0] ? r.content[0].text : "";
    } catch (_) {
      return `Sorry, I couldn't do that just now.`;
    }
  };

  async function handleCommand(rawText) {
    const t = (rawText || "").trim().toLowerCase().replace(/[.!?]+$/, "");
    if (!t || t.startsWith("[")) return null; // ignore the bracketed greeting trigger
    const path = location.pathname;
    const onWatch = path.startsWith("/watch") || path.startsWith("/shorts");
    const onList = path === "/" || path.startsWith("/feed") || path.startsWith("/results");

    // Ergonomics (any surface)
    if (/^(repeat|say (that|it) again|again|what did you say)$/.test(t)) return state.lastReply || "I haven't said anything yet.";
    if (/^faster$|(speak|talk|go)\b.*\bfaster\b/.test(t)) { voice.setRate(0.15); return "Speaking faster."; }
    if (/^slower$|slow down|(speak|talk)\b.*\bslower\b/.test(t)) { voice.setRate(-0.15); return "Speaking slower."; }
    if (/\b(louder|volume up|turn it up)\b/.test(t)) { voice.setSpeechVolume(0.15); return "Louder."; }
    if (/\b(quieter|softer|volume down|turn it down)\b/.test(t)) { voice.setSpeechVolume(-0.15); return "Quieter."; }
    if (/^(stop|quiet|shush|shut up|never ?mind|be quiet)$/.test(t)) { voice.cancelSpeech(); return ""; }
    if (/^(help|what can i (say|do)|options|commands|how do i)\b/.test(t)) return helpText();

    // Navigation
    if (/^(go )?home$|take me home/.test(t)) { try { sessionStorage.setItem("ytA11yPending", "You're on the home page."); } catch (_) {} await voice.speak("Going home."); location.href = "https://www.youtube.com/"; return ""; }
    if (/^(go back|previous page)$/.test(t)) { await voice.speak("Going back."); history.back(); return ""; }
    {
      const m = t.match(/^(?:search(?: for)?|find|look up|search up) (.+)$/);
      if (m) {
        // Navigate to results DIRECTLY — works from ANY surface. (run_search is only
        // registered on /results, so calling it from home/watch was a no-op: the original
        // bug where "search for X" did nothing.) Stash a continuation for the results page.
        const q = m[1].trim();
        const url = "https://www.youtube.com/results?search_query=" + encodeURIComponent(q);
        try {
          sessionStorage.setItem("ytA11yPending", `Here are the results for ${q}.`);
        } catch (_) {}
        await voice.speak(`Searching for ${q}.`);
        location.href = url;
        return "";
      }
    }

    // Open by number (home / search / up-next)
    if (/\b(open|play|watch|select|choose)\b/.test(t) || /\bnumber\b/.test(t) || /\b(first|second|third|fourth|fifth|last)\b/.test(t)) {
      const n = parseNum(t);
      if (n != null) return await openByNumber(n);
      if (/\b(open|play|watch)\b/.test(t) && onList) return "Which number? Say, for example, open 3.";
    }

    // Browse next / previous on list surfaces
    if (onList && /^(next|next one|down|forward)$/.test(t)) { if (!browseState.armed) await startBrowse(false); await browseMove(1); return ""; }
    if (onList && /^(previous|prev|back one|up|go up)$/.test(t)) { if (!browseState.armed) await startBrowse(false); await browseMove(-1); return ""; }
    if (onList && /^(more|load more|show more)$/.test(t)) {
      const msg = await callText("load_more_home");
      // Keep arrow-browse in sync with the newly loaded cards.
      if (browseState.armed) {
        const fresh = await feed(BROWSE_LIMIT);
        if (fresh.length) browseState.items = fresh;
      }
      return msg;
    }
    if (/^(list|what'?s here|read( the)? titles|list (videos|results))$/.test(t)) return await listHere();

    // List categories (home) — deterministic so it never hits the slow on-device model.
    if ((path === "/" || path.startsWith("/feed")) && /\bcategor(y|ies)\b/.test(t) && /^(list|read|what|which|show|tell|name)\b/.test(t)) {
      const raw = await callText("list_categories");
      let names = [];
      try {
        names = JSON.parse(raw);
      } catch (_) {}
      if (Array.isArray(names) && names.length)
        return "Categories you can pick: " + names.slice(0, 12).join(", ") + ". Say, for example, filter by Music.";
      return "I couldn't read the categories here.";
    }

    // Filter by category (home)
    {
      const m = t.match(/^(?:filter by|show me|show|category) (.+)$/);
      if (m && (path === "/" || path.startsWith("/feed"))) return await callText("select_category", { name: m[1] });
    }

    // Playback (watch)
    if (onWatch) {
      if (/^(pause|pause( the)? video)$/.test(t)) return await callText("playback_control", { action: "pause" });
      if (/^(play|resume|continue|unpause|play( the)? video)$/.test(t)) return await callText("playback_control", { action: "play" });
      if (/(skip|jump|go)\b.*(ahead|forward)|fast ?forward/.test(t)) return await callText("playback_control", { action: "forward", value: parseNum(t) || 10 });
      if (/(skip back|rewind|go back)/.test(t)) return await callText("playback_control", { action: "back", value: parseNum(t) || 10 });
      if (/captions?\b.*\bon\b|subtitles?\b.*\bon\b/.test(t)) return await callText("set_captions", { on: true });
      if (/captions?\b.*\boff\b|subtitles?\b.*\boff\b/.test(t)) return await callText("set_captions", { on: false });
      if (/^(next( video| up)?|play next)$/.test(t)) return await callText("play_next");
    }

    return null; // not a recognized command -> hand to the model
  }

  async function ask(utterance) {
    if (!utterance || !utterance.trim()) return "";
    const cmd = await handleCommand(utterance);
    if (cmd !== null) {
      if (cmd) state.lastReply = cmd;
      log("reply (command):", cmd);
      return cmd; // "" = handled silently (already spoke / no reply needed)
    }
    const reply = await state.engine(utterance);
    state.lastReply = reply;
    log("reply:", reply);
    return reply;
  }

  // Simulates the browser/AT opt-in handoff: greet + orient proactively (fresh session).
  async function activate() {
    destroySession();
    const reply = await ask(
      "[Session start. First call get_account, then greet the user (by name if signed in). Say what page they're on. If on the HOME page, also call list_categories and list_home_feed: name the available categories, read the first few video titles, and tell them they can use the up/down arrow keys to browse videos one at a time or name a category. End with a question.]"
    );
    await voice.speak(reply);
    return reply;
  }

  // Capture one spoken utterance using the selected listen mode. Nano ASR is experimental
  // (slow / can jank the page); on any non-silence error it falls back to Web Speech.
  async function captureUtterance() {
    if (state.listenMode === "nano") {
      try {
        return await nanoAsr.listenOnce();
      } catch (e) {
        if (e.message === "no speech detected") throw e;
        log("nano ASR failed, falling back to Web Speech:", e.message);
        return await voice.listenOnce();
      }
    }
    if (!voice.supported.stt) throw new Error("STT unavailable; use ytAgent.ask(text).");
    return await voice.listenOnce();
  }

  async function converse() {
    const heard = await captureUtterance();
    log(`heard: ${heard}`);
    const reply = await ask(heard);
    await voice.speak(reply);
    return { heard, reply };
  }

  // Continuous hands-free conversation: greet, then listen → respond → listen … until the
  // user says a stop word, stays silent twice, or ytAgent.stop() is called. This is how a
  // screen-reader user actually replies — they just talk; no console calls between turns.
  // Turn-taking is sequential (we listen only AFTER finishing speaking) so the agent never
  // hears its own TTS. Note: starting the mic may need a user gesture — if start() captures
  // nothing, click the page once (or use push-to-talk, where the keypress is the gesture).
  const STOP_WORDS = /^\s*(stop|cancel|never mind|nevermind|goodbye|bye|that's all|thats all|quit|exit|done)\b/i;
  async function start() {
    if (state.listenMode === "webspeech" && !voice.supported.stt)
      throw new Error("STT unavailable; use ytAgent.ask(text).");
    if (state.running) return "Already in a conversation.";
    state.running = true;
    await activate(); // speak the greeting + its question
    let silent = 0;
    while (state.running) {
      let heard;
      try {
        heard = await captureUtterance();
      } catch (e) {
        if (!state.running) break; // stop() aborted the listen
        if (++silent >= 2) {
          await voice.speak("I'll be here when you need me. Say start to talk again.");
          break;
        }
        continue; // transient no-speech/error — keep listening
      }
      silent = 0;
      if (!state.running) break;
      log(`heard: ${heard}`);
      if (STOP_WORDS.test(heard)) {
        await voice.speak("Okay, I'll stop. Say start when you want me again.");
        break;
      }
      const reply = await ask(heard);
      if (!state.running) break;
      await voice.speak(reply);
    }
    state.running = false;
    return "conversation ended";
  }

  function stop() {
    if (!state.running) return "Not currently in a conversation.";
    state.running = false;
    voice.abortListen();
    nanoAsr.abort();
    voice.cancelSpeech();
    log("conversation stopped.");
    return "stopped";
  }

  // Optional push-to-talk: bind a hotkey that runs one converse() turn. Off by default
  // (global key handlers can interfere with AT); requires a modifier combo and consumes the
  // event so it won't trigger YouTube's own shortcuts. The keypress also counts as the user
  // gesture some Chrome builds want before opening the mic.
  let pttHandler = null;
  function enablePushToTalk(opts = {}) {
    disablePushToTalk();
    const combo = { ctrlKey: true, shiftKey: true, altKey: false, code: "Space", ...opts };
    pttHandler = (e) => {
      if (
        !!combo.ctrlKey === e.ctrlKey &&
        !!combo.shiftKey === e.shiftKey &&
        !!combo.altKey === e.altKey &&
        e.code === combo.code
      ) {
        e.preventDefault();
        e.stopPropagation();
        converse().catch((err) => log("push-to-talk:", err.message));
      }
    };
    window.addEventListener("keydown", pttHandler, true);
    const label =
      `${combo.ctrlKey ? "Ctrl+" : ""}${combo.shiftKey ? "Shift+" : ""}` +
      `${combo.altKey ? "Alt+" : ""}${combo.code}`;
    log(`push-to-talk enabled: press ${label} to speak one turn.`);
    return label;
  }
  function disablePushToTalk() {
    if (pttHandler) {
      window.removeEventListener("keydown", pttHandler, true);
      pttHandler = null;
    }
  }

  // ===========================================================================
  // FEED NAVIGATION + ARROW-KEY BROWSE MODE.
  // Lets a user step through the current surface's videos with arrow keys, hearing each one
  // described — a guided alternative to traversing YouTube's DOM with a screen reader.
  // ===========================================================================
  function surfaceListTool() {
    const p = location.pathname;
    if (p.startsWith("/results")) return "list_results";
    if (p === "/" || p.startsWith("/feed")) return "list_home_feed";
    if (p.startsWith("/watch")) return "list_up_next";
    return null;
  }

  async function feed(limit = 20) {
    const tool = surfaceListTool();
    if (!tool) return [];
    try {
      const res = await consumer.call(tool, { limit });
      const items = JSON.parse(res.content[0].text);
      return Array.isArray(items) ? items : [];
    } catch (_) {
      return [];
    }
  }

  async function openIndex(i) {
    if (location.pathname.startsWith("/watch")) {
      const items = await feed(50);
      const it = items.find((v) => v.index === i);
      if (it && it.url) {
        window.location.href = it.url;
        return `Opening ${it.title}.`;
      }
      return "I couldn't open that item.";
    }
    const tool = location.pathname.startsWith("/results") ? "open_result" : "open_video";
    try {
      const res = await consumer.call(tool, { index: i });
      return res.content[0].text;
    } catch (_) {
      return "I couldn't open that item.";
    }
  }

  // Down/Right = next, Up/Left = previous, Enter = play, Escape = exit. Arrows are captured
  // ONLY while armed and when focus isn't in a text field (so it never fights the search
  // box). While armed it takes over arrow keys (intended guided nav); Escape/stopBrowse hand
  // them back to the page / screen reader.
  const browseState = { armed: false, index: -1, items: [] };

  function describeBrowseItem() {
    const it = browseState.items[browseState.index];
    if (!it) return;
    const bits = [`Item ${browseState.index + 1} of ${browseState.items.length}`, it.title];
    if (it.channel) bits.push("by " + it.channel);
    bits.push(it.duration || "live");
    voice.speak(bits.join(", ") + ". Press Enter to play.");
  }

  // Arrow browsing is only meaningful on the list surfaces (home / search). On /watch and
  // /shorts the arrow keys belong to the player, and replaying a stale home feed here is the
  // "it thinks I'm on home" bug — so disarm cleanly instead.
  function onBrowsableSurface() {
    const p = location.pathname;
    return p === "/" || p.startsWith("/feed") || p.startsWith("/results");
  }

  let browseFetching = false;
  // Read as many of the currently-loaded cards as the provider allows (not just 20), so
  // browsing covers everything on the page. load_more_home / scrolling adds more, which
  // growFeed() picks up when the user reaches the end.
  const BROWSE_LIMIT = 100;

  // At the end of the list, pull in more: ask the provider to load the next batch onto the
  // page (home only — search has no load-more tool), then re-read. Returns true if the list
  // actually grew. Guarded by browseFetching so rapid presses don't stack fetches.
  async function growFeed() {
    if (browseFetching) return false;
    browseFetching = true;
    try {
      const before = browseState.items.length;
      if (consumer.has("load_more_home")) {
        try {
          await callText("load_more_home");
        } catch (_) {}
      }
      const fresh = await feed(BROWSE_LIMIT);
      if (fresh.length > before) {
        browseState.items = fresh;
        return true;
      }
      return false;
    } finally {
      browseFetching = false;
    }
  }

  async function browseMove(delta) {
    voice.cancelSpeech(); // stop the previous item immediately — never read a backlog
    if (!onBrowsableSurface()) {
      stopBrowse();
      voice.speak("Arrow browsing isn't available on this page. The arrow keys control the video here.");
      return;
    }
    if (!browseState.items.length) {
      if (browseFetching) return; // a fetch is already in flight; ignore the extra press
      browseFetching = true;
      try {
        browseState.items = await feed(BROWSE_LIMIT);
      } finally {
        browseFetching = false;
      }
    }
    if (!browseState.items.length) {
      voice.speak("There are no videos to browse here.");
      return;
    }
    // Moving forward past the last item → try to load more before giving up.
    if (delta > 0 && browseState.index >= browseState.items.length - 1) {
      voice.speak("Loading more videos.");
      const grew = await growFeed();
      if (!grew) {
        voice.speak("That's the end of the feed for now.");
        return;
      }
    }
    const n = browseState.items.length;
    browseState.index = Math.max(0, Math.min(browseState.index + delta, n - 1));
    describeBrowseItem();
  }

  function onBrowseKey(e) {
    if (!browseState.armed) return;
    const t = e.target;
    const tag = (t && t.tagName) || "";
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (t && t.isContentEditable)) return;
    switch (e.key) {
      case "ArrowDown":
      case "ArrowRight":
        e.preventDefault();
        e.stopPropagation();
        browseMove(1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        e.preventDefault();
        e.stopPropagation();
        browseMove(-1);
        break;
      case "Enter": {
        const it = browseState.index >= 0 ? browseState.items[browseState.index] : null;
        if (it) {
          e.preventDefault();
          e.stopPropagation();
          openIndex(it.index); // 1-based index the provider expects
        }
        break;
      }
      case "Escape":
        stopBrowse();
        voice.speak("Exited browsing.");
        break;
      default:
        break;
    }
  }

  async function startBrowse(announce = true) {
    // Re-arming on a new surface (e.g. home -> search via SPA nav) must refresh the list —
    // otherwise the stale previous-surface feed lingers. Refresh items, keep the listener.
    if (browseState.armed) {
      browseState.index = -1;
      browseState.items = onBrowsableSurface() ? await feed(20) : [];
      return browseState.items.length;
    }
    browseState.armed = true;
    browseState.index = -1;
    browseState.items = await feed(20);
    window.addEventListener("keydown", onBrowseKey, true);
    log(`browse mode armed (${browseState.items.length} items)`);
    if (announce && browseState.items.length) {
      voice.speak(
        `Browsing ${browseState.items.length} videos. Down arrow for next, up arrow for previous, Enter to play, Escape to stop.`
      );
    }
    return browseState.items.length;
  }

  function stopBrowse() {
    browseState.armed = false;
    browseState.index = -1;
    browseState.items = []; // drop the surface's list so we never replay it after navigating
    window.removeEventListener("keydown", onBrowseKey, true);
  }

  // ===========================================================================
  // TAP-TO-TALK + UNIVERSAL BARGE-IN. Press the talk key once and speak; non-continuous
  // recognition auto-ends on a pause (and a 10s watchdog force-frees the mic regardless), so
  // the microphone is never held open. EVERY press interrupts whatever we're doing — it stops
  // speaking, aborts any in-flight listen, and bumps talk.gen so a pending LLM reply can't
  // speak over the new turn. Speech is a single channel (voice.speak interrupts, never
  // queues), so the agent goes quiet the instant you press the key. Earcons give instant
  // feedback (listening / captured / ready / error) so there's never silent waiting.
  // ===========================================================================
  const talk = { key: "Backquote", state: "idle", hold: null, gen: 0 };

  function isTextTarget(t) {
    const tag = (t && t.tagName) || "";
    return /^(INPUT|TEXTAREA|SELECT)$/.test(tag) || (t && t.isContentEditable);
  }

  // Pause the page's own media (the YouTube <video>, any <audio>) WHILE the mic is open.
  // Opening the mic (Web Speech) at the same time loud audio is playing out the speakers is
  // the classic macOS coreaudiod-contention trigger that can beachball the whole machine —
  // and it also makes the mic hear the video/our TTS. We pause for the capture+reply window,
  // then resume. Acting on the player's native pause is read-and-act safe (no DOM/a11y edits).
  let duckedMedia = [];
  function duckMedia() {
    try {
      document.querySelectorAll("video, audio").forEach((m) => {
        if (!m.paused) {
          m.pause();
          duckedMedia.push(m);
        }
      });
    } catch (_) {}
  }
  function restoreMedia() {
    const list = duckedMedia;
    duckedMedia = [];
    list.forEach((m) => {
      try {
        const p = m.play();
        if (p && p.catch) p.catch(() => {});
      } catch (_) {}
    });
  }

  async function handleHeard(text, gen) {
    if (talk.gen !== gen) return; // superseded before we even processed it
    if (!text || !text.trim()) {
      audio.error();
      if (talk.gen === gen) talk.state = "idle";
      return;
    }
    audio.captured();
    log(`heard: ${text}`);
    talk.state = "thinking";
    let reply;
    const tAsk = nowms();
    try {
      reply = await ask(text); // progress cues fire inside the loop
    } catch (_) {
      reply = "Sorry, something went wrong.";
    }
    log(`ask() total ${Math.round(nowms() - tAsk)}ms`);
    if (talk.gen !== gen) return; // user started a new turn while the LLM was thinking — drop this
    talk.state = "speaking";
    audio.ready();
    const tSpeak = nowms();
    await voice.speak(reply);
    log(`speak() ${Math.round(nowms() - tSpeak)}ms`);
    if (talk.state === "speaking" && talk.gen === gen) talk.state = "idle";
  }

  // TAP-to-talk (not hold). Press the key once and speak; recognition is NON-continuous, so
  // the browser ends it automatically when you pause and reliably releases the mic — there is
  // no continuous session to get stuck holding the microphone. Press again while the agent is
  // replying to interrupt (barge-in).
  async function onTalkDown(e) {
    if (e.code !== talk.key || e.repeat || isTextTarget(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    // Universal barge-in: a press ALWAYS interrupts — stop talking, abort any in-flight
    // recognition, and bump the generation so a pending LLM reply (or a listen that was about
    // to resolve) can't speak over this new turn. This is what makes it feel intuitive: the
    // moment you press the key, the agent goes quiet and listens.
    talk.gen++;
    const myGen = talk.gen;
    voice.cancelSpeech();
    voice.abortListen();
    // If we were already listening, this press cancels it (toggle off) without opening a new mic.
    if (talk.state === "listening") {
      talk.state = "idle";
      audio.error();
      restoreMedia(); // we paused it when this listen started — bring it back
      return;
    }
    talk.state = "listening";
    audio.listening();
    duckMedia(); // pause the video/audio before opening the mic — avoids coreaudiod contention
    let heard;
    try {
      heard = await voice.listenOnce(); // auto-ends on pause; browser frees the mic
    } catch (_) {
      audio.error();
      if (talk.gen === myGen) talk.state = "idle";
      restoreMedia();
      return;
    }
    if (talk.gen !== myGen) {
      restoreMedia();
      return;
    }
    await handleHeard(heard, myGen);
    restoreMedia(); // resume playback after the reply (or after navigation, harmlessly)
  }

  function enableTalk(key) {
    if (key) talk.key = key;
    disableTalk();
    window.addEventListener("keydown", onTalkDown, true);
    log(`tap-to-talk on: press "${talk.key}" and speak; it sends when you pause. Press again to interrupt.`);
  }
  function disableTalk() {
    window.removeEventListener("keydown", onTalkDown, true);
  }

  // Cross-navigation continuity: the provider's navigating tools stash a short message in
  // sessionStorage (which survives the page load); we speak it on the next page.
  function consumePending() {
    try {
      const v = sessionStorage.getItem("ytA11yPending");
      if (v) sessionStorage.removeItem("ytA11yPending");
      return v || null;
    } catch (_) {
      return null;
    }
  }

  // ===========================================================================
  // SAFETY: never hold the microphone when the user isn't actively talking to us.
  // Releases the mic, stops any recording, cancels speech, and ends the loop whenever the
  // tab is hidden, the window loses focus (e.g. switching to a video call), or the page
  // unloads. This is what stops the extension from blocking other apps' mic / running the
  // recognizer in the background.
  // ===========================================================================
  function releaseAll() {
    try {
      voice.releaseMic();
    } catch (_) {}
    try {
      nanoAsr.abort();
    } catch (_) {}
    try {
      voice.cancelSpeech();
    } catch (_) {}
    try {
      restoreMedia(); // never strand a video we paused for the mic (only resumes ones we paused)
    } catch (_) {}
    talk.gen++; // invalidate any in-flight turn so its reply can't speak after release
    talk.state = "idle";
    state.running = false;
  }
  if (typeof document !== "undefined") {
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.hidden) releaseAll();
      },
      true
    );
  }
  if (typeof window !== "undefined") {
    window.addEventListener("blur", releaseAll, true);
    window.addEventListener("pagehide", releaseAll, true);
    window.addEventListener("beforeunload", releaseAll, true);
  }

  // ===========================================================================
  // PUBLIC API — headless on purpose (no DOM injection; AT-safe).
  // ===========================================================================
  const ytAgent = {
    availability, // -> "available" | "downloadable" | "downloading" | "unavailable" | ...
    ask, // ask(text) -> reply text
    activate, // proactive greeting (simulated opt-in handoff)
    converse, // listen -> ask -> speak (one turn)
    start, // hands-free loop: greet, then listen<->respond until "stop" / silence / stop()
    stop, // end the conversation loop
    enableTalk, // (key?) hold-to-talk + barge-in (default hold Backquote `); the primary input
    disableTalk,
    setTalkKey: enableTalk, // alias: re-bind the talk key (KeyboardEvent.code, e.g. "Backquote")
    setEarconVolume: audio.setVolume, // 0 mute … 1 default … 2 louder
    setVoice: voice.setVoice, // (nameSubstring) pick a TTS voice; e.g. "Google US English"
    listVoices: voice.listVoices,
    talkKey: () => talk.key,
    enablePushToTalk, // (opts?) alternative: tap a combo (default Ctrl+Shift+Space) for one turn
    disablePushToTalk,
    consumePending, // read+clear the cross-navigation continuity message
    release: releaseAll, // panic: drop the mic + stop everything right now
    isRunning: () => state.running,
    // Arrow-key feed browsing (guided navigation with spoken descriptions).
    startBrowse, // (announce=true) -> arms arrows: Down/Up move, Enter plays, Escape exits
    stopBrowse,
    isBrowsing: () => browseState.armed,
    feed, // (limit) -> current surface's video list
    openIndex, // (i) -> open item i on the current surface
    // "webspeech" (default) or "nano" (EXPERIMENTAL on-device audio transcription — slower,
    // can jank the page; needs #prompt-api-for-gemini-nano-multimodal-input).
    setListenMode(mode) {
      state.listenMode = mode === "nano" ? "nano" : "webspeech";
      if (state.listenMode === "nano")
        log("listen mode: nano (experimental — slower, may briefly freeze the page per turn)");
      else log("listen mode: webspeech");
      return state.listenMode;
    },
    useEngine(fn) {
      state.engine = typeof fn === "function" ? fn : geminiEngine;
      destroySession();
      log("engine:", state.engine === geminiEngine ? "Gemini Nano (default)" : "custom");
    },
    speak: voice.speak,
    listen: captureUtterance, // respects listenMode
    describeImage, // (url, question?) -> spoken-friendly description via Nano vision
    // Describe the thumbnail of item `index` on the current surface (home/search/up-next).
    async describeThumbnail(index = 0, question) {
      const path = location.pathname;
      const listTool = path.startsWith("/results")
        ? "list_results"
        : path === "/" || path.startsWith("/feed")
        ? "list_home_feed"
        : path.startsWith("/watch")
        ? "list_up_next"
        : null;
      if (!listTool) return "I can only describe thumbnails on the home, search, or watch pages.";
      const res = await consumer.call(listTool, { limit: index + 1 });
      let items = [];
      try {
        items = JSON.parse(res.content[0].text);
      } catch (_) {}
      const item = Array.isArray(items) ? items.find((v) => v.index === index) : null;
      if (!item || !item.thumb) return `No thumbnail available for item ${index}.`;
      return `${item.title}: ${await describeImage(item.thumb, question)}`;
    },
    listTools: () => consumer.list().concat(localTools).map((t) => ({ name: t.name, description: t.description })),
    reset() {
      destroySession();
      log("session reset.");
    },
    _state: state,
  };
  if (typeof window !== "undefined") window.ytAgent = ytAgent;

  // ---------------------------------------------------------------------------
  // Bootstrap: install the registerTool wrapper ASAP (retry until modelContext exists),
  // then report Prompt API availability so the user knows if Gemini Nano is ready.
  // ---------------------------------------------------------------------------
  (function bootstrap(attempt) {
    if (consumer.wrap()) {
      availability().then((a) =>
        log(
          `ready. Gemini Nano: ${a}. voice: tts=${voice.supported.tts} stt=${voice.supported.stt}. ` +
            `Try: ytAgent.start() for hands-free voice, ytAgent.ask("...") to type, ` +
            `or ytAgent.enablePushToTalk() for a hotkey.`
        )
      );
      return;
    }
    if (attempt >= 20) {
      log("WebMCP API never appeared — is the flag on and a provider loaded? Wrapper not installed.");
      return;
    }
    setTimeout(() => bootstrap(attempt + 1), 300);
  })(0);
})();
