# StoryGraph Sync Plugin — MVP Build Plan

**Target Hardware:** XTEInk X4 Pro (`xteink_x4_pro`, ESP32-S3, ~99 KB typical free heap in File Transfer mode)  
**Target Firmware:** CrossInk `v2.0.0-0b939f4-RC` (`firmwareFamily: "crosspoint"`, `pluginApi: 1`)  
**Plugin Runtime:** Hybrid SD-Card Plugin — declarative `device.json` firmware event subscriber (`events.jsonl` outbox) + Browser-Mounted Web UI (`plugin.js`, `"mount": "files"`)  
**Verified `pluginCapabilities`:** `catalog.lists`, `catalog.notices`, `catalog.bundle_install`, `catalog.version_tracking`, `catalog.compatibility`, `catalog.item_details`, `events.reader.open`, `events.reader.exit`, `events.reader.session`, `events.book.downloaded`, `events.sleep.enter`, `crypto`, `book.key`, `book.protected`, `catalog.encoded_item_fields`

---

## 1. Architecture Overview

Because The StoryGraph does not provide an official public API, syncing relies on browser session cookies, Rails CSRF tokens, and HTML/Turbo form submissions. On CrossInk `v2.0.0-0b939f4-RC`, a browser plugin **cannot** read `/.crosspoint/` system or book-cache files directly over HTTP:

- `GET /download?path=/.crosspoint/...` returns **`HTTP 403 Forbidden`** (`Access denied to protected path`).
- The firmware's `/plugin-host.js` does **not** expose `api.readFile`. Browser-side reads are scoped to the plugin's own directory via `api.pluginFile(file)` (`/plugin?name=<name>&file=<file>`), and writes via `api.writeFile(path, dataB64)` (`/api/plugin-fs`) are sandboxed to the plugin directory.

Instead of attempting to read protected EPUB cache binaries over HTTP, the plugin uses **firmware event subscriptions** (`events.jsonl`) combined with the File Manager Web UI:

1. **On-Device Event Collector (`device.json` → `events.jsonl`):** Subscribes to `reader.exit` and `reader.session`. Whenever you close a book or finish a reading session on the X4 Pro, CrossInk appends a JSON line (carrying stringified fields inside `vars`, such as `book`, `percent`, `end_percent`, `start_progress_bp`, `end_progress_bp`, `progress_scale: "10000"`, and `duration_seconds`) into `/.crosspoint/plugins/storygraph-sync/events.jsonl`. Declaring a fast-failing local spool URL (`http://127.0.0.1:1/storygraph-spool`) with default `"connect": false` (never wakes Wi-Fi at sleep) ensures queued events remain in `events.jsonl` until `plugin.js` reads and compacts them.
2. **Browser Client (`plugin.js`):** Renders the UI card inside CrossInk's File Manager (`/files`) when File Transfer mode is active. Reads `events.jsonl` and `storygraph-map.json` via `fetch(api.pluginFile(...))`, reduces the latest progress per book, parses StoryGraph HTML responses using `DOMParser`, and persists mappings via UTF-8-safe Base64 `api.writeFile(api.dir + '/storygraph-map.json', ...)`.
3. **ESP32-S3 HTTP Bridge (`/api/relay` + `/api/fetch` fallback):** Proxies outbound HTTPS requests to `https://app.thestorygraph.com` to bypass browser CORS restrictions. Uses `api.relay()` for lightweight requests (**32 KB** `32,768` B firmware response body cap, **4 KB** `4,096` B / 16-header request cap; does not follow `3xx` redirects) and form submissions (sending `Accept-Encoding: gzip` so Rails JS/HTML responses compress well under 32 KB), and uses `api.fetchToSd(url, api.dir + '/tmp-fetch.html', ...)` → `fetch(api.pluginFile('tmp-fetch.html'))` for large HTML `GET` responses (plus post-502 confirmation checks if a `POST` overflows the 32 KB buffer after StoryGraph applies it).

### Directory & Storage Layout

