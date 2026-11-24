# StoryGraph Sync for CrossPoint

A CrossPoint / CrossInk SD-card plugin that syncs reading progress, per-session reading journals, and start/finish dates from your e-reader directly to **The StoryGraph** via the File Manager Web UI (`/files`).

> **Tested Firmware:** **CrossInk 2.0.0 RC3** (XTEInk X4 Pro)  
> **Compatibility:** **CrossPoint 2.0.0 RC / nightly** (`firmware_family: crosspoint`, `plugin_api >= 1`)

## Features

- **Per-session reading diary (`reading-history.json` v2):** Preserves each individual `reader.session` sitting (duration, local time-of-day range, start/end progress, midnight-spanning dates) with a persistent synchronization ledger (`sessionId → journalEntryId → syncStatus`) and single-candidate interrupted-sync reconciliation. Firmware builds that only emit `reader.exit` gracefully record `progress_checkpoint` entries.
- **Progress, status & dates:** Updates StoryGraph progress (pages or percentage), marks finished books as **Read** (including books moved into `/Read/`), and syncs start/finish dates while preserving earlier start dates already on StoryGraph.
- **Clean Journals & resilient fetching:** Repairs stray `100%` / `0%` StoryGraph journal entries while strictly preserving ledger-bound and note-bearing sessions; automatically retries transient `/api/fetch` errors with backoff (never reading stale SD cache on failure) and skips already-verified clean **Read** books via a local activity watermark.
- **Browse SD Library & Session History Import:** Link older or already-finished books directly from your SD card, or import historical sessions from CrossPoint Sync exports, `reading-history.json`, or `events.jsonl`.
- **Privacy-first storage:** StoryGraph session cookies stay strictly in browser `localStorage` and are never written to the microSD card.

---

## Setup Guide

### 1. Install the Plugin

#### Option A — CrossPoint Plugin Hub (Recommended)
1. Enable **Settings → System → Plugins** (or **Connectivity → Plugins**) on your e-reader.
2. Open **Home → Plugins → Plugin Hub** (or the Plugin Hub WebUI).
3. Find **StoryGraph Sync** under **Community Plugins** and click **Install**.
4. **Reboot your e-reader once** so firmware registers the `reader.exit` and `reader.session` event subscriptions.

#### Option B — Manual SD Card Install
1. Connect your e-reader in **USB Drive** mode (or insert the microSD card into your computer).
2. Copy the contents of [`storygraph-sync.crosspoint-plugin/`](storygraph-sync.crosspoint-plugin/) into:
   ```text
   /.crosspoint/plugins/storygraph-sync/
   ```
3. Eject safely, enable **Plugins** in device settings, and **reboot once**.

---

### 2. Record Your First Reading Event

Open any book on your e-reader, read a few pages, and exit back to Home. Firmware automatically records your progress and sitting details to `/.crosspoint/plugins/storygraph-sync/events.jsonl` (without waking Wi-Fi during sleep).

---

### 3. Connect Your StoryGraph Account (Browser Cookies)

Because The StoryGraph does not offer a public API, the plugin signs requests using your existing browser session cookies:

#### Option A — Desktop Browser
1. Log in to `https://app.thestorygraph.com/` in your desktop browser (ideally on the same non-VPN network as your e-reader if Cloudflare challenges requests).
2. Open DevTools (**F12**) → **Network** tab → reload (**F5**).
3. Click the main `app.thestorygraph.com` document request → **Request Headers** → copy the `cookie` header (or **Copy as cURL**).

#### Option B — Smartphone Only (No PC)
1. Install the **Cookie-Editor** extension in **Firefox** (Android) or **Safari** (iOS) and log in to `https://app.thestorygraph.com/` in that browser.
2. Open **Cookie-Editor** on `app.thestorygraph.com` and tap **Export → JSON** (or **Header String**).
   - *Tip:* Open `http://crosspoint.local/files` in that **same browser** so your `User-Agent` automatically matches — or set up once on desktop, click **Export Settings** (under **Account Settings → Advanced & Backup**), copy the JSON file to your phone, and use **Import Settings**.

#### Paste & Verify
1. Start **File Transfer** on your e-reader and open `http://crosspoint.local/files` in your browser.
   - *Tip:* Using `http://crosspoint.local/files` instead of a raw IP keeps your browser `localStorage` cookies intact even if your router assigns a new DHCP IP later.
2. Expand **Account Settings** and paste into **StoryGraph Cookies** (smart-paste accepts raw cookie headers, DevTools `cookie: ...`, **Cookie-Editor JSON**, Netscape `cookies.txt`, or cURL).
3. *(Optional)* Customize **Journal device label** (defaults to `CrossPoint`, e.g. `X4 Pro` — saved on the SD card inside `storygraph-map.json` alongside your journal/batch toggles so it persists across IP changes and devices) or uncheck **Include reading duration in StoryGraph journal notes** (a live note preview updates below). Only edit **User-Agent** under **Advanced & Backup** if you copied cookies from a different browser.
4. Click **Verify Session**. You should see a green **Connected** badge and your StoryGraph **Current Reads** count.

