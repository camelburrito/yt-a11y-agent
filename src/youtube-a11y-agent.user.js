// ==UserScript==
// @name         YouTube A11y Agent Tools (WebMCP)
// @namespace    https://github.com/camelburrito/yt-a11y-agent
// @version      0.1.0
// @description  Registers WebMCP tools on YouTube so an in-browser AI agent can help users with accessibility needs navigate YouTube. Read-and-act only — never mutates the page or its accessibility tree.
// @author       camelburrito
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==
//
// @grant none is CRITICAL: it keeps this script running in the page's MAIN world
// (not an isolated userscript sandbox). document.modelContext / navigator.modelContext
// are page-context objects and are NOT visible from an isolated world. If you ever see
// "WebMCP API not found" while the flag is on, the first thing to check is that the
// script is still @grant none and therefore still in MAIN.

(function () {
  "use strict";

  const LOG = "[yt-a11y]";

  // ---------------------------------------------------------------------------
  // WebMCP API resolution.
  // The spec draft and Chrome's docs disagree on the namespace: some builds expose
  // document.modelContext, others navigator.modelContext. Support both. Resolve lazily
  // (not once at load) because the object may attach slightly after document-idle.
  // ---------------------------------------------------------------------------
  function getModelContext() {
    return (
      (typeof document !== "undefined" && document.modelContext) ||
      (typeof navigator !== "undefined" && navigator.modelContext) ||
      null
    );
  }

  // ---------------------------------------------------------------------------
  // SEL — every YouTube DOM selector lives here, on purpose.
  // YouTube renames/restructures these constantly (it's a Polymer app with churny
  // ids/tag names). When a tool starts returning blanks or empty arrays, THIS BLOCK
  // IS THE FIRST PLACE TO LOOK — odds are a selector drifted, not the logic.
  // Selectors are comma-lists (querySelector picks the first match) so we can carry a
  // couple of fallbacks per field without scattering them through the code.
  // ---------------------------------------------------------------------------
  const SEL = {
    // Shared fields for a video "card" in ANY list (home grid, search results, up-next).
    // YouTube's lockup component (yt-lockup-view-model) uses camelCase classes (no
    // hyphens), e.g. ytLockupMetadataViewModelTitle; older layouts use #video-title ids.
    // Both are covered as comma-list fallbacks. readVideoCards() consumes these.
    // Verified live on the HOME grid (2026-06-04); search/up-next reuse the same lockup
    // structure but should be re-verified live per the docs/HANDOFF.md recipe.
    card: {
      // Title text AND (when it's an <a>) the canonical /watch link.
      title: "a.ytLockupMetadataViewModelTitle, h3 a, a#video-title-link, #video-title",
      // Fallback link if the title element isn't itself an anchor.
      watchLink:
        "a.ytLockupMetadataViewModelTitle, a#video-title-link, a#thumbnail, a[href*='/watch']",
      channel: "a[href^='/@'], a[href*='/channel/'], a[href*='/c/'], ytd-channel-name #text",
      // Metadata line spans ("12K views", "2 hours ago"). The channel is also one of
      // these; readVideoCards filters it out of the meta string.
      meta: ".ytContentMetadataViewModelMetadataText, #metadata-line span",
      // Thumbnail badges. Broad + case-insensitive because the duration badge class is
      // volatile; readVideoCards keeps only the mm:ss value (skips "LIVE"/"4K"/"NEW").
      duration:
        "[class*='Badge' i], ytd-thumbnail-overlay-time-status-renderer #text, .badge-shape__text",
    },

    home: {
      // The tile wrapper. Contents are a yt-lockup-view-model (see SEL.card).
      container: "ytd-rich-item-renderer",
      // Home feed filter chips ("All, Music, Live, Gaming, …"). BEST-EFFORT — these only
      // render when signed in; verify live (see docs/HANDOFF.md probe).
      chip: "ytd-feed-filter-chip-bar-renderer yt-chip-cloud-chip-renderer, #chips yt-chip-cloud-chip-renderer, yt-chip-cloud-chip-renderer",
    },

    // Masthead account info. BEST-EFFORT — signed-in only; name often isn't in the DOM
    // until the account menu opens, so `name` may be empty (greeting degrades gracefully).
    account: {
      avatar: "#avatar-btn, button#avatar-btn, ytd-topbar-menu-button-renderer #avatar img",
      name: "#account-name, ytd-active-account-header-renderer #account-name, #avatar-btn img[alt]",
      signIn: "a[href*='ServiceLogin'], a[href*='accounts.google'], ytd-button-renderer a[aria-label*='Sign in' i]",
    },

    search: {
      container: "ytd-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model",
      box: "input#search, ytd-searchbox input, input[name='search_query']",
    },

    watch: {
      title: "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, #title h1",
      channel: "ytd-channel-name#channel-name a, #owner #channel-name a, #upload-info #channel-name a",
      info: "ytd-watch-metadata #info, #info-container, ytd-watch-info-text",
      video: "video.html5-main-video, video",
      playButton: "button.ytp-play-button",
      // Player container; gets an "ad-showing"/"ad-interrupting" class during ads, when
      // <video>.duration reflects the AD, not the real video.
      player: "#movie_player, .html5-video-player",
      // Native player controls we actuate when a Web API needs a real gesture or for toggles.
      ccButton: "button.ytp-subtitles-button",
      pipButton: "button.ytp-pip-button",
      autoplayToggle: ".ytp-autonav-toggle-button button, .ytp-autonav-toggle-button",
      // Transcript panel (opened from the description's "Show transcript").
      transcriptSegment: "ytd-transcript-segment-renderer",
      transcriptText: ".segment-text, yt-formatted-string.segment-text",
      transcriptTime: ".segment-timestamp",
      transcriptOpenButton: "button[aria-label*='transcript' i]",
    },

    watchNext: {
      scope: "#secondary, #related, ytd-watch-next-secondary-results-renderer",
      container: "yt-lockup-view-model, ytd-compact-video-renderer",
    },

    comments: {
      thread: "ytd-comment-thread-renderer",
      content: "#content-text",
      author: "#author-text",
      pinned: "ytd-comment-thread-renderer:has(#pinned-comment-badge), ytd-comment-thread-renderer:has([pinned-comment-badge])",
    },
  };

  // ---------------------------------------------------------------------------
  // Small helpers.
  // ---------------------------------------------------------------------------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const txt = (el) => (el && el.textContent ? el.textContent.trim() : "");
  const qsText = (root, sel) => txt(root && root.querySelector(sel));

  // Standard tool result envelope. Tools return text only — media (speech/vision) is
  // handled out-of-band in this script, never shoved through the tool boundary.
  const ok = (text) => ({ content: [{ type: "text", text }] });
  const okJSON = (obj) => ok(JSON.stringify(obj, null, 2));

  // Format seconds -> "m:ss" / "h:mm:ss".
  const mmss = (s) => {
    if (s == null || isNaN(s)) return "";
    s = Math.floor(s);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  };

  // Parse a timecode: number of seconds, or "ss" / "m:ss" / "h:mm:ss".
  function parseTimecode(v) {
    if (typeof v === "number") return v;
    if (typeof v !== "string") return NaN;
    const t = v.trim();
    if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
    const parts = t.split(":").map(Number);
    if (parts.some((n) => isNaN(n))) return NaN;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  const getVideo = () => document.querySelector(SEL.watch.video);

  // Start playback robustly. video.play() can be rejected by the autoplay policy when there
  // was no recent user gesture (common after a programmatic navigation); fall back to
  // clicking YouTube's native play button, and report honestly rather than failing silently.
  async function tryPlay(v) {
    try {
      await v.play();
      return "Playing.";
    } catch (e) {
      const btn = document.querySelector(SEL.watch.playButton);
      if (btn && v.paused) btn.click();
      // Re-check after the click.
      if (!v.paused) return "Playing.";
      return "I couldn't start playback automatically — the browser may need a keypress first. Press the space bar (or Ctrl+Shift+Space and say play) to start it.";
    }
  }

  // Actuate a native control (read-and-act; we click YouTube's own button, never build
  // our own UI). Returns whether something was clicked.
  function actuate(sel) {
    const el = document.querySelector(sel);
    if (el) {
      el.click();
      return true;
    }
    return false;
  }

  // Generic reader for a list of video cards (home, search, up-next). Uses SEL.card for
  // fields; dedupes by URL so nested lockup matches don't double-count.
  function readVideoCards(scope, containerSel, limit) {
    const root = scope || document;
    const items = Array.from(root.querySelectorAll(containerSel));
    const out = [];
    const seen = new Set();
    for (let i = 0; i < items.length && out.length < limit; i++) {
      const el = items[i];
      const titleEl = el.querySelector(SEL.card.title);
      const title = txt(titleEl);
      if (!title) continue; // skip ads / shelves / non-video tiles
      const linkEl =
        (titleEl && titleEl.tagName === "A" ? titleEl : null) ||
        el.querySelector(SEL.card.watchLink);
      let url = linkEl ? linkEl.getAttribute("href") || "" : "";
      if (url && url.startsWith("/")) url = "https://www.youtube.com" + url;
      if (url && seen.has(url)) continue; // dedupe nested matches
      if (url) seen.add(url);
      const metaParts = Array.from(el.querySelectorAll(SEL.card.meta)).map(txt).filter(Boolean);
      // Channel is usually a /@ link; in the watch-next sidebar lockup it isn't, so it
      // shows up as the first metadata line instead. Fall back to that.
      let channel = qsText(el, SEL.card.channel);
      if (!channel && metaParts.length) channel = metaParts[0];
      const meta = metaParts.filter((t) => t !== channel).join(" · ");
      const duration =
        Array.from(el.querySelectorAll(SEL.card.duration))
          .map(txt)
          .find((t) => /^\d+:\d{2}/.test(t)) || "";
      // Thumbnail URL derived from the video id (robust vs. lazy-loaded <img> src). A
      // consumer can fetch this and describe it for a user who can't see the screen.
      out.push({ index: out.length, title, channel, meta, duration, url, thumb: thumbUrl(url) });
    }
    return out;
  }

  // Canonical thumbnail URL for a /watch URL (or video id). hqdefault.jpg always exists.
  function thumbUrl(urlOrId) {
    const m = String(urlOrId || "").match(/(?:[?&]v=|^)([A-Za-z0-9_-]{11})/);
    return m ? `https://i.ytimg.com/vi/${m[1]}/hqdefault.jpg` : "";
  }

  // ---------------------------------------------------------------------------
  // Surface detection from the path. Used to scope which tools are registered.
  // ---------------------------------------------------------------------------
  function detectSurface(pathname) {
    if (pathname === "/" || pathname.startsWith("/feed")) return "home";
    if (pathname.startsWith("/results")) return "search";
    if (pathname.startsWith("/watch")) return "watch";
    if (
      pathname.startsWith("/@") ||
      pathname.startsWith("/channel/") ||
      pathname.startsWith("/c/")
    ) {
      return "channel";
    }
    return "other";
  }

  // ===========================================================================
  // HOME JOURNEY TOOLS — fully implemented.
  // Descriptions are written as instructions to the *model*: they tell the agent
  // when and how to call the tool, because that text is the only thing the model sees.
  // ===========================================================================

  // Read the home grid into plain objects. Shared by list/describe/open.
  // Delegates to the generic card reader (same logic verified live on home 2026-06-04).
  function readHomeFeed(limit) {
    return readVideoCards(document, SEL.home.container, limit);
  }

  function homeTools() {
    return [
      {
        name: "list_home_feed",
        description:
          "List the videos currently loaded on the YouTube home feed. Call this first on the home page to know what is available before describing or opening anything. Returns an array of items, each with a stable `index` you can pass to open_video.",
        inputSchema: {
          type: "object",
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: 20,
              description: "Maximum number of videos to return.",
            },
          },
        },
        async execute({ limit = 20 } = {}) {
          const feed = readHomeFeed(limit);
          if (feed.length === 0) {
            return ok(
              "No videos found on the home feed yet. The feed may still be loading — try again, or call load_more_home."
            );
          }
          return okJSON(feed);
        },
      },

      {
        name: "describe_home",
        description:
          "Give a short, spoken-friendly overview of the home feed for a user who cannot see the screen. Use this to orient the user before they choose. Keep it brief — read the top few titles aloud.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          const feed = readHomeFeed(20);
          if (feed.length === 0) {
            return ok("The home feed has not loaded any videos yet.");
          }
          const top = feed
            .slice(0, 3)
            .map((v) => `${v.title}${v.channel ? " by " + v.channel : ""}`)
            .join("; ");
          return ok(
            `${feed.length} videos loaded on your home feed. Top picks: ${top}. Say "open" with a number to play one, or ask me to load more.`
          );
        },
      },

      {
        name: "open_video",
        description:
          "Open (navigate to) a home-feed video by its `index` from list_home_feed. This changes the page to the watch surface. Confirm the choice with the user first if there is any ambiguity.",
        inputSchema: {
          type: "object",
          properties: {
            index: {
              type: "integer",
              minimum: 0,
              description: "The index of the video from list_home_feed.",
            },
          },
          required: ["index"],
        },
        async execute({ index }) {
          const feed = readHomeFeed(100);
          const item = feed.find((v) => v.index === index);
          if (!item) {
            return ok(
              `No video at index ${index}. There are ${feed.length} videos loaded (indices 0–${feed.length - 1}).`
            );
          }
          if (!item.url) {
            return ok(`Found "${item.title}" but could not resolve its URL.`);
          }
          // Navigate via location — read-and-act, no DOM mutation.
          window.location.href = item.url;
          return ok(`Opening "${item.title}"${item.channel ? " by " + item.channel : ""}.`);
        },
      },

      {
        name: "load_more_home",
        description:
          "Load more videos onto the home feed by scrolling to the bottom and waiting for YouTube to fetch the next batch. Use when the user wants more options than list_home_feed currently shows. Reports how many new videos appeared.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          const before = document.querySelectorAll(SEL.home.container).length;
          window.scrollTo(0, document.documentElement.scrollHeight);
          await sleep(1500);
          const after = document.querySelectorAll(SEL.home.container).length;
          const added = Math.max(0, after - before);
          return ok(
            added > 0
              ? `Loaded ${added} more video(s). The feed now has ${after} items. Call list_home_feed to see them.`
              : `No new videos loaded (still ${after}). You may be at the end of the feed, or it needs another moment.`
          );
        },
      },

      {
        name: "list_categories",
        description:
          "List the home feed's filter categories (the chips like 'All, Music, Live, Gaming, …'). Use this in the greeting so the user can pick a category to filter the feed.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          const chips = Array.from(document.querySelectorAll(SEL.home.chip))
            .map(txt)
            .filter(Boolean);
          // De-dupe while preserving order.
          const seen = new Set();
          const cats = chips.filter((c) => (seen.has(c) ? false : seen.add(c)));
          return cats.length
            ? okJSON(cats)
            : ok("No category chips are visible (you may need to be signed in, or the bar hasn't loaded).");
        },
      },

      {
        name: "select_category",
        description:
          "Filter the home feed by a category from list_categories, by its `name` (e.g. 'Music'). Clicks the matching chip; then call list_home_feed to read the filtered videos.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        async execute({ name }) {
          if (!name) return ok("Tell me which category to pick.");
          const want = name.trim().toLowerCase();
          const chip = Array.from(document.querySelectorAll(SEL.home.chip)).find(
            (c) => txt(c).toLowerCase() === want
          );
          if (!chip) return ok(`I couldn't find a "${name}" category. Call list_categories to hear the options.`);
          chip.click();
          await sleep(800);
          return ok(`Filtered by ${txt(chip)}. Call list_home_feed for the videos.`);
        },
      },
    ];
  }

  // ===========================================================================
  // CROSS-CUTTING TOOL — registered on EVERY route.
  // ===========================================================================
  function whereAmITool() {
    return {
      name: "where_am_i",
      description:
        "Report which YouTube surface the user is currently on (home, search, watch, channel, or other) and the raw path. Call this whenever you are unsure what tools apply or what the user is looking at.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const surface = detectSurface(location.pathname);
        return ok(`Surface: ${surface}. Path: ${location.pathname}${location.search}`);
      },
    };
  }

  function accountTool() {
    return {
      name: "get_account",
      description:
        "Report whether the user is signed in to YouTube and, if available, their account name — so you can welcome them by name. Call this once at the start of a session before greeting.",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        const signedIn = !!document.querySelector(SEL.account.avatar) && !document.querySelector(SEL.account.signIn);
        let name = qsText(document, SEL.account.name);
        if (!name) {
          // The avatar image's alt text is sometimes "Avatar image" or the channel name.
          const alt = (document.querySelector("#avatar-btn img, " + SEL.account.avatar) || {}).getAttribute
            ? document.querySelector("#avatar-btn img")?.getAttribute("alt")
            : "";
          if (alt && !/avatar/i.test(alt)) name = alt;
        }
        return okJSON({ signedIn, name: name || null });
      },
    };
  }

  // ===========================================================================
  // OTHER JOURNEYS — implemented. Selectors live in SEL; logic mirrors the verified
  // home reader. NOTE: search/watch/comments selectors are best-effort and should be
  // re-verified live per docs/HANDOFF.md (YouTube's lockup migration affects them too).
  // ===========================================================================

  // ---- SEARCH (/results) ----------------------------------------------------
  function searchUrl(q) {
    return "https://www.youtube.com/results?search_query=" + encodeURIComponent(q.trim());
  }
  function searchTools() {
    return [
      {
        name: "run_search",
        description:
          "Search YouTube for a query. Navigates to the results page. After it loads, call list_results to read what came back.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", description: "What to search for." } },
          required: ["query"],
        },
        async execute({ query }) {
          if (!query || !query.trim()) return ok("Please tell me what to search for.");
          window.location.href = searchUrl(query);
          return ok(`Searching for "${query.trim()}".`);
        },
      },
      {
        name: "list_results",
        description:
          "List the current YouTube search results. Returns an array of items, each with a stable `index` (for open_result), title, channel, meta, and duration.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
        },
        async execute({ limit = 20 } = {}) {
          const r = readVideoCards(document, SEL.search.container, limit);
          return r.length
            ? okJSON(r)
            : ok("No results loaded yet. Try run_search first, or the page may still be loading.");
        },
      },
      {
        name: "refine_search",
        description:
          "Run a new, refined query, replacing the current results. Use when the user wants to narrow or change what they searched for.",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
        },
        async execute({ query }) {
          if (!query || !query.trim()) return ok("Tell me the refined search.");
          window.location.href = searchUrl(query);
          return ok(`Refining the search to "${query.trim()}".`);
        },
      },
      {
        name: "open_result",
        description:
          "Open a search result by its `index` from list_results. Navigates to that video.",
        inputSchema: {
          type: "object",
          properties: { index: { type: "integer", minimum: 0 } },
          required: ["index"],
        },
        async execute({ index }) {
          const r = readVideoCards(document, SEL.search.container, 50);
          const item = r.find((v) => v.index === index);
          if (!item) return ok(`No result at index ${index}. There are ${r.length} results loaded.`);
          if (!item.url) return ok(`Found "${item.title}" but couldn't resolve its URL.`);
          window.location.href = item.url;
          return ok(`Opening "${item.title}".`);
        },
      },
    ];
  }

  // ---- WATCH (/watch) -------------------------------------------------------
  function watchTitle() {
    return qsText(document, SEL.watch.title) || document.title.replace(/\s*-\s*YouTube\s*$/, "");
  }
  function readTranscript(limit) {
    const segs = Array.from(document.querySelectorAll(SEL.watch.transcriptSegment));
    return segs.slice(0, limit).map((s) => ({
      time: txt(s.querySelector(SEL.watch.transcriptTime)),
      text: txt(s.querySelector(SEL.watch.transcriptText)) || txt(s),
    }));
  }
  function watchTools() {
    return [
      {
        name: "get_video_info",
        description:
          "Get information about the video currently playing: title, channel, view/date info, and playback position. Call this to orient the user on a watch page.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          const v = getVideo();
          const player = document.querySelector(SEL.watch.player);
          const adShowing = !!(player && /ad-showing|ad-interrupting/.test(player.className));
          return okJSON({
            title: watchTitle(),
            channel: qsText(document, SEL.watch.channel),
            info: qsText(document, SEL.watch.info),
            thumb: thumbUrl(location.search), // describe-able via the consumer's vision tool
            // During an ad, the <video> reports the ad's timing, not the video's.
            adPlaying: adShowing,
            position: v && !adShowing ? mmss(v.currentTime) : null,
            duration: v && !adShowing ? mmss(v.duration) : null,
            paused: v ? v.paused : null,
            playbackRate: v ? v.playbackRate : null,
          });
        },
      },
      {
        name: "get_transcript",
        description:
          "Get the transcript of the current video as timestamped lines, if available. If the transcript panel isn't open, this tries to open it and asks the user to try again.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", default: 200 } },
        },
        async execute({ limit = 200 } = {}) {
          let lines = readTranscript(limit);
          if (lines.length === 0) {
            const opened = actuate(SEL.watch.transcriptOpenButton);
            await sleep(1200);
            lines = readTranscript(limit);
            if (lines.length === 0) {
              return ok(
                opened
                  ? "I'm opening the transcript — please ask again in a moment."
                  : "No transcript is available or open for this video. It may need to be opened from the description."
              );
            }
          }
          return ok(lines.map((l) => (l.time ? `[${l.time}] ${l.text}` : l.text)).join("\n"));
        },
      },
      {
        name: "summarize_video",
        description:
          "Gather the material needed to summarize the current video (title, channel, transcript if available). Returns that source text; you, the agent, then produce a concise spoken summary for the user.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          const transcript = readTranscript(400)
            .map((l) => l.text)
            .filter(Boolean)
            .join(" ");
          return ok(
            "SOURCE FOR SUMMARY — summarize this for the user in a few spoken sentences.\n" +
              `Title: ${watchTitle()}\n` +
              `Channel: ${qsText(document, SEL.watch.channel)}\n` +
              `Transcript: ${transcript || "(not open/available — summarize from the title and offer to open the transcript)"}`
          );
        },
      },
      {
        name: "plain_language_summary",
        description:
          "Like summarize_video, but you should produce an extra-simple, plain-language explanation (short sentences, no jargon) for someone who wants the gist quickly. Returns the source material to explain.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          const transcript = readTranscript(400)
            .map((l) => l.text)
            .filter(Boolean)
            .join(" ");
          return ok(
            "SOURCE FOR PLAIN-LANGUAGE SUMMARY — explain this simply, short sentences, no jargon.\n" +
              `Title: ${watchTitle()}\n` +
              `Transcript: ${transcript || "(no transcript — explain from the title and offer to open the transcript)"}`
          );
        },
      },
      {
        name: "jump_to",
        description:
          "Jump the video to a specific time. Accept seconds (a number) or a timestamp like '1:30' or '1:02:03'.",
        inputSchema: {
          type: "object",
          properties: {
            time: { type: ["string", "number"], description: "Seconds, or mm:ss / h:mm:ss." },
          },
          required: ["time"],
        },
        async execute({ time }) {
          const v = getVideo();
          if (!v) return ok("No video found on this page.");
          const sec = parseTimecode(time);
          if (isNaN(sec)) return ok(`I couldn't understand the time "${time}".`);
          v.currentTime = Math.max(0, isNaN(v.duration) ? sec : Math.min(sec, v.duration));
          return ok(`Jumped to ${mmss(v.currentTime)}.`);
        },
      },
      {
        name: "playback_control",
        description:
          "Control playback of the current video. `action` is one of: play, pause, toggle, forward, back, speed. For forward/back, `value` is seconds (default 10). For speed, `value` is the rate (e.g. 1.5).",
        inputSchema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["play", "pause", "toggle", "forward", "back", "speed"] },
            value: { type: "number" },
          },
          required: ["action"],
        },
        async execute({ action, value }) {
          const v = getVideo();
          if (!v) return ok("No video found on this page.");
          switch (action) {
            case "play":
              return ok(await tryPlay(v));
            case "pause":
              v.pause();
              return ok("Paused.");
            case "toggle":
              if (v.paused) return ok(await tryPlay(v));
              v.pause();
              return ok("Paused.");
            case "forward":
              v.currentTime += value || 10;
              return ok(`Skipped forward to ${mmss(v.currentTime)}.`);
            case "back":
              v.currentTime -= value || 10;
              return ok(`Skipped back to ${mmss(v.currentTime)}.`);
            case "speed":
              v.playbackRate = value || 1;
              return ok(`Playback speed is now ${v.playbackRate}x.`);
            default:
              return ok(`Unknown action "${action}".`);
          }
        },
      },
      {
        name: "set_captions",
        description:
          "Turn captions/subtitles on or off by toggling YouTube's native captions button.",
        inputSchema: {
          type: "object",
          properties: { on: { type: "boolean", default: true } },
        },
        async execute({ on = true } = {}) {
          const btn = document.querySelector(SEL.watch.ccButton);
          if (!btn) return ok("The captions button isn't available on this player.");
          const pressed = btn.getAttribute("aria-pressed") === "true";
          if (on !== pressed) btn.click();
          return ok(`Captions ${on ? "on" : "off"}.`);
        },
      },
    ];
  }

  // ---- WATCH-NEXT (sidebar on /watch) --------------------------------------
  function watchNextScope() {
    return document.querySelector(SEL.watchNext.scope) || document;
  }
  function watchNextTools() {
    return [
      {
        name: "list_up_next",
        description:
          "List the up-next / recommended videos in the sidebar of the current watch page. Returns indexed items.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", default: 10 } },
        },
        async execute({ limit = 10 } = {}) {
          const r = readVideoCards(watchNextScope(), SEL.watchNext.container, limit);
          return r.length ? okJSON(r) : ok("No up-next videos found yet.");
        },
      },
      {
        name: "play_next",
        description:
          "Play the first up-next video. Navigates to it. Confirm with the user first if appropriate.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          const r = readVideoCards(watchNextScope(), SEL.watchNext.container, 1);
          if (!r.length || !r[0].url) return ok("I couldn't find an up-next video.");
          window.location.href = r[0].url;
          return ok(`Playing next: "${r[0].title}".`);
        },
      },
      {
        name: "set_autoplay",
        description: "Turn autoplay on or off using the player's native autoplay toggle.",
        inputSchema: {
          type: "object",
          properties: { on: { type: "boolean", default: true } },
        },
        async execute({ on = true } = {}) {
          const btn = document.querySelector(SEL.watch.autoplayToggle);
          if (!btn) return ok("The autoplay toggle isn't available.");
          const checked = btn.getAttribute("aria-checked") === "true";
          if (on !== checked) btn.click();
          return ok(`Autoplay ${on ? "on" : "off"}.`);
        },
      },
    ];
  }

  // ---- COMMENTS (on /watch) -------------------------------------------------
  async function ensureCommentsLoaded() {
    if (!document.querySelector(SEL.comments.thread)) {
      window.scrollTo(0, Math.floor(document.documentElement.scrollHeight * 0.4));
      await sleep(1400);
    }
  }
  function commentsTools() {
    return [
      {
        name: "get_comments",
        description:
          "Read top-level comments on the current video. Scrolls to load them if needed. Returns indexed {author, text}.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", default: 10 } },
        },
        async execute({ limit = 10 } = {}) {
          await ensureCommentsLoaded();
          const threads = Array.from(document.querySelectorAll(SEL.comments.thread)).slice(0, limit);
          if (!threads.length) return ok("No comments loaded — they may be turned off, or still loading.");
          return okJSON(
            threads.map((t, i) => ({
              index: i,
              author: qsText(t, SEL.comments.author),
              text: qsText(t, SEL.comments.content),
            }))
          );
        },
      },
      {
        name: "summarize_comments",
        description:
          "Gather the top comments so you, the agent, can summarize the overall themes and sentiment for the user. Returns the comment texts.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", default: 20 } },
        },
        async execute({ limit = 20 } = {}) {
          await ensureCommentsLoaded();
          const threads = Array.from(document.querySelectorAll(SEL.comments.thread)).slice(0, limit);
          if (!threads.length) return ok("There are no comments to summarize.");
          const text = threads
            .map((t) => qsText(t, SEL.comments.content))
            .filter(Boolean)
            .map((c) => `- ${c}`)
            .join("\n");
          return ok(
            "SOURCE FOR COMMENT SUMMARY — summarize the themes and sentiment for the user:\n" + text
          );
        },
      },
      {
        name: "get_pinned_comment",
        description: "Get the pinned comment on the current video, if there is one.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          await ensureCommentsLoaded();
          let pinned = null;
          try {
            pinned = document.querySelector(SEL.comments.pinned);
          } catch (_) {
            /* :has() unsupported — ignore */
          }
          if (!pinned) return ok("There's no pinned comment on this video.");
          return ok(
            `Pinned comment by ${qsText(pinned, SEL.comments.author)}: ${qsText(pinned, SEL.comments.content)}`
          );
        },
      },
    ];
  }

  // ---- PICTURE-IN-PICTURE (on /watch) --------------------------------------
  function pipTools() {
    return [
      {
        name: "enter_pip",
        description:
          "Put the current video into Picture-in-Picture — a small floating window that stays on top — so it stays visible/audible while navigating elsewhere.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          const v = getVideo();
          if (!v) return ok("No video found on this page.");
          if (document.pictureInPictureElement) return ok("Already in Picture-in-Picture.");
          // Open question (c): requestPictureInPicture needs transient user activation.
          // Measure it, then fall back to actuating the native button if the API refuses.
          const active = !!(navigator.userActivation && navigator.userActivation.isActive);
          try {
            await v.requestPictureInPicture();
            return ok(`Entered Picture-in-Picture. (userActivation.isActive was ${active})`);
          } catch (e) {
            const clicked = actuate(SEL.watch.pipButton);
            return ok(
              `Direct Picture-in-Picture failed (userActivation.isActive=${active}: ${e.message}). ` +
                (clicked
                  ? "I clicked the native PiP button instead — let me know if it worked."
                  : "No native PiP button was found.")
            );
          }
        },
      },
      {
        name: "exit_pip",
        description: "Exit Picture-in-Picture and return the video to the page.",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          if (!document.pictureInPictureElement) return ok("The video isn't in Picture-in-Picture.");
          try {
            await document.exitPictureInPicture();
            return ok("Exited Picture-in-Picture.");
          } catch (e) {
            return ok("I couldn't exit Picture-in-Picture: " + e.message);
          }
        },
      },
    ];
  }

  // ===========================================================================
  // Route-scoped registration backbone.
  // Each route gets its own AbortController. Registering with { signal } means
  // aborting the controller unregisters exactly that route's tools — no manual
  // bookkeeping, no leaks across navigations.
  // ===========================================================================
  let currentController = null;
  let currentSurface = null;

  function toolsForSurface(surface) {
    // where_am_i and get_account are registered everywhere.
    const tools = [whereAmITool(), accountTool()];
    switch (surface) {
      case "home":
        tools.push(...homeTools());
        break;
      case "search":
        tools.push(...searchTools());
        break;
      case "watch":
        tools.push(...watchTools(), ...watchNextTools(), ...commentsTools(), ...pipTools());
        break;
      case "channel":
      case "other":
      default:
        // Only the cross-cutting tool for now.
        break;
    }
    return tools;
  }

  function registerForRoute() {
    const api = getModelContext();
    if (!api || typeof api.registerTool !== "function") {
      console.warn(
        `${LOG} WebMCP API not found (no registerTool). Is chrome://flags/#enable-webmcp-testing enabled and is this script @grant none / MAIN world?`
      );
      return;
    }

    const surface = detectSurface(location.pathname);

    // Tear down the previous route's tools.
    if (currentController) {
      currentController.abort();
      currentController = null;
    }

    currentController = new AbortController();
    currentSurface = surface;
    const { signal } = currentController;

    const tools = toolsForSurface(surface);
    const registered = [];
    for (const tool of tools) {
      try {
        api.registerTool(tool, { signal });
        registered.push(tool.name);
      } catch (err) {
        console.error(`${LOG} failed to register tool "${tool.name}":`, err);
      }
    }

    console.log(
      `${LOG} surface="${surface}" path="${location.pathname}" registered ${registered.length} tool(s): ${registered.join(", ")}`
    );
  }

  // ---------------------------------------------------------------------------
  // Route-change detection. YouTube is an SPA, so we listen on multiple signals:
  //   1. yt-navigate-finish  — YouTube's own "done navigating" event (primary)
  //   2. popstate            — back/forward
  //   3. 1s URL poll         — fallback for anything the above miss
  // We only re-register when the resolved surface actually changes.
  // ---------------------------------------------------------------------------
  let lastSurface = null;
  let lastPath = null;

  function onMaybeRouteChange() {
    const path = location.pathname;
    const surface = detectSurface(path);
    if (surface === lastSurface && path === lastPath) return;
    lastSurface = surface;
    lastPath = path;
    registerForRoute();
  }

  window.addEventListener("yt-navigate-finish", onMaybeRouteChange, true);
  window.addEventListener("popstate", onMaybeRouteChange, true);
  setInterval(onMaybeRouteChange, 1000);

  // Initial registration once the API is (likely) available. document-idle usually
  // suffices, but retry briefly in case modelContext attaches a beat late.
  (function bootstrap(attempt) {
    if (getModelContext()) {
      onMaybeRouteChange();
      return;
    }
    if (attempt >= 10) {
      console.warn(`${LOG} gave up waiting for WebMCP API after ${attempt} attempts.`);
      // Still wire up route detection so it activates if the API shows up later.
      onMaybeRouteChange();
      return;
    }
    setTimeout(() => bootstrap(attempt + 1), 500);
  })(0);

  console.log(`${LOG} userscript loaded (MAIN world). Awaiting WebMCP API…`);
})();
