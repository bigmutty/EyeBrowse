// EyeBrowse – background service worker
// Maintains optional Tobii local WebSocket bridge and relays gaze to content scripts.

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

let tobiiSocket = null;
let tobiiReconnectTimer = null;
let tobiiConnected = false;
let lastGaze = null;
let currentSettings = { ...DEFAULTS };

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get(null, (items) => {
    const toSet = {};
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (items[key] === undefined) toSet[key] = value;
    }
    if (Object.keys(toSet).length) chrome.storage.sync.set(toSet);
  });
});

function updateBadge() {
  if (!currentSettings.enabled) {
    chrome.action.setBadgeText({ text: "OFF" });
    chrome.action.setBadgeBackgroundColor({ color: "#c0392b" });
  } else if (currentSettings.tobiiEnabled && tobiiConnected) {
    chrome.action.setBadgeText({ text: "ON" });
    chrome.action.setBadgeBackgroundColor({ color: "#00aaff" });
  } else if (currentSettings.tobiiEnabled && !tobiiConnected) {
    chrome.action.setBadgeText({ text: "..." });
    chrome.action.setBadgeBackgroundColor({ color: "#f39c12" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
}

function extractXY(obj) {
  if (!obj || typeof obj !== "object") return null;
  const x = obj.X ?? obj.x;
  const y = obj.Y ?? obj.y;
  if (typeof x === "number" && typeof y === "number" && Number.isFinite(x) && Number.isFinite(y)) {
    return { x, y };
  }
  return null;
}

function parseGazeMessage(raw) {
  // Tobii EyeX WS sometimes sends plain "gazePoint x y" text; normally JSON.
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
      const parts = trimmed.split(/[\s,;]+/);
      if (parts.length >= 3 && /^gazePoint$/i.test(parts[0])) {
        const x = Number(parts[1]);
        const y = Number(parts[2]);
        if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
      }
      return null;
    }
  }

  let msg;
  try {
    msg = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (_) {
    return null;
  }
  if (!msg || typeof msg !== "object") return null;

  // Ignore non-gaze control/state messages from EyeX bridge
  if (typeof msg.type === "string") {
    const t = msg.type.toLowerCase();
    if (t === "state" || t === "headpose" || t === "eyeposition" || t === "error") {
      return null;
    }
  }

  // rezreal Tobii-EyeX-Web-Socket-Server:
  // { type: "gazePoint", data: { X, Y, Timestamp } }
  if (msg.type === "gazePoint" || msg.type === "GazePoint" || msg.type === "gaze") {
    const fromData = extractXY(msg.data);
    if (fromData) return fromData;
    const fromRoot = extractXY(msg);
    if (fromRoot) return fromRoot;
    if (msg.data && (msg.data.left || msg.data.right)) {
      const d = msg.data;
      const lx = d.left?.x ?? d.left?.X;
      const ly = d.left?.y ?? d.left?.Y;
      const rx = d.right?.x ?? d.right?.X;
      const ry = d.right?.y ?? d.right?.Y;
      const pts = [];
      if (typeof lx === "number" && typeof ly === "number") pts.push([lx, ly]);
      if (typeof rx === "number" && typeof ry === "number") pts.push([rx, ry]);
      if (pts.length) {
        return {
          x: pts.reduce((s, p) => s + p[0], 0) / pts.length,
          y: pts.reduce((s, p) => s + p[1], 0) / pts.length
        };
      }
    }
  }

  // { gazePoint: { X, Y } } or { gaze: { x, y } }
  const nested = extractXY(msg.gazePoint) || extractXY(msg.GazePoint) || extractXY(msg.gaze);
  if (nested) return nested;

  const root = extractXY(msg);
  if (root) return root;

  if (Array.isArray(msg) && msg.length >= 2 && typeof msg[0] === "number") {
    return { x: msg[0], y: msg[1] };
  }

  return null;
}

function broadcastGaze(point) {
  lastGaze = { ...point, t: Date.now() };
  // Omit frameId so Chrome delivers to every frame's content script in the tab.
  const payload = { type: "tobiiGaze", x: point.x, y: point.y, connected: true };
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, payload, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

function broadcastTobiiStatus() {
  const payload = {
    type: "tobiiStatus",
    connected: tobiiConnected,
    enabled: !!currentSettings.tobiiEnabled
  };
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (!tab.id) continue;
      chrome.tabs.sendMessage(tab.id, payload, () => {
        void chrome.runtime.lastError;
      });
    }
  });
  updateBadge();
}

function stopTobii() {
  if (tobiiReconnectTimer) {
    clearTimeout(tobiiReconnectTimer);
    tobiiReconnectTimer = null;
  }
  if (tobiiSocket) {
    try {
      tobiiSocket.onclose = null;
      tobiiSocket.onerror = null;
      tobiiSocket.onmessage = null;
      tobiiSocket.close();
    } catch (_) {}
    tobiiSocket = null;
  }
  if (tobiiConnected) {
    tobiiConnected = false;
    broadcastTobiiStatus();
  } else {
    updateBadge();
  }
}

