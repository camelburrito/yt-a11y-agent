// ISOLATED-world content script. The MAIN-world agent (agent.js / agent-control.js) can't
// touch chrome.* APIs, so this bridges between the extension (popup) and the page:
//   popup --chrome.tabs.sendMessage--> bridge --window.postMessage--> MAIN agent
//   MAIN agent --window.postMessage--> bridge --chrome.runtime--> popup
// Keeps extension glue out of the shared agent code.

const EXT = "yt-a11y-ext"; // commands: extension -> page
const STATUS = "yt-a11y-agent-status"; // status: page -> extension

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
    chrome.runtime.sendMessage({ source: STATUS, status: d.status, text: d.text }).catch(() => {});
  } catch (_) {
    // Context invalidated mid-flight — stop relaying; this tab needs a refresh.
    window.removeEventListener("message", onStatus);
  }
};
window.addEventListener("message", onStatus);
