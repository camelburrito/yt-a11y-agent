// MAIN-world content script. Loaded AFTER agent.js (which defines window.ytAgent) and
// provider.js. Maps extension commands (relayed via bridge.js as window messages) onto the
// existing ytAgent API — so the popup can drive the same agent the console drives, with no
// extension-specific logic baked into the shared agent code.

(function () {
  "use strict";
  const EXT = "yt-a11y-ext";
  const STATUS = "yt-a11y-agent-status";

  const postStatus = (status, text, extra) =>
    window.postMessage({ source: STATUS, status, text, ...(extra || {}) }, "*");

  window.addEventListener("message", async (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== EXT) return;
    const a = window.ytAgent;
    if (!a) {
      postStatus("error", "Agent not loaded yet.");
      return;
    }
    try {
      switch (d.cmd) {
        case "start":
          postStatus("listening", "Listening…");
          await a.start();
          postStatus("idle", "Conversation ended.");
          break;
        case "stop":
          a.stop();
          postStatus("idle", "Stopped.");
          break;
        case "activate":
          postStatus("speaking", "Greeting…");
          await a.activate();
          postStatus("idle", "Ready.");
          break;
        case "setListenMode":
          a.setListenMode(d.args);
          postStatus("idle", `Listen mode: ${d.args}`);
          break;
        case "setTalkKey":
          if (a.setTalkKey) a.setTalkKey(d.args);
          postStatus("idle", `Talk key: ${d.args}`);
          break;
        case "setEarconVolume":
          if (a.setEarconVolume) a.setEarconVolume(d.args);
          if (a.speak) a.speak("Volume."); // sample so they hear the new level (and an earcon plays)
          break;
        case "setModel": {
          // The model kill switch (default OFF). In the extension, ON means off-device cloud
          // replies via the service worker (the safe path); the on-device Nano engine is a
          // console-only opt-in (ytAgent.setEngine("nano")).
          if (a.setModel) a.setModel(!!d.args);
          const on = a.cloudStatus ? !!a.cloudStatus().modelEnabled : !!d.args;
          postStatus("idle", `AI replies: ${on ? "on" : "off"}.`, { model: on });
          break;
        }
        case "ping": {
          const cloud = a.cloudStatus ? a.cloudStatus() : null;
          postStatus(
            "ready",
            `Ready (Gemini Nano: ${await a.availability()}${cloud ? ` · AI replies ${cloud.modelEnabled ? "on" : "off"} · engine ${cloud.effectiveEngine}` : ""}).`,
            cloud ? { model: !!cloud.modelEnabled } : null
          );
          break;
        }
        default:
          break;
      }
    } catch (err) {
      console.error("[yt-a11y-ext] command error:", err);
      postStatus("error", String((err && err.message) || err));
    }
  });

  postStatus("loaded", "Agent content script loaded.");

  // ---------------------------------------------------------------------------
  // Cloud transport: route the agent's Gemini calls through the service worker via
  // bridge.js. The user's API key lives in chrome.storage.local and is read ONLY by the
  // SW — it never enters this MAIN-world context, and YouTube's page CSP never applies to
  // the request. Correlation ids pair each response with its request.
  // ---------------------------------------------------------------------------
  const CLOUD_REQ = "yt-a11y-cloud-req";
  const CLOUD_RES = "yt-a11y-cloud-res";
  const CLOUD_RELAY_TIMEOUT_MS = 25000; // SW fetch caps at 20s; allow relay overhead
  const pendingCloud = new Map(); // id -> { resolve, timer }
  let cloudSeq = 0;
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (e.source !== window || !d || d.source !== CLOUD_RES) return;
    const p = pendingCloud.get(d.id);
    if (p) {
      pendingCloud.delete(d.id);
      clearTimeout(p.timer); // don't leave the 25s fallback timer (and its closure) live
      p.resolve(d.res || { ok: false, error: "empty relay response" });
    }
  });
  function cloudViaWorker(payload) {
    return new Promise((resolve) => {
      const id = "c" + ++cloudSeq + "-" + Math.random().toString(36).slice(2, 8);
      const timer = setTimeout(() => {
        if (pendingCloud.delete(id)) resolve({ ok: false, error: "cloud relay timeout" });
      }, CLOUD_RELAY_TIMEOUT_MS);
      pendingCloud.set(id, { resolve, timer });
      window.postMessage({ source: CLOUD_REQ, id, type: "generate", model: payload.model, body: payload.body }, "*");
    });
  }
  if (window.ytAgent && window.ytAgent.setCloudTransport) {
    window.ytAgent.setCloudTransport(cloudViaWorker);
  }

  // ---------------------------------------------------------------------------
  // Talk-first entry. A popup click is sighted-first; instead the agent speaks on the user's
  // FIRST interaction with the page (a valid audio gesture; a screen-reader user makes one
  // immediately). On that gesture we: enable hold-to-talk (the primary input), arm arrow
  // browsing on list surfaces, and speak EITHER a cross-navigation continuation (e.g. "Here
  // are your search results…") OR — only once per tab session — a short welcome. The full
  // model greeting is on the talk key ("give me an overview") or Alt+Shift+A.
  // ---------------------------------------------------------------------------
  const GREETED = "ytA11yGreeted";
  const greeted = () => {
    try {
      return sessionStorage.getItem(GREETED) === "1";
    } catch (_) {
      return false;
    }
  };
  const markGreeted = () => {
    try {
      sessionStorage.setItem(GREETED, "1");
    } catch (_) {}
  };

  function onListSurface() {
    const p = location.pathname;
    return p === "/" || p.startsWith("/feed") || p.startsWith("/results");
  }
  function armBrowse() {
    const a = window.ytAgent;
    if (!a || !a.startBrowse) return;
    if (onListSurface()) a.startBrowse(false);
    else if (a.isBrowsing && a.isBrowsing()) a.stopBrowse();
  }
  window.addEventListener("yt-navigate-finish", armBrowse, true);

  let firstHandled = false;
  const onFirstGesture = async () => {
    if (firstHandled) return;
    firstHandled = true;
    window.removeEventListener("keydown", onFirstGesture, true);
    window.removeEventListener("pointerdown", onFirstGesture, true);
    const a = window.ytAgent;
    if (!a) return;
    try {
      a.enableTalk();
    } catch (_) {}
    if (onListSurface()) {
      try {
        a.startBrowse(false);
      } catch (_) {}
    }

    // Continuity first: if we just navigated (search / open), announce that.
    const pending = a.consumePending ? a.consumePending() : null;
    const arrowHint = onListSurface() ? " Use the arrow keys to browse." : "";
    if (pending) {
      try {
        await a.speak(pending);
      } catch (_) {}
    } else if (!greeted()) {
      markGreeted();
      try {
        await a.speak(
          "YouTube accessibility agent ready. Press the backtick key and speak to ask me anything; I'll respond when you pause." +
            arrowHint
        );
      } catch (_) {}
    }
    postStatus("ready", "Ready. Tap ` to talk · arrows browse · Alt+Shift+A overview.");
  };
  window.addEventListener("keydown", onFirstGesture, true);
  window.addEventListener("pointerdown", onFirstGesture, true);
})();
