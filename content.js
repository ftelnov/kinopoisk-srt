(function () {
  "use strict";

  let video = null;
  let overlay = null;
  let textEl = null;
  let subtitles = [];
  let syncOffsetMs = 0;
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

    // Find the best container: Kinopoisk player wrapper or video parent
    const container =
      video.closest('[data-tid="ContentPlayerBody"]') ||
      video.closest('[class*="PlayerSkin_layout"]') ||
      video.closest('[class*="PlayerManager_player"]') ||
      video.parentElement;

    if (!container) return;

    // Ensure container is positioned
    const pos = getComputedStyle(container).position;
    if (pos === "static" || pos === "") {
      container.style.position = "relative";
    }

    if (!container.contains(overlay)) {
      container.appendChild(overlay);
    }
  }

  // --- Subtitle display loop ---

  function onTimeUpdate() {
    if (!video || subtitles.length === 0) return;

    const currentMs = video.currentTime * 1000 + syncOffsetMs;

    // Binary search for current subtitle
    const idx = findCueAt(currentMs);

    if (idx === lastDisplayedIndex) return;
    lastDisplayedIndex = idx;

    if (idx !== -1) {
      // Replace \n with <br> but keep a space so textContent doesn't merge words
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

  // --- Video detection ---

  function findVideo() {
    video = document.querySelector("video");
    if (video) {
      clearInterval(pollTimer);
      pollTimer = null;
      video.addEventListener("timeupdate", onTimeUpdate);
      video.addEventListener("seeking", () => {
        // Clear immediately so stale text doesn't linger during seek
        lastDisplayedIndex = -2; // sentinel: force update on next timeupdate
        if (textEl) textEl.innerHTML = "";
      });
      video.addEventListener("seeked", onTimeUpdate);
      attachOverlay();

      // Re-attach on fullscreen changes
      document.addEventListener("fullscreenchange", () => {
        setTimeout(attachOverlay, 300);
      });

      // Watch for video element replacement (Kinopoisk SPA navigation)
      const observer = new MutationObserver(() => {
        const newVideo = document.querySelector("video");
        if (newVideo && newVideo !== video) {
          video.removeEventListener("timeupdate", onTimeUpdate);
          video = newVideo;
          video.addEventListener("timeupdate", onTimeUpdate);
          video.addEventListener("seeking", () => {
            lastDisplayedIndex = -2;
            if (textEl) textEl.innerHTML = "";
          });
          video.addEventListener("seeked", onTimeUpdate);
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

        // Save to storage for auto-restore
        chrome.storage.local.set({
          kso_srt: msg.data,
          kso_filename: msg.filename,
        });

        sendResponse({
          ok: true,
          count: subtitles.length,
        });
        break;
      }

      case "sync_offset": {
        syncOffsetMs += msg.delta;
        lastDisplayedIndex = -2;
        onTimeUpdate();
        sendResponse({ offset: syncOffsetMs });
        break;
      }

      case "set_sync": {
        syncOffsetMs = msg.offset;
        lastDisplayedIndex = -2;
        onTimeUpdate();
        sendResponse({ offset: syncOffsetMs });
        break;
      }

      case "reset_sync": {
        syncOffsetMs = 0;
        lastDisplayedIndex = -1;
        sendResponse({ offset: 0 });
        break;
      }

      case "get_status": {
        sendResponse({
          videoFound: !!video,
          subtitleCount: subtitles.length,
          offset: syncOffsetMs,
        });
        break;
      }

      case "clear_subs": {
        subtitles = [];
        lastDisplayedIndex = -1;
        syncOffsetMs = 0;
        if (textEl) textEl.innerHTML = "";
        chrome.storage.local.remove(["kso_srt", "kso_filename"]);
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
    return true; // async sendResponse
  });

  // --- Window event listener (for external injection, e.g. Puppeteer tests) ---

  window.addEventListener("kso-load-srt", (e) => {
    const { data, filename } = e.detail || {};
    if (!data) return;
    subtitles = parseSRT(data);
    lastDisplayedIndex = -1;
    syncOffsetMs = 0;
    chrome.storage.local.set({ kso_srt: data, kso_filename: filename });
    console.log("[KSO] Loaded", subtitles.length, "cues via window event");
    window.dispatchEvent(
      new CustomEvent("kso-srt-loaded", { detail: { count: subtitles.length } })
    );
  });

  // --- Init ---

  function init() {
    createOverlay();

    // Auto-restore saved subtitles
    chrome.storage.local.get(["kso_srt"], (result) => {
      if (result.kso_srt) {
        subtitles = parseSRT(result.kso_srt);
        console.log("[KSO] Restored", subtitles.length, "subtitles from storage");
      }
    });

    // Start polling for video
    findVideo();
    if (!video) {
      pollTimer = setInterval(findVideo, 500);
    }
  }

  // Kinopoisk is an SPA — watch for navigation
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // Re-find video after SPA navigation
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
