// EyeBrowse – content script
// Activates clickable elements when the mouse (gaze) dwells on them.
// Handles dynamically added / removed elements via MutationObserver.

(function () {
  "use strict";

  // ---------- State ----------
  let settings = {
    enabled: true,
    dwellTime: 1000,
    showProgress: true,
    minElementSize: 8,
    clickCooldown: 600,
    highlightColor: "#00aaff",
    progressColor: "#00aaff",
    siteFilterMode: "off", // "off" | "blacklist" | "whitelist"
    siteList: [],
    tobiiEnabled: false,
    tobiiWsUrl: "ws://localhost:8887",
    tobiiPreferGaze: true,
    oskEnabled: true
  };

  let siteAllowed = true; // computed from hostname + filter settings

  let currentTarget = null;          // the clickable element we are dwelling on
  let dwellStart = 0;                // performance.now() when we started dwelling
  let lastClickTime = 0;             // performance.now() of last synthetic click
  let rafId = null;
  let lastMouseX = 0;
  let lastMouseY = 0;
  let lastGazeX = null;
  let lastGazeY = null;
  let lastGazeTime = 0;
  let tobiiConnected = false;
  // Calibrated screen→client offsets from real mouse events (most accurate).
  // screenClient = client + offset  ⇒  client = screen - offset
  let screenClientOffsetX = null;
  let screenClientOffsetY = null;
  let progressEl = null;
  let highlightEl = null;
  let isProcessing = false;
  let mutationObserver = null;

  // ---------- Utilities ----------
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        {
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
        },
        (items) => {
          settings = items;
          if (!Array.isArray(settings.siteList)) settings.siteList = [];
          applyColors();
          updateSiteAllowed();
          resolve();
        }
      );
    });
  }

  /**
   * Convert absolute screen pixels (Tobii GazePointData X/Y) to viewport
   * client coordinates for elementFromPoint / overlay positioning.
   *
   * Prefer a live calibration from mousemove (screenX - clientX). When no
   * mouse sample exists yet (pure gaze, no cursor warping), estimate browser
   * chrome from outer/inner window size.
   */
  function screenToClient(screenX, screenY) {
    if (screenClientOffsetX != null && screenClientOffsetY != null) {
      return {
        x: screenX - screenClientOffsetX,
        y: screenY - screenClientOffsetY
      };
    }

    // Estimate chrome: side borders are roughly symmetric; most of
    // (outerHeight - innerHeight) is the top toolbar/tab strip.
    const sideBorder = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    const bottomBorder = sideBorder; // approx window frame
    const topChrome = Math.max(0, window.outerHeight - window.innerHeight - bottomBorder);

    return {
      x: screenX - window.screenX - sideBorder,
      y: screenY - window.screenY - topChrome
    };
  }

  /** Current pointer position: Tobii gaze if preferred & fresh, else mouse. */
  function getPointer() {
    const preferGaze = settings.tobiiPreferGaze !== false;
    // Treat recent gaze samples as proof of a live stream even if the
    // initial tobiiStatus broadcast was missed (common on SPA navigations).
    const gazeFresh =
      lastGazeX != null &&
      lastGazeY != null &&
      performance.now() - lastGazeTime < 500;

    if (preferGaze && gazeFresh && (tobiiConnected || settings.tobiiEnabled)) {
      return screenToClient(lastGazeX, lastGazeY);
    }
    return { x: lastMouseX, y: lastMouseY };
  }

  /**
   * Normalize a hostname pattern from the user list.
   * Accepts: "example.com", "*.example.com", "https://example.com/path", "www.example.com"
   * Returns lowercase hostname without leading "*."
   */
  function normalizeHostPattern(raw) {
    if (!raw || typeof raw !== "string") return "";
    let s = raw.trim().toLowerCase();
    if (!s) return "";
    // Strip protocol and path if pasted as a full URL
    try {
      if (s.includes("://")) {
        s = new URL(s).hostname;
      } else if (s.includes("/")) {
        s = s.split("/")[0];
      }
    } catch (_) {
      // keep as-is
    }
    // Drop port
    s = s.split(":")[0];
    // Leading wildcard
    if (s.startsWith("*.")) s = s.slice(2);
    // Leading dot
    if (s.startsWith(".")) s = s.slice(1);
    return s;
  }

  function hostnameMatches(hostname, pattern) {
    if (!hostname || !pattern) return false;
    const host = hostname.toLowerCase();
    const pat = normalizeHostPattern(pattern);
    if (!pat) return false;
    return host === pat || host.endsWith("." + pat);
  }

  function updateSiteAllowed() {
    const mode = settings.siteFilterMode || "off";
    const list = Array.isArray(settings.siteList) ? settings.siteList : [];
    const host = (location.hostname || "").toLowerCase();

    if (mode === "off" || !list.length) {
      siteAllowed = true;
      return;
    }

    const matched = list.some((entry) => hostnameMatches(host, entry));

    if (mode === "blacklist") {
      siteAllowed = !matched;
    } else if (mode === "whitelist") {
      siteAllowed = matched;
    } else {
      siteAllowed = true;
    }
  }

  function shouldRun() {
    return settings.enabled && siteAllowed;
  }

  function applyColors() {
    document.documentElement.style.setProperty("--edc-highlight-color", settings.highlightColor);
    document.documentElement.style.setProperty("--edc-progress-color", settings.progressColor);
  }

  function ensureOverlayElements() {
    // Re-create if missing or detached (common after SPA route changes / body.innerHTML swaps)
    if (!progressEl || !document.documentElement.contains(progressEl)) {
      if (progressEl && progressEl.parentNode) {
        try { progressEl.parentNode.removeChild(progressEl); } catch (_) {}
      }
      progressEl = document.createElement("div");
      progressEl.id = "eyebrowse-progress";
      document.documentElement.appendChild(progressEl);
    }

    if (!highlightEl || !document.documentElement.contains(highlightEl)) {
      if (highlightEl && highlightEl.parentNode) {
        try { highlightEl.parentNode.removeChild(highlightEl); } catch (_) {}
      }
      highlightEl = document.createElement("div");
      highlightEl.id = "eyebrowse-highlight";
      document.documentElement.appendChild(highlightEl);
    }
  }

  function hideFeedback() {
    if (progressEl) progressEl.style.display = "none";
    if (highlightEl) highlightEl.style.display = "none";
  }

  function showProgress(x, y, ratio) {
    if (!settings.showProgress) return;
    ensureOverlayElements();
    progressEl.style.display = "block";
    progressEl.style.left = x + "px";
    progressEl.style.top = y + "px";
    progressEl.style.setProperty("--edc-progress", Math.min(100, ratio * 100));
  }

  function showHighlight(el) {
    if (!settings.showProgress || !el) return;
    ensureOverlayElements();
    const rect = el.getBoundingClientRect();
    highlightEl.style.display = "block";
    highlightEl.style.left = rect.left + window.scrollX + "px";
    highlightEl.style.top = rect.top + window.scrollY + "px";
    highlightEl.style.width = rect.width + "px";
    highlightEl.style.height = rect.height + "px";
  }

  // ---------- Clickable detection ----------
  const TEXT_INPUT_TYPES = new Set([
    "text",
    "search",
    "email",
    "url",
    "tel",
    "password",
    "number",
    "date",
    "datetime-local",
    "month",
    "week",
    "time",
    "" // missing type defaults to text
  ]);

  const TEXT_ENTRY_ROLES = new Set(["textbox", "searchbox", "combobox"]);

  function isDisabled(el) {
    return !!(el.disabled || el.getAttribute("aria-disabled") === "true");
  }

  /** Native or ARIA control the user types into. */
  function isTextEntryTarget(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE || isDisabled(el)) return false;

    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
      const type = (el.getAttribute("type") || el.type || "text").toLowerCase();
      return TEXT_INPUT_TYPES.has(type);
    }
    if (el.isContentEditable) return true;

    const role = (el.getAttribute("role") || "").toLowerCase();
    return TEXT_ENTRY_ROLES.has(role);
  }

  function isInteractive(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;

    // Skip feedback overlays (keyboard keys remain interactive for dwell typing)
    if (el.id === "eyebrowse-progress" || el.id === "eyebrowse-highlight") return false;
    if (el.closest && el.closest("#eyebrowse-progress, #eyebrowse-highlight")) return false;

    const tag = el.tagName.toLowerCase();

    // Standard interactive elements
    if (["a", "button", "input", "select", "textarea", "summary", "label"].includes(tag)) {
      if (isDisabled(el)) return false;
      if (tag === "input" && (el.type === "hidden" || el.type === "file")) return false;
      return true;
    }

    // ARIA roles (include text-entry roles used by modern search boxes)
    const role = (el.getAttribute("role") || "").toLowerCase();
    if (
      role &&
      [
        "button",
        "link",
        "menuitem",
        "tab",
        "checkbox",
        "radio",
        "switch",
        "option",
        "textbox",
        "searchbox",
        "combobox"
      ].includes(role)
    ) {
      return !isDisabled(el);
    }

    // Explicit handlers
    if (el.hasAttribute("onclick") || typeof el.onclick === "function") return true;

    // Focusable
    if (el.tabIndex >= 0) return true;

    // Content editable
    if (el.isContentEditable) return true;

    // Pointer cursor is a strong signal on modern sites
    try {
      const style = window.getComputedStyle(el);
      if (style.cursor === "pointer" || style.cursor === "hand") return true;
      // Text caret on this node (not ancestors): common for contenteditable hosts
      if (style.cursor === "text" && el.isContentEditable) return true;
      if (style.pointerEvents === "none") return false;
    } catch (e) {
      // getComputedStyle can fail in some edge cases
    }

    return false;
  }

  function findClickable(startEl) {
    let el = startEl;
    let fallback = null;

    while (el && el !== document.documentElement) {
      if (isInteractive(el)) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= settings.minElementSize && rect.height >= settings.minElementSize) {
          // Prefer the innermost text field so dwell focuses the input, not a
          // surrounding clickable wrapper (common on search UIs).
          if (isTextEntryTarget(el)) return el;
          if (!fallback) fallback = el;
        }
      }
      el = el.parentElement;
    }
    return fallback;
  }

  /**
   * Map a dwell hit to the element that should actually receive focus/click.
   * Labels → labeled control; combobox wrappers → inner input; contenteditable
   * children → editing host.
   */
  function queryInnerTextField(root) {
    if (!root || !root.querySelector) return null;
    const inner = root.querySelector(
      'input:not([type="hidden"]):not([type="file"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="image"]), textarea, [contenteditable="true"], [role="textbox"], [role="searchbox"]'
    );
    if (inner && !isDisabled(inner)) return inner;
    return null;
  }

  function resolveActivationTarget(el, clientX, clientY) {
    if (!el) return null;

    const tag = el.tagName.toLowerCase();
    const role = (el.getAttribute("role") || "").toLowerCase();

    if (tag === "label") {
      const control = el.control || (el.htmlFor && document.getElementById(el.htmlFor));
      if (control && isStillInDocument(control) && !isDisabled(control)) return control;
    }

    if (el.isContentEditable) {
      let host = el;
      while (host.parentElement && host.parentElement.isContentEditable) {
        host = host.parentElement;
      }
      return host;
    }

    // Native input/textarea: use as-is
    if (tag === "input" || tag === "textarea") return el;

    // ARIA combobox/searchbox/textbox wrappers usually own a real <input> child
    if (TEXT_ENTRY_ROLES.has(role)) {
      const inner = queryInnerTextField(el);
      if (inner) return inner;
      return el;
    }

    // Gaze may be on padding of a wrapper around a real text field
    const under =
      typeof clientX === "number" && typeof clientY === "number"
        ? document.elementFromPoint(clientX, clientY)
        : null;
    let node = under;
    while (node && node !== el) {
      if (el.contains(node) && isTextEntryTarget(node) && node.tagName) {
        const t = node.tagName.toLowerCase();
        if (t === "input" || t === "textarea") return node;
        if (node.isContentEditable) return resolveActivationTarget(node, clientX, clientY);
      }
      node = node.parentElement;
    }

    if (fallbackLooksLikeField(el)) {
      const inner = queryInnerTextField(el);
      if (inner) return inner;
    }

    return el;
  }

  function fallbackLooksLikeField(el) {
    if (!el || !el.classList) return false;
    // Lightweight heuristic for unlabeled search/field wrappers
    const cls = typeof el.className === "string" ? el.className.toLowerCase() : "";
    return /\b(search|input|field|textbox|text-field)\b/.test(cls);
  }

  // Fast check whether an element is still in the live document
  function isStillInDocument(el) {
    return el && el.isConnected === true;
  }

  // ---------- Core dwell logic ----------
  function onMouseMove(e) {
    lastMouseX = e.clientX;
    lastMouseY = e.clientY;
    // Keep a live screen↔client calibration. Eye trackers that also warp the
    // system cursor (and any real mouse use) keep this accurate for chrome,
    // DPI scaling, and docked DevTools.
    if (typeof e.screenX === "number" && typeof e.screenY === "number") {
      screenClientOffsetX = e.screenX - e.clientX;
      screenClientOffsetY = e.screenY - e.clientY;
    }
  }

  function tick() {
    rafId = requestAnimationFrame(tick);

    if (!shouldRun() || isProcessing) {
      hideFeedback();
      currentTarget = null;
      return;
    }

    const now = performance.now();

    // Cooldown after a click
    if (now - lastClickTime < settings.clickCooldown) {
      hideFeedback();
      currentTarget = null;
      return;
    }

    // If the element we were dwelling on was removed by the page, reset
    if (currentTarget && !isStillInDocument(currentTarget)) {
      currentTarget = null;
      hideFeedback();
    }

    const ptr = getPointer();

    // elementFromPoint requires coordinates inside the viewport
    if (
      !Number.isFinite(ptr.x) ||
      !Number.isFinite(ptr.y) ||
      ptr.x < 0 ||
      ptr.y < 0 ||
      ptr.x > window.innerWidth ||
      ptr.y > window.innerHeight
    ) {
      currentTarget = null;
      hideFeedback();
      return;
    }

    // Element under the current pointer (live DOM query – works with dynamic content)
    const under = document.elementFromPoint(ptr.x, ptr.y);
    const target = findClickable(under);

    if (!target) {
      currentTarget = null;
      hideFeedback();
      return;
    }

    // Same target → continue dwelling
    if (target === currentTarget) {
      const elapsed = now - dwellStart;
      const ratio = elapsed / settings.dwellTime;

      showProgress(ptr.x, ptr.y, ratio);
      showHighlight(target);

      if (elapsed >= settings.dwellTime) {
        performClick(target, ptr.x, ptr.y);
      }
    } else {
      // New target – restart timer
      currentTarget = target;
      dwellStart = now;
      showProgress(ptr.x, ptr.y, 0);
      showHighlight(target);
    }
  }

  function dispatchPointerSequence(target, clientX, clientY) {
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX,
      clientY,
      screenX: clientX + (window.screenX || 0),
      screenY: clientY + (window.screenY || 0),
      button: 0,
      buttons: 1,
      detail: 1
    };

    try {
      if (typeof PointerEvent === "function") {
        target.dispatchEvent(
          new PointerEvent("pointerdown", {
            ...base,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true
          })
        );
      }
    } catch (_) {}

    target.dispatchEvent(new MouseEvent("mousedown", base));

    const up = { ...base, buttons: 0 };
    try {
      if (typeof PointerEvent === "function") {
        target.dispatchEvent(
          new PointerEvent("pointerup", {
            ...up,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true
          })
        );
      }
    } catch (_) {}

    target.dispatchEvent(new MouseEvent("mouseup", up));
    target.dispatchEvent(new MouseEvent("click", up));
  }

  /**
   * High-accuracy caret index from viewport coordinates for <input>/<textarea>.
   *
   * Strategy:
   * 1. Build a mirror <div> that copies typography + content width (wrap metrics).
   * 2. Measure caret slots with Range#getClientRects (layout-engine accurate).
   * 3. For multiline/soft-wrap: pick the visual line by Y, then the character by X.
   * 4. Fall back to binary search on single-line inputs.
   */
  function caretIndexFromPoint(el, clientX, clientY) {
    if (!el || typeof el.value !== "string") return 0;
    const value = el.value;
    if (!value.length) return 0;

    const style = window.getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const isTextarea = el.tagName.toLowerCase() === "textarea";

    const padL = parseFloat(style.paddingLeft) || 0;
    const padR = parseFloat(style.paddingRight) || 0;
    const padT = parseFloat(style.paddingTop) || 0;
    const borderL = parseFloat(style.borderLeftWidth) || 0;
    const borderR = parseFloat(style.borderRightWidth) || 0;
    const borderT = parseFloat(style.borderTopWidth) || 0;

    // Content width used for soft-wrap (clientWidth excludes scrollbar)
    const contentWidth = Math.max(
      0,
      (typeof el.clientWidth === "number"
        ? el.clientWidth
        : rect.width - borderL - borderR) -
        padL -
        padR
    );

    // Viewport origin of the content box (padding edge), before scroll
    const contentLeft = rect.left + borderL + padL;
    const contentTop = rect.top + borderT + padT;

    // Pointer in content coordinates + scroll
    const localX = clientX - contentLeft + (el.scrollLeft || 0);
    const localY = clientY - contentTop + (el.scrollTop || 0);

    const mirror = document.createElement("div");
    const ms = mirror.style;
    ms.position = "fixed";
    ms.left = "0";
    ms.top = "0";
    ms.visibility = "hidden";
    ms.pointerEvents = "none";
    ms.boxSizing = "content-box";
    ms.margin = "0";
    ms.padding = "0";
    ms.border = "none";
    ms.overflow = "visible";
    ms.zIndex = "-1";

    if (isTextarea) {
      ms.whiteSpace = "pre-wrap";
      ms.overflowWrap = "break-word";
      ms.wordWrap = "break-word";
      ms.wordBreak = style.wordBreak && style.wordBreak !== "normal" ? style.wordBreak : "normal";
      ms.width = contentWidth + "px";
      try {
        ms.tabSize = style.tabSize || "8";
        ms.MozTabSize = style.tabSize || "8";
      } catch (_) {}
    } else {
      ms.whiteSpace = "pre";
      ms.overflowWrap = "normal";
      ms.wordBreak = "normal";
      ms.width = "auto";
      ms.maxWidth = "none";
    }

    const copyProps = [
      "fontFamily",
      "fontSize",
      "fontWeight",
      "fontStyle",
      "fontVariant",
      "fontStretch",
      "fontFeatureSettings",
      "fontKerning",
      "fontOpticalSizing",
      "fontVariationSettings",
      "letterSpacing",
      "textTransform",
      "wordSpacing",
      "textIndent",
      "lineHeight",
      "direction",
      "textAlign",
      "unicodeBidi",
      "textRendering",
      "webkitFontSmoothing",
      "mozOsxFontSmoothing"
    ];
    for (const prop of copyProps) {
      try {
        if (style[prop] != null && style[prop] !== "") ms[prop] = style[prop];
      } catch (_) {}
    }

    // Full text as a single text node so Range offsets map 1:1 to value indices
    const textNode = document.createTextNode(value);
    mirror.appendChild(textNode);
    document.documentElement.appendChild(mirror);

    const range = document.createRange();

    /** Collapsed caret rect at character offset (viewport coords relative to mirror origin at 0,0). */
    function caretRectAt(offset) {
      const o = Math.max(0, Math.min(value.length, offset));
      try {
        range.setStart(textNode, o);
        range.setEnd(textNode, o);
      } catch (_) {
        return null;
      }
      // getClientRects is more reliable at line wraps than getBoundingClientRect
      const rects = range.getClientRects();
      if (rects && rects.length) {
        const r = rects[0];
        return { left: r.left, top: r.top, bottom: r.bottom, height: r.height || 0, width: r.width || 0 };
      }
      const br = range.getBoundingClientRect();
      if (br) {
        return { left: br.left, top: br.top, bottom: br.bottom, height: br.height || 0, width: br.width || 0 };
      }
      return null;
    }

    // Mirror is at (0,0); its caret rects are in viewport space as if content
    // started at the top-left of the viewport. Map those to content-local coords:
    // local = mirrorRect - 0 + scroll already applied in localX/Y comparison
    // Since mirror isn't scrolled, caretRectAt returns positions in the unscrolled
    // content coordinate system starting at (0,0) — same space as localX/localY.

    function localCaret(offset) {
      const r = caretRectAt(offset);
      if (!r) return null;
      return {
        x: r.left,
        y: r.top,
        cy: r.top + (r.height || 0) * 0.5,
        h: r.height || 0
      };
    }

    let bestIdx = value.length;

    try {
      if (!isTextarea) {
        // Single-line: binary search on X
        let lo = 0;
        let hi = value.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const m = localCaret(mid);
          if (m && m.x < localX) lo = mid + 1;
          else hi = mid;
        }
        bestIdx = lo;
        const a = localCaret(lo);
        if (lo > 0) {
          const b = localCaret(lo - 1);
          if (a && b && Math.abs(b.x - localX) < Math.abs(a.x - localX)) bestIdx = lo - 1;
          else if (!a && b) bestIdx = lo - 1;
        }
      } else {
        // Multiline / soft-wrap
        const len = value.length;
        const lineHeight = (() => {
          const lh = parseFloat(style.lineHeight);
          if (!isNaN(lh) && String(style.lineHeight) !== "normal") return lh;
          return (parseFloat(style.fontSize) || 16) * 1.2;
        })();

        // --- Phase 1: find visual line (by Y) via coarse sampling ---
        const step = Math.max(1, Math.ceil(len / 250));
        let bestLineY = 0;
        let bestDy = Infinity;
        const coarse = [];

        for (let i = 0; i <= len; i += step) {
          const m = localCaret(i);
          if (!m) continue;
          coarse.push({ i, x: m.x, y: m.y, cy: m.cy });
          const dy = Math.abs(m.cy - localY);
          if (dy < bestDy) {
            bestDy = dy;
            bestLineY = m.y;
          }
        }
        // Ensure last index measured
        if (!coarse.length || coarse[coarse.length - 1].i !== len) {
          const m = localCaret(len);
          if (m) {
            coarse.push({ i: len, x: m.x, y: m.y, cy: m.cy });
            if (Math.abs(m.cy - localY) < bestDy) bestLineY = m.y;
          }
        }

        // Pick the coarse sample whose line is closest; prefer cy
        let seed = 0;
        bestDy = Infinity;
        for (const s of coarse) {
          const dy = Math.abs(s.cy - localY);
          if (dy < bestDy) {
            bestDy = dy;
            seed = s.i;
            bestLineY = s.y;
          }
        }

        const lineTol = Math.max(lineHeight * 0.55, 3);

        // --- Phase 2: expand to all offsets on that visual line ---
        // Walk left/right from seed until Y jumps to another line
        let left = seed;
        let right = seed;
        while (left > 0) {
          const m = localCaret(left - 1);
          if (!m || Math.abs(m.y - bestLineY) > lineTol) break;
          left -= 1;
        }
        while (right < len) {
          const m = localCaret(right + 1);
          if (!m || Math.abs(m.y - bestLineY) > lineTol) break;
          right += 1;
        }

        // Re-measure seed y in case coarse was on a boundary
        const seedM = localCaret(seed);
        if (seedM) bestLineY = seedM.y;

        // Build dense points on the line for X search
        const onLine = [];
        for (let i = left; i <= right; i++) {
          const m = localCaret(i);
          if (!m) continue;
          if (Math.abs(m.y - bestLineY) <= lineTol) {
            onLine.push({ i, x: m.x, y: m.y });
          }
        }

        if (onLine.length) {
          // Binary search by X on this line
          let lo = 0;
          let hi = onLine.length - 1;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (onLine[mid].x < localX) lo = mid + 1;
            else hi = mid;
          }
          bestIdx = onLine[lo].i;
          if (lo > 0) {
            const d0 = Math.abs(onLine[lo].x - localX);
            const d1 = Math.abs(onLine[lo - 1].x - localX);
            if (d1 <= d0) bestIdx = onLine[lo - 1].i;
          }
        } else {
          // Fallback: weighted 2D over dense sample (Y weighted higher)
          let bestDist = Infinity;
          const dense = Math.max(1, Math.ceil(len / 400));
          for (let i = 0; i <= len; i += dense) {
            const m = localCaret(i);
            if (!m) continue;
            const dx = m.x - localX;
            const dy = m.cy - localY;
            const dist = dx * dx + dy * dy * 12;
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
            }
          }
          const from = Math.max(0, bestIdx - dense * 2);
          const to = Math.min(len, bestIdx + dense * 2);
          for (let i = from; i <= to; i++) {
            const m = localCaret(i);
            if (!m) continue;
            const dx = m.x - localX;
            const dy = m.cy - localY;
            const dist = dx * dx + dy * dy * 12;
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = i;
            }
          }
        }

        // Soft-wrap edge case: clicking past the end of a wrapped line should
        // place caret at the last character of that line (not the next line).
        // Already handled by restricting to onLine band.
      }
    } finally {
      mirror.remove();
    }

    return Math.max(0, Math.min(value.length, bestIdx));
  }

  function setCaretFromPoint(target, clientX, clientY) {
    if (!target || typeof clientX !== "number" || typeof clientY !== "number") return;

    try {
      // contenteditable: browser handles wrapping natively
      if (target.isContentEditable) {
        let range = null;
        if (typeof document.caretRangeFromPoint === "function") {
          range = document.caretRangeFromPoint(clientX, clientY);
        } else if (typeof document.caretPositionFromPoint === "function") {
          const pos = document.caretPositionFromPoint(clientX, clientY);
          if (pos) {
            range = document.createRange();
            range.setStart(pos.offsetNode, pos.offset);
            range.collapse(true);
          }
        }
        if (range && target.contains(range.startContainer)) {
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(range);
          }
          return;
        }
      }

      // Native input / textarea
      if (typeof target.setSelectionRange === "function" && typeof target.value === "string") {
        // After focus, re-read pointer in case of subpixel layout settling
        const idx = caretIndexFromPoint(target, clientX, clientY);
        target.setSelectionRange(idx, idx);

        // If the caret is outside the visible scrollport, nudge scroll so it shows
        try {
          if (target.tagName && target.tagName.toLowerCase() === "textarea") {
            // Approximate: ensure selection is visible by scrolling to a rough ratio
            const len = target.value.length || 1;
            const ratio = idx / len;
            const maxScroll = Math.max(0, target.scrollHeight - target.clientHeight);
            if (maxScroll > 0 && (target.scrollTop > 0 || ratio > 0.05)) {
              // Only auto-scroll if caret measurement suggests we're far off-screen
              // Leave scroll mostly alone to avoid jumping; browser usually handles it.
            }
          }
        } catch (_) {}
      }
    } catch (_) {
      // Some input types reject setSelectionRange
    }
  }

  function focusTextEntry(target, clientX, clientY) {
    if (!target || typeof target.focus !== "function") return;

    try {
      target.focus({ preventScroll: true });
    } catch (_) {
      try {
        target.focus();
      } catch (_) {}
    }

    // Place caret at the dwell/click position (handles soft-wrapped multiline)
    // Double-rAF: wait for focus/layout so mirror metrics match the focused field
    const x = clientX;
    const y = clientY;
    setCaretFromPoint(target, x, y);
    requestAnimationFrame(() => {
      setCaretFromPoint(target, x, y);
    });
  }


  function performClick(el, clientX, clientY) {
    if (!el || isProcessing || !isStillInDocument(el)) return;
    isProcessing = true;
    lastClickTime = performance.now();
    currentTarget = null;
    hideFeedback();

    const x = typeof clientX === "number" ? clientX : lastMouseX;
    const y = typeof clientY === "number" ? clientY : lastMouseY;
    const target = resolveActivationTarget(el, x, y) || el;

    try {
      const textEntry = isTextEntryTarget(target) || tagIsTextualInput(target);

      if (textEntry) {
        // Text fields: pointer sequence + explicit focus. A bare .click() often
        // does not leave the caret in the field (especially custom/ARIA inputs).
        dispatchPointerSequence(target, x, y);
        focusTextEntry(target, x, y);
      } else {
        // Buttons/links: one activation path only (avoid double-firing).
        // HTMLElement.click() runs default actions (navigate, toggle, submit).
        if (typeof target.click === "function") {
          target.click();
        } else {
          dispatchPointerSequence(target, x, y);
        }
        if (tagIsFocusableFormControl(target) && typeof target.focus === "function") {
          try {
            target.focus({ preventScroll: true });
          } catch (_) {}
        }
      }
    } catch (err) {
      console.warn("[EyeBrowse] Failed to activate element:", err);
    }

    // Small delay before allowing another dwell
    setTimeout(() => {
      isProcessing = false;
    }, 100);
  }

  function tagIsTextualInput(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (tag === "input") {
      const type = (el.getAttribute("type") || el.type || "text").toLowerCase();
      return TEXT_INPUT_TYPES.has(type);
    }
    return !!el.isContentEditable;
  }

  function tagIsFocusableFormControl(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = el.tagName.toLowerCase();
    return tag === "select" || tag === "summary" || (tag === "input" && !isDisabled(el));
  }

  function applyTobiiSample(x, y) {
    if (typeof x !== "number" || typeof y !== "number") return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    lastGazeX = x;
    lastGazeY = y;
    lastGazeTime = performance.now();
    // A live sample means the bridge is up, even if status was never received.
    tobiiConnected = true;
  }

  function syncTobiiFromBackground() {
    try {
      chrome.runtime.sendMessage({ type: "contentReady" }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        tobiiConnected = !!res.connected;
        if (res.lastGaze && typeof res.lastGaze.x === "number" && typeof res.lastGaze.y === "number") {
          // Only accept a recent sample so a stale SW cache doesn't pin the pointer.
          const age = typeof res.lastGaze.t === "number" ? Date.now() - res.lastGaze.t : Infinity;
          if (age < 1000) applyTobiiSample(res.lastGaze.x, res.lastGaze.y);
        }
      });
    } catch (_) {
      // Extension context invalidated on reload — ignore.
    }
  }

  // Tobii gaze + status from background service worker
  chrome.runtime.onMessage.addListener((message) => {
    if (!message || !message.type) return;
    if (message.type === "tobiiGaze") {
      applyTobiiSample(message.x, message.y);
      if (message.connected) tobiiConnected = true;
    } else if (message.type === "tobiiStatus") {
      tobiiConnected = !!message.connected;
      if (!tobiiConnected) {
        // Drop stale gaze so we fall back to mouse cleanly on disconnect.
        lastGazeTime = 0;
      }
    }
  });


  // ---------- MutationObserver – handle dynamic DOM ----------
  function onMutations(mutations) {
    let overlaysPossiblyGone = false;
    let currentTargetPossiblyGone = false;

    for (const mutation of mutations) {
      if (mutation.type !== "childList") continue;

      // Check removed nodes
      for (const node of mutation.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;

        // Our overlays were removed
        if (
          node === progressEl ||
          node === highlightEl ||
          (node.contains && (node.contains(progressEl) || node.contains(highlightEl)))
        ) {
          overlaysPossiblyGone = true;
        }

        // The element we are currently dwelling on was removed
        if (currentTarget && (node === currentTarget || (node.contains && node.contains(currentTarget)))) {
          currentTargetPossiblyGone = true;
        }
      }
    }

    if (overlaysPossiblyGone) {
      // Force re-creation on next feedback call
      progressEl = null;
      highlightEl = null;
    }

    if (currentTargetPossiblyGone) {
      currentTarget = null;
      hideFeedback();
    }
  }

  function startMutationObserver() {
    if (mutationObserver) return;

    mutationObserver = new MutationObserver(onMutations);
    mutationObserver.observe(document.documentElement, {
      childList: true,
      subtree: true
      // We intentionally skip attributes & characterData for performance.
      // elementFromPoint + isConnected already covers most dynamic cases.
    });
  }

  function stopMutationObserver() {
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
  }

  // ---------- On-screen keyboard ----------
  let oskEl = null;
  let oskTarget = null;
  let oskShift = false;
  let oskSymbols = false;
  let oskHideTimer = null;

  const OSK_ROWS_ALPHA = [
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
    ["shift", "z", "x", "c", "v", "b", "n", "m", "backspace"],
    ["123", "space", "enter", "close"]
  ];

  const OSK_ROWS_SYMBOLS = [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["@", "#", "$", "%", "&", "*", "-", "+", "(", ")"],
    ["abc", "!", "?", ",", ".", "'", "\"", ":", "backspace"],
    ["@", "space", "enter", "close"]
  ];

  function isOskElement(el) {
    return !!(el && el.closest && el.closest("#eyebrowse-osk"));
  }

  function ensureOsk() {
    if (oskEl && document.documentElement.contains(oskEl)) return oskEl;

    oskEl = document.createElement("div");
    oskEl.id = "eyebrowse-osk";
    oskEl.setAttribute("role", "keyboard");
    oskEl.setAttribute("aria-label", "EyeBrowse on-screen keyboard");

    // Prevent keys from stealing focus from the text field
    oskEl.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
    oskEl.addEventListener("pointerdown", (e) => {
      if (e.target && e.target.closest(".eb-osk-key, .eb-osk-close")) {
        e.preventDefault();
      }
    });

    document.documentElement.appendChild(oskEl);
    renderOskKeys();
    return oskEl;
  }

  function keyLabel(key) {
    if (key === "shift") return oskShift ? "SHIFT" : "Shift";
    if (key === "backspace") return "⌫";
    if (key === "enter") return "Enter";
    if (key === "space") return "Space";
    if (key === "close") return "Hide";
    if (key === "123") return "123";
    if (key === "abc") return "ABC";
    if (!oskSymbols && oskShift && key.length === 1) return key.toUpperCase();
    return key;
  }

  function keyClass(key) {
    const classes = ["eb-osk-key"];
    if (key === "space") classes.push("eb-osk-space");
    if (["shift", "backspace", "enter", "123", "abc", "close"].includes(key)) {
      classes.push("eb-osk-wide", "eb-osk-special");
    }
    if (key === "shift" && oskShift) classes.push("eb-osk-active");
    return classes.join(" ");
  }

  function renderOskKeys() {
    if (!oskEl) return;
    const rows = oskSymbols ? OSK_ROWS_SYMBOLS : OSK_ROWS_ALPHA;
    oskEl.innerHTML = "";

    const bar = document.createElement("div");
    bar.className = "eb-osk-bar";
    bar.innerHTML =
      '<span class="eb-osk-title">On-screen keyboard</span>';
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "eb-osk-close";
    closeBtn.textContent = "Hide";
    closeBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hideOsk(true);
    });
    bar.appendChild(closeBtn);
    oskEl.appendChild(bar);

    for (const row of rows) {
      const rowEl = document.createElement("div");
      rowEl.className = "eb-osk-row";
      for (const key of row) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = keyClass(key);
        btn.textContent = keyLabel(key);
        btn.dataset.oskKey = key;
        btn.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          handleOskKey(key);
        });
        rowEl.appendChild(btn);
      }
      oskEl.appendChild(rowEl);
    }
  }

  function insertIntoTarget(text) {
    const el = oskTarget;
    if (!el || !isStillInDocument(el)) return;

    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      try {
        el.focus();
      } catch (_) {}
    }

    // contenteditable
    if (el.isContentEditable) {
      try {
        if (document.execCommand) {
          document.execCommand("insertText", false, text);
        } else {
          const sel = window.getSelection();
          if (sel && sel.rangeCount) {
            const range = sel.getRangeAt(0);
            range.deleteContents();
            range.insertNode(document.createTextNode(text));
            range.collapse(false);
          }
        }
      } catch (_) {}
      el.dispatchEvent(new InputEvent("input", { bubbles: true, data: text, inputType: "insertText" }));
      return;
    }

    // input / textarea
    if (typeof el.value === "string") {
      const start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
      const end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
      const before = el.value.slice(0, start);
      const after = el.value.slice(end);
      el.value = before + text + after;
      const caret = start + text.length;
      try {
        el.setSelectionRange(caret, caret);
      } catch (_) {}
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function backspaceTarget() {
    const el = oskTarget;
    if (!el || !isStillInDocument(el)) return;

    try {
      el.focus({ preventScroll: true });
    } catch (_) {
      try {
        el.focus();
      } catch (_) {}
    }

    if (el.isContentEditable) {
      try {
        document.execCommand && document.execCommand("delete");
      } catch (_) {}
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      return;
    }

    if (typeof el.value === "string") {
      let start = typeof el.selectionStart === "number" ? el.selectionStart : el.value.length;
      let end = typeof el.selectionEnd === "number" ? el.selectionEnd : el.value.length;
      if (start === end && start > 0) start -= 1;
      el.value = el.value.slice(0, start) + el.value.slice(end);
      try {
        el.setSelectionRange(start, start);
      } catch (_) {}
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function handleOskKey(key) {
    if (key === "close") {
      hideOsk(true);
      return;
    }
    if (key === "shift") {
      oskShift = !oskShift;
      renderOskKeys();
      return;
    }
    if (key === "123") {
      oskSymbols = true;
      oskShift = false;
      renderOskKeys();
      return;
    }
    if (key === "abc") {
      oskSymbols = false;
      renderOskKeys();
      return;
    }
    if (key === "backspace") {
      backspaceTarget();
      return;
    }
    if (key === "enter") {
      insertIntoTarget("\n");
      // Also try submitting nearest form for single-line inputs
      if (oskTarget && oskTarget.tagName && oskTarget.tagName.toLowerCase() === "input") {
        const form = oskTarget.form;
        if (form && typeof form.requestSubmit === "function") {
          try {
            form.requestSubmit();
          } catch (_) {}
        }
      }
      return;
    }
    if (key === "space") {
      insertIntoTarget(" ");
      return;
    }

    let ch = key;
    if (!oskSymbols && oskShift) ch = key.toUpperCase();
    insertIntoTarget(ch);
    if (oskShift && !oskSymbols) {
      oskShift = false;
      renderOskKeys();
    }
  }

  function showOsk(target) {
    if (!settings.oskEnabled || !shouldRun()) return;
    if (!target || !isStillInDocument(target)) return;
    if (isOskElement(target)) return;

    if (oskHideTimer) {
      clearTimeout(oskHideTimer);
      oskHideTimer = null;
    }

    oskTarget = target;
    ensureOsk();
    oskEl.classList.add("eyebrowse-osk-visible");
  }

  function hideOsk(force) {
    if (oskHideTimer) {
      clearTimeout(oskHideTimer);
      oskHideTimer = null;
    }
    const doHide = () => {
      if (oskEl) oskEl.classList.remove("eyebrowse-osk-visible");
      if (force) oskTarget = null;
    };
    if (force) doHide();
    else {
      // Brief delay so clicking/dwelling a key doesn't flash-hide on focusout
      oskHideTimer = setTimeout(doHide, 180);
    }
  }

  function onFocusIn(e) {
    const t = e.target;
    if (!t || !shouldRun() || settings.oskEnabled === false) return;
    if (isOskElement(t)) return;

    let el = t;
    // Climb to contenteditable host if needed
    if (el.nodeType === Node.TEXT_NODE) el = el.parentElement;
    if (!el) return;

    if (isTextEntryTarget(el)) {
      showOsk(resolveActivationTarget(el) || el);
      return;
    }
    // Focus may land on a child of contenteditable
    if (el.closest && el.closest('[contenteditable="true"]')) {
      const host = el.closest('[contenteditable="true"]');
      showOsk(resolveActivationTarget(host) || host);
    }
  }

  function onFocusOut(e) {
    const next = e.relatedTarget;
    if (isOskElement(next)) return;
    // If focus moves to another text field, focusin will re-show
    hideOsk(false);
  }

  function startOskListeners() {
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("focusout", onFocusOut, true);
    // If something is already focused when extension becomes active
    const active = document.activeElement;
    if (active && isTextEntryTarget(active)) {
      showOsk(resolveActivationTarget(active) || active);
    }
  }

  function stopOskListeners() {
    document.removeEventListener("focusin", onFocusIn, true);
    document.removeEventListener("focusout", onFocusOut, true);
    hideOsk(true);
  }

  // ---------- Lifecycle ----------
  function start() {
    ensureOverlayElements();
    document.addEventListener("mousemove", onMouseMove, { passive: true });
    startMutationObserver();
    startOskListeners();
    if (!rafId) {
      rafId = requestAnimationFrame(tick);
    }
  }

  function stop() {
    document.removeEventListener("mousemove", onMouseMove);
    stopMutationObserver();
    stopOskListeners();
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    currentTarget = null;
    hideFeedback();
  }

  // React to settings changes
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;

    for (const [key, { newValue }] of Object.entries(changes)) {
      settings[key] = newValue;
    }
    if (!Array.isArray(settings.siteList)) settings.siteList = [];

    applyColors();
    updateSiteAllowed();

    if (changes.oskEnabled && settings.oskEnabled === false) {
      hideOsk(true);
    }

    // Restart or stop based on combined enabled + site filter state
    if (shouldRun()) {
      if (!rafId) start();
      else if (settings.oskEnabled !== false) startOskListeners();
    } else {
      stop();
    }
  });

  // Boot
  loadSettings().then(() => {
    // Always sync Tobii status after settings load. If the page (re)loaded
    // while the WS was already connected, we would otherwise never set
    // tobiiConnected and would ignore gaze samples for dwell.
    syncTobiiFromBackground();
    if (shouldRun()) start();
  });
})();
