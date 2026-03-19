(function () {
  "use strict";

  let video = null;
  let overlay = null;
  let textEl = null;
  let subtitles = [];
  let syncOffsetMs = 0;
  let syncRate = 1.0; // multiplier: srtTime = videoTime * syncRate + syncOffsetMs
  let lastDisplayedIndex = -1;
  let pollTimer = null;

  // --- SRT Parser ---

  function parseSRT(text) {
    const cues = [];
    const blocks = text.replace(/\r\n/g, "\n").trim().split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.split("\n");
      let timeLine = -1;

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes("-->")) {
          timeLine = i;
          break;
        }
      }
      if (timeLine === -1) continue;

      const match = lines[timeLine].match(
        /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
      );
      if (!match) continue;

      const start = tsToMs(match[1], match[2], match[3], match[4]);
      const end = tsToMs(match[5], match[6], match[7], match[8]);
      const textLines = lines.slice(timeLine + 1).join("\n").trim();

      if (textLines) {
        cues.push({ start, end, text: textLines });
      }
    }

    return cues;
  }

  function tsToMs(h, m, s, ms) {
    return (+h * 3600 + +m * 60 + +s) * 1000 + +ms;
  }

  // --- Overlay creation ---

  function createOverlay() {
    if (overlay) return;

    overlay = document.createElement("div");
    overlay.className = "kso-subtitle-overlay";

    textEl = document.createElement("span");
    textEl.className = "kso-subtitle-text";
    overlay.appendChild(textEl);

    // Make vertically draggable
    const handle = document.createElement("div");
    handle.className = "kso-drag-handle";
    overlay.appendChild(handle);

    let dragging = false;
    let startY = 0;
    let startBottom = 0;

    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      startY = e.clientY;
      startBottom = parseInt(getComputedStyle(overlay).bottom, 10) || 60;
      e.preventDefault();
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const delta = startY - e.clientY;
      overlay.style.bottom = Math.max(10, startBottom + delta) + "px";
    });

    document.addEventListener("mouseup", () => {
      dragging = false;
    });
  }

  function attachOverlay() {
    if (!video || !overlay) return;

    const container =
      video.closest('[data-tid="ContentPlayerBody"]') ||
      video.closest('[class*="PlayerSkin_layout"]') ||
      video.closest('[class*="PlayerManager_player"]') ||
      video.parentElement;

    if (!container) return;

    const pos = getComputedStyle(container).position;
    if (pos === "static" || pos === "") {
      container.style.position = "relative";
    }

    if (!container.contains(overlay)) {
      container.appendChild(overlay);
    }
  }

  // --- Core: map video time to SRT time ---

  function videoToSrtMs(videoMs) {
    return videoMs * syncRate + syncOffsetMs;
  }

  // --- Subtitle display loop ---

  function onTimeUpdate() {
    if (!video || subtitles.length === 0) return;

    const srtMs = videoToSrtMs(video.currentTime * 1000);

    const idx = findCueAt(srtMs);

    if (idx === lastDisplayedIndex) return;
    lastDisplayedIndex = idx;

    if (idx !== -1) {
      textEl.innerHTML = escapeHTML(subtitles[idx].text).replace(/\n/g, " <br>");
    } else {
      textEl.innerHTML = "";
    }
  }

  function findCueAt(ms) {
    let lo = 0;
    let hi = subtitles.length - 1;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ms < subtitles[mid].start) {
        hi = mid - 1;
      } else if (ms > subtitles[mid].end) {
        lo = mid + 1;
      } else {
        return mid;
      }
    }
    return -1;
  }

  function escapeHTML(str) {
    const el = document.createElement("span");
    el.textContent = str;
    return el.innerHTML;
  }

  // --- Sync helpers ---

  function persistSync() {
    chrome.storage.local.set({ kso_offset: syncOffsetMs, kso_rate: syncRate });
  }

  function getFullStatus() {
    return {
      videoFound: !!video,
      subtitleCount: subtitles.length,
      offset: syncOffsetMs,
      rate: syncRate,
      videoTime: video ? video.currentTime * 1000 : 0,
    };
  }

  // --- Video detection ---

  function bindVideo(v) {
    v.addEventListener("timeupdate", onTimeUpdate);
    v.addEventListener("seeking", () => {
      lastDisplayedIndex = -2;
      if (textEl) textEl.innerHTML = "";
    });
    v.addEventListener("seeked", onTimeUpdate);
  }

  function findVideo() {
    video = document.querySelector("video");
    if (video) {
      clearInterval(pollTimer);
      pollTimer = null;
      bindVideo(video);
      attachOverlay();

      document.addEventListener("fullscreenchange", () => {
        setTimeout(attachOverlay, 300);
      });

      const observer = new MutationObserver(() => {
        const newVideo = document.querySelector("video");
        if (newVideo && newVideo !== video) {
          video.removeEventListener("timeupdate", onTimeUpdate);
          video = newVideo;
          bindVideo(video);
          lastDisplayedIndex = -2;
          attachOverlay();
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });

      console.log("[KSO] Video found, subtitle overlay ready");
      return;
    }
  }

  // --- Message handling from popup ---

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg.action) {
      case "load_srt": {
        subtitles = parseSRT(msg.data);
        lastDisplayedIndex = -1;
        syncOffsetMs = 0;
        syncRate = 1.0;

        chrome.storage.local.set({
          kso_srt: msg.data,
          kso_filename: msg.filename,
        });
        persistSync();

        sendResponse({ ok: true, count: subtitles.length });
        break;
      }

      case "sync_offset": {
        syncOffsetMs += msg.delta;
        lastDisplayedIndex = -2;
        persistSync();
        onTimeUpdate();
        sendResponse(getFullStatus());
        break;
      }

      case "set_sync": {
        syncOffsetMs = msg.offset;
        lastDisplayedIndex = -2;
        persistSync();
        onTimeUpdate();
        sendResponse(getFullStatus());
        break;
      }

      case "set_rate": {
        syncRate = msg.rate;
        lastDisplayedIndex = -2;
        persistSync();
        onTimeUpdate();
        sendResponse(getFullStatus());
        break;
      }

      // Two-point calibration: user provides two (videoTimeMs, srtTimeMs) pairs
      // We solve: srtTime = videoTime * rate + offset
      case "calibrate": {
        const { pointA, pointB } = msg;
        // pointA/B: { videoMs, srtMs }
        if (pointA && pointB && pointA.videoMs !== pointB.videoMs) {
          syncRate =
            (pointB.srtMs - pointA.srtMs) / (pointB.videoMs - pointA.videoMs);
          syncOffsetMs = pointA.srtMs - pointA.videoMs * syncRate;
        } else if (pointA) {
          // Single point: keep current rate, adjust offset
          syncOffsetMs = pointA.srtMs - pointA.videoMs * syncRate;
        }
        lastDisplayedIndex = -2;
        persistSync();
        onTimeUpdate();
        sendResponse(getFullStatus());
        break;
      }

      case "get_status": {
        sendResponse(getFullStatus());
        break;
      }

      // Get the SRT cue nearest to the current mapped time (for calibration UI)
      case "get_nearby_cues": {
        const srtMs = videoToSrtMs(video ? video.currentTime * 1000 : 0);
        const nearby = [];
        for (let i = 0; i < subtitles.length; i++) {
          const dist = Math.abs((subtitles[i].start + subtitles[i].end) / 2 - srtMs);
          if (dist < 30000) {
            nearby.push({
              index: i,
              start: subtitles[i].start,
              end: subtitles[i].end,
              text: subtitles[i].text.slice(0, 80),
            });
          }
        }
        nearby.sort((a, b) => Math.abs((a.start + a.end) / 2 - srtMs) - Math.abs((b.start + b.end) / 2 - srtMs));
        sendResponse({ cues: nearby.slice(0, 10), currentSrtMs: srtMs });
        break;
      }

      case "clear_subs": {
        subtitles = [];
        lastDisplayedIndex = -1;
        syncOffsetMs = 0;
        syncRate = 1.0;
        if (textEl) textEl.innerHTML = "";
        chrome.storage.local.remove(["kso_srt", "kso_filename", "kso_offset", "kso_rate"]);
        sendResponse({ ok: true });
        break;
      }

      case "set_font_size": {
        if (textEl) textEl.style.fontSize = msg.size;
        sendResponse({ ok: true });
        break;
      }

      case "set_bg": {
        if (textEl) {
          textEl.style.background = msg.enabled
            ? "rgba(0,0,0,0.5)"
            : "transparent";
        }
        sendResponse({ ok: true });
        break;
      }
    }
    return true;
  });

  // --- Window event listeners (for external control / Puppeteer tests) ---

  window.addEventListener("kso-load-srt", (e) => {
    const { data, filename } = e.detail || {};
    if (!data) return;
    subtitles = parseSRT(data);
    lastDisplayedIndex = -1;
    syncOffsetMs = 0;
    syncRate = 1.0;
    chrome.storage.local.set({ kso_srt: data, kso_filename: filename });
    persistSync();
    console.log("[KSO] Loaded", subtitles.length, "cues via window event");
    window.dispatchEvent(
      new CustomEvent("kso-srt-loaded", { detail: { count: subtitles.length } })
    );
  });

  window.addEventListener("kso-set-sync", (e) => {
    const { offset, rate } = e.detail || {};
    if (typeof offset === "number") syncOffsetMs = offset;
    if (typeof rate === "number") syncRate = rate;
    lastDisplayedIndex = -2;
    persistSync();
    onTimeUpdate();
    window.dispatchEvent(new CustomEvent("kso-sync-updated", { detail: getFullStatus() }));
  });

  window.addEventListener("kso-calibrate", (e) => {
    const { pointA, pointB } = e.detail || {};
    if (pointA && pointB && pointA.videoMs !== pointB.videoMs) {
      syncRate = (pointB.srtMs - pointA.srtMs) / (pointB.videoMs - pointA.videoMs);
      syncOffsetMs = pointA.srtMs - pointA.videoMs * syncRate;
    } else if (pointA) {
      syncOffsetMs = pointA.srtMs - pointA.videoMs * syncRate;
    }
    lastDisplayedIndex = -2;
    persistSync();
    onTimeUpdate();
    window.dispatchEvent(new CustomEvent("kso-sync-updated", { detail: getFullStatus() }));
  });

  // --- Init ---

  function init() {
    createOverlay();

    // Restore saved state
    chrome.storage.local.get(["kso_srt", "kso_offset", "kso_rate"], (result) => {
      if (result.kso_srt) {
        subtitles = parseSRT(result.kso_srt);
        console.log("[KSO] Restored", subtitles.length, "subtitles");
      }
      if (typeof result.kso_offset === "number") syncOffsetMs = result.kso_offset;
      if (typeof result.kso_rate === "number") syncRate = result.kso_rate;
    });

    findVideo();
    if (!video) {
      pollTimer = setInterval(findVideo, 500);
    }
  }

  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (!pollTimer) {
        video = null;
        pollTimer = setInterval(findVideo, 500);
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
