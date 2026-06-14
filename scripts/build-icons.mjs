// Generate the extension icons (16/32/48/128 PNG) from an inline SVG, using the installed
// Chrome (puppeteer-core screenshot with a transparent background) — no extra image deps.
// Design: deep-red rounded tile, white play triangle + two voice arcs (play + speech =
// voice-controlled YouTube). Run after changing the SVG:
//   npm run build:icons

import puppeteer from "puppeteer-core";
import { mkdirSync, writeFileSync } from "node:fs";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SIZES = [16, 32, 48, 128];

const svg = (s) => `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 128 128">
  <rect width="128" height="128" rx="28" fill="#b3261e"/>
  <path d="M38 38 L78 64 L38 90 Z" fill="#fff"/>
  <path d="M86 50 a20 20 0 0 1 0 28" stroke="#fff" stroke-width="8" fill="none" stroke-linecap="round"/>
  <path d="M97 40 a32 32 0 0 1 0 48" stroke="#fff" stroke-width="8" fill="none" stroke-linecap="round"/>
</svg>`;

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  mkdirSync("extension/icons", { recursive: true });
  for (const s of SIZES) {
    await page.setViewport({ width: s, height: s, deviceScaleFactor: 1 });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}</style>${svg(s)}`
    );
    const buf = await page.screenshot({
      omitBackground: true,
      clip: { x: 0, y: 0, width: s, height: s },
    });
    writeFileSync(`extension/icons/icon${s}.png`, buf);
    console.log(`wrote extension/icons/icon${s}.png`);
  }
} finally {
  await browser.close();
}
