// ==UserScript==
// @name         YouTube A11y Agent — Dev Consumer + Voice (Gemini Nano)
// @namespace    https://github.com/camelburrito/yt-a11y-agent
// @version      0.6.0
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
  const log = (...a) => console.log(LOG, ...a);
  const MANUAL_LOOP_HOPS = 4; // max tool-call round-trips per ask() in the manual JSON loop

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

    function speak(text) {
      return new Promise((resolve) => {
        if (!synth || !text) return resolve();
        // Do NOT call synth.cancel() right before speak() — on Chrome it races and can
        // swallow the utterance (silent TTS). Also wait for voices to load (they arrive
        // async via voiceschanged; getVoices() is often empty on the first call), pick one
        // explicitly, and resume() to unstick Chrome's long-standing paused-queue bug.
        const fire = () => {
          const u = new SpeechSynthesisUtterance(text);
          u.rate = 1.05;
          const v =
            synth.getVoices().find((x) => x.lang && x.lang.startsWith("en")) ||
            synth.getVoices()[0];
          if (v) u.voice = v;
          u.onend = () => resolve();
          u.onerror = () => resolve();
          synth.speak(u);
          setTimeout(() => synth.resume(), 100);
        };
        if (synth.getVoices().length) fire();
        else synth.addEventListener("voiceschanged", fire, { once: true });
      });
    }

    let activeRec = null;
    function listenOnce() {
      return new Promise((resolve, reject) => {
        if (!SR) return reject(new Error("SpeechRecognition not supported in this browser."));
        const rec = new SR();
        activeRec = rec;
        rec.lang = "en-US";
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        let done = false;
        rec.onresult = (e) => {
          done = true;
          resolve(e.results[0][0].transcript);
        };
        rec.onerror = (e) => reject(new Error("speech recognition error: " + e.error));
        rec.onend = () => {
          activeRec = null;
          if (!done) reject(new Error("no speech detected"));
        };
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
      if (synth) {
        try {
          synth.cancel();
        } catch (_) {}
      }
    }

    return { speak, listenOnce, abortListen, cancelSpeech, supported: { tts: !!synth, stt: !!SR } };
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

    async transcribe(blob) {
      const LM = getLanguageModel();
      if (!LM) throw new Error("Prompt API unavailable for transcription.");
      const s = await LM.create({ expectedInputs: [{ type: "audio" }] });
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
        try {
          s.destroy && s.destroy();
        } catch (_) {}
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

  async function describeImage(url, question) {
    if (!url) throw new Error("describeImage needs a url");
    const LM = getLanguageModel();
    if (!LM) throw new Error("Prompt API unavailable for vision.");
    const r = await fetch(url);
    if (!r.ok) throw new Error(`couldn't fetch image (${r.status})`);
    const blob = await toJpeg(await r.blob());
    const s = await LM.create({ expectedInputs: [{ type: "image" }] });
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
      try {
        s.destroy && s.destroy();
      } catch (_) {}
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
      'To use a tool: {"action":"call","tool":"<name>","args":{...}}\n' +
      'When you can answer the user: {"action":"final","say":"<the reply to speak>"}\n' +
      "Available tools:\n" +
      catalog;

    state.session = await LM.create({
      initialPrompts: [{ role: "system", content: sys }],
      monitor(m) {
        if (m && m.addEventListener) {
          m.addEventListener("downloadprogress", (e) =>
            log(`Gemini Nano download: ${Math.round((e.loaded || 0) * 100)}%`)
          );
        }
      },
    });
    state.sessionSig = sig;
    log(`Gemini session ready (availability="${avail}"); tools: ${sig || "(none)"}`);
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
    const session = await ensureSession();
    const tools = consumer.asPromptApiTools().concat(localTools);
    let turn = `User said: ${utterance}`;
    for (let i = 0; i < MANUAL_LOOP_HOPS; i++) {
      const raw = await session.prompt(turn);
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
        let result;
        try {
          result = await tool.execute(step.args || {});
        } catch (e) {
          result = "tool error: " + ((e && e.message) || e);
        }
        log(`tool ${step.tool} ->`, result);
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
  async function ask(utterance) {
    if (!utterance || !utterance.trim()) return "";
    const reply = await state.engine(utterance);
    log("reply:", reply);
    return reply;
  }

  // Simulates the browser/AT opt-in handoff: greet + orient proactively (fresh session).
  async function activate() {
    destroySession();
    const reply = await ask(
      "[The user just switched to you from their screen reader and opted in. Greet them, tell them what page they're on and briefly what's available, and offer their main choices, ending with a question.]"
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
  // PUBLIC API — headless on purpose (no DOM injection; AT-safe).
  // ===========================================================================
  const ytAgent = {
    availability, // -> "available" | "downloadable" | "downloading" | "unavailable" | ...
    ask, // ask(text) -> reply text
    activate, // proactive greeting (simulated opt-in handoff)
    converse, // listen -> ask -> speak (one turn)
    start, // hands-free loop: greet, then listen<->respond until "stop" / silence / stop()
    stop, // end the conversation loop
    enablePushToTalk, // (opts?) bind a hotkey (default Ctrl+Shift+Space) for one turn
    disablePushToTalk,
    isRunning: () => state.running,
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
