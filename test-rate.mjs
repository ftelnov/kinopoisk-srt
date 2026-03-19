import puppeteer from "puppeteer-core";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRT_PATH = path.join(__dirname, "data", "Anne.S01E01.HDTV.FLEET.en.srt");
const CHROME_PATH = "/home/fedor/.nix-profile/bin/google-chrome-stable";
const CHROME_PROFILE = "/home/fedor/.config/google-chrome";
const HD_SERIES_URL =
  "https://hd.kinopoisk.ru/film/f3208a5ddeb348bab3f41926c34c8912?content_tab=series";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function parseSRT(text) {
  const cues = [];
  for (const block of text.replace(/\r\n/g, "\n").trim().split(/\n\n+/)) {
    const lines = block.split("\n");
    const tl = lines.findIndex((l) => l.includes("-->"));
    if (tl === -1) continue;
    const m = lines[tl].match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
    if (!m) continue;
    const start = (+m[1]*3600 + +m[2]*60 + +m[3])*1000 + +m[4];
    const end = (+m[5]*3600 + +m[6]*60 + +m[7])*1000 + +m[8];
    const t = lines.slice(tl + 1).join(" ").trim();
    if (t) cues.push({ start, end, text: t });
  }
  return cues;
}

function findCueAt(cues, ms) {
  for (const c of cues) { if (ms >= c.start && ms <= c.end) return c; }
  return null;
}

async function setupBrowser() {
  const tmpProfile = path.join(__dirname, ".test-chrome-profile");
  fs.mkdirSync(path.join(tmpProfile, "Default"), { recursive: true });
  for (const f of ["Default/Cookies","Default/Login Data","Default/Web Data","Default/Preferences","Default/Secure Preferences","Local State"]) {
    try { fs.mkdirSync(path.dirname(path.join(tmpProfile, f)), { recursive: true }); fs.copyFileSync(path.join(CHROME_PROFILE, f), path.join(tmpProfile, f)); } catch {}
  }
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH, headless: false,
    defaultViewport: { width: 1280, height: 800 }, userDataDir: tmpProfile,
    args: [`--disable-extensions-except=${__dirname}`, `--load-extension=${__dirname}`,
      "--no-first-run","--disable-default-apps","--disable-popup-blocking","--autoplay-policy=no-user-gesture-required"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  return { browser, tmpProfile };
}

async function navigateToVideo(page) {
  await page.goto(HD_SERIES_URL, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(3000);
  if (page.url().includes("/profiles")) {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll("a, button, div"))
        if (el.textContent?.trim().startsWith("Федор")||el.textContent?.trim().startsWith("Фёдор")) { el.click(); return; }
    });
    await sleep(5000);
    if (!page.url().includes("f3208a5ddeb348bab3f41926c34c8912")) {
      await page.goto(HD_SERIES_URL, { waitUntil: "networkidle2", timeout: 30000 });
      await sleep(3000);
    }
  }
  await page.evaluate(() => document.querySelector('[class*="CardPlay"]')?.click());
  await sleep(5000);
  await page.waitForSelector("video", { timeout: 20000 });
}

async function setSync(page, offset, rate) {
  await page.evaluate(({ offset, rate }) => {
    return new Promise((resolve) => {
      window.addEventListener("kso-sync-updated", (e) => resolve(e.detail), { once: true });
      setTimeout(resolve, 3000);
      window.dispatchEvent(new CustomEvent("kso-set-sync", { detail: { offset, rate } }));
    });
  }, { offset, rate });
}

async function calibrate(page, pointA, pointB) {
  return page.evaluate(({ pointA, pointB }) => {
    return new Promise((resolve) => {
      window.addEventListener("kso-sync-updated", (e) => resolve(e.detail), { once: true });
      setTimeout(resolve, 3000);
      window.dispatchEvent(new CustomEvent("kso-calibrate", { detail: { pointA, pointB } }));
    });
  }, { pointA, pointB });
}

