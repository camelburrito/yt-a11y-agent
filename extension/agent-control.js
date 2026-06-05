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
  // Talk-first entry (accessibility). A popup click is sighted-first; instead, the agent
  // announces itself by VOICE on the user's first interaction with the page — which is a
  // valid user gesture for audio, and a screen-reader user generates one immediately (Tab /
  // arrows). It enables a keyboard shortcut for talk-back (each press is a fresh mic
  // gesture) so the whole thing works hands-free without ever seeing the popup.
  // Browsers forbid speaking on bare page-load, so "first interaction" is the earliest we
  // legally can. Greets once per tab session (sessionStorage survives same-tab navigation).
  // ---------------------------------------------------------------------------
  const GREETED = "ytA11yGreeted";
  function alreadyGreeted() {
    try {
      return sessionStorage.getItem(GREETED) === "1";
    } catch (_) {
      return false;
    }
  }
  function markGreeted() {
    try {
      sessionStorage.setItem(GREETED, "1");
    } catch (_) {}
  }

  // Arrow-key browsing is armed on the home feed and disarmed elsewhere, re-evaluated on
  // SPA navigation. So a user can step through videos with the arrow keys (Escape exits).
  // Browse arrows on list surfaces (home feed + search results). NOT on /watch, where arrow
  // keys seek the player. Re-evaluated on SPA navigation.
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

  if (alreadyGreeted()) {
    // Returning within the same tab session — re-arm browsing, skip the announcement.
    armBrowse();
  } else {
    const onFirstGesture = async () => {
      window.removeEventListener("keydown", onFirstGesture, true);
      window.removeEventListener("pointerdown", onFirstGesture, true);
      markGreeted();
      const a = window.ytAgent;
      if (!a) return;
      // Keyboard talk-back: each Ctrl+Shift+Space press is the gesture the mic needs.
      try {
        a.enablePushToTalk();
      } catch (_) {}
      const home = onListSurface();
      const arrowHint = home ? " Use the up and down arrow keys to browse videos one at a time." : "";
      // A short, instant spoken announcement (no model round-trip, so it can't be silent or
      // janky). The full model-driven orientation runs on the Alt+Shift+A / popup greeting.
      try {
        await a.speak(
          "YouTube accessibility agent ready. Hold Control Shift Space and speak to ask me anything, or press Alt Shift A for an overview of this page." +
            arrowHint
        );
      } catch (_) {}
      // Arm browsing AFTER the announcement so the first arrow doesn't double-speak.
      if (home) {
        try {
          a.startBrowse(false);
        } catch (_) {}
      }
      postStatus(
        "ready",
        home
          ? "Ready. Arrows browse · Ctrl+Shift+Space talk · Alt+Shift+A overview."
          : "Ready. Ctrl+Shift+Space talk · Alt+Shift+A overview."
      );
    };
    window.addEventListener("keydown", onFirstGesture, true);
    window.addEventListener("pointerdown", onFirstGesture, true);
  }
})();
