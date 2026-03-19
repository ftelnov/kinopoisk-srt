import puppeteer from "puppeteer-core";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = __dirname;
const SRT_PATH = path.join(__dirname, "data", "Anne.S01E01.HDTV.FLEET.en.srt");
const CHROME_PATH = "/home/fedor/.nix-profile/bin/google-chrome-stable";
const CHROME_PROFILE = "/home/fedor/.config/google-chrome";
const HD_SERIES_URL =
  "https://hd.kinopoisk.ru/film/f3208a5ddeb348bab3f41926c34c8912?content_tab=series";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseSRT(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.split("\n");
    let timeLine = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) { timeLine = i; break; }
    }
    if (timeLine === -1) continue;
    const m = lines[timeLine].match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!m) continue;
    const start = (+m[1]*3600 + +m[2]*60 + +m[3])*1000 + +m[4];
    const end = (+m[5]*3600 + +m[6]*60 + +m[7])*1000 + +m[8];
    const text2 = lines.slice(timeLine + 1).join(" ").trim();
    if (text2) cues.push({ start, end, text: text2 });
  }
  return cues;
}

(async () => {
  const tmpProfile = path.join(__dirname, ".test-chrome-profile");
  fs.mkdirSync(path.join(tmpProfile, "Default"), { recursive: true });
  for (const f of [
    "Default/Cookies", "Default/Login Data", "Default/Web Data",
    "Default/Preferences", "Default/Secure Preferences", "Local State",
  ]) {
    try {
      const dst = path.join(tmpProfile, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(CHROME_PROFILE, f), dst);
    } catch {}
  }

  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: false,
    defaultViewport: { width: 1280, height: 800 },
    userDataDir: tmpProfile,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      "--no-first-run", "--disable-default-apps", "--disable-popup-blocking",
      "--autoplay-policy=no-user-gesture-required",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const page = (await browser.pages())[0] || (await browser.newPage());
  const srtCues = parseSRT(fs.readFileSync(SRT_PATH, "utf-8"));

  try {
    console.log("[DRIFT] Navigating...");
    await page.goto(HD_SERIES_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(3000);
    if (page.url().includes("/profiles")) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("a, button, div")) {
          if (el.textContent?.trim().startsWith("Федор") || el.textContent?.trim().startsWith("Фёдор")) {
            el.click(); return;
          }
        }
      });
      await sleep(5000);
      if (!page.url().includes("f3208a5ddeb348bab3f41926c34c8912")) {
        await page.goto(HD_SERIES_URL, { waitUntil: "networkidle2", timeout: 30000 });
        await sleep(3000);
      }
    }

    await page.evaluate(() => {
      document.querySelector('[class*="CardPlay"]')?.click();
    });
    await sleep(5000);
    await page.waitForSelector("video", { timeout: 20000 });
    console.log("[DRIFT] Video found.");

    // Enable Russian subtitle track and wait for cues to load
    console.log("[DRIFT] Enabling Russian subtitle track...");
    await page.evaluate(() => {
      const v = document.querySelector("video");
      for (let i = 0; i < v.textTracks.length; i++) {
        if (v.textTracks[i].language === "rus") {
          v.textTracks[i].mode = "showing";
        }
      }
    });

    // Play for a bit to let cues load
    await page.evaluate(() => { document.querySelector("video")?.play().catch(() => {}); });
    await sleep(3000);
    await page.evaluate(() => { document.querySelector("video")?.pause(); });

    // Collect Russian track cues
    console.log("[DRIFT] Collecting Russian cues...");

    // Kinopoisk loads cues lazily, need to seek through the video to populate them
    const seekPoints = [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3300, 3600, 4000, 4500, 5000];
    for (const t of seekPoints) {
      await page.evaluate((sec) => {
        const v = document.querySelector("video");
        if (sec < v.duration) v.currentTime = sec;
      }, t);
      await sleep(1000);
    }

    const rusCues = await page.evaluate(() => {
      const v = document.querySelector("video");
      const cues = [];
      for (let i = 0; i < v.textTracks.length; i++) {
        const t = v.textTracks[i];
        if (t.language === "rus" && t.cues) {
          for (let j = 0; j < t.cues.length; j++) {
            const c = t.cues[j];
            cues.push({ start: c.startTime * 1000, end: c.endTime * 1000, text: c.text?.trim() });
          }
        }
      }
      // Sort by start time
      cues.sort((a, b) => a.start - b.start);
      return cues;
    });

    console.log(`[DRIFT] Got ${rusCues.length} Russian cues from video`);
    console.log(`[DRIFT] Got ${srtCues.length} English SRT cues`);

    if (rusCues.length === 0) {
      console.log("[DRIFT] No Russian cues loaded. Trying alternative: measuring via audio cue matching.");
      // Fall back to just measuring SRT timing vs video duration
      const duration = await page.evaluate(() => document.querySelector("video").duration);
      console.log(`[DRIFT] Video duration: ${duration.toFixed(2)}s`);
      const lastSrtCue = srtCues[srtCues.length - 1];
      console.log(`[DRIFT] Last SRT cue ends at: ${(lastSrtCue.end / 1000).toFixed(2)}s`);
      const ratio = duration / (lastSrtCue.end / 1000);
      console.log(`[DRIFT] Video/SRT duration ratio: ${ratio.toFixed(6)}`);
      console.log(`[DRIFT] If SRT was for exact same content, rate factor = ${ratio.toFixed(6)}`);
    } else {
      // Match Russian and English cues by timing proximity
      // Russian and English dialogue cues should occur at the same video times,
      // so we can align them by their density/pattern
      console.log("\n[DRIFT] === Comparing timing patterns ===");
      console.log("[DRIFT] First 5 Russian cues:");
      rusCues.slice(0, 5).forEach((c, i) =>
        console.log(`  ${i}: ${(c.start/1000).toFixed(2)}s-${(c.end/1000).toFixed(2)}s "${c.text.slice(0, 50)}"`));
      console.log("[DRIFT] First 5 SRT cues:");
      srtCues.slice(0, 5).forEach((c, i) =>
        console.log(`  ${i}: ${(c.start/1000).toFixed(2)}s-${(c.end/1000).toFixed(2)}s "${c.text.slice(0, 50)}"`));

      // Filter out music/sfx cues from SRT (keep dialogue only)
      const srtDialogue = srtCues.filter(c =>
        !c.text.startsWith("[") && !c.text.startsWith("♪"));

      // Compare cue count density in time windows
      // For each 60s window, count the number of cues in both tracks
      // Then find the offset that maximizes correlation
      console.log("\n[DRIFT] === Cross-correlation analysis ===");

      // Build density signals at 1s resolution
      const maxTime = Math.max(
        rusCues[rusCues.length - 1]?.end || 0,
        srtCues[srtCues.length - 1]?.end || 0
      ) / 1000 + 10;

      function buildOnsetSignal(cues, maxT) {
        const signal = new Float64Array(Math.ceil(maxT));
        for (const c of cues) {
          const t = Math.floor(c.start / 1000);
          if (t < signal.length) signal[t] += 1;
        }
        return signal;
      }

      const rusSignal = buildOnsetSignal(rusCues, maxTime);
      const srtSignal = buildOnsetSignal(srtDialogue, maxTime);

      // Cross-correlate with offsets from -60s to +60s
      let bestCorr = -Infinity;
      let bestOffset = 0;
      const corrResults = [];

      for (let offset = -60; offset <= 60; offset++) {
        let corr = 0;
        let n = 0;
        for (let t = 0; t < rusSignal.length; t++) {
          const srtT = t + offset;
          if (srtT >= 0 && srtT < srtSignal.length) {
            corr += rusSignal[t] * srtSignal[srtT];
            n++;
          }
        }
        corrResults.push({ offset, corr });
        if (corr > bestCorr) {
          bestCorr = corr;
          bestOffset = offset;
        }
      }

      console.log(`[DRIFT] Best correlation at offset: ${bestOffset}s (corr=${bestCorr.toFixed(1)})`);
      console.log(`[DRIFT] This means SRT is ${bestOffset > 0 ? "ahead" : "behind"} by ${Math.abs(bestOffset)}s`);

      // Now check for rate drift: split into early/late halves and compare offsets
      const halfTime = maxTime / 2;

      function bestOffsetForRange(startT, endT) {
        let best = -Infinity, bestOff = 0;
        for (let offset = -60; offset <= 60; offset++) {
          let corr = 0;
          for (let t = Math.floor(startT); t < Math.min(Math.ceil(endT), rusSignal.length); t++) {
            const srtT = t + offset;
            if (srtT >= 0 && srtT < srtSignal.length) {
              corr += rusSignal[t] * srtSignal[srtT];
            }
          }
          if (corr > best) { best = corr; bestOff = offset; }
        }
        return bestOff;
      }

      const earlyOffset = bestOffsetForRange(0, halfTime);
      const lateOffset = bestOffsetForRange(halfTime, maxTime);

      console.log(`\n[DRIFT] Early half (0-${Math.round(halfTime)}s) best offset: ${earlyOffset}s`);
      console.log(`[DRIFT] Late half (${Math.round(halfTime)}-${Math.round(maxTime)}s) best offset: ${lateOffset}s`);

      const driftPerSec = (lateOffset - earlyOffset) / halfTime;
      console.log(`[DRIFT] Drift rate: ${(driftPerSec * 1000).toFixed(2)} ms/s = ${(driftPerSec * 60000).toFixed(1)} ms/min`);

      if (Math.abs(lateOffset - earlyOffset) >= 2) {
        const rateFactor = 1 / (1 + driftPerSec);
        console.log(`\n[DRIFT] DRIFT DETECTED!`);
        console.log(`[DRIFT] Required rate factor: ${rateFactor.toFixed(6)}`);
        console.log(`[DRIFT] Required constant offset: ${earlyOffset}s`);

        const fps2523 = 23.976 / 25;
        const fps2325 = 25 / 23.976;
        if (Math.abs(rateFactor - fps2523) < 0.005) {
          console.log(`[DRIFT] Cause: SRT is for 25fps source, video is 23.976fps`);
        } else if (Math.abs(rateFactor - fps2325) < 0.005) {
          console.log(`[DRIFT] Cause: SRT is for 23.976fps source, video is 25fps`);
        }
      } else {
        console.log(`\n[DRIFT] No significant drift. Constant offset of ${bestOffset}s should suffice.`);
      }

      // Also try finer-grained: split into quarters
      console.log("\n[DRIFT] Quarter analysis:");
      const q = maxTime / 4;
      for (let i = 0; i < 4; i++) {
        const off = bestOffsetForRange(q * i, q * (i + 1));
        console.log(`  Q${i+1} (${Math.round(q*i)}-${Math.round(q*(i+1))}s): offset=${off}s`);
      }
    }

  } catch (err) {
    console.error("[DRIFT] Error:", err.message, err.stack);
  }

  await browser.close();
  fs.rmSync(tmpProfile, { recursive: true, force: true });
  console.log("\n[DRIFT] Done.");
})();
