(function () {
  "use strict";

  const statusEl = document.getElementById("status");
  const filenameEl = document.getElementById("filename");
  const fileInput = document.getElementById("fileInput");
  const fileDrop = document.getElementById("fileDrop");
  const encodingSelect = document.getElementById("encoding");
  const syncValue = document.getElementById("syncValue");
  const rateValue = document.getElementById("rateValue");
  const fontSizeSelect = document.getElementById("fontSize");

  let bgEnabled = true;

  // Calibration state: { videoMs, srtMs, cueIndex }
  let calA = null;
  let calB = null;

  function sendMsg(msg) {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs[0]) {
          resolve(null);
          return;
        }
        chrome.tabs.sendMessage(tabs[0].id, msg, resolve);
      });
    });
  }

  function setStatus(text, type) {
    statusEl.textContent = text;
    statusEl.className = "status " + type;
  }

  function fmtMs(ms) {
    const s = Math.abs(ms) / 1000;
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(1);
    return (ms < 0 ? "-" : "") + m + ":" + sec.padStart(4, "0");
  }

  function updateSyncDisplay(status) {
    if (!status) return;
    syncValue.value = (status.offset / 1000).toFixed(1) + "s";
    rateValue.value = status.rate.toFixed(6);
  }

  // --- Init ---

  async function checkStatus() {
    const resp = await sendMsg({ action: "get_status" });
    if (!resp) {
      setStatus("Not on Kinopoisk HD page", "err");
      return;
    }
    if (!resp.videoFound) {
      setStatus("No video detected yet", "warn");
      return;
    }
    if (resp.subtitleCount > 0) {
      setStatus(resp.subtitleCount + " cues loaded", "ok");
    } else {
      setStatus("Video found — load an SRT file", "ok");
    }
    updateSyncDisplay(resp);

    chrome.storage.local.get(["kso_filename"], (result) => {
      if (result.kso_filename) {
        filenameEl.textContent = result.kso_filename;
      }
    });
  }

  checkStatus();

  // --- File loading ---

  function loadFile(file) {
    if (!file) return;
    const encoding = encodingSelect.value;
    const reader = new FileReader();

    reader.onload = async (e) => {
      const resp = await sendMsg({
        action: "load_srt",
        data: e.target.result,
        filename: file.name,
      });

      if (resp && resp.ok) {
        setStatus(resp.count + " cues loaded", "ok");
        filenameEl.textContent = file.name;
        calA = null;
        calB = null;
        updateCalUI();
      } else {
        setStatus("Failed to load — is the page open?", "err");
      }
    };

    reader.readAsText(file, encoding);
  }

  fileInput.addEventListener("change", (e) => loadFile(e.target.files[0]));
  fileDrop.addEventListener("click", () => fileInput.click());

  fileDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    fileDrop.classList.add("dragover");
  });
  fileDrop.addEventListener("dragleave", () => fileDrop.classList.remove("dragover"));
  fileDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    fileDrop.classList.remove("dragover");
    if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });

  // --- Sync controls ---

  async function adjustSync(deltaMs) {
    const resp = await sendMsg({ action: "sync_offset", delta: deltaMs });
    updateSyncDisplay(resp);
  }

  function parseSyncInput(raw) {
    const s = raw.trim().toLowerCase();
    if (s.endsWith("ms")) return Math.round(parseFloat(s)) || null;
    const n = parseFloat(s);
    return isNaN(n) ? null : Math.round(n * 1000);
  }

  function commitSyncInput() {
    const ms = parseSyncInput(syncValue.value);
    if (ms !== null) {
      sendMsg({ action: "set_sync", offset: ms }).then(updateSyncDisplay);
    } else {
      sendMsg({ action: "get_status" }).then(updateSyncDisplay);
    }
  }

  syncValue.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitSyncInput(); syncValue.blur(); }
  });
  syncValue.addEventListener("blur", commitSyncInput);
  syncValue.addEventListener("focus", () => syncValue.select());

  document.getElementById("syncBack1s").addEventListener("click", () => adjustSync(-1000));
  document.getElementById("syncBack").addEventListener("click", () => adjustSync(-500));
  document.getElementById("syncFwd").addEventListener("click", () => adjustSync(500));
  document.getElementById("syncFwd1s").addEventListener("click", () => adjustSync(1000));

  // --- Rate ---

  function commitRate() {
    const r = parseFloat(rateValue.value);
    if (!isNaN(r) && r > 0 && r < 10) {
      sendMsg({ action: "set_rate", rate: r }).then(updateSyncDisplay);
    } else {
      sendMsg({ action: "get_status" }).then(updateSyncDisplay);
    }
  }

  rateValue.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); commitRate(); rateValue.blur(); }
  });
  rateValue.addEventListener("blur", commitRate);
  rateValue.addEventListener("focus", () => rateValue.select());

  document.querySelectorAll(".rate-presets button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const r = parseFloat(btn.dataset.rate);
      rateValue.value = r.toFixed(6);
      sendMsg({ action: "set_rate", rate: r }).then(updateSyncDisplay);
    });
  });

  // --- Calibration ---

  const calATime = document.getElementById("calATime");
  const calBTime = document.getElementById("calBTime");
  const calACue = document.getElementById("calACue");
  const calBCue = document.getElementById("calBCue");

  function updateCalUI() {
    if (calA) {
      calATime.textContent = fmtMs(calA.videoMs);
      calACue.textContent = calA.cueText || "";
    } else {
      calATime.textContent = "—";
      calACue.textContent = "";
    }
    if (calB) {
      calBTime.textContent = fmtMs(calB.videoMs);
      calBCue.textContent = calB.cueText || "";
    } else {
      calBTime.textContent = "—";
      calBCue.textContent = "";
    }
  }

  async function markPoint(target) {
    const status = await sendMsg({ action: "get_status" });
    if (!status || !status.videoFound) return;

    const nearby = await sendMsg({ action: "get_nearby_cues" });
    if (!nearby || !nearby.cues.length) return;

    // Pick the first nearby cue (closest to current mapped time)
    const cue = nearby.cues[0];
    const point = {
      videoMs: status.videoTime,
      srtMs: (cue.start + cue.end) / 2,
      cueIndex: cue.index,
      cueText: cue.text,
      nearbyCues: nearby.cues,
      selectedIdx: 0,
    };

    if (target === "A") calA = point;
    else calB = point;
    updateCalUI();
  }

  function nudgePoint(target, dir) {
    const point = target === "A" ? calA : calB;
    if (!point || !point.nearbyCues) return;

    const newIdx = point.selectedIdx + dir;
    if (newIdx < 0 || newIdx >= point.nearbyCues.length) return;

    point.selectedIdx = newIdx;
    const cue = point.nearbyCues[newIdx];
    point.srtMs = (cue.start + cue.end) / 2;
    point.cueIndex = cue.index;
    point.cueText = cue.text;
    updateCalUI();
  }

  document.getElementById("calABtn").addEventListener("click", () => markPoint("A"));
  document.getElementById("calBBtn").addEventListener("click", () => markPoint("B"));

  document.querySelectorAll(".cal-nudge").forEach((btn) => {
    btn.addEventListener("click", () => {
      nudgePoint(btn.dataset.point, parseInt(btn.dataset.dir));
    });
  });

  document.getElementById("calApply").addEventListener("click", async () => {
    if (!calA) return;

    const msg = { action: "calibrate", pointA: { videoMs: calA.videoMs, srtMs: calA.srtMs } };
    if (calB) {
      msg.pointB = { videoMs: calB.videoMs, srtMs: calB.srtMs };
    }

    const resp = await sendMsg(msg);
    updateSyncDisplay(resp);
    setStatus("Calibration applied", "ok");
  });

  // --- Font size ---

  fontSizeSelect.addEventListener("change", () => {
    sendMsg({ action: "set_font_size", size: fontSizeSelect.value });
  });

  // --- Toggle background ---

  document.getElementById("toggleBg").addEventListener("click", () => {
    bgEnabled = !bgEnabled;
    sendMsg({ action: "set_bg", enabled: bgEnabled });
  });

  // --- Clear ---

  document.getElementById("clearSubs").addEventListener("click", async () => {
    await sendMsg({ action: "clear_subs" });
    setStatus("Subtitles cleared", "warn");
    filenameEl.textContent = "";
    syncValue.value = "0.0s";
    rateValue.value = "1.000000";
    calA = null;
    calB = null;
    updateCalUI();
  });
})();