function wireTobiiSocket(socket, { allowProtocolFallback }) {
  let opened = false;

  socket.onopen = () => {
    opened = true;
    tobiiConnected = true;
    broadcastTobiiStatus();
    try {
      // EyeX bridge commands are plain strings (not JSON).
      socket.send("startGazePoint");
      socket.send("state");
      // Other bridges may expect JSON subscribe messages.
      socket.send(JSON.stringify({ type: "startGazePoint" }));
      socket.send(JSON.stringify({ action: "subscribe", stream: "gaze" }));
    } catch (_) {}
  };

  socket.onmessage = (event) => {
    const point = parseGazeMessage(event.data);
    if (point) {
      // Receiving gaze proves the stream is live even if a prior status was missed.
      if (!tobiiConnected) {
        tobiiConnected = true;
        broadcastTobiiStatus();
      }
      broadcastGaze(point);
    }
  };

  socket.onerror = () => {};

  socket.onclose = () => {
    const wasOurs = tobiiSocket === socket;
    if (wasOurs) tobiiSocket = null;

    if (tobiiConnected) {
      tobiiConnected = false;
      broadcastTobiiStatus();
    }

    // Handshake can fail when the server rejects the Tobii.Interaction
    // subprotocol — retry once without it before the normal reconnect loop.
    if (
      wasOurs &&
      !opened &&
      allowProtocolFallback &&
      currentSettings.tobiiEnabled
    ) {
      openTobiiSocket({ useSubprotocol: false, allowProtocolFallback: false });
      return;
    }

    if (currentSettings.tobiiEnabled) scheduleReconnect();
  };
}

function openTobiiSocket({ useSubprotocol, allowProtocolFallback }) {
  const url = (currentSettings.tobiiWsUrl || "ws://localhost:8887").trim();
  let socket;
  try {
    socket = useSubprotocol
      ? new WebSocket(url, ["Tobii.Interaction"])
      : new WebSocket(url);
  } catch (err) {
    console.warn("[EyeBrowse] Tobii WebSocket open failed:", err);
    if (useSubprotocol && allowProtocolFallback) {
      openTobiiSocket({ useSubprotocol: false, allowProtocolFallback: false });
      return;
    }
    scheduleReconnect();
    return;
  }
  tobiiSocket = socket;
  wireTobiiSocket(socket, { allowProtocolFallback: !!allowProtocolFallback });
}

function connectTobii() {
  stopTobii();
  if (!currentSettings.tobiiEnabled) {
    updateBadge();
    return;
  }

  const url = (currentSettings.tobiiWsUrl || "ws://localhost:8887").trim();
  if (!url.startsWith("ws://") && !url.startsWith("wss://")) {
    console.warn("[EyeBrowse] Invalid Tobii WebSocket URL:", url);
    updateBadge();
    return;
  }

  // Prefer the EyeX subprotocol; fall back to a bare socket for other bridges.
  openTobiiSocket({ useSubprotocol: true, allowProtocolFallback: true });
}

function scheduleReconnect() {
  if (tobiiReconnectTimer) return;
  tobiiReconnectTimer = setTimeout(() => {
    tobiiReconnectTimer = null;
    if (currentSettings.tobiiEnabled) connectTobii();
  }, 2000);
}

function applySettings(items) {
  currentSettings = { ...DEFAULTS, ...items };
  if (!Array.isArray(currentSettings.siteList)) currentSettings.siteList = [];
  updateBadge();
  if (currentSettings.tobiiEnabled) connectTobii();
  else stopTobii();
}

chrome.storage.sync.get(DEFAULTS, applySettings);

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;
  for (const [key, { newValue }] of Object.entries(changes)) {
    currentSettings[key] = newValue;
  }
  if (changes.enabled || changes.tobiiEnabled || changes.tobiiWsUrl) {
    updateBadge();
    if (currentSettings.tobiiEnabled) connectTobii();
    else stopTobii();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "getSettings") {
    chrome.storage.sync.get(DEFAULTS, (settings) => sendResponse(settings));
    return true;
  }
  if (message.type === "getTobiiStatus") {
    sendResponse({
      connected: tobiiConnected,
      enabled: !!currentSettings.tobiiEnabled,
      lastGaze
    });
    return false;
  }
  if (message.type === "contentReady") {
    // A content script just booted — push current Tobii status + last gaze sample
    // so dwell works immediately even if the page loaded after the WS connected.
    sendResponse({
      connected: tobiiConnected,
      enabled: !!currentSettings.tobiiEnabled,
      lastGaze
    });
    if (tobiiConnected && lastGaze && sender.tab?.id != null) {
      const frameId = sender.frameId;
      const payload = { type: "tobiiGaze", x: lastGaze.x, y: lastGaze.y, connected: true };
      const opts = typeof frameId === "number" ? { frameId } : undefined;
      chrome.tabs.sendMessage(sender.tab.id, payload, opts || {}, () => {
        void chrome.runtime.lastError;
      });
    }
    return false;
  }
  if (message.type === "reconnectTobii") {
    if (currentSettings.tobiiEnabled) connectTobii();
    sendResponse({ ok: true });
    return false;
  }
});