> **Security & Privacy Note:** Your session cookies are stored **only** in your browser's `localStorage` and are never written to the microSD card. `_storygraph_session` rotates automatically whenever StoryGraph sends `Set-Cookie`. Because firmware caps outbound request headers at `4,096` bytes / 16 headers, the plugin automatically trims non-essential cookies if your header is large (keeping `_storygraph_session`, `remember_user_token`, `cf_clearance`, and `__cf_bm`).

---

### 4. Link Books & Sync

1. **Link books:** Click **Link Book** on any tracked book and match it using:
   - **Current Reads** (one-click match from your StoryGraph shelf),
   - **Search StoryGraph** (`/browse`), or
   - **Book URL / ID** (`https://app.thestorygraph.com/books/<id>`).
2. **Add older or already-finished books:** Expand **Browse SD Library**, navigate to a folder, and click **Add & Link**. Once linked, click **Mark Read** for finished books or leave them pre-linked for future sessions.
3. **Sync progress & reading journal:**
   - Click **Sync Now** on one book or **Sync All** in the header to push all pending reading sessions, progress updates, **Read** completions, and start/finish dates.
   - Each sitting is recorded individually in StoryGraph's **Reading Journal** (e.g. `20:10–20:55 · 45m read on CrossPoint`).
   - Use **Sync Dates** anytime to align start/finish dates for previously synced books.
   - Use **Clean Journals** (under **Tools & Preferences**, or **Clean Journal** inside any book's **Reading history** alongside **Open Journal ↗**) anytime to clean stray `0%` or un-ledgered duplicate `100%` journal artifacts while preserving all genuine reading sessions.
   - Use **Compact Outbox** (under **Tools & Preferences**, or keep **Auto-compact after Sync All** enabled) to keep `events.jsonl` well under firmware's 4 KB outbox cap.
   - Use **Import Session History** (under **Tools & Preferences**) anytime to import historical sessions from CrossPoint Sync exports, `reading-history.json`, or `events.jsonl`.
4. **Badges to watch for:**
   - **Journal unsynced:** Progress matches StoryGraph, but some reading sessions are not in the Reading Journal yet. These books appear under **Needs Sync** and are included in **Sync All**.
   - **Needs reconciliation:** An interrupted journal post left more than one matching entry on StoryGraph. Open the book's **Reading history**, click **Open Journal ↗** to check, then click **Mark Synced** (the entry already exists, so nothing is posted) or **Retry** (queue the session again for the next sync).

---

### 5. Troubleshooting

- **Cloudflare 403 / 503 or "session expired":** Make sure your desktop browser and e-reader are on the same network (no VPN mismatch), reload `app.thestorygraph.com` in your browser, copy a fresh `cookie` header (including `cf_clearance`), and click **Verify Session**.
- **No books appear after installing:** Make sure **Plugins** is enabled in device settings and you **rebooted once** after installing (firmware builds its event subscription table only at boot), then open and exit a book.
- **Transient `/api/fetch` transport errors during batch operations:** The plugin automatically retries transient network/transport errors up to 2 times with backoff and caches verified-clean **Read** books to minimize consecutive TLS handshakes.

---

## Optional: Historical SD Backfill

To backfill pre-plugin reading progress, durations, and dates from existing on-device EPUB caches (`/.crosspoint/epub_*/`), connect your e-reader in **USB Drive** mode and run:

```bash
python backfill_sd.py --write-sd
```

*(Pass `--sd-root E:\` if auto-detection doesn't find the drive.)* Eject safely, switch back to **File Transfer**, and reload `/files`.

---

## Repository Structure

```text
storygraph-sync/
├── .github/workflows/release.yml        # Automated ZIP + SHA256SUMS.txt GitHub Release workflow
├── src/
│   └── plugin.js                        # Readable source for the browser plugin UI
├── scripts/
│   └── build.mjs                        # Zero-dep builder -> storygraph-sync.crosspoint-plugin/plugin.js (<256 KB)
├── storygraph-sync.crosspoint-plugin/   # Installable Plugin Hub payload
│   ├── manifest.json
│   ├── device.json
│   ├── plugin.js
│   ├── README.md
│   └── DETAILS.md
├── backfill_sd.py                       # Optional USB historical cache backfill tool
├── harness/                             # Local mock CrossPoint + StoryGraph test harness
│   ├── server.mjs
│   └── test.mjs
├── docs/
│   └── architecture.md                  # Technical design & firmware plugin API notes
└── LICENSE
```

## Development & Tests

Build `storygraph-sync.crosspoint-plugin/plugin.js` from `src/plugin.js` and run the local mock CrossPoint + StoryGraph test suite (Node.js 18+, zero npm dependencies):

```bash
node scripts/build.mjs
node --check src/plugin.js
node --check storygraph-sync.crosspoint-plugin/plugin.js
node --check harness/server.mjs
node harness/test.mjs
```

## License

[MIT](LICENSE)
