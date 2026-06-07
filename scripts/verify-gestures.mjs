// Gesture-path verification against LIVE YouTube (open questions c + transcript-open).
// Headful Chrome via puppeteer-core. Two subtleties this script handles:
//   * puppeteer's page.evaluate() sets CDP userGesture:true — which GRANTS transient user
//     activation and silently contaminates any activation measurement. All measured
//     attempts therefore go through a raw CDP Runtime.evaluate with userGesture:false
//     (evalNoGesture); only the deliberate "fresh trusted gesture" tests use real
//     page.keyboard input (CDP input events are trusted).
//   * Chrome's transient-activation window is ~5s, so tests are spaced >5s apart.
// What it answers (HANDOFF open items):
//   1. PiP — does video.requestPictureInPicture() from a tool call need activation, does
//      activation survive the realistic talk-key -> STT -> tool latency (~6s), and does the
//      untrusted el.click() fallback on the native PiP button work without activation?
//   2. Transcript — does SEL.watch.transcriptOpenButton match the REAL "Show transcript"
//      control, does an untrusted click open the panel, and do segments render?
//
// Run: node scripts/verify-gestures.mjs   (opens a visible Chrome window; ~90s)

import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Mirrored from src/youtube-a11y-agent.user.js SEL (keep in sync).
const SEL = {
  search: { container: "ytd-video-renderer, ytd-rich-item-renderer, yt-lockup-view-model" },
  watch: {
    video: "video.html5-main-video, video",
    pipButton: "button.ytp-pip-button",
    transcriptSegment: "ytd-transcript-segment-renderer",
    transcriptOpenButton: "button[aria-label*='transcript' i]",
    descriptionExpand: "tp-yt-paper-button#expand, #description-inline-expander #expand, #expand",
  },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ACTIVATION_COOLOFF_MS = 7000; // > Chrome's ~5s transient-activation window

// One PiP attempt inside the page, with full context captured.
const TRY_PIP = `
(async () => {
  const v = document.querySelector("video.html5-main-video, video");
  if (!v) return { error: "no <video>" };
  const active = !!(navigator.userActivation && navigator.userActivation.isActive);
  const hasBeenActive = !!(navigator.userActivation && navigator.userActivation.hasBeenActive);
  try {
    await v.requestPictureInPicture();
    const inPip = !!document.pictureInPictureElement;
    return { userActivationIsActive: active, hasBeenActive, pipSucceeded: true, inPip };
  } catch (e) {
    return { userActivationIsActive: active, hasBeenActive, pipSucceeded: false, error: e.name + ": " + e.message };
  }
})()`;

const EXIT_PIP = `
(async () => {
  if (document.pictureInPictureElement) {
    try { await document.exitPictureInPicture(); return "exited"; } catch (e) { return "exit failed: " + e.message; }
  }
  return "not in pip";
})()`;

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false, // PiP + user-activation fidelity need a real window
    args: ["--no-sandbox", "--lang=en-US", "--window-size=1280,1000", "--mute-audio"],
    defaultViewport: { width: 1280, height: 900 },
  });
  const report = {};
  try {
    const page = await browser.newPage();
    const cdp = await page.createCDPSession();
    // Evaluate WITHOUT granting user activation (Runtime.evaluate defaults userGesture:false).
    const evalNoGesture = async (expression) => {
      const { result, exceptionDetails } = await cdp.send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
        userGesture: false,
      });
      if (exceptionDetails) return { error: exceptionDetails.text };
      return result.value;
    };

    await page.setUserAgent(UA);
    await page.setCookie(
      { name: "SOCS", value: "CAI", domain: ".youtube.com" },
      { name: "CONSENT", value: "YES+1", domain: ".youtube.com" }
    );

    // Find a real watch URL via search (same approach as verify-selectors).
    await page.goto("https://www.youtube.com/results?search_query=screen+reader+accessibility&hl=en", {
      waitUntil: "networkidle2",
      timeout: 45000,
    });
    await page.waitForSelector(SEL.search.container, { timeout: 15000 }).catch(() => {});
    const watchUrl = await page.evaluate(() => {
      const a = document.querySelector("a[href*='/watch?v=']");
      return a ? a.href : null;
    });
    if (!watchUrl) throw new Error("no watch URL found on results page");
    await page.goto(watchUrl.split("&")[0] + "&hl=en", { waitUntil: "networkidle2", timeout: 45000 });
    await page.waitForSelector(SEL.watch.video, { timeout: 15000 });
    await sleep(3000); // let the player settle
    await sleep(ACTIVATION_COOLOFF_MS); // make sure nothing from page load counts as activation

    // ---- PiP test A: NO user gesture (cold tool call) -------------------------------
    report.pip_noGesture = await evalNoGesture(TRY_PIP);
    await evalNoGesture(EXIT_PIP);
    await sleep(ACTIVATION_COOLOFF_MS);

    // ---- PiP test B: fresh trusted gesture (talk-key press), call immediately -------
    // Backquote mirrors the real tap-to-talk key. CDP key events are trusted input.
    await page.keyboard.press("Backquote");
    report.pip_freshGesture = await evalNoGesture(TRY_PIP);
    report.pip_freshGesture.delayAfterGestureMs = 0;
    await evalNoGesture(EXIT_PIP);
    await sleep(ACTIVATION_COOLOFF_MS);

    // ---- PiP test C: realistic voice latency — gesture, wait ~6s, then call ---------
    // (tap-to-talk -> speak -> STT result -> tool execution is typically 2-8s)
    await page.keyboard.press("Backquote");
    await sleep(6000);
    report.pip_after6s = await evalNoGesture(TRY_PIP);
    report.pip_after6s.delayAfterGestureMs = 6000;
    await evalNoGesture(EXIT_PIP);
    await sleep(ACTIVATION_COOLOFF_MS);

    // ---- PiP test D: the provider's fallback — UNTRUSTED click on the native button -
    // actuate() does el.click() with NO activation; does YouTube's own handler get PiP?
    report.pip_untrustedButtonClick = await evalNoGesture(`
      (async () => {
        const btn = document.querySelector(${JSON.stringify(SEL.watch.pipButton)});
        if (!btn) return { buttonFound: false };
        const active = !!(navigator.userActivation && navigator.userActivation.isActive);
        btn.click();
        await new Promise((r) => setTimeout(r, 1500));
        return { buttonFound: true, userActivationIsActive: active, inPip: !!document.pictureInPictureElement };
      })()`);
    await evalNoGesture(EXIT_PIP);

    // ---- Transcript test -------------------------------------------------------------
    // Untrusted clicks (same as the provider's actuate()). Poll for segments up to 8s and,
    // if none render, dump forensics: which element the selector matched, every
    // transcript-labeled control, and what engagement panels exist/showed.
    report.transcript = await evalNoGesture(`
      (async () => {
        const S = ${JSON.stringify(SEL.watch)};
        const out = {};
        const q = (s) => document.querySelector(s);
        const describe = (el) => el && {
          tag: el.tagName.toLowerCase(),
          label: el.getAttribute("aria-label") || (el.textContent || "").trim().slice(0, 60),
          visible: !!(el.offsetParent || el.getClientRects().length),
          inDescription: !!el.closest("ytd-video-description-transcript-section-renderer, #description"),
        };
        out.segmentsBefore = document.querySelectorAll(S.transcriptSegment).length;
        out.matchBeforeExpand = describe(q(S.transcriptOpenButton));
        const expand = q(S.descriptionExpand);
        out.expandFound = !!expand;
        if (expand) { expand.click(); await new Promise((r) => setTimeout(r, 1200)); }
        const btn = q(S.transcriptOpenButton);
        out.matchAfterExpand = describe(btn);
        out.allTranscriptControls = [...document.querySelectorAll("button, [role='button']")]
          .map((b) => describe(b))
          .filter((c) => c && /transcript/i.test(c.label))
          .slice(0, 6);
        if (btn) {
          btn.click();
          // Poll up to 8s — the panel lazy-renders.
          for (let i = 0; i < 16; i++) {
            await new Promise((r) => setTimeout(r, 500));
            if (document.querySelectorAll(S.transcriptSegment).length) break;
          }
        }
        out.segmentsAfter = document.querySelectorAll(S.transcriptSegment).length;
        if (!out.segmentsAfter) {
          // Forensics: did a panel open at all, and what does YouTube call segments now?
          out.engagementPanels = [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")]
            .map((p) => ({
              target: p.getAttribute("target-id"),
              visibility: p.getAttribute("visibility"),
              textSample: (p.innerText || "").trim().slice(0, 120),
            }));
          out.transcriptTagged = [...document.querySelectorAll("*")]
            .map((el) => el.tagName.toLowerCase())
            .filter((t) => t.includes("transcript"))
            .reduce((acc, t) => ((acc[t] = (acc[t] || 0) + 1), acc), {});
        }
        return out;
      })()`);

    report.watchUrl = watchUrl.split("&")[0];
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("VERIFY ERROR:", e.message);
  process.exit(1);
});
