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

| Journey      | State |
|--------------|-------|
| **Home**     | ✅ Done — `list_home_feed`, `describe_home`, `open_video`, `load_more_home` |
| Search       | 🔜 Planned — `run_search`, `list_results`, `refine_search`, `open_result` |
| Watch        | 🔜 Planned — info, transcript, summary, plain-language summary, jump-to, playback, captions |
| Watch Next   | 🔜 Planned — `list_up_next`, `play_next`, `set_autoplay` |
| Comments     | 🔜 Planned — `get_comments`, `summarize_comments`, `get_pinned_comment` |
| Picture-in-Picture | 🔜 Planned — `enter_pip`, `exit_pip` |

`where_am_i` works everywhere and tells the agent which surface you're on.

## Requirements

- **Google Chrome** with WebMCP testing enabled: `chrome://flags/#enable-webmcp-testing`
  (restart Chrome after enabling).
- **[Tampermonkey](https://www.tampermonkey.net/)** (or any userscript manager that
  supports `@grant none`).
- A WebMCP-capable agent / inspector to call the tools — e.g. the
  **Model Context Tool Inspector** extension.

## Try it

1. Enable `chrome://flags/#enable-webmcp-testing` and restart Chrome.
2. Install the userscript: open
   [`src/youtube-a11y-agent.user.js`](src/youtube-a11y-agent.user.js) in Tampermonkey
   (the `@grant none` header keeps it in the page's main world, which WebMCP requires).
3. Open <https://www.youtube.com> and check the console for a `[yt-a11y]` line listing the
   registered tools.
4. With the Model Context Tool Inspector, try `describe_home`, then `list_home_feed`, then
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

See [`CLAUDE.md`](CLAUDE.md) for architecture details and open questions.

## License

[MIT](LICENSE)
