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
  if (!tab || !tab.id) return setStatus("No active tab.");
  if (!/^https:\/\/www\.youtube\.com\//.test(tab.url || "")) {
    return setStatus("Open a YouTube tab, then reopen this popup.");
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { source: EXT, cmd, args });
  } catch (_) {
    setStatus("Couldn't reach the page — reload the YouTube tab.");
  }
}

// Status messages relayed up from the page.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.source === STATUS && msg.text) setStatus(msg.text);
});

document.getElementById("start").addEventListener("click", () => send("start"));
document.getElementById("stop").addEventListener("click", () => send("stop"));
document.getElementById("activate").addEventListener("click", () => send("activate"));
document.getElementById("nano").addEventListener("change", (e) =>
  send("setListenMode", e.target.checked ? "nano" : "webspeech")
);
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
