// Dispatches the global keyboard shortcut (Alt+Shift+A) to the active YouTube tab so a
// non-sighted user can invoke the agent without opening the popup. Speaking (TTS) works
// from this relayed command; mic talk-back uses the in-page push-to-talk hotkey, where the
// keypress is itself the user gesture the mic requires.
chrome.commands.onCommand.addListener((command) => {
  if (command !== "greet") return;
  chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
    if (tab && tab.id && /^https:\/\/www\.youtube\.com\//.test(tab.url || "")) {
      chrome.tabs.sendMessage(tab.id, { source: "yt-a11y-ext", cmd: "activate" }).catch(() => {});
    }
  });
});

// ---------------------------------------------------------------------------
// BYOK cloud fallback (Gemini API, user's own Google AI Studio key).
// The key lives in chrome.storage.local and is read ONLY here, in the service worker —
// never in page/MAIN-world context (chrome.storage is invisible to page JS). The fetch
// happens here too, so YouTube's page CSP is irrelevant and the key can't leak into the
// page. The MAIN-world agent reaches this via bridge.js (postMessage -> runtime message).
// Endpoint + auth header per ai.google.dev (verified 2026-06): POST
// /v1beta/models/{model}:generateContent with x-goog-api-key.
// ---------------------------------------------------------------------------
const CLOUD = "yt-a11y-cloud";
const CLOUD_TIMEOUT_MS = 20000; // fetch abort reliably ends a stalled request
const DEFAULT_MODEL = "gemini-3.1-flash-lite"; // pinned STABLE (never the -latest alias: parked on a preview)

async function cloudHandle(msg) {
  if (msg.type === "setKey") {
    if (msg.key) await chrome.storage.local.set({ geminiKey: String(msg.key).trim() });
    else await chrome.storage.local.remove("geminiKey");
    return { ok: true, hasKey: !!msg.key };
  }
  if (msg.type === "setModelEnabled") {
    // The agent mirrors its kill switch here so the SW can refuse inference when AI replies
    // are off — see the modelEnabled check in "generate" below.
    await chrome.storage.local.set({ modelEnabled: !!msg.value });
    return { ok: true };
  }
  if (msg.type === "status") {
    const { geminiKey } = await chrome.storage.local.get("geminiKey");
    return { ok: true, hasKey: !!geminiKey };
  }
  if (msg.type === "generate") {
    // Kill-switch gate: the "generate" relay is reachable from page context (any youtube.com
    // script can postMessage a request — it can spend quota but never read the key). Refusing
    // when AI replies are off means a forged request can't drive inference while the user has
    // the model turned off. The agent itself still gates every call before it ever gets here.
    const { geminiKey, modelEnabled } = await chrome.storage.local.get(["geminiKey", "modelEnabled"]);
    if (!modelEnabled) return { ok: false, error: "AI replies are off" };
    if (!geminiKey) return { ok: false, error: "no key set — add your Gemini API key in the extension popup" };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), CLOUD_TIMEOUT_MS);
    try {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(msg.model || DEFAULT_MODEL)}:generateContent`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
          body: JSON.stringify(msg.body),
          signal: ac.signal,
        }
      );
      if (!r.ok) {
        if (r.status === 429) return { ok: false, error: "rate-limited (free-tier quota reached for today?)" };
        let m = `HTTP ${r.status}`;
        try {
          m += ": " + (((await r.json()).error || {}).message || "");
        } catch (_) {}
        return { ok: false, error: m };
      }
      const data = await r.json();
      const text = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
        .map((p) => p.text || "")
        .join("");
      return text ? { ok: true, text } : { ok: false, error: "empty response (safety block?)" };
    } catch (e) {
      return { ok: false, error: ac.signal.aborted ? `timeout after ${CLOUD_TIMEOUT_MS}ms` : String((e && e.message) || e) };
    } finally {
      clearTimeout(t);
    }
  }
  return { ok: false, error: "unknown cloud message type" };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.source !== CLOUD) return;
  cloudHandle(msg).then(sendResponse, (e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
  return true; // keep the channel open for the async response
});
