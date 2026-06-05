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