```text
/.crosspoint/plugins/storygraph-sync/
├── manifest.json         # Plugin title, "files" mount point, compatibility metadata
├── device.json           # Declarative event subscriptions (reader.exit, reader.session)
├── plugin.js             # UI card, events.jsonl reducer, and StoryGraph relay client
├── events.jsonl          # Firmware-written outbox of reading progress/session events
├── storygraph-map.json   # Plugin-managed book mappings & lastSyncedPercent (via api.writeFile)
├── tmp-fetch.html        # Ephemeral scratch file for large HTML GETs via api.fetchToSd()
└── README.md             # Setup, cookie extraction, and troubleshooting guide
```

| Data Layer | Storage Location | Purpose & Constraints |
| :--- | :--- | :--- |
| **Session Cookies** | Browser `localStorage` | Stores session cookies on your client device (masked via `type="password"` inputs; never written to the microSD card). Access the UI via `http://crosspoint.local/` so DHCP IP changes do not isolate `localStorage`, and include JSON export/import backup. |
| **Reading Progress** | `/.crosspoint/plugins/storygraph-sync/events.jsonl` | Appended on-device by CrossInk firmware on `reader.exit` / `reader.session` (4 KB max outbox; 512 B/line; subscription table built at boot); read by `plugin.js` via `api.pluginFile('events.jsonl')`. |
| **Book Mappings & Sync State** | `/.crosspoint/plugins/storygraph-sync/storygraph-map.json` | Persisted inside the plugin directory via `api.writeFile(api.dir + '/storygraph-map.json', ...)`. Keyed by `sdPath` with fallback matching on normalized `(title, author)` and filename so moving books via `organize_books.py` preserves links. |

---

## 2. Verified CrossInk `v2.0.0-0b939f4-RC` Plugin Host Contract

Inspected directly from `/plugin-host.js` inside `firmware-x4-pro-v2.0.0-0b939f4-RC.bin`, CrossInk calls `CrossPoint.registerPlugin((container, api) => { ... })` synchronously on load and injects the following `api` surface:

| Member | Signature / Type | Verified Firmware Behavior |
| :--- | :--- | :--- |
| `api.name` | `string` | Plugin folder/identifier (e.g., `"storygraph-sync"`). |
| `api.dir` | `string` | Plugin SD directory path (e.g., `"/.crosspoint/plugins/storygraph-sync"`). |
| `api.relay` | `(method, url, headers, body) => Promise<{ status, headers, body }>` | Calls `POST /api/relay`. Firmware caps upstream response bodies at **32 KB** (`32,768` B) and outbound request headers at **4 KB** (`4,096` B) / **16** headers (forbidding `host`, `content-length`, `transfer-encoding`, `connection`, `range`), and does **not** decompress gzip. Does **not** follow `3xx` redirects. `headers` is an ordered array of `[name, value]` pairs (preserving duplicate `Set-Cookie` headers). Throws an `Error` on `502` (`{"error":"relay failed; large bodies need /api/fetch"}`). |
| `api.writeFile` | `(path, dataB64) => Promise<object>` | Requires an **absolute SD path** inside `api.dir` (e.g., `api.dir + '/storygraph-map.json'`, no `..`, no leading dot on filename) and a **Base64-encoded** string (non-empty, ≤ **256 KB**). Posts multipart `POST /api/plugin-fs?plugin=<name>&path=<path>` and writes atomically via `<path>.tmp`. |
| `api.fetchToSd` | `(url, dest, headers) => Promise<object>` | Chunked `POST /api/fetch` (2 MiB segments) that streams large `GET` payloads directly to an **absolute SD path** `dest` (e.g., `api.dir + '/tmp-fetch.html'`); read back with `fetch(api.pluginFile('tmp-fetch.html'))` and delete `dest` in a `finally` block via `POST /delete` (if permitted) or overwrite cleanly. |
| `api.pluginFile` | `(file) => string` | Returns `/plugin?name=<name>&file=<file>` (served with `Cache-Control: no-cache` and `ETag`). Used to read `events.jsonl`, `storygraph-map.json`, and `tmp-fetch.html`. |
| `api.registerAction` | `(action, fn) => void` | Registers named actions executed via `/api/plugin-jobs` (polled on `/files`, `/settings`, or `/plugins-run`). Reserved for v2 background automation. |
| `api.crypto` | `(op, fields) => Promise<object>` | Calls `POST /api/crypto` (`random`, `aesenc`, `aesdec`, `rsadec`, `keygen`, `pubencrypt`, `pkcs12`). |

