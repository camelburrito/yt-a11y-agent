// Popup UI -> active YouTube tab's content script (via bridge.js), and shows status.
const EXT = "yt-a11y-ext";
const STATUS = "yt-a11y-agent-status";
const statusEl = document.getElementById("status");

function setStatus(text) {
  statusEl.textContent = text;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function send(cmd, args) {
  const tab = await activeTab();
  if (!tab || !tab.id) {
    setStatus("No active tab.");
    return false;
  }
  if (!/^https:\/\/www\.youtube\.com\//.test(tab.url || "")) {
    setStatus("Open a YouTube tab, then reopen this popup.");
    return false;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { source: EXT, cmd, args });
    return true;
  } catch (_) {
    setStatus("Couldn't reach the page — reload the YouTube tab.");
    return false;
  }
}

// Status messages relayed up from the page.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.source !== STATUS) return;
  if (typeof msg.text === "string") setStatus(msg.text);
  // The ping reply carries the page's kill-switch state — sync the checkbox AND mirror it to
  // the service worker so the SW's generate gate tracks the page's persisted switch (it may
  // have been set from the console). The popup is the trusted context allowed to do this.
  if (typeof msg.model === "boolean") {
    document.getElementById("model").checked = msg.model;
    chrome.runtime.sendMessage({ source: CLOUD, type: "setModelEnabled", value: msg.model }).catch(() => {});
  }
});

document.getElementById("start").addEventListener("click", () => send("start"));
document.getElementById("stop").addEventListener("click", () => send("stop"));
document.getElementById("activate").addEventListener("click", () => send("activate"));
document.getElementById("nano").addEventListener("change", (e) =>
  send("setListenMode", e.target.checked ? "nano" : "webspeech")
);

// --- BYOK cloud key + the model kill switch ---------------------------------
// The key goes straight to the SERVICE WORKER (chrome.storage.local); it never touches the
// page. The "AI replies" toggle flips the in-page kill switch (default OFF) via the bridge.
const CLOUD = "yt-a11y-cloud";
const keyInput = document.getElementById("apikey");

async function refreshKeyStatus() {
  try {
    const res = await chrome.runtime.sendMessage({ source: CLOUD, type: "status" });
    keyInput.placeholder = res && res.hasKey ? "Key saved ✓ (enter a new one to replace)" : "Gemini API key (AIza…)";
  } catch (_) {}
}
document.getElementById("savekey").addEventListener("click", async () => {
  const key = keyInput.value.trim();
  if (!key) return setStatus("Paste your Gemini API key first.");
  await chrome.runtime.sendMessage({ source: CLOUD, type: "setKey", key });
  keyInput.value = "";
  setStatus("Key saved (browser-local). Turn on AI replies to use it.");
  refreshKeyStatus();
});
document.getElementById("clearkey").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ source: CLOUD, type: "setKey", key: null });
  setStatus("Key removed.");
  refreshKeyStatus();
});
document.getElementById("model").addEventListener("change", async (e) => {
  const want = e.target.checked;
  // Mirror the switch into the SW gate first (the page can't be trusted to do this), then
  // flip the page's kill switch. If the page is unreachable, revert the checkbox so it never
  // shows "on" while the page is actually off.
  await chrome.runtime.sendMessage({ source: CLOUD, type: "setModelEnabled", value: want }).catch(() => {});
  const ok = await send("setModel", want);
  if (!ok) e.target.checked = !want;
});
refreshKeyStatus();
document.getElementById("vol").addEventListener("input", (e) =>
  send("setEarconVolume", parseFloat(e.target.value))
);

// Rebind the talk key: click, then press the key you want.
const rebind = document.getElementById("rebind");
const talkkey = document.getElementById("talkkey");
let capturing = false;
rebind.addEventListener("click", () => {
  capturing = true;
  setStatus("Press the key you want to use to talk…");
});
window.addEventListener("keydown", (e) => {
  if (!capturing) return;
  e.preventDefault();
  capturing = false;
  const label = e.key === "`" ? "`" : e.key.length === 1 ? e.key : e.code;
  talkkey.textContent = label;
  send("setTalkKey", e.code);
  setStatus(`Talk key set to ${label}.`);
});

// Ask the page for readiness on open.
send("ping");
