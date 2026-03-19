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

async function screenshot(page, name) {
  const p = path.join(__dirname, `test-screenshot-${name}.png`);
  await page.screenshot({ path: p, fullPage: false });
  console.log(`[SCREENSHOT] ${name}`);
}

// Parse SRT to get ground truth cues for verification
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
    const text2 = lines.slice(timeLine + 1).join("\n").trim();
    if (text2) cues.push({ start, end, text: text2 });
  }
  return cues;
}

function findCueAt(cues, ms) {
  for (const c of cues) {
    if (ms >= c.start && ms <= c.end) return c;
  }
  return null;
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

(async () => {
  // Prepare temp profile
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

  try {
    // Navigate & handle profile selection
    console.log("[TEST] Navigating to series...");
    await page.goto(HD_SERIES_URL, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(3000);

    if (page.url().includes("/profiles")) {
      console.log("[TEST] Selecting profile...");
      await page.evaluate(() => {
        for (const el of document.querySelectorAll("a, button, [role='button'], div")) {
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

    // Click first episode
    console.log("[TEST] Clicking first episode...");
    await page.evaluate(() => {
      const btn = document.querySelector('[class*="CardPlay"]');
      if (btn) btn.click();
    });
    await sleep(5000);

    // Wait for video
    await page.waitForSelector("video", { timeout: 20000 });
    console.log("[TEST] Video found! Loading SRT...");

    // Inject SRT
    const srtContent = fs.readFileSync(SRT_PATH, "utf-8");
    const groundTruth = parseSRT(srtContent);
    console.log(`[TEST] Ground truth: ${groundTruth.length} cues`);

    await sleep(2000);
    const loadResult = await page.evaluate((srt) => {
      return new Promise((resolve) => {
        const handler = (e) => { window.removeEventListener("kso-srt-loaded", handler); resolve(e.detail); };
        window.addEventListener("kso-srt-loaded", handler);
        setTimeout(() => resolve({ timeout: true }), 5000);
        window.dispatchEvent(new CustomEvent("kso-load-srt", {
          detail: { data: srt, filename: "Anne.S01E01.srt" },
        }));
      });
    }, srtContent);
    console.log("[TEST] SRT loaded:", JSON.stringify(loadResult));

    // Unpause video
    await page.evaluate(() => { document.querySelector("video")?.play().catch(() => {}); });
    await sleep(1000);

    // ============================================================
    // TEST 1: Forward linear playback — sample every 5s for 3 minutes
    // ============================================================
    console.log("\n[TEST] === TEST 1: Forward playback 0:00 → 3:00 (sample every 5s) ===");
    let passed = 0, failed = 0, checked = 0;

    for (let t = 0; t <= 180; t += 5) {
      const timeMs = t * 1000;
      await page.evaluate((sec) => { document.querySelector("video").currentTime = sec; }, t);
      await sleep(400);
      await page.evaluate(() => { document.querySelector("video")?.dispatchEvent(new Event("timeupdate")); });
      await sleep(200);

      const displayed = await page.evaluate(() =>
        document.querySelector(".kso-subtitle-text")?.textContent?.trim() || ""
      );

      const expected = findCueAt(groundTruth, timeMs);
      const expectedText = expected ? expected.text.replace(/\n/g, " ") : "";

      // Normalize for comparison: strip tags, brackets for music cues, whitespace
      const norm = (s) => s.replace(/<br\/?>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      const dispNorm = norm(displayed);
      const expNorm = norm(expectedText);

      let ok;
      if (!expected && displayed === "") {
        ok = true; // Both empty — correct gap
      } else if (expected && dispNorm && expNorm.includes(dispNorm.slice(0, 20))) {
        ok = true;
      } else if (expected && displayed && norm(displayed) === norm(expectedText)) {
        ok = true;
      } else if (!expected && displayed === "") {
        ok = true;
      } else {
        ok = false;
      }

      checked++;
      if (ok) {
        passed++;
      } else {
        failed++;
        const tag = expected ? `"${expectedText.slice(0, 50)}"` : "(gap)";
        console.log(`  FAIL @${formatTime(timeMs)}: expected ${tag}, got "${displayed.slice(0, 50)}"`);
      }
    }
    console.log(`[TEST] Forward: ${passed}/${checked} passed, ${failed} failed`);
    await screenshot(page, "01-forward-3min");

    // ============================================================
    // TEST 2: Seek backwards — jump back to earlier timestamps
    // ============================================================
    console.log("\n[TEST] === TEST 2: Seek backward (3:00 → 1:00 → 0:10 → 2:30) ===");
    const backSeeks = [60, 10, 150, 45, 120, 5, 90, 30, 175, 2];
    let bPassed = 0, bFailed = 0;

    for (const t of backSeeks) {
      const timeMs = t * 1000;
      await page.evaluate((sec) => { document.querySelector("video").currentTime = sec; }, t);
      await sleep(500);
      await page.evaluate(() => { document.querySelector("video")?.dispatchEvent(new Event("timeupdate")); });
      await sleep(300);

      const displayed = await page.evaluate(() =>
        document.querySelector(".kso-subtitle-text")?.textContent?.trim() || ""
      );
      const expected = findCueAt(groundTruth, timeMs);
      const expectedText = expected ? expected.text.replace(/\n/g, " ") : "";

      const norm = (s) => s.replace(/<br\/?>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      let ok;
      if (!expected && displayed === "") {
        ok = true;
      } else if (expected && displayed && norm(displayed) === norm(expectedText)) {
        ok = true;
      } else {
        ok = false;
      }

      const tag = expected ? `"${expectedText.slice(0, 50)}"` : "(gap)";
      if (ok) {
        bPassed++;
        console.log(`  PASS @${formatTime(timeMs)}: ${tag}`);
      } else {
        bFailed++;
        console.log(`  FAIL @${formatTime(timeMs)}: expected ${tag}, got "${displayed.slice(0, 50)}"`);
      }
    }
    console.log(`[TEST] Backward seeks: ${bPassed}/${backSeeks.length} passed, ${bFailed} failed`);
    await screenshot(page, "02-backward-seeks");

    // ============================================================
    // TEST 3: Rapid scrubbing — quick back-and-forth
    // ============================================================
    console.log("\n[TEST] === TEST 3: Rapid scrubbing ===");
    const scrubSequence = [10, 120, 15, 160, 5, 90, 170, 3, 45, 130, 25, 100, 0, 175, 50, 80, 140, 20, 110, 60];
    let sPassed = 0, sFailed = 0;

    for (const t of scrubSequence) {
      const timeMs = t * 1000;
      await page.evaluate((sec) => { document.querySelector("video").currentTime = sec; }, t);
      // Shorter wait to simulate rapid scrubbing
      await sleep(300);
      await page.evaluate(() => { document.querySelector("video")?.dispatchEvent(new Event("timeupdate")); });
      await sleep(200);

      const displayed = await page.evaluate(() =>
        document.querySelector(".kso-subtitle-text")?.textContent?.trim() || ""
      );
      const expected = findCueAt(groundTruth, timeMs);
      const expectedText = expected ? expected.text.replace(/\n/g, " ") : "";

      const norm = (s) => s.replace(/<br\/?>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      let ok;
      if (!expected && displayed === "") {
        ok = true;
      } else if (expected && displayed && norm(displayed) === norm(expectedText)) {
        ok = true;
      } else {
        ok = false;
      }

      if (ok) { sPassed++; } else {
        sFailed++;
        const tag = expected ? `"${expectedText.slice(0, 50)}"` : "(gap)";
        console.log(`  FAIL @${formatTime(timeMs)}: expected ${tag}, got "${displayed.slice(0, 50)}"`);
      }
    }
    console.log(`[TEST] Rapid scrub: ${sPassed}/${scrubSequence.length} passed, ${sFailed} failed`);
    await screenshot(page, "03-rapid-scrub");

    // ============================================================
    // TEST 4: Watch continuously for 30s at different points, verify real-time sync
    // ============================================================
    console.log("\n[TEST] === TEST 4: Continuous playback verification (30s segments) ===");
    const segments = [
      { start: 0, label: "opening" },
      { start: 120, label: "2min-mark" },
      { start: 300, label: "5min-mark" },
      { start: 600, label: "10min-mark" },
    ];

    let cPassed = 0, cFailed = 0, cChecked = 0;

    for (const seg of segments) {
      console.log(`  Watching segment: ${seg.label} (${formatTime(seg.start * 1000)})...`);
      await page.evaluate((sec) => {
        const v = document.querySelector("video");
        v.currentTime = sec;
        v.play().catch(() => {});
      }, seg.start);
      await sleep(1000);

      // Sample every 2s for 30s
      for (let offset = 0; offset < 30; offset += 2) {
        await sleep(2000);

        const { displayed, videoTime } = await page.evaluate(() => {
          const v = document.querySelector("video");
          return {
            displayed: document.querySelector(".kso-subtitle-text")?.textContent?.trim() || "",
            videoTime: v ? v.currentTime * 1000 : 0,
          };
        });

        const expected = findCueAt(groundTruth, videoTime);
        const expectedText = expected ? expected.text.replace(/\n/g, " ") : "";

        const norm = (s) => s.replace(/<br\/?>/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
        let ok;
        if (!expected && displayed === "") {
          ok = true;
        } else if (expected && displayed && norm(displayed) === norm(expectedText)) {
          ok = true;
        } else {
          ok = false;
        }

        cChecked++;
        if (ok) { cPassed++; } else {
          cFailed++;
          const tag = expected ? `"${expectedText.slice(0, 50)}"` : "(gap)";
          console.log(`    FAIL @${formatTime(videoTime)}: expected ${tag}, got "${displayed.slice(0, 50)}"`);
        }
      }
    }
    console.log(`[TEST] Continuous: ${cPassed}/${cChecked} passed, ${cFailed} failed`);

    // Pause video
    await page.evaluate(() => { document.querySelector("video")?.pause(); });
    await screenshot(page, "04-continuous-final");

    // ============================================================
    // SUMMARY
    // ============================================================
    const totalPassed = passed + bPassed + sPassed + cPassed;
    const totalChecked = checked + backSeeks.length + scrubSequence.length + cChecked;
    const totalFailed = failed + bFailed + sFailed + cFailed;

    console.log("\n========================================");
    console.log("[TEST] FINAL SUMMARY");
    console.log("========================================");
    console.log(`  Forward playback:   ${passed}/${checked}`);
    console.log(`  Backward seeks:     ${bPassed}/${backSeeks.length}`);
    console.log(`  Rapid scrubbing:    ${sPassed}/${scrubSequence.length}`);
    console.log(`  Continuous play:    ${cPassed}/${cChecked}`);
    console.log(`  ─────────────────────────`);
    console.log(`  TOTAL:              ${totalPassed}/${totalChecked} passed, ${totalFailed} failed`);
    console.log("========================================");

  } catch (err) {
    console.error("[TEST] Error:", err.message, err.stack);
    await screenshot(page, "99-error");
  }

  await browser.close();
  fs.rmSync(tmpProfile, { recursive: true, force: true });
  console.log("[TEST] Done.");
})();
