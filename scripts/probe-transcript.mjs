// One-off probe (v4): discover YouTube's CURRENT transcript-panel markup. Earlier probes
// showed: untrusted clicks open the engagement panel (EXPANDED) and can click the
// "Transcript" chip, but NO transcript content ever renders and no transcript/segment
// tags exist in the light DOM. This run tests the two remaining hypotheses:
//   (a) the content is inside SHADOW DOM (light-DOM querySelectorAll can't see it), and/or
//   (b) rendering requires TRUSTED clicks (puppeteer mouse input, not el.click()).
//
// Run: node scripts/probe-transcript.mjs

import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Shadow-piercing snapshot of transcript-ish content, run in the page.
const SNAPSHOT = `
(() => {
  function* allNodes(root) {
    for (const el of root.querySelectorAll("*")) {
      yield el;
      if (el.shadowRoot) yield* allNodes(el.shadowRoot);
    }
  }
  const out = { tags: {}, classHits: new Set(), tsLeaves: 0, shadowHosts: 0, sample: [] };
  for (const el of allNodes(document)) {
    if (el.shadowRoot) out.shadowHosts++;
    const t = el.tagName.toLowerCase();
    if (/transcript|segment/.test(t)) out.tags[t] = (out.tags[t] || 0) + 1;
    if (typeof el.className === "string") {
      for (const c of el.className.split(/\\s+/)) if (/transcript|segment/i.test(c)) out.classHits.add(c);
    }
    if (el.children.length === 0 && /^\\d+:\\d{2}$/.test((el.textContent || "").trim())) {
      out.tsLeaves++;
      if (out.sample.length < 2) {
        const chain = [];
        let n = el;
        for (let i = 0; i < 8 && n && n.tagName; i++) {
          chain.push(n.tagName.toLowerCase() + (typeof n.className === "string" && n.className ? "." + n.className.split(/\\s+/).slice(0, 2).join(".") : ""));
          n = n.parentElement || (n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
        }
        out.sample.push(chain);
      }
    }
  }
  out.classHits = [...out.classHits].slice(0, 25);
  const panel = [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")]
    .find((p) => (p.getAttribute("target-id") || "").includes("transcript") &&
                 p.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
  out.expandedPanelText = panel ? (panel.innerText || "").trim().slice(0, 200) : null;
  return out;
})()`;

async function clickTrusted(page, handle, label, report) {
  if (!handle) {
    report.push({ label, found: false });
    return false;
  }
  await handle.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await sleep(600);
  const box = await handle.boundingBox();
  if (!box) {
    report.push({ label, found: true, visible: false });
    return false;
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  report.push({ label, found: true, clicked: true });
  return true;
}

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: false,
    args: ["--no-sandbox", "--lang=en-US", "--window-size=1280,1000", "--mute-audio"],
    defaultViewport: { width: 1280, height: 900 },
  });
  const report = { clicks: [] };
  try {
    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setCookie(
      { name: "SOCS", value: "CAI", domain: ".youtube.com" },
      { name: "CONSENT", value: "YES+1", domain: ".youtube.com" }
    );
    await page.goto("https://www.youtube.com/watch?v=dEbl5jvLKGQ&hl=en", {
      waitUntil: "networkidle2",
      timeout: 45000,
    });
    await page.waitForSelector("video", { timeout: 15000 });
    await sleep(3000);

    // 1. TRUSTED click: expand the description.
    const expand = await page.$("tp-yt-paper-button#expand, #description-inline-expander #expand, #expand");
    await clickTrusted(page, expand, "expand description", report.clicks);
    await sleep(1200);

    // 2. TRUSTED click: "Show transcript".
    const showBtn = await page.$("button[aria-label*='transcript' i]");
    await clickTrusted(page, showBtn, "show transcript", report.clicks);
    await sleep(2500);
    report.afterOpen = await page.evaluate((s) => eval(s), SNAPSHOT);

    // 3. TRUSTED click: the "Transcript" chip in the panel (if the tabbed header is present).
    const chipBtn = await page.evaluateHandle(() => {
      const panel = [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")]
        .find((p) => (p.getAttribute("target-id") || "").includes("transcript") &&
                     p.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
      if (!panel) return null;
      return [...panel.querySelectorAll("button")].find((b) => /^transcript$/i.test((b.textContent || "").trim())) || null;
    });
    const chipEl = chipBtn.asElement && chipBtn.asElement();
    await clickTrusted(page, chipEl, "transcript chip", report.clicks);
    await sleep(4000);
    report.afterChip = await page.evaluate((s) => eval(s), SNAPSHOT);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error("PROBE ERROR:", e.message);
  process.exit(1);
});
