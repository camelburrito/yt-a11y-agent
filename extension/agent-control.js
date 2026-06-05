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
})();
