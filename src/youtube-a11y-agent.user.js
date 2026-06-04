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
    home: {
      // A feed tile on the home grid (and most /feed surfaces). The tile wrapper is
      // still ytd-rich-item-renderer, but its CONTENTS are now the newer
      // yt-lockup-view-model component, whose classes are camelCase (no hyphens),
      // e.g. ytLockupMetadataViewModelTitle. Old #video-title ids no longer exist
      // here; they're kept below only as fallbacks for other/older surfaces.
      feedItem: "ytd-rich-item-renderer",
      // Title text AND canonical /watch link — in the lockup the title is the anchor.
      title: "a.ytLockupMetadataViewModelTitle, a#video-title-link, #video-title",
      // Fallback link selectors if the title element isn't itself an <a>.
      link: "a.ytLockupMetadataViewModelTitle, a#video-title-link, a#thumbnail",
      // Channel link, found inside a metadata row.
      channel:
        "a[href^='/@'], a[href*='/channel/'], a[href*='/c/'], ytd-channel-name #text",
      // Each metadata line span (e.g. "12K views", "2 hours ago"). The channel row is
      // also a MetadataText span; readHomeFeed filters it out of the meta string.
      meta: ".ytContentMetadataViewModelMetadataText, #metadata-line span",
      // Thumbnail badges. Broad on purpose (case-insensitive) because the duration
      // badge container class is volatile; readHomeFeed keeps only the mm:ss value,
      // which also skips "LIVE"/"4K"/"NEW" badges.
      duration:
        "[class*='Badge' i], ytd-thumbnail-overlay-time-status-renderer #text, .badge-shape__text",
    },

    search: {
      // Placeholder selectors for the search journey (tools still stubbed).
      result: "ytd-video-renderer, ytd-reel-item-renderer",
      title: "#video-title, a#video-title-link",
      searchBox: "input#search, ytd-searchbox input",
    },

    watch: {
      title: "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string",
      channel: "ytd-channel-name#channel-name #text a, #owner #channel-name a",
      video: "video.html5-main-video, video",
      // Player control buttons we may have to actuate when a Web API needs a real gesture.
      playButton: "button.ytp-play-button",
      ccButton: "button.ytp-subtitles-button",
      pipButton: "button.ytp-pip-button",
      // Up-next / autoplay (watch-next journey).
      upNextItem: "ytd-compact-video-renderer, yt-lockup-view-model",
      autoplayToggle: "#toggle.ytd-compact-autoplay-renderer, .ytp-autonav-toggle-button",
    },

    comments: {
      thread: "ytd-comment-thread-renderer",
      content: "#content-text",
      author: "#author-text",
      pinned: "ytd-comment-thread-renderer:has(#pinned-comment-badge)",
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
  function readHomeFeed(limit) {
    const items = Array.from(document.querySelectorAll(SEL.home.feedItem));
    const out = [];
    for (let i = 0; i < items.length && out.length < limit; i++) {
      const el = items[i];
      const titleEl = el.querySelector(SEL.home.title);
      const title = txt(titleEl);
      if (!title) continue; // skip ads / shelves / non-video tiles
      // In the lockup component the title element IS the /watch anchor; older layouts
      // use a separate link. Fall back to any /watch anchor in the tile.
      const linkEl =
        (titleEl && titleEl.tagName === "A" ? titleEl : null) ||
        el.querySelector(SEL.home.link) ||
        el.querySelector('a[href*="/watch"]');
      let url = linkEl ? linkEl.getAttribute("href") : "";
      if (url && url.startsWith("/")) url = "https://www.youtube.com" + url;
      const channel = qsText(el, SEL.home.channel);
      // Metadata rows minus the channel row -> "12K views · 2 hours ago".
      const meta = Array.from(el.querySelectorAll(SEL.home.meta))
        .map(txt)
        .filter((t) => t && t !== channel)
        .join(" · ");
      // Thumbnail badges include duration; keep only an mm:ss value (skips "LIVE" etc.).
      const duration =
        Array.from(el.querySelectorAll(SEL.home.duration))
          .map(txt)
          .find((t) => /^\d+:\d{2}/.test(t)) || "";
      out.push({ index: out.length, title, channel, meta, duration, url });
    }
    return out;
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
          const before = document.querySelectorAll(SEL.home.feedItem).length;
          window.scrollTo(0, document.documentElement.scrollHeight);
          await sleep(1500);
          const after = document.querySelectorAll(SEL.home.feedItem).length;
          const added = Math.max(0, after - before);
          return ok(
            added > 0
              ? `Loaded ${added} more video(s). The feed now has ${after} items. Call list_home_feed to see them.`
              : `No new videos loaded (still ${after}). You may be at the end of the feed, or it needs another moment.`
          );
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

  // ===========================================================================
  // OTHER JOURNEYS — stubbed. Each returns [] (no tools) for now.
  // Fill these in route by route; the registration backbone already handles them.
  // ===========================================================================

  function searchTools() {
    // TODO(search journey): run_search, list_results, refine_search, open_result
    return [];
  }

  function watchTools() {
    // TODO(watch journey): get_video_info, get_transcript, summarize_video,
    // plain_language_summary, jump_to, playback_control, set_captions
    return [];
  }

  function watchNextTools() {
    // TODO(watch-next journey): list_up_next, play_next, set_autoplay
    return [];
  }

  function commentsTools() {
    // TODO(comments journey): get_comments, summarize_comments, get_pinned_comment
    return [];
  }

  function pipTools() {
    // TODO(pip journey): enter_pip, exit_pip
    // NOTE: video.requestPictureInPicture() requires transient user activation
    // (a real user gesture). A tool call may not count — measure
    // navigator.userActivation.isActive, and fall back to actuating SEL.watch.pipButton.
    return [];
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
    // where_am_i is registered everywhere.
    const tools = [whereAmITool()];
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
