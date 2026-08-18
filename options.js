const DEFAULTS = {
  enabled: true,
  dwellTime: 1000,
  showProgress: true,
  minElementSize: 8,
  clickCooldown: 600,
  highlightColor: "#00aaff",
  progressColor: "#00aaff",
  siteFilterMode: "off",
  siteList: [],
  tobiiEnabled: false,
  tobiiWsUrl: "ws://localhost:8887",
  tobiiPreferGaze: true,
  oskEnabled: true
};

const fields = {
  enabled: document.getElementById("enabled"),
  dwellTime: document.getElementById("dwellTime"),
  showProgress: document.getElementById("showProgress"),
  minElementSize: document.getElementById("minElementSize"),
  clickCooldown: document.getElementById("clickCooldown"),
  highlightColor: document.getElementById("highlightColor"),
  highlightColorText: document.getElementById("highlightColorText"),
  progressColor: document.getElementById("progressColor"),
  progressColorText: document.getElementById("progressColorText"),
  siteList: document.getElementById("siteList"),
  siteListWrap: document.getElementById("siteListWrap"),
  tobiiEnabled: document.getElementById("tobiiEnabled"),
  tobiiWsUrl: document.getElementById("tobiiWsUrl"),
  tobiiPreferGaze: document.getElementById("tobiiPreferGaze"),
  oskEnabled: document.getElementById("oskEnabled")
};

const modeRadios = {
  off: document.getElementById("modeOff"),
  blacklist: document.getElementById("modeBlacklist"),
  whitelist: document.getElementById("modeWhitelist")
};

const statusEl = document.getElementById("status");
const tobiiStatusHint = document.getElementById("tobiiStatusHint");

function showStatus(msg) {
  statusEl.textContent = msg;
  setTimeout(() => { statusEl.textContent = ""; }, 2500);
}

function getSelectedMode() {
  if (modeRadios.blacklist.checked) return "blacklist";
  if (modeRadios.whitelist.checked) return "whitelist";
  return "off";
}

function setSelectedMode(mode) {
  const m = mode === "blacklist" || mode === "whitelist" ? mode : "off";
  modeRadios[m].checked = true;
  updateSiteListEnabled();
}

function updateSiteListEnabled() {
  const mode = getSelectedMode();
  fields.siteListWrap.classList.toggle("disabled", mode === "off");
}

function parseSiteList(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line, i, arr) => arr.indexOf(line) === i);
}

function refreshTobiiStatus() {
  chrome.runtime.sendMessage({ type: "getTobiiStatus" }, (res) => {
    if (chrome.runtime.lastError || !res) {
      tobiiStatusHint.textContent = "Status: unavailable (reload extension)";
      return;
    }
    if (!res.enabled) {
      tobiiStatusHint.textContent = "Status: Tobii bridge disabled";
    } else if (res.connected) {
      const g = res.lastGaze;
      if (g && typeof g.x === "number" && typeof g.y === "number") {
        const ageMs = typeof g.t === "number" ? Date.now() - g.t : null;
        const age =
          ageMs == null
            ? ""
            : ageMs < 500
              ? " (gaze streaming)"
              : ` (last gaze ${Math.round(ageMs / 1000)}s ago)`;
        tobiiStatusHint.textContent =
          `Status: connected — gaze (${Math.round(g.x)}, ${Math.round(g.y)})${age}`;
      } else {
        tobiiStatusHint.textContent =
          "Status: connected, but no gaze samples yet — send startGazePoint / check tracker";
      }
    } else {
      tobiiStatusHint.textContent = "Status: connecting / not connected — is the local bridge running?";
    }
  });
}

function load() {
  chrome.storage.sync.get(DEFAULTS, (items) => {
    fields.enabled.checked = items.enabled !== false;
    fields.dwellTime.value = items.dwellTime;
    fields.showProgress.checked = items.showProgress !== false;
    fields.minElementSize.value = items.minElementSize;
    fields.clickCooldown.value = items.clickCooldown;
    fields.highlightColor.value = items.highlightColor;
    fields.highlightColorText.value = items.highlightColor;
    fields.progressColor.value = items.progressColor;
    fields.progressColorText.value = items.progressColor;
    setSelectedMode(items.siteFilterMode || "off");
    const list = Array.isArray(items.siteList) ? items.siteList : [];
    fields.siteList.value = list.join("\n");
    fields.tobiiEnabled.checked = !!items.tobiiEnabled;
    fields.tobiiWsUrl.value = items.tobiiWsUrl || DEFAULTS.tobiiWsUrl;
    fields.tobiiPreferGaze.checked = items.tobiiPreferGaze !== false;
    if (fields.oskEnabled) fields.oskEnabled.checked = items.oskEnabled !== false;
    refreshTobiiStatus();
  });
}

function save() {
  const data = {
    enabled: fields.enabled.checked,
    dwellTime: clamp(Number(fields.dwellTime.value), 300, 5000),
    showProgress: fields.showProgress.checked,
    minElementSize: clamp(Number(fields.minElementSize.value), 0, 50),
    clickCooldown: clamp(Number(fields.clickCooldown.value), 0, 3000),
    highlightColor: normalizeColor(fields.highlightColor.value),
    progressColor: normalizeColor(fields.progressColor.value),
    siteFilterMode: getSelectedMode(),
    siteList: parseSiteList(fields.siteList.value),
    tobiiEnabled: fields.tobiiEnabled.checked,
    tobiiWsUrl: (fields.tobiiWsUrl.value || DEFAULTS.tobiiWsUrl).trim(),
    tobiiPreferGaze: fields.tobiiPreferGaze.checked,
    oskEnabled: fields.oskEnabled ? fields.oskEnabled.checked : true
  };

  chrome.storage.sync.set(data, () => {
    showStatus("Settings saved.");
    setTimeout(refreshTobiiStatus, 400);
  });
}

function reset() {
  chrome.storage.sync.set(DEFAULTS, () => {
    load();
    showStatus("Reset to defaults.");
  });
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, isNaN(n) ? min : n));
}

function normalizeColor(c) {
  if (/^#[0-9a-fA-F]{6}$/.test(c)) return c.toLowerCase();
  return "#00aaff";
}

fields.highlightColor.addEventListener("input", () => {
  fields.highlightColorText.value = fields.highlightColor.value;
});
fields.highlightColorText.addEventListener("change", () => {
  const v = fields.highlightColorText.value;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) fields.highlightColor.value = v;
});

fields.progressColor.addEventListener("input", () => {
  fields.progressColorText.value = fields.progressColor.value;
});
fields.progressColorText.addEventListener("change", () => {
  const v = fields.progressColorText.value;
  if (/^#[0-9a-fA-F]{6}$/.test(v)) fields.progressColor.value = v;
});

Object.values(modeRadios).forEach((radio) => {
  radio.addEventListener("change", updateSiteListEnabled);
});

document.getElementById("save").addEventListener("click", save);
document.getElementById("reset").addEventListener("click", reset);
document.getElementById("tobiiReconnect").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "reconnectTobii" }, () => {
    showStatus("Reconnect requested.");
    setTimeout(refreshTobiiStatus, 500);
  });
});

load();
setInterval(refreshTobiiStatus, 3000);