async function runSyncTest(page, srtCues, rate, offset, label) {
  const testPoints = [5, 30, 60, 120, 180, 300, 600, 900, 1200];
  let pass = 0, fail = 0;

  for (const t of testPoints) {
    await page.evaluate((sec) => { document.querySelector("video").currentTime = sec; }, t);
    await sleep(500);
    await page.evaluate(() => document.querySelector("video")?.dispatchEvent(new Event("timeupdate")));
    await sleep(300);

    const displayed = await page.evaluate(() =>
      document.querySelector(".kso-subtitle-text")?.textContent?.trim() || "");

    // Compute expected SRT time using the same formula as content.js
    const srtMs = t * 1000 * rate + offset;
    const expected = findCueAt(srtCues, srtMs);
    const expText = expected ? expected.text.replace(/\n/g, " ") : "";

    const norm = (s) => s.replace(/[^a-z0-9 ]/gi, "").toLowerCase().trim();
    const ok = (!expected && !displayed)
      || (expected && displayed && norm(displayed).includes(norm(expText).slice(0, 20)));

    if (ok) { pass++; }
    else {
      fail++;
      const e = expected ? `"${expText.slice(0,45)}"` : "(gap)";
      const d = displayed ? `"${displayed.slice(0,45)}"` : "(gap)";
      console.log(`  FAIL @${t}s (srt@${(srtMs/1000).toFixed(1)}s): exp=${e} got=${d}`);
    }
  }
  console.log(`[${label}] ${pass}/${testPoints.length} passed, ${fail} failed`);
  return { pass, fail, total: testPoints.length };
}

(async () => {
  const srtCues = parseSRT(fs.readFileSync(SRT_PATH, "utf-8"));
  const { browser, tmpProfile } = await setupBrowser();
  const page = (await browser.pages())[0] || (await browser.newPage());

  try {
    console.log("[TEST] Navigating...");
    await navigateToVideo(page);
    console.log("[TEST] Video found. Loading SRT...");

    await page.evaluate((srt) => {
      return new Promise((resolve) => {
        window.addEventListener("kso-srt-loaded", () => resolve(), { once: true });
        setTimeout(resolve, 5000);
        window.dispatchEvent(new CustomEvent("kso-load-srt", { detail: { data: srt, filename: "test.srt" } }));
      });
    }, fs.readFileSync(SRT_PATH, "utf-8"));

    // TEST 1: Baseline (rate=1, offset=0)
    console.log("\n=== TEST 1: rate=1.0 offset=0 (baseline) ===");
    await setSync(page, 0, 1.0);
    await runSyncTest(page, srtCues, 1.0, 0, "Baseline");

    // TEST 2: Offset only (-5s)
    console.log("\n=== TEST 2: rate=1.0, offset=-5000ms ===");
    await setSync(page, -5000, 1.0);
    await runSyncTest(page, srtCues, 1.0, -5000, "Offset -5s");

    // TEST 3: Rate only (25→23.976fps correction)
    console.log("\n=== TEST 3: rate=0.959041, offset=0 ===");
    await setSync(page, 0, 0.959041);
    await runSyncTest(page, srtCues, 0.959041, 0, "Rate 25→23.976");

    // TEST 4: Two-point calibration
    console.log("\n=== TEST 4: Two-point calibration ===");
    const calResult = await calibrate(page,
      { videoMs: 90000, srtMs: 83550 },
      { videoMs: 2700000, srtMs: 2656000 }
    );
    const calRate = calResult?.rate ?? 1;
    const calOffset = calResult?.offset ?? 0;
    console.log(`[TEST] Calibrated: rate=${calRate.toFixed(6)}, offset=${(calOffset/1000).toFixed(2)}s`);
    await runSyncTest(page, srtCues, calRate, calOffset, "Calibrated");

    // TEST 5: Verify rate persistence across seek
    console.log("\n=== TEST 5: Scrub test with rate correction ===");
    await setSync(page, 0, 0.959041);
    const scrubPoints = [120, 10, 600, 30, 900, 5, 1200, 60];
    let sp = 0;
    for (const t of scrubPoints) {
      await page.evaluate((s) => { document.querySelector("video").currentTime = s; }, t);
      await sleep(400);
      await page.evaluate(() => document.querySelector("video")?.dispatchEvent(new Event("timeupdate")));
      await sleep(200);
      const displayed = await page.evaluate(() =>
        document.querySelector(".kso-subtitle-text")?.textContent?.trim() || "");
      const srtMs = t * 1000 * 0.959041;
      const expected = findCueAt(srtCues, srtMs);
      const norm = (s) => s.replace(/[^a-z0-9 ]/gi, "").toLowerCase().trim();
      const ok = (!expected && !displayed)
        || (expected && displayed && norm(displayed).includes(norm(expected.text).slice(0,20)));
      if (ok) sp++;
      else console.log(`  FAIL @${t}s`);
    }
    console.log(`[Scrub with rate] ${sp}/${scrubPoints.length} passed`);

  } catch (err) {
    console.error("[TEST] Error:", err.message);
  }

  await browser.close();
  fs.rmSync(tmpProfile, { recursive: true, force: true });
  console.log("\n[TEST] Done.");
})();
