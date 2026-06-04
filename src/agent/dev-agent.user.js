// ==UserScript==
// @name         YouTube A11y Agent — Dev Consumer + Voice
// @namespace    https://github.com/camelburrito/yt-a11y-agent
// @version      0.1.0
// @description  In-page DEV harness that consumes the WebMCP tools registered by the provider userscript and drives them with Claude + Web Speech. Simulates the browser/AT opt-in handoff via ytAgent.activate(). Not the production client — see docs/HANDOFF.md (the real consumer is an MV3 extension).
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
// CSP NOTE: YouTube's Content-Security-Policy may block fetch() to api.anthropic.com from
// the page. If the Claude transport fails, exercise the loop with ytAgent.useTransport().
// The production fix is the MV3 extension (LLM call in the background worker, off-page).

(function () {
  "use strict";

  const LOG = "[yt-a11y-agent]";
  const KEY_STORE = "ytA11yAnthropicKey";
  const DEFAULT_MODEL = "claude-opus-4-8"; // swap to claude-haiku-4-5 / sonnet for lower latency
  const MAX_HOPS = 6; // max tool-use round trips per ask()

  const log = (...a) => console.log(LOG, ...a);

  function getModelContext() {
    return (
      (typeof document !== "undefined" && document.modelContext) ||
      (typeof navigator !== "undefined" && navigator.modelContext) ||
      null
    );
  }

  // ---------------------------------------------------------------------------
  // System prompt — defines the agent's behavior, including the proactive,
  // orient-first greeting and the "offer a short spoken menu, don't autoplay" stance.
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
  // LAYER 2a — CONSUMER BRIDGE (MCP client side).
  // The provider's ModelContext only exposes registerTool — there's no list/call. So we
  // wrap registerTool to capture every tool as it registers, and honor its AbortSignal to
  // drop it on unregister (route changes). That gives us a live tool registry to drive.
  // ===========================================================================
  const consumer = (() => {
    const tools = new Map(); // name -> tool object { name, description, inputSchema, execute }
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
      // Anthropic tool-definition shape (note: our tools use inputSchema -> input_schema).
      asAnthropicTools: () =>
        [...tools.values()].map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.inputSchema || { type: "object", properties: {} },
        })),
      call: async (name, args) => {
        const t = tools.get(name);
        if (!t) throw new Error(`Tool not registered: ${name}`);
        return t.execute(args || {});
      },
    };
  })();

  // ===========================================================================
  // LAYER 2-voice — VOICE (Web Speech). Out-of-band from tools; tools stay text-only.
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
  // LAYER 2b — LLM TRANSPORT (Claude Messages API w/ tool use + prompt caching).
  // Pluggable: ytAgent.useTransport(fn) swaps it (mock for testing, or an extension bridge
  // that calls the model off-page to dodge YouTube's CSP).
  // ===========================================================================
  function getKey() {
    try {
      return sessionStorage.getItem(KEY_STORE) || "";
    } catch (_) {
      return "";
    }
  }

  async function claudeTransport({ system, messages, tools }) {
    const key = getKey();
    if (!key) throw new Error("No Anthropic key. Call ytAgent.setKey('sk-ant-...') first.");
    // Cache the (stable) system prompt and tool definitions across turns.
    const body = {
      model: state.model,
      max_tokens: 1024,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: tools.map((t, i) =>
        i === tools.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t
      ),
      messages,
    };
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        // Required for direct browser calls; also why this is dev-only (key is in the page).
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res.json();
  }

  // ===========================================================================
  // LAYER 2c — AGENT LOOP.
  // ===========================================================================
  const state = {
    model: DEFAULT_MODEL,
    transport: claudeTransport,
    messages: [], // running conversation (Anthropic format)
  };

  async function ask(utterance) {
    if (!utterance || !utterance.trim()) return "";
    state.messages.push({ role: "user", content: utterance });

    for (let hop = 0; hop < MAX_HOPS; hop++) {
      const tools = consumer.asAnthropicTools();
      const resp = await state.transport({ system: SYSTEM, messages: state.messages, tools });
      state.messages.push({ role: "assistant", content: resp.content });

      const toolUses = (resp.content || []).filter((b) => b.type === "tool_use");
      if (resp.stop_reason !== "tool_use" || toolUses.length === 0) {
        const text = (resp.content || [])
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join(" ")
          .trim();
        log(`reply: ${text}`);
        return text;
      }

      const toolResults = [];
      for (const tu of toolUses) {
        log(`tool_use: ${tu.name}(${JSON.stringify(tu.input || {})})`);
        let content;
        try {
          const out = await consumer.call(tu.name, tu.input || {});
          content = out && out.content ? out.content : [{ type: "text", text: String(out) }];
        } catch (e) {
          content = [{ type: "text", text: "Tool error: " + e.message }];
        }
        toolResults.push({ type: "tool_result", tool_use_id: tu.id, content });
      }
      state.messages.push({ role: "user", content: toolResults });
    }
    return "Sorry, I couldn't complete that — it took too many steps.";
  }

  // Simulates layer 1 (the browser/AT opt-in handoff): greet + orient proactively.
  async function activate() {
    state.messages = []; // fresh session
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
  // PUBLIC API — headless on purpose (no DOM injection; AT-safe). Drive from console
  // or wire to a key in your own snippet.
  // ===========================================================================
  const ytAgent = {
    setKey(k) {
      try {
        sessionStorage.setItem(KEY_STORE, k || "");
        log("Anthropic key stored for this tab (dev only).");
      } catch (e) {
        log("could not store key:", e.message);
      }
    },
    setModel(m) {
      state.model = m;
      log("model:", m);
    },
    useTransport(fn) {
      state.transport = typeof fn === "function" ? fn : claudeTransport;
      log("transport overridden:", state.transport === claudeTransport ? "default Claude" : "custom");
    },
    ask, // ask(text) -> reply text
    activate, // proactive greeting (simulated opt-in handoff)
    converse, // listen -> ask -> speak (one turn)
    speak: voice.speak,
    listen: voice.listenOnce,
    listTools: () => consumer.list().map((t) => ({ name: t.name, description: t.description })),
    reset() {
      state.messages = [];
      log("conversation reset.");
    },
    _state: state, // for debugging
  };
  if (typeof window !== "undefined") window.ytAgent = ytAgent;

  // ---------------------------------------------------------------------------
  // Bootstrap: install the registerTool wrapper ASAP (retry until modelContext exists).
  // ---------------------------------------------------------------------------
  (function bootstrap(attempt) {
    if (consumer.wrap()) {
      log(
        `ready. voice: tts=${voice.supported.tts} stt=${voice.supported.stt}. ` +
          `Try: ytAgent.setKey('sk-ant-...') then await ytAgent.activate()`
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
