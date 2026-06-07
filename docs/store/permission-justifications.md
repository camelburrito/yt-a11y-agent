# Chrome Web Store — permission justifications & data-usage form answers

_Drafted 2026-06-07 for the dashboard's "Privacy practices" tab. Keep these in sync with
`extension/manifest.json` and `docs/store/privacy-policy.md` — the review bot rejects
mismatches between requested permissions, justification text, and the privacy policy._

## Single purpose statement

> YouTube A11y Agent lets people with visual or motor accessibility needs use YouTube
> hands-free by voice: it reads the page aloud (feed, search results, video info,
> transcripts, comments) and performs the user's spoken commands (open, play/pause, seek,
> captions, search, browse) by actuating YouTube's own controls. It never modifies the
> page or its accessibility tree.

## Permission justifications

### `host_permissions: https://www.youtube.com/*`
> The extension's single purpose is voice-driven accessible navigation OF YouTube. Content
> scripts must run on YouTube pages to (a) register the page's WebMCP accessibility tools,
> (b) read on-screen text (titles, results, transcripts, comments) to speak it to the
> user, and (c) actuate YouTube's native controls (play/pause/captions) on the user's
> spoken command. No other site is accessed.

### `host_permissions: https://generativelanguage.googleapis.com/*`
> Optional bring-your-own-key AI replies: when the user has saved their own Google Gemini
> API key and enabled AI replies, the extension's service worker sends the user's spoken
> request plus the page text the tools read to Google's Gemini API under the user's key. The
> call is made from the service worker so the key is never exposed to web pages. Off by
> default; every core feature works without it. (The request relay is reachable from the
> YouTube page, so other youtube.com scripts could trigger API calls under the key — never
> read it — while AI replies are enabled; the service worker refuses requests when the user
> has AI replies turned off.)

### `storage`
> Stores exactly one thing locally: the user's own Gemini API key (chrome.storage.local;
> entered voluntarily, removable with one click, never transmitted to the developer). No
> browsing data is collected or stored. (Other UI preferences live in the page's own
> localStorage, which does not use this permission.)

### Content scripts on youtube.com (MAIN + ISOLATED worlds)
> The MAIN-world scripts host the WebMCP tool provider and the voice agent (the page-level
> `document.modelContext` API is only reachable from the page's world). The ISOLATED-world
> script is a thin message bridge to the popup and service worker. Scripts run only on
> youtube.com.

## Data-usage form (dashboard checkboxes)

| Category | Collected? | Notes |
|---|---|---|
| Personally identifiable information | No | |
| Health / Financial / Authentication information | **Yes — Authentication information** | The user's own Gemini API key, stored locally only, never transmitted to the developer. |
| Personal communications | No | |
| Location | No | |
| Web history | No | |
| User activity | No | No analytics/telemetry. |
| Website content | **Yes** | YouTube page text (titles, transcripts, comments) is read locally to be spoken aloud; it is sent to Google's Gemini API only if the user enables BYOK AI replies. |
| Audio | **Yes** | Microphone audio is processed by Chrome's Web Speech API (Google speech servers) only while the user holds/taps the talk key. On-device mode available. |

Certifications: ✅ not sold to third parties; ✅ not used/transferred for purposes unrelated
to the single purpose; ✅ not used for creditworthiness/lending — and certify **Limited Use**.

## Listing copy (short description)

> Use YouTube hands-free by voice. Hear your feed, search, open videos, control playback
> and captions — built for screen-reader users. AI replies optional with your own key.

## Review-risk notes (internal)

- 2026 CWS reviews are hostile to AI-extensions that touch page content — over-disclose.
  The strongest defense is architectural: no developer server, key never leaves the
  browser, AI off by default, deterministic commands work with zero AI.
- Never declare `externally_connectable` for youtube.com (would open a page→extension
  message channel; the bridge already isolates everything that matters).
- Calling the Gemini REST API is NOT "remotely hosted code" under MV3 rules (responses are
  data, never executed) — say so if the reviewer flags it.
