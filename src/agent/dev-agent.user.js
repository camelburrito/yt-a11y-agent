// ==UserScript==
// @name         YouTube A11y Agent — Dev Consumer + Voice (Gemini Nano)
// @namespace    https://github.com/camelburrito/yt-a11y-agent
// @version      0.2.0
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
// non-issue here. Requires Chrome flags:
//   chrome://flags/#prompt-api-for-gemini-nano
//   chrome://flags/#optimization-guide-on-device-model   (set to "Enabled BypassPerfRequirement")
// The model may download on first use (watch the console for progress).

(function () {
  "use strict";

  const LOG = "[yt-a11y-agent]";
  const log = (...a) => console.log(LOG, ...a);

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
        synth.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.05;
        u.onend = () => resolve();
        u.onerror = () => resolve();
        synth.speak(u);
      });
    }

    function listenOnce() {
      return new Promise((resolve, reject) => {
        if (!SR) return reject(new Error("SpeechRecognition not supported in this browser."));
        const rec = new SR();
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
          if (!done) reject(new Error("no speech detected"));
        };
        rec.start();
      });
    }

    return { speak, listenOnce, supported: { tts: !!synth, stt: !!SR } };
  })();

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

    state.session = await LM.create({
      initialPrompts: [{ role: "system", content: SYSTEM }],
      tools: consumer.asPromptApiTools(),
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

  async function geminiEngine(utterance) {
    const session = await ensureSession();
    // The Prompt API runs the tool-call loop internally and returns the final text.
    return await session.prompt(utterance);
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

  async function converse() {
    if (!voice.supported.stt) throw new Error("STT unavailable; use ytAgent.ask(text).");
    const heard = await voice.listenOnce();
    log(`heard: ${heard}`);
    const reply = await ask(heard);
    await voice.speak(reply);
    return { heard, reply };
  }

  // ===========================================================================
  // PUBLIC API — headless on purpose (no DOM injection; AT-safe).
  // ===========================================================================
  const ytAgent = {
    availability, // -> "available" | "downloadable" | "downloading" | "unavailable" | ...
    ask, // ask(text) -> reply text
    activate, // proactive greeting (simulated opt-in handoff)
    converse, // listen -> ask -> speak (one turn)
    useEngine(fn) {
      state.engine = typeof fn === "function" ? fn : geminiEngine;
      destroySession();
      log("engine:", state.engine === geminiEngine ? "Gemini Nano (default)" : "custom");
    },
    speak: voice.speak,
    listen: voice.listenOnce,
    listTools: () => consumer.list().map((t) => ({ name: t.name, description: t.description })),
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
            `Try: await ytAgent.activate()  (or ytAgent.ask("what's on my home feed?"))`
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