### `device.json` Event Schema & Drain Semantics

Verified against `docs/plugin-events.md` and `v2.0.0-0b939f4-RC` firmware capabilities:

- **Subscription Limits:** Plugin folder name ≤ 23 bytes (`storygraph-sync` = 15 B), full folder path ≤ 63 bytes (`/.crosspoint/plugins/storygraph-sync` = 36 B), max 8 subscribed plugins, 512 B per event line, 4 KB outbox cap (dropped wholesale if exceeded), and the subscription table is rebuilt **only at boot** (reboot required after install/edit).
- **Verified Event Fields (`ev.vars`, all values are strings):**
  - `reader.exit`: `book` (SD path), `percent` (top of visible page, `"0"`–`"100"`), `end_percent` (bottom of visible page; `"100"` only on the last page or end-of-book screen — treat `end_percent === "100"` as finished).
  - `reader.session`: `book`, `document` (32-char hex KOSync partial-MD5), `start_time`, `end_time`, `duration_seconds`, `start_progress_bp`, `end_progress_bp`, `progress_scale` (`"10000"`). Fires only for active forward reading dwells ≥ 10 s.
- **Drain Semantics:** CrossInk drains `events.jsonl` automatically whenever Wi-Fi connects (including File Transfer in STA mode), removing an event line on HTTP `2xx` and halting on the first failed delivery. To keep events queued locally for the browser UI without waking Wi-Fi on sleep, declare `"request"` handlers pointing to a fast-failing loopback spool URL (`http://127.0.0.1:1/storygraph-spool`) with default `"connect": false`.

### Reference Browser Helpers

```javascript
function pluginPath(api, filename) {
  const dir = (api && typeof api.dir === 'string' && api.dir.startsWith('/'))
    ? api.dir.replace(/\/+$/, '')
    : '/.crosspoint/plugins/' + ((api && api.name) || 'storygraph-sync');
  return `${dir}/${filename}`;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function writePluginJson(api, filename, obj) {
  const json = JSON.stringify(obj, null, 2);
  return api.writeFile(pluginPath(api, filename), utf8ToBase64(json));
}

async function readPluginText(api, filename) {
  const res = await fetch(api.pluginFile(filename), { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Failed to read ${filename}: HTTP ${res.status}`);
  return res.text();
}

function extractSetCookies(headers) {
  const cookies = {};
  for (const [name, value] of headers || []) {
    if (String(name).toLowerCase() === 'set-cookie') {
      const pair = String(value).split(';', 1)[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
      }
    }
  }
  return cookies;
}

