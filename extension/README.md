# logflow-sim — Browser Extension

A Chrome / Firefox (and Chromium-compatible) extension that runs the full
logflow-sim kernel directly in your browser. Open a configuration block on
any web page (a GitHub PR, a Confluence article, a Gist), click **Open in
logflow-sim**, and inspect what the config would do — without uploading
anything to a server.

## Build

From the repo root:

```bash
npx vite build --config extension/vite.config.ts
```

That produces `dist-extension/` with:

```
dist-extension/
├── manifest.json
├── popup.html
├── popup.js
├── popup.css
├── content-script.js
├── background.js
└── icon-{16,48,128}.png    # add your own
```

## Install (Chrome)

1. Open `chrome://extensions`
2. Toggle **Developer mode** (top right)
3. Click **Load unpacked**
4. Pick the `dist-extension/` directory

## Install (Firefox)

1. Open `about:debugging`
2. Click **This Firefox** → **Load Temporary Add-on**
3. Select `dist-extension/manifest.json`

## How it works

- **Content script** (`content-script.js`) runs on every page, scans for
  `<pre>` / `<code>` blocks that match a small set of rsyslog /
  syslog-ng / Fluent Bit / NXLog / Logstash / Vector signatures, and adds a
  small "Open in logflow-sim" button above each match.
- **Popup** (`popup.html`) hosts the same kernel as the server-side build:
  the user pastes a config + optional raw syslog message, and gets the
  trace + diagnostics back without any network call.
- **Background service worker** (`background.js`) is a stub today — kept
  so future capabilities (alarms, omnibox, cross-tab state) have a home.

## Permissions used

- `storage` — to hand the popup the config the content script captured
- `activeTab` + `scripting` — for the content script
- `<all_urls>` — required so detection works on any page (we don't read
  page state; just look for visible `<pre>`/`<code>` text)

No outbound network calls. No analytics. No telemetry.
