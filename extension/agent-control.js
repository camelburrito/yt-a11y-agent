// MAIN-world content script. Loaded AFTER agent.js (which defines window.ytAgent) and
// provider.js. Maps extension commands (relayed via bridge.js as window messages) onto the
// existing ytAgent API — so the popup can drive the same agent the console drives, with no
// extension-specific logic baked into the shared agent code.

(function () {
  "use strict";
  const EXT = "yt-a11y-ext";
  const STATUS = "yt-a11y-agent-status";

  const postStatus = (status, text) =>
    window.postMessage({ source: STATUS, status, text }, "*");

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
        case "ping":
          postStatus("ready", `Ready (Gemini: ${await a.availability()}).`);
          break;
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
    postStatus("ready", "Ready. Hold ` to talk · arrows browse · Alt+Shift+A overview.");
  };
  window.addEventListener("keydown", onFirstGesture, true);
  window.addEventListener("pointerdown", onFirstGesture, true);
})();
