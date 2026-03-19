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
      syncValue.textContent = (resp.offset / 1000).toFixed(1) + "s";
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

  async function adjustSync(deltaMs) {
    const resp = await sendMsg({ action: "sync_offset", delta: deltaMs });
    if (resp) {
      syncValue.textContent = (resp.offset / 1000).toFixed(1) + "s";
    }
  }

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
    syncValue.textContent = "0.0s";
  });
})();
