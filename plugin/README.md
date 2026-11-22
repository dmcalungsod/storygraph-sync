# StoryGraph Sync

Sync reading progress from your XTEInk X4 Pro (CrossInk) to **The StoryGraph** from the File Manager Web UI (`/files`).

## 1. Install & First Boot

1. Copy the `storygraph-sync` folder to `/.crosspoint/plugins/storygraph-sync/` via **USB Drive** mode or an SD card reader.
2. Enable **Settings → System → Plugins** (or **Connectivity → Plugins**).
3. **Reboot once** so CrossInk registers `reader.exit` and `reader.session` subscriptions.
4. Open a book, read, and exit back to Home so CrossInk records progress in `events.jsonl`.

## 2. Sign In (Browser Cookies)

1. Log into `https://app.thestorygraph.com/` in your desktop browser (ideally on the same non-VPN network as the X4 Pro if Cloudflare challenges requests).
2. Open DevTools (**F12**) → **Network** tab → reload (**F5**).
3. Click the main `app.thestorygraph.com` document request → **Request Headers** → copy the `cookie` header (must include `_storygraph_session`, plus `cf_clearance` if present).
4. Start File Transfer on your X4 Pro, open `http://crosspoint.local/files`, expand **Account Settings**, paste your cookie header, make sure **User-Agent** matches that browser, and click **Verify Session**.

> Credentials are never written to the microSD card; session cookies stay strictly in browser `localStorage` (use `http://crosspoint.local/files` so they survive DHCP IP changes), and `_storygraph_session` rotates automatically whenever StoryGraph sends `Set-Cookie`. CrossInk enforces a 4 KB total request-header limit (`4,096` B, max 16 headers), so the plugin automatically trims non-essential cookies if needed — if you paste a very large header, keeping only `_storygraph_session` and `cf_clearance` avoids header-size errors.

## 3. Link & Sync Books

- **Tracked Books (`events.jsonl` & `reading-history.json`):** Every reading session recorded while `plugin` subscriptions are active is aggregated per day inside `reading-history.json` (preserved and migrated automatically even across `/Books/` → `/Read/` folder moves or `events.jsonl` compaction, rolling up the highest recorded progress from `reading-history.json` while ignoring trailing `0%` open-only / book-finish exit resets). Books moved into `/Read/` after finishing (even when CrossInk logs a `0%` cache-reset event after moving) are automatically recognized as **100% — Ready** to mark Read directly via `status=read` (avoiding duplicate `100%` + `Finished (0 pages read)` journal entries on StoryGraph). Books appear inside collapsible **Currently Reading**, **Unlinked & From SD**, and **Read** sections, with clickable StoryGraph title links (`↗`), percentage progress, duration, pages turned, a collapsible per-book **Reading history** timeline (also showing start/finish milestones and cumulative session/page-turn totals for books backfilled from `backfill.json`, including already-finished books in `/Read/`), and non-wrapping human-readable dates (same-year ranges shortened to `read October 19 → October 21, 2026`). Use the filter tabs (**All**, **Reading**, **Needs Sync**, **Read**, **Unlinked**), quick search box, and **Sort** selector to narrow or reorder the list anytime, or click **Link Book** on unlinked rows to match via StoryGraph **Current Reads**, `/browse` search, or Book URL / ID.
- **Older or Already-Finished Books:** Expand **Browse SD Library** to browse folders on your SD card on demand and click **Add & Link** on any book. Once linked, click **Mark Read** for finished books — or leave it pre-linked so progress fills in after your next reading session. *(To pull current `%` for an untouched mid-read book immediately, open and exit it once on the X4 Pro.)*
- **Sync:** Click **Sync Now** on one book or **Sync All** in the header to sequentially update every linked book with new progress (shown in the progress bar, auto-compacting `events.jsonl` when enabled), or **Mark Read** when finished. When multiple unsynced days exist for a book (or when **Include reading duration in StoryGraph journal notes** is enabled in Account Settings), the plugin posts each day chronologically to StoryGraph's **Reading Journal** via `/update-progress-with-note` (checking `/journal` first to avoid duplicates and automatically cleaning bogus `0%` or duplicate `100%` entries), or you can click **Sync Journal** inside any book's Reading History section. Use **Clean Journals** in the header anytime to scan all linked books on StoryGraph, transfer page credit from stray `100%` entries onto `Finished (0 pages read)` entries, and delete bogus `0%` or duplicate same-day journal entries. Start and finish dates from your X4 Pro reading history (`startDate` / `lastDate`) are synced to StoryGraph automatically during **Sync Now**, **Sync All**, and **Mark Read** (preserving any earlier start date you already set on StoryGraph for Currently Reading / Rereading books). Use **Sync Dates** in the header anytime to push start/finish dates for previously synced books. You can also import historical sessions via **Import Session History** in Account Settings by choosing a `.json`/`.jsonl` file directly or pasting multi-line JSON/JSONL (supports CrossPoint Sync exports, `reading-history.json`, and `events.jsonl`). **Sync All** automatically ignores `0%` open-only events and books already marked **Read** (so finished books are never switched to *Rereading*). If other books in a batch have lower device progress than StoryGraph, you are prompted at most once per batch (or never if **Overwrite lower/0% without asking** is enabled).
- Use **Compact Outbox** anytime to keep `events.jsonl` well under CrossInk's 4 KB outbox cap.
- **Updating the Plugin on X4 Pro:** After updating `plugin.js` locally, run `python storygraph-sync/backfill_sd.py --write-sd` in USB Drive mode (or copy `storygraph-sync/plugin/plugin.js` to `/.crosspoint/plugins/storygraph-sync/plugin.js`), then reload `/files`.

## 4. Historical Progress Backfill (USB Drive Mode)

To recover reading percentages, durations, page turns, and dates from before the plugin was installed (or after moving books to `/Read/`):

1. Connect the X4 Pro via **USB Drive** mode (e.g. `E:\`).
2. Run:
   ```bash
   python storygraph-sync/backfill_sd.py --write-sd
   ```
   *(Pass `--sd-root E:\` if auto-detection doesn't find the drive.)*
3. Eject safely, switch back to **File Transfer**, and reload `/files` — historical percentages, reading times, and dates appear automatically via `backfill.json` (your `storygraph-map.json` links are preserved untouched).
