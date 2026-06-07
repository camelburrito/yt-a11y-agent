# Privacy Policy — YouTube A11y Agent

_Last updated: 2026-06-07_

YouTube A11y Agent is an accessibility extension that lets you use YouTube hands-free by
voice. It is built so that **no data ever reaches the developer**: there are no developer
servers, no analytics, no telemetry, and nothing is sold or shared. This policy explains
exactly what the extension processes and where it goes.

## What the extension processes

**1. Page content (YouTube pages only).**
The extension reads what is already on the YouTube page you are viewing — video titles,
channel names, search results, captions/transcripts, comments — in order to read it aloud
and act on your spoken commands. This happens entirely inside your browser.

**2. Your voice (microphone).**
Speech-to-text uses the browser's Web Speech API, which is provided by Google Chrome and
**sends microphone audio to Google's speech servers** for recognition. The microphone is
opened only when you press the talk key, or during a hands-free voice conversation you
explicitly start (the Start button) — in which it listens for your reply after each spoken
answer until you say "stop", stay silent, or stop it. In every mode it is auto-released the
moment your words are captured (with a hard watchdog) and is never held open in the
background. An optional on-device transcription mode (Gemini Nano) keeps audio entirely on
your machine.

**3. Optional AI replies (your own Gemini API key).**
AI-generated replies are **off by default**. If you choose to enable them with your own
Google AI Studio API key:

- Your key is stored only in this browser's extension storage (`chrome.storage.local`),
  read only by the extension's background service worker (which makes the API call). It is
  never transmitted to the developer. When you enter it via the extension popup it never
  passes through the web page. You can remove it at any time with one click ("Remove key").
- When you speak a request that needs AI (anything beyond the built-in direct commands),
  your request text and the page text the tools read (e.g. video titles, a transcript) are
  sent to **Google's Gemini API** under your key and Google's own terms.
- Per Google's terms, **free-tier API prompts may be used by Google to improve its
  products**. Use a paid-tier key if you do not want that.
- Because the request is sent from the YouTube page context, other scripts running on
  youtube.com could in principle trigger Gemini API calls under your stored key while AI
  replies are enabled (spending your quota). They can **never read or extract the key**,
  which is held only by the extension's background worker. Keeping a per-key budget cap on
  your Google Cloud project bounds any such use.
- Without a key, the extension can optionally use Chrome's built-in on-device model
  (Gemini Nano), which never leaves your machine — or no AI at all: every direct command
  (play, pause, search, browse, etc.) works deterministically without any model.

## What the extension does NOT do

- No data is sent to the developer — there is no developer server.
- No analytics, tracking, profiling, or advertising.
- No sale or transfer of any user data to anyone.
- No reading of pages other than `https://www.youtube.com/*`.
- No modification of YouTube pages or their accessibility tree (read-and-act only).
- No background microphone use: the mic opens only on your explicit keypress and is
  force-released when the tab is hidden, the window loses focus, or the page unloads.

## Data retention

- API key: kept in browser-local extension storage until you remove it.
- Conversation context: the last few spoken turns are kept in the tab's `sessionStorage`
  (so the agent can keep context across page navigations) and are discarded when the tab
  closes.
- Preferences (whether AI replies are enabled, and which engine/model you've selected) are
  kept in the page's `localStorage`. They contain no personal data and persist until you
  change them or clear the site's data.

## Limited Use

The extension's use of data complies with the Chrome Web Store User Data Policy,
including the Limited Use requirements: all data described above is used solely to
provide the extension's single user-facing purpose (voice-driven, accessible YouTube
navigation) and is never sold, never used for advertising, and never read by humans.

## Contact

Questions or concerns: open an issue at
https://github.com/camelburrito/yt-a11y-agent/issues.