function toFiniteNumber(val) {
  if (val === null || val === undefined || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function computePercentFromVars(vars) {
  const endPct = toFiniteNumber(vars.end_percent);
  if (endPct !== null) {
    return Math.max(0, Math.min(100, Math.round(endPct)));
  }
  const endBp = toFiniteNumber(vars.end_progress_bp);
  if (endBp !== null) {
    const scaleRaw = toFiniteNumber(vars.progress_scale);
    const scale = scaleRaw && scaleRaw > 0 ? scaleRaw : 10000;
    return Math.max(0, Math.min(100, Math.round((endBp / scale) * 100)));
  }
  const pct = toFiniteNumber(vars.percent);
  if (pct !== null) {
    return Math.max(0, Math.min(100, Math.round(pct)));
  }
  return null;
}

function reduceEventsJsonl(jsonlText) {
  const byBook = new Map();
  if (!jsonlText) return byBook;

  for (const rawLine of jsonlText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // Skip incomplete/malformed trailing lines safely
    }

    const vars = ev && typeof ev.vars === 'object' && ev.vars ? ev.vars : ev;
    const sdPath = vars.book || vars.path || vars.book_path || vars.sdPath;
    if (!sdPath) continue;

    const percent = computePercentFromVars(vars);
    const endPct = toFiniteNumber(vars.end_percent);
    const prev = byBook.get(sdPath);
    byBook.set(sdPath, {
      sdPath,
      documentHash: vars.document || prev?.documentHash || '',
      percent: percent !== null ? percent : (prev?.percent ?? null),
      finished: endPct === 100 || (prev?.finished ?? false),
      lastEvent: ev.e || ev.event || prev?.lastEvent || '',
      lastReadTs: toFiniteNumber(ev.ts) || toFiniteNumber(vars.end_time) || prev?.lastReadTs || null,
      durationSeconds: (prev?.durationSeconds || 0) + (toFiniteNumber(vars.duration_seconds) || 0),
    });
  }
  return byBook;
}
```

> **Appendix Note — Offline SD Cache Reference (Corrected):**  
> The browser web plugin uses `events.jsonl` and does **not** touch `/.crosspoint/epub_*/`. If you ever build a separate offline PC/USB-Drive companion script, note how CrossInk `v2.0.0-0b939f4-RC` actually stores on-disk caches:
> - **Directory Hash:** **64-bit FNV-1a** (`offset = 0xcbf29ce484222325n`, `prime = 0x100000001b3n`), formatted as unsigned base-10 decimal (`BigInt` required in JS — *not* IEEE CRC-32).
> - **`progress.bin`:** 10 bytes little-endian (`uint16 spineIndex`, `uint16 page`, `uint16 pageCount`, `uint32` offset at `0x06..0x09` — *not* a `uint8` percentage).
> - **`progress_percent.bin`:** 7-byte file `struct.unpack("<4sBH", raw[:7])` (`"PRPE"` magic, `uint8` version `1`, `uint16 LE` basis points `0..10000`, e.g. `10000` = `100%`).
> - **`stats_v7_<profile>.bin` (`99 B`) / `stats_v5*.bin` (`73 B`):** `uint16` sessions (`0x01`), `uint32` duration seconds (`0x03`), `uint32` pages turned (`0x07`), `uint8` finished flag (`0x0B`), `uint16/uint8/uint8` start date (`0x11..0x14`), and finish date (`0x15..0x18`, zeroed while still reading).

---

## 3. Verified Phase 0 Findings & StoryGraph HTTP Contract

### Verified Phase 0 Hardware & Firmware Findings (`v2.0.0-0b939f4-RC`)

- **Cloudflare & Network Access (Passed):** With ~97.5 KB free heap in File Transfer mode, the X4 Pro directly reached `https://app.thestorygraph.com/` via `api.fetchToSd` (`HTTP 200`, `141,165` bytes, `cloudflareBlocked: false`, `redirectedToSignIn: false`, `hasCsrfMeta: true`, `hasAuthenticityInput: true`). No LAN proxy is needed.
- **Large HTML Transport & Relay Limits:** `api.relay()` returned `502` (`relay failed; large bodies need /api/fetch`) on the 141 KB StoryGraph homepage, and binary inspection of `firmware-x4-pro-v2.0.0-0b939f4-RC.bin` (`handlePluginRelay` / `PluginHttp`) confirmed `/api/relay` has a **`32 KB` (`32,768` B)** response body cap and both `/api/relay` and `/api/fetch` enforce a **`4 KB` (`4,096` B) / 16-header** request header cap (without decompressing gzip). All StoryGraph HTML `GET` requests therefore go through `api.fetchToSd(url, api.dir + '/tmp-fetch.html', headers)` → `fetch(api.pluginFile('tmp-fetch.html'), { cache: 'no-store' })` (uncompressed), while XHR form `POST`s use `api.relay()` with `Accept-Encoding: gzip`, automatic non-essential cookie trimming near 4 KB, direct `status=read` for unstarted `100%` books, and post-502 `/api/fetch` verification.
- **`events.jsonl` Schema Confirmed:** Loopback spooling (`http://127.0.0.1:1/storygraph-spool`) retains events reliably (`5` lines, `1,192` bytes, `0` malformed):
  - `reader.session` emits `vars`: `book`, `document`, `start_time`, `end_time`, `duration_seconds`, `start_progress_bp`, `end_progress_bp`, `progress_scale` (`"10000"`).
  - `reader.exit` emits `vars`: `book`, `percent` (note: `end_percent` is **not** emitted on `v2.0.0-0b939f4-RC`, so the UI provides a manual **Mark Read** button in addition to auto-marking `read` at `100%`).
- **Write & Delete Quirk:** `api.writeFile()` passed UTF-8 round-trip (`105` bytes), whereas `POST /delete` inside `/.crosspoint/plugins/storygraph-sync/` returned `HTTP 500`. Therefore the plugin never depends on `POST /delete` and instead reuses `tmp-fetch.html` in place (atomically replaced by `/api/fetch`).

### StoryGraph Unofficial HTTP Contract (Cross-Checked with `Lyfts/ShelfSync` & `storygraph-wrapper`)

1. **Session Cookies & Rotation:**
   - Primary cookies: `_storygraph_session` (no underscore between `story` and `graph`) and `remember_user_token` (plus `cookies_popup_seen=yes; plus_popup_seen=yes`, and any extra cookies such as `cf_clearance` if the user pastes a full `Cookie` header).
   - `POST` responses via `api.relay()` inspect `Set-Cookie` headers and merge rotated `_storygraph_session` values back into browser `localStorage`.
2. **Homepage & Current Reads (`GET https://app.thestorygraph.com/` via `api.fetchToSd`):**
   - Confirms authentication, extracts `<meta name="csrf-token">` (or `input[name="authenticity_token"]`), and extracts books under the **Current Reads** `<h2>` heading for 1-click linking.
3. **Edition Search (`GET https://app.thestorygraph.com/browse?search_term=<query>` via `api.fetchToSd`):**
   - Parses `.book-title-author-and-series` (`a[href^="/books/"]`, `a[href^="/authors/"]`, page counts, `.edition-info` format, filtering out audiobooks by default) with fallback to `a.book-list-option[href^="/books/"]`.
4. **Book Status & Fresh CSRF (`GET https://app.thestorygraph.com/books/<bookId>` via `api.fetchToSd`):**
   - Extracts fresh CSRF token, `.read-status-label` shelf status (`currently-reading`, `rereading`, `to-read`, `paused`, `did-not-finish`, `read`), `read_status[book_num_of_pages]`, `read_status[progress_type]` (`percentage` vs `pages`), `read_status[last_reached_percent]`, and `read_status[last_reached_pages]`.
5. **Shelf-Status Transitions (`POST https://app.thestorygraph.com/update-status.js?book_id=<bookId>&status=<status>` via `api.relay`):**
   - Form body: `authenticity_token=<csrf>` with headers `X-CSRF-Token`, `X-Requested-With: XMLHttpRequest`, `Accept: text/javascript, application/javascript, application/ecmascript, application/x-ecmascript, */*; q=0.01`, `Accept-Encoding: gzip`, `Content-Type: application/x-www-form-urlencoded; charset=UTF-8`, `Origin`, `Referer` (auto-trimmed under 4 KB).
   - Only posts `status=currently-reading` if the book is not already `currently-reading` or `rereading` (falling back to `rereading` on `422`), avoiding accidental start-date resets. Unstarted `100%` books post `status=read` directly in 1 POST instead of 3.
6. **Progress Update (`POST https://app.thestorygraph.com/update-progress` via `api.relay`):**
   - URL-encoded body: `read_status[progress_number]=<val>`, `read_status[progress_type]=percentage|pages`, `read_status[book_num_of_pages]=<pages>`, `book_id=<bookId>`, `on_book_page=true`, `authenticity_token=<csrf>` with `Accept-Encoding: gzip`. Skipped if the fetched book page already reflects the target progress, and verified via `/api/fetch` if a `502` occurs.
7. **Error Signatures:**
   - Expired session: `302`/`303` `Location` containing `/users/sign_in`, `401`, or `form[action*="/users/sign_in"]`
   - Invalid/stale CSRF: `422 Unprocessable Entity`
   - Cloudflare challenge: `403`/`503`, `cf-mitigated` header, or challenge markers (`Just a moment...`, `/cdn-cgi/challenge-platform`)
   - ESP32 relay overflow / header cap: `502` with `{"error":"relay failed; large bodies need /api/fetch"}` (> `32,768` B uncompressed response body or > `4,096` B / `16` outbound headers)

---

## 4. 6-Phase Build Roadmap

### Phase 0: Feasibility & Contract Validation Spike (Go / No-Go Gate — Completed on Hardware)
- [x] Inspected CrossPoint/CrossInk `docs/sd-plugins.md`, `docs/plugin-events.md`, `docs/webserver-endpoints.md`, and `pluginhub/plugin.js` to confirm the exact `device.json` schema for `reader.exit` and `reader.session`.
- [x] Deployed a Phase 0 probe plugin onto the X4 Pro (`/.crosspoint/plugins/storygraph-sync/`), rebooted, opened/read/exited EPUBs, and verified `events.jsonl` generation.
- [x] Inspected real `events.jsonl` entries from the device and locked down exact JSON keys (`e`, `id`, `ts`, `vars.book`, `vars.percent`, `vars.document`, `vars.end_progress_bp`, `vars.progress_scale`, `vars.duration_seconds`).
- [x] Captured and cross-checked StoryGraph HTTP endpoints, cookies, form fields, and DOM selectors for homepage Current Reads, `/browse` search, `/books/<id>`, `/update-status.js`, and `/update-progress`.
- [x] Ran live `/api/relay` + `/api/fetch` probes from the X4 Pro against `https://app.thestorygraph.com/`, confirming `api.fetchToSd` succeeds (`HTTP 200`, `141,165` B) with no Cloudflare block and `api.writeFile` succeeds (`105` B UTF-8 round-trip).

### Phase 1: Scaffold Plugin & Accurate Local Browser Test Harness — Completed
- [x] Created `manifest.json` (`"title": "StoryGraph Sync"`, `"mount": "files"`, `"version": "0.1.0"`) and `device.json` subscribing to `reader.exit` and `reader.session` with the loopback spool URL.
- [x] Created `plugin.js` synchronously calling `CrossPoint.registerPlugin((container, api) => { ... })` at top level (no `await` before registration).
- [x] Built a local Node.js mock harness (`harness/server.mjs` + `harness/test.mjs`) matching the **real** `/plugin-host.js` contract (`name`, `dir`, `relay` returning `{ status, headers, body }` and throwing on `!r.ok`, absolute-path Base64 `writeFile` rejecting 0-byte or >256 KB payloads, absolute-path `fetchToSd`, `pluginFile`, `registerAction`), simulated `502` relay size caps (`32 KB` response body and `4 KB` / 16-header request cap), gzip compression on StoryGraph POST responses, `403` on `/.crosspoint/` `/download`, and `500` on `/delete` inside plugin space.

### Phase 2: StoryGraph Auth, Cookie Hygiene & Large-Body Relay Client — Completed
- [x] Built a collapsible **Account Settings** UI panel with `type="password"` cookie inputs (supporting full pasted `Cookie` headers or `_storygraph_session` + `remember_user_token`), an optional `User-Agent` override, and persistence in browser `localStorage`.
- [x] Added **Export Settings** and **Import Settings** actions (with sensitive-cookie warning) so settings survive router DHCP IP changes; documented `http://crosspoint.local/` as the preferred stable origin.
- [x] Implemented ESP32-safe serialized transport (`runExclusive`) where `GET` HTML requests use `api.fetchToSd(url, api.dir + '/tmp-fetch.html', headers)` → `fetch(api.pluginFile('tmp-fetch.html'), { cache: 'no-store' })` (reusing `tmp-fetch.html` without calling `/delete`), and `POST` requests use `api.relay()` while merging rotated `Set-Cookie` headers into `localStorage`.
- [x] Added a **Verify Session** button that fetches `https://app.thestorygraph.com/` via `api.fetchToSd`, verifies login + CSRF token extraction, and caches **Current Reads** for quick linking.

### Phase 3: Read `events.jsonl` Progress & Build Resilient Edition Linker — Completed
- [x] On plugin load, fetched `api.pluginFile('events.jsonl')` and `api.pluginFile('storygraph-map.json')` (`cache: 'no-store'`), handling missing files (`404`) gracefully.
- [x] Reduced `events.jsonl` to the latest progress snapshot per EPUB using `reduceEventsJsonl()`, rendering the union of active outbox books and previously linked books in `storygraph-map.json`.
- [x] Matched books against `storygraph-map.json` by `sdPath`, falling back to `documentHash` (KOSync MD5), normalized filename, or normalized `(title, author)` — auto-updating `sdPath` via `api.writeFile()` when books are moved by `organize_books.py`.
- [x] Added per-book **Link Book** controls supporting (a) 1-click linking from **Current Reads**, (b) StoryGraph `/browse` search via `api.fetchToSd`, and (c) direct Book ID / URL entry, saving `{ bookId, title, author, sdPath, documentHash, trackingMode, pageCount, status, lastSyncedPercent, lastSyncedAt }` to `storygraph-map.json`.

### Phase 4: One-Click Progress Updates, Safety Guards & Read-Status Transitions — Completed
- [x] Displayed each book's `Device %`, `Last Synced %`, session reading time, and **Sync Now**, **Mark Read**, and **Unlink** buttons.
- [x] Enforced pre-sync safety guards:
  - Prompted for confirmation if `devicePercent < lastSyncedPercent` or `devicePercent === 0` (or if StoryGraph's `last_reached_percent` is already higher than `devicePercent`).
  - Fetched `/books/<bookId>` immediately before syncing to obtain a fresh CSRF token and check remote shelf status; only set **Currently Reading** if not already `currently-reading` / `rereading`.
  - Converted percentage to `Math.round((devicePercent / 100) * bookNumOfPages)` when the linked StoryGraph edition tracks **pages** instead of **%**.
- [x] Submitted `POST /update-progress`, persisted `lastSyncedPercent` and `lastSyncedAt` to `storygraph-map.json`, transitioned to **Read** automatically at `100%` (guarded if already `read`) or manually via **Mark Read**, and automatically PATCHed StoryGraph start/finish dates via `/read_instances/<id>` (`Read` books) and `/update-journal-entry-from-book` (`Currently Reading` / `Rereading`, preserving earlier remote start dates) plus a header **Sync Dates** batch button (`lastSyncedStartDate` / `lastSyncedFinishDate`).
- [x] Added **Compact Outbox** (writes latest 1 event line per book via `api.writeFile(api.dir + '/events.jsonl', ...)`, or `"\n"` if empty) and warned before hitting the 4 KB firmware cap.

### Phase 5: Sideload & Smoke-Test on CrossInk `v2.0.0-0b939f4-RC` — Completed
- [x] Deployed `storygraph-sync/` into `/.crosspoint/plugins/storygraph-sync/` via `POST /api/plugin-fs` over Wi-Fi (`manifest.json`, `device.json`, `plugin.js`, `README.md`), preserving existing `events.jsonl`.
- [x] Verified **Settings → System → Plugins** was enabled on the X4 Pro and `GET /api/plugins` returned `storygraph-sync` with `"mount": "files"`.
- [x] Opened, read, and exited test EPUBs so CrossInk wrote `events.jsonl`.
- [x] Opened File Manager `/files`, pasted session cookies, linked all 3 active books (*Sample Non-Fiction A*, *Sample Non-Fiction B*, *Sample Series Vol. 9*), and verified **Sync Now** live against StoryGraph.
- [x] **Live Hardware Smoke-Test Result:** All 3 books linked and reached `Up to date` state on StoryGraph, including automatic page-mode conversion on *Sample Non-Fiction A* (`89%` → `342/384 pp`), and UI styling was polished to match CrossInk's light/dark CSS tokens.

---

## 5. Scope Boundaries (v1 MVP vs. v2 Expansion)

| Feature | Status | Notes |
| :--- | :--- | :--- |
| **Firmware-driven progress capture (`device.json` → `events.jsonl`)** | Included (`v0.1.0`) | Loopback spool retains `reader.session` + `reader.exit` events |
| **Manual single-book percentage/page sync with regression & shelf guards** | Included (`v0.1.0`) | Auto-converts `%` to pages for page-tracked StoryGraph editions |
| **Auto-mark "Read" at 100% + manual Mark Read** | Included (`v0.1.0`) | Manual button covers books ending before 100% due to endmatter |
| **Edition search & move-resilient `storygraph-map.json` linking** | Included (`v0.1.0`) | Matches by `sdPath`, KOSync MD5, filename, and normalized title/author |
| **Large HTML GET fallback via `api.fetchToSd()`** | Included (`v0.1.0`) | Reuses `tmp-fetch.html` atomically without `POST /delete` |
| **Batch multi-book sync (`Sync All`), `Sync Dates`, Daily Reading Journal & Auto-Compact** | Included (`v0.1.0`) | Sequential per-book queue (400 ms spacing for ~99 KB heap, `Accept-Encoding: gzip` on `api.relay` POSTs, automatic non-essential cookie trimming near 4 KB, direct `status=read` for unstarted 100% books, automatic read-instance / start-date PATCHes with post-502 `/api/fetch` verification, persistent per-day `reading-history.json` + collapsible Reading History timeline + chronological StoryGraph Reading Journal sync via `/update-progress-with-note` with `/journal` deduplication + CrossPoint Sync session JSON import, standalone **Sync Dates** batch action), CrossInk-style progress bar, single per-batch confirmation for lower/0% progress (plus optional skip-prompts toggle), and history-safe outbox compaction |
| **On-demand SD Library browser (`/api/files`)** | Included (`v0.1.0`) | Collapsible folder picker (`#sg-sd-details`) to link older/finished books for **Mark Read** or pre-linking without scanning the whole SD card on load |
| **In-plugin StoryGraph sign-in (`/users/sign_in`)** | Not feasible (Cloudflare) | Live testing on X4 Pro hit Cloudflare `HTTP 403` (`cf-mitigated: challenge`) and StoryGraph has no "Remember me" checkbox; `v0.1.0` uses browser cookie auth with automatic `_storygraph_session` rotation |
| **USB / SD historical progress backfill script** | Included (`v0.1.0`) | PC USB Drive utility ([backfill_sd.py](backfill_sd.py)) reading `/.crosspoint/epub_*/` (`progress_percent.bin`, `progress.bin` + EPUB spine sizes, `stats_v5.bin` dates/durations/page turns) into `backfill.json`, merged automatically in `plugin.js` |
| **CrossPoint Sync server progress import** | Deferred (v2) | Optional Wi-Fi import from a user's CrossPoint Sync server (`/api/v1/stats/books`, `/api/v1/progress/*`) |
| **Journal quotes from `/My Clippings.txt`** | Deferred (v2) | Parse `/download?path=/My%20Clippings.txt` and attach selected highlights to reading journal entries. |
| **Background job automation (`/api/plugin-jobs`)** | Deferred (v2) | Register handlers with `api.registerAction()` and execute queued sync jobs via `/plugins-run`. |
