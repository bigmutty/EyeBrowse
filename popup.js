const enabledEl = document.getElementById("enabled");
const dwellEl = document.getElementById("dwellTime");
const dwellValue = document.getElementById("dwellValue");
const openOptions = document.getElementById("openOptions");
const siteBox = document.getElementById("siteBox");
const siteHostEl = document.getElementById("siteHost");
const siteStatusEl = document.getElementById("siteStatus");
const siteActionsEl = document.getElementById("siteActions");

function updateDwellLabel(ms) {
  dwellValue.textContent = ms + " ms";
}

function normalizeHostPattern(raw) {
  if (!raw || typeof raw !== "string") return "";
  let s = raw.trim().toLowerCase();
  if (!s) return "";
  try {
    if (s.includes("://")) s = new URL(s).hostname;
    else if (s.includes("/")) s = s.split("/")[0];
  } catch (_) {}
  s = s.split(":")[0];
  if (s.startsWith("*.")) s = s.slice(2);
  if (s.startsWith(".")) s = s.slice(1);
  return s;
}

function hostnameMatches(hostname, pattern) {
  const host = (hostname || "").toLowerCase();
  const pat = normalizeHostPattern(pattern);
  if (!host || !pat) return false;
  return host === pat || host.endsWith("." + pat);
}

function isSiteAllowed(hostname, mode, list) {
  if (!mode || mode === "off" || !list || !list.length) return true;
  const matched = list.some((entry) => hostnameMatches(hostname, entry));
  if (mode === "blacklist") return !matched;
  if (mode === "whitelist") return matched;
  return true;
}

function listContainsHost(list, hostname) {
  return (list || []).some((entry) => hostnameMatches(hostname, entry));
}

function renderSiteSection(hostname, settings) {
  if (!hostname) {
    siteBox.style.display = "none";
    return;
  }

  siteBox.style.display = "block";
  siteHostEl.textContent = hostname;

  const mode = settings.siteFilterMode || "off";
  const list = Array.isArray(settings.siteList) ? settings.siteList : [];
  const allowed = isSiteAllowed(hostname, mode, list);
  const onList = listContainsHost(list, hostname);

  siteStatusEl.className = "site-status " + (allowed ? "active" : "blocked");
  if (mode === "off") {
    siteStatusEl.textContent = "Filter: off — dwell is active here";
  } else if (allowed) {
    siteStatusEl.textContent =
      mode === "whitelist"
        ? "Whitelist: this site is allowed"
        : "Blacklist: this site is not blocked";
  } else {
    siteStatusEl.textContent =
      mode === "whitelist"
        ? "Whitelist: this site is not allowed"
        : "Blacklist: this site is blocked";
  }

  siteActionsEl.innerHTML = "";

  // Helper to add a button
  function addBtn(label, primary, onClick) {
    const btn = document.createElement("button");
    btn.textContent = label;
    if (primary) btn.classList.add("primary");
    btn.addEventListener("click", onClick);
    siteActionsEl.appendChild(btn);
  }

  if (mode === "blacklist") {
    if (onList) {
      addBtn("Remove from blacklist", true, () => {
        const next = list.filter((e) => !hostnameMatches(hostname, e));
        chrome.storage.sync.set({ siteList: next }, () => refreshSiteSection());
      });
    } else {
      addBtn("Add to blacklist", true, () => {
        const next = list.concat([hostname]);
        chrome.storage.sync.set({ siteList: next }, () => refreshSiteSection());
      });
    }
  } else if (mode === "whitelist") {
    if (onList) {
      addBtn("Remove from whitelist", true, () => {
        const next = list.filter((e) => !hostnameMatches(hostname, e));
        chrome.storage.sync.set({ siteList: next }, () => refreshSiteSection());
      });
    } else {
      addBtn("Add to whitelist", true, () => {
        const next = list.concat([hostname]);
        chrome.storage.sync.set({ siteList: next }, () => refreshSiteSection());
      });
    }
  } else {
    // mode off — offer to switch modes for this site
    addBtn("Blacklist this site", false, () => {
      const next = listContainsHost(list, hostname) ? list : list.concat([hostname]);
      chrome.storage.sync.set(
        { siteFilterMode: "blacklist", siteList: next },
        () => refreshSiteSection()
      );
    });
    addBtn("Whitelist only this site", false, () => {
      chrome.storage.sync.set(
        { siteFilterMode: "whitelist", siteList: [hostname] },
        () => refreshSiteSection()
      );
    });
  }
}

let cachedHostname = null;

function refreshSiteSection() {
  chrome.storage.sync.get(
    { siteFilterMode: "off", siteList: [] },
    (settings) => {
      renderSiteSection(cachedHostname, settings);
    }
  );
}

// Load current settings
chrome.storage.sync.get(
  { enabled: true, dwellTime: 1000, siteFilterMode: "off", siteList: [] },
  (settings) => {
    enabledEl.checked = settings.enabled !== false;
    dwellEl.value = settings.dwellTime;
    updateDwellLabel(settings.dwellTime);

    // Current tab hostname
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) {
        siteBox.style.display = "none";
        return;
      }
      try {
        const url = new URL(tab.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
          siteBox.style.display = "none";
          return;
        }
        cachedHostname = url.hostname.toLowerCase();
        renderSiteSection(cachedHostname, settings);
      } catch (_) {
        siteBox.style.display = "none";
      }
    });
  }
);

// Save on change
enabledEl.addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: enabledEl.checked });
});

dwellEl.addEventListener("input", () => {
  const ms = Number(dwellEl.value);
  updateDwellLabel(ms);
  chrome.storage.sync.set({ dwellTime: ms });
});

openOptions.addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});
