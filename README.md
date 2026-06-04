# YouTube A11y Agent (WebMCP)

An in-browser accessibility assistant for YouTube, built on **WebMCP**. It registers a
set of [WebMCP](https://github.com/webmachinelearning/webmcp) tools on YouTube pages so
an in-browser AI agent can help people with accessibility needs find, understand, and
control YouTube videos — by voice, in plain language, hands-free.

## Why tools, not an overlay

Most "accessibility add-ons" inject overlays or rewrite the page's accessibility tree.
That fights the assistive technology a user already trusts and often makes things worse.

This project takes the opposite stance: **the agent is an intermediary, never a mutator.**
We expose *tools* — `list the home feed`, `open video 3`, `load more` — that **read**
page state and **act** on the user's behalf (navigate, scroll, actuate native controls).
We never inject overlays, rewrite the DOM, or touch ARIA. Your screen reader, your
magnifier, your switch control keep seeing the real YouTube, unchanged. The AI just
drives it for you.

## Status

All journeys are **implemented**. The **Home** journey is verified live against YouTube;
the others are implemented and **pending live selector verification** (YouTube renames its
DOM classes often — see [`docs/HANDOFF.md`](docs/HANDOFF.md) for the verify recipe).

| Journey      | Tools | State |
|--------------|-------|-------|
| **Home**     | `list_home_feed`, `describe_home`, `open_video`, `load_more_home` | ✅ verified live |
| Search       | `run_search`, `list_results`, `refine_search`, `open_result` | ✅ implemented · verify pending |
| Watch        | `get_video_info`, `get_transcript`, `summarize_video`, `plain_language_summary`, `jump_to`, `playback_control`, `set_captions` | ✅ implemented · verify pending |
| Watch Next   | `list_up_next`, `play_next`, `set_autoplay` | ✅ implemented · verify pending |
| Comments     | `get_comments`, `summarize_comments`, `get_pinned_comment` | ✅ implemented · verify pending |
| Picture-in-Picture | `enter_pip`, `exit_pip` | ✅ implemented · verify pending |

`where_am_i` works everywhere and tells the agent which surface you're on. The AI agent
itself runs on **Chrome's on-device Gemini Nano** (no API key) — see
[`src/agent/`](src/agent/).

## Requirements

- **Google Chrome** with these flags enabled (restart after):
  - `chrome://flags/#enable-webmcp-testing` — the WebMCP tools
  - `chrome://flags/#prompt-api-for-gemini-nano` — the on-device agent model
  - `chrome://flags/#optimization-guide-on-device-model` → "Enabled BypassPerfRequirement"
- **[Tampermonkey](https://www.tampermonkey.net/)** (or any userscript manager that
  supports `@grant none`) — or just paste the scripts as DevTools snippets.
- To call tools manually instead of via the agent, a WebMCP inspector such as the
  **Model Context Tool Inspector** extension.

## Try it

1. Enable the flags above and restart Chrome.
2. Install the **provider**
   [`src/youtube-a11y-agent.user.js`](src/youtube-a11y-agent.user.js) in Tampermonkey
   (the `@grant none` header keeps it in the page's main world, which WebMCP requires).
3. Open <https://www.youtube.com> and check the console for a `[yt-a11y]` line listing the
   registered tools.
4. **Via the agent** (no API key — on-device Gemini Nano): install the consumer harness
   [`src/agent/dev-agent.user.js`](src/agent/dev-agent.user.js), then in the console run
   `await ytAgent.activate()` for a spoken greeting, or
   `await ytAgent.ask("what's on my home feed?")`. See [`src/agent/`](src/agent/).
5. **Via an inspector** (manual): try `describe_home`, then `list_home_feed`, then
   `open_video` with an index. Navigate to a video and back — watch the registered tool
   set change with the route.

## How it works

- Runs in the page's **main world** (so `document.modelContext` /
  `navigator.modelContext` is visible) — a userscript today, a `world: "MAIN"` MV3
  extension later.
- **Route-scoped registration:** each YouTube surface (home, search, watch, …) registers
  its own tools, torn down via `AbortController` on navigation so the agent only ever sees
  tools relevant to where you are.
- **Read-and-act, AT-safe:** tools return plain text and perform navigation/native
  actions; nothing mutates the page or its accessibility tree.
- **Media out-of-band:** speech and vision are handled in the script layer; tools
  themselves pass text only (WebMCP has no standard multimodal tool I/O yet).

See [`docs/architecture/yt-a11y-agent.md`](docs/architecture/yt-a11y-agent.md) for the
full architecture (with diagrams), and [`CLAUDE.md`](CLAUDE.md) for conventions and open
questions.

## License

[MIT](LICENSE)
