// Headless selector verification against LIVE YouTube.
// Drives the installed Chrome via puppeteer-core and runs the SAME extraction logic the
// provider userscript uses (SEL.card + readVideoCards, watch/<video>, comments) so we can
// confirm the non-home selectors find real data. Does NOT exercise WebMCP/Gemini (those
// need experimental flags / a model download); this checks the fragile DOM layer only.
//
// Run: node scripts/verify-selectors.mjs

import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// --- Selectors mirrored from src/youtube-a11y-agent.user.js (SEL) -----------------------
const SEL = {
  card: {
    title: "a.ytLockupMetadataViewModelTitle, h3 a, a#video-title-link, #video-title",
    watchLink: "a.ytLockupMetadataViewModelTitle, a#video-title-link, a#thumbnail, a[href*='/watch']",
    channel: "a[href^='/@'], a[href*='/channel/'], a[href*='/c/'], ytd-channel-name #text",
    meta: ".ytContentMetadataViewModelMetadataText, #metadata-line span",
    duration: "[class*='Badge' i], ytd-thumbnail-overlay-time-status-renderer #text, .badge-shape__text",
  },
  search: { container: "ytd-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model" },
  watch: {
    title: "h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string, #title h1",
    channel: "ytd-channel-name#channel-name a, #owner #channel-name a, #upload-info #channel-name a",
    info: "ytd-watch-metadata #info, #info-container, ytd-watch-info-text",
    video: "video.html5-main-video, video",
    ccButton: "button.ytp-subtitles-button",
    pipButton: "button.ytp-pip-button",
    autoplayToggle: ".ytp-autonav-toggle-button button, .ytp-autonav-toggle-button",
    transcriptSegment: "ytd-transcript-segment-renderer",
  },
  watchNext: {
    scope: "#secondary, #related, ytd-watch-next-secondary-results-renderer",
    container: "yt-lockup-view-model, ytd-compact-video-renderer",
  },
  comments: { thread: "ytd-comment-thread-renderer", content: "#content-text", author: "#author-text" },
};

// readVideoCards mirrored from the provider (runs in page context).
const READ_CARDS = `
(function(SELcard, containerSel, scopeSel, limit){
  const txt = (el) => (el && el.textContent ? el.textContent.trim() : "");
  const root = scopeSel ? (document.querySelector(scopeSel) || document) : document;
  const items = Array.from(root.querySelectorAll(containerSel));
  const out = []; const seen = new Set();
  for (let i=0;i<items.length && out.length<limit;i++){
    const el = items[i];
    const titleEl = el.querySelector(SELcard.title);
    const title = txt(titleEl); if(!title) continue;
    const linkEl = (titleEl && titleEl.tagName==="A"?titleEl:null) || el.querySelector(SELcard.watchLink);
    let url = linkEl ? (linkEl.getAttribute("href")||"") : "";
    if(url && url.startsWith("/")) url = "https://www.youtube.com"+url;
    if(url && seen.has(url)) continue; if(url) seen.add(url);
    const metaParts = Array.from(el.querySelectorAll(SELcard.meta)).map(txt).filter(Boolean);
    let channel = txt(el.querySelector(SELcard.channel));
    if(!channel && metaParts.length) channel = metaParts[0];
    const meta = metaParts.filter(t=>t!==channel).join(" · ");
    const duration = Array.from(el.querySelectorAll(SELcard.duration)).map(txt).find(t=>/^\\d+:\\d{2}/.test(t)) || "";
    out.push({ index: out.length, title, channel, meta, duration, url });
  }
  return out;
})`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: "new",
    args: ["--no-sandbox", "--lang=en-US", "--window-size=1280,1400"],
  });
  const report = {};
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setViewport({ width: 1280, height: 1400 });
    // Bypass the EU consent interstitial for logged-out sessions.
    await page.setCookie(
      { name: "SOCS", value: "CAI", domain: ".youtube.com" },
      { name: "CONSENT", value: "YES+1", domain: ".youtube.com" }
    );

    // ---- SEARCH ----
    await page.goto("https://www.youtube.com/results?search_query=screen+reader+accessibility&hl=en", {
      waitUntil: "networkidle2",
      timeout: 45000,
    });
    await page.waitForSelector(SEL.search.container, { timeout: 15000 }).catch(() => {});
    await sleep(1500);
    const results = await page.evaluate(
      (fn, c, cont) => eval(fn)(c, cont, null, 5),
      READ_CARDS,
      SEL.card,
      SEL.search.container
    );
    report.search = { count: results.length, sample: results };

    // ---- WATCH (open the first real result) ----
    const firstUrl = results.find((r) => r.url && r.url.includes("/watch"))?.url;
    if (firstUrl) {
      await page.goto(firstUrl + "&hl=en", { waitUntil: "networkidle2", timeout: 45000 });
      await page.waitForSelector(SEL.watch.video, { timeout: 15000 }).catch(() => {});
      await sleep(2500);
      report.watch = await page.evaluate(
        (S) => {
          const txt = (s) => {
            const el = document.querySelector(s);
            return el && el.textContent ? el.textContent.trim() : "";
          };
          const v = document.querySelector(S.watch.video);
          return {
            title: txt(S.watch.title) || document.title.replace(/\s*-\s*YouTube\s*$/, ""),
            channel: txt(S.watch.channel),
            info: txt(S.watch.info),
            videoFound: !!v,
            duration: v && !isNaN(v.duration) ? Math.round(v.duration) : null,
            ccButton: !!document.querySelector(S.watch.ccButton),
            pipButton: !!document.querySelector(S.watch.pipButton),
            autoplayToggle: !!document.querySelector(S.watch.autoplayToggle),
            transcriptSegmentsOpen: document.querySelectorAll(S.watch.transcriptSegment).length,
          };
        },
        SEL
      );

      // ---- WATCH-NEXT (sidebar) ----
      const upnext = await page.evaluate(
        (fn, c, cont, scope) => eval(fn)(c, cont, scope, 5),
        READ_CARDS,
        SEL.card,
        SEL.watchNext.container,
        SEL.watchNext.scope
      );
      report.watchNext = { count: upnext.length, sample: upnext.slice(0, 3) };

      // ---- COMMENTS (scroll to load) ----
      await page.evaluate(() => window.scrollTo(0, Math.floor(document.documentElement.scrollHeight * 0.4)));
      await sleep(3000);
      report.comments = await page.evaluate((S) => {
        const txt = (root, s) => {
          const el = root.querySelector(s);
          return el && el.textContent ? el.textContent.trim() : "";
        };
        const threads = Array.from(document.querySelectorAll(S.comments.thread)).slice(0, 3);
        return {
          count: document.querySelectorAll(S.comments.thread).length,
          sample: threads.map((t) => ({
            author: txt(t, S.comments.author),
            text: txt(t, S.comments.content).slice(0, 80),
          })),
        };
      }, SEL);
    } else {
      report.watch = "skipped — no search result URL resolved";
    }
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("VERIFY ERROR:", e.message);
  process.exit(1);
});
