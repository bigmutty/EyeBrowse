# EyeBrowse

Browser extension that activates links and other clickable elements when the mouse cursor dwells on them for a configurable amount of time.

Designed for people who use eye trackers (Tobii, Windows Eye Control, etc.) that move the system mouse pointer to the gaze location.

This project is still in an early stage of development; therefore, bugs are to be expected.

## Features

- **Dwell-to-click** – Hold the cursor over a clickable element for the configured time → it is activated.
- **Broad clickable detection** – Not limited to `<a>` tags. Detects:
  - Links, buttons, inputs, selects, textareas, summary
  - Text fields get **focus** (not only a synthetic click), including ARIA `textbox` / `searchbox` / `combobox`
  - Elements with ARIA roles (`button`, `link`, `menuitem`, …)
  - Elements with `onclick` handlers
  - Focusable elements (`tabindex ≥ 0`)
  - Elements with `cursor: pointer`
- **Visual feedback** – Progress ring at the cursor + highlight outline on the target.
- **Configurable** – Dwell time, cooldown, minimum size, colors, enable/disable.
- **Site filter** – Blacklist or whitelist sites by hostname (subdomains match automatically). Manage from Options or the popup on the current page.
- **Works in iframes** (content script runs in all frames).
- **Dynamic DOM support** – MutationObserver detects when the current target or the feedback overlays are removed (common in SPAs) and resets / recreates them automatically.

## Installation (Chrome / Edge / Brave)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the 'EyeBrowse' folder.

## Usage

1. Make sure your eye tracker is moving the system mouse cursor.
2. Click the extension icon → toggle **Enabled** and adjust dwell time if needed.
3. Look at a link or button and hold your gaze (cursor) steady until the progress ring completes.
4. Open the full **Options** page for more settings.

## Default settings

| Setting | Default |
| --- | --- |
| Enabled | true |
| Dwell time | 1000 ms |
| Show progress | true |
| Min element size | 8 px |
| Click cooldown | 600 ms |
| Site filter mode | off |
| Site list | (empty) |
| Tobii WebSocket | disabled |
| Tobii WS URL | ws://localhost:8887 |

## Tobii WebSocket setup

Tobii does not expose browser APIs directly. Use a **local WebSocket bridge** that talks to the Tobii SDK / EyeX / Interaction API and streams gaze points:

1. Install and run a bridge, for example:
   - [Tobii EyeX Web Socket Server](https://github.com/rezreal/Tobii-EyeX-Web-Socket-Server) (default `ws://localhost:8887`, optional port arg e.g. `8886`)
   - Other Pro SDK bridges that emit JSON gaze messages
2. Make sure the **Tobii EyeX / Interaction engine** is running and tracking before starting the bridge.
3. In EyeBrowse **Options → Tobii WebSocket**, enable the bridge and set the URL (default `ws://localhost:8887`).
4. When the badge shows **ON** and Options shows live gaze coordinates, dwell uses those points (screen space converted to the page viewport).

### EyeX bridge details

EyeBrowse speaks the [rezreal](https://github.com/rezreal/Tobii-EyeX-Web-Socket-Server) protocol:

- Connects with the `Tobii.Interaction` WebSocket subprotocol (falls back to a plain socket for other bridges)
- Sends `startGazePoint` on connect
- Parses `{ "type": "gazePoint", "data": { "X": …, "Y": … } }` (screen pixels)

Also accepted: `{ x, y }`, `{ gazePoint: { X, Y } }`, and averaged left/right eye points.

### If the socket connects but links never activate

1. **Reload the extension** on `chrome://extensions` after updating, then refresh the page.
2. In Options, confirm status shows **gaze streaming** with changing `(x, y)` — connected without samples means the tracker or `startGazePoint` subscription is not live.
3. Keep **Prefer Tobii gaze over mouse** enabled when the eye tracker does *not* move the system cursor.
4. If the progress ring appears offset from where you look, move the mouse once on the page (calibrates screen→viewport) or check Windows display scaling / multi-monitor layout.

## Limitations & future ideas

- Pure JavaScript `addEventListener('click')` handlers that are not reflected in the DOM are not always detectable (this is a browser limitation). The heuristics catch the majority of real-world interactive elements.
- Direct hardware eye-tracker APIs (Tobii Pro SDK, WebGazer, etc.) can be added later as an alternative input source instead of relying on the system mouse.
- Extremely aggressive DOM thrashing (thousands of mutations per second) can still impact performance; the observer is limited to `childList` + `subtree` for this reason.

## File structure

```
EyeBrowse/
├── manifest.json
├── background.js
├── content.js
├── content.css
├── popup.html / popup.js
├── options.html / options.js
├── icons/
└── README.md
```

## License

MIT – free to use, modify, and distribute.
