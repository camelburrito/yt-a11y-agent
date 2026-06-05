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

// Page -> extension (relay status to any listening popup)
window.addEventListener("message", (e) => {
  const d = e.data;
  if (e.source === window && d && d.source === STATUS) {
    chrome.runtime.sendMessage({ source: STATUS, status: d.status, text: d.text }).catch(() => {});
  }
});
