(function () {
  "use strict";

  const statusEl = document.getElementById("status");
  const filenameEl = document.getElementById("filename");
  const fileInput = document.getElementById("fileInput");
  const fileDrop = document.getElementById("fileDrop");
  const encodingSelect = document.getElementById("encoding");
  const syncValue = document.getElementById("syncValue");
  const fontSizeSelect = document.getElementById("fontSize");

  let bgEnabled = true;

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

  // Check initial status
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
      syncValue.value = (resp.offset / 1000).toFixed(1) + "s";
    } else {
      setStatus("Video found — load an SRT file", "ok");
    }

    // Restore filename
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
      } else {
        setStatus("Failed to load — is the page open?", "err");
      }
    };

    reader.readAsText(file, encoding);
  }

  fileInput.addEventListener("change", (e) => {
    loadFile(e.target.files[0]);
  });

  fileDrop.addEventListener("click", () => fileInput.click());

  fileDrop.addEventListener("dragover", (e) => {
    e.preventDefault();
    fileDrop.classList.add("dragover");
  });

  fileDrop.addEventListener("dragleave", () => {
    fileDrop.classList.remove("dragover");
  });

  fileDrop.addEventListener("drop", (e) => {
    e.preventDefault();
    fileDrop.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  // --- Sync controls ---

  function updateSyncDisplay(offsetMs) {
    syncValue.value = (offsetMs / 1000).toFixed(1) + "s";
  }

  async function adjustSync(deltaMs) {
    const resp = await sendMsg({ action: "sync_offset", delta: deltaMs });
    if (resp) updateSyncDisplay(resp.offset);
  }

  async function setSync(absoluteMs) {
    const resp = await sendMsg({ action: "set_sync", offset: absoluteMs });
    if (resp) updateSyncDisplay(resp.offset);
  }

  // Parse user input like "1.5s", "-2s", "1.5", "-500ms", "0"
  function parseSyncInput(raw) {
    const s = raw.trim().toLowerCase();
    if (s.endsWith("ms")) {
      const n = parseFloat(s);
      return isNaN(n) ? null : Math.round(n);
    }
    const n = parseFloat(s);
    return isNaN(n) ? null : Math.round(n * 1000);
  }

  function commitSyncInput() {
    const ms = parseSyncInput(syncValue.value);
    if (ms !== null) {
      setSync(ms);
    } else {
      // Revert to current value
      sendMsg({ action: "get_status" }).then((resp) => {
        if (resp) updateSyncDisplay(resp.offset);
      });
    }
  }

  syncValue.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitSyncInput();
      syncValue.blur();
    }
  });

  syncValue.addEventListener("blur", commitSyncInput);

  // Select all text on focus for easy replacement
  syncValue.addEventListener("focus", () => syncValue.select());

  document.getElementById("syncBack1s").addEventListener("click", () => adjustSync(-1000));
  document.getElementById("syncBack").addEventListener("click", () => adjustSync(-500));
  document.getElementById("syncFwd").addEventListener("click", () => adjustSync(500));
  document.getElementById("syncFwd1s").addEventListener("click", () => adjustSync(1000));

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
  });
})();
