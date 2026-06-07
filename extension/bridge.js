// ISOLATED-world content script. The MAIN-world agent (agent.js / agent-control.js) can't
// touch chrome.* APIs, so this bridges between the extension (popup) and the page:
//   popup --chrome.tabs.sendMessage--> bridge --window.postMessage--> MAIN agent
//   MAIN agent --window.postMessage--> bridge --chrome.runtime--> popup
//   MAIN agent --cloud-req--> bridge --runtime msg--> service worker (Gemini fetch) --> back
// Keeps extension glue out of the shared agent code.

const EXT = "yt-a11y-ext"; // commands: extension -> page
const STATUS = "yt-a11y-agent-status"; // status: page -> extension
const CLOUD_REQ = "yt-a11y-cloud-req"; // cloud generate: page -> service worker
const CLOUD_RES = "yt-a11y-cloud-res"; // cloud result: service worker -> page

// Extension (popup) -> page
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.source === EXT) {
    window.postMessage({ source: EXT, cmd: msg.cmd, args: msg.args }, "*");
  }
});

// Page -> extension (relay status to any listening popup).
// When the extension is reloaded while this tab stays open, our chrome.runtime context is
// invalidated: chrome.runtime.id becomes undefined and sendMessage THROWS synchronously
// ("Extension context invalidated.") — a .catch() can't see that. Guard on the id, wrap the
// call, and once the context is gone tear down this listener so it can't keep throwing.
const onStatus = (e) => {
  const d = e.data;
  if (e.source !== window || !d || d.source !== STATUS) return;
  if (!chrome.runtime || !chrome.runtime.id) {
    window.removeEventListener("message", onStatus);
    return;
  }
  try {
    chrome.runtime.sendMessage({ source: STATUS, status: d.status, text: d.text, model: d.model }).catch(() => {});
  } catch (_) {
    // Context invalidated mid-flight — stop relaying; this tab needs a refresh.
    window.removeEventListener("message", onStatus);
  }
};
window.addEventListener("message", onStatus);

// Page -> service worker cloud relay. The page sends {source: CLOUD_REQ, id, type, model,
// body}; the SW reads the key from chrome.storage.local, calls Gemini, and the result
// comes back as {source: CLOUD_RES, id, res}. The key itself NEVER crosses this bridge in
// either direction. THREAT MODEL (window.postMessage is page-readable/forgeable by design):
//   - Request side: any youtube.com script could submit a `generate` request through this
//     relay (spending the user's quota with attacker prompts) — but never read the key, and
//     the SW refuses unless the kill switch (modelEnabled) is on (service-worker.js).
//   - Response side: equally forgeable — CLOUD_REQ (incl. the correlation id) is broadcast
//     on window, so a page script could race a fake {source: CLOUD_RES, id, res:{ok,text}}
//     that agent-control resolves and cloudEngine parses as a model turn (spoken text or a
//     tool call). Tools are read-and-act and AT-safe, so the blast radius is a wrong spoken
//     line or a benign tool call, not key/data exfiltration. Accepted for an a11y dev tool;
//     a hardened build would move the agent's cloud calls into the ISOLATED world.
// Same context-invalidation guards as the status relay above.
const onCloudReq = (e) => {
  const d = e.data;
  if (e.source !== window || !d || d.source !== CLOUD_REQ) return;
  const respond = (res) => window.postMessage({ source: CLOUD_RES, id: d.id, res }, "*");
  if (!chrome.runtime || !chrome.runtime.id) {
    // Respond before tearing down so the caller fails fast instead of waiting out its 25s
    // timeout in silence.
    respond({ ok: false, error: "extension context invalidated — reload the tab" });
    window.removeEventListener("message", onCloudReq);
    return;
  }
  // ONLY "generate" crosses this bridge. setKey/status/setModelEnabled are popup-or-agent →
  // SW only; relaying them from the page would let any page script overwrite or clear the
  // user's key, or flip the kill switch, via postMessage.
  if (d.type !== "generate") {
    respond({ ok: false, error: "only generate is relayed from the page" });
    return;
  }
  try {
    chrome.runtime
      .sendMessage({ source: "yt-a11y-cloud", type: "generate", model: d.model, body: d.body })
      .then((res) => respond(res || { ok: false, error: "no response from service worker" }))
      .catch((err) => respond({ ok: false, error: String((err && err.message) || err) }));
  } catch (_) {
    respond({ ok: false, error: "extension context invalidated — reload the tab" });
    window.removeEventListener("message", onCloudReq);
  }
};
window.addEventListener("message", onCloudReq);
